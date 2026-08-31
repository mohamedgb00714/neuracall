/**
 * Getting the agent's voice onto the call.
 *
 * This is the direction Android actively resists. There is no adb or scrcpy
 * mechanism to write into a call's uplink — scrcpy captures, it does not play
 * (see docs/AUDIO-ABI.md). So injection is always "play the PCM to some audio
 * device on this host, and arrange for the phone to be listening to it". What
 * changes between setups is only *which* device:
 *
 *   Bluetooth HFP   the host is paired to the phone as a hands-free headset,
 *                   so the host's HFP output IS the call uplink. Best quality,
 *                   needs a one-time pairing the user performs on the phone.
 *   Acoustic        a speaker next to the phone's microphone. Always works,
 *                   sounds like it, and leaks room noise into the call.
 *   Loopback/null   a virtual sink, for testing the plumbing with nothing
 *                   audible.
 *
 * `CommandAudioInjector` covers all three: it is the same code path with a
 * different `sink` name, which is exactly why the sink is a parameter rather
 * than three separate classes.
 *
 * Cancellation deserves a note. Barge-in has to drop audio the player has
 * already buffered, and a player reading raw PCM from stdin gives no way to
 * flush that buffer — so `cancel()` kills the process and starts a new one on
 * the next write. Killing a short-lived player is cheap; letting the agent
 * keep talking over the caller is not.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import type { AudioInjector } from "@neuracall/audio-pipeline";

/** Players that can read raw PCM from stdin, best first. */
export type AudioPlayer = "pw-play" | "paplay" | "aplay";

/** Candidate players in preference order. PipeWire first on modern Linux. */
export const PLAYER_PREFERENCE: readonly AudioPlayer[] = ["pw-play", "paplay", "aplay"] as const;

export interface CommandAudioInjectorOptions {
  /** Player binary. Auto-detected from PATH when omitted. */
  player?: AudioPlayer;
  /** Rate of the PCM handed to `write`. Default 16000. */
  sampleRate?: number;
  /** Channels of the PCM handed to `write`. Default 1. */
  channels?: 1 | 2;
  /**
   * Output device. For Bluetooth HFP this is the phone's HFP sink, which
   * `pactl list short sinks` reports as something like
   * `bluez_output.AA_BB_CC_DD_EE_FF.1`. Omit for the system default.
   */
  sink?: string;
  /** Look up a binary on PATH. Injectable for tests. */
  lookPath?: (binary: string) => boolean;
  /** Process spawner. Injectable for tests. */
  spawnFn?: (cmd: string, args: string[]) => ChildProcess;
  /** Reports player stderr and spawn failures. */
  onError?: (message: string) => void;
}

/** Real PATH probe — a directory walk rather than a `which` subprocess per candidate. */
function defaultLookPath(binary: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(":").filter(Boolean)) {
    try {
      accessSync(join(dir, binary), fsConstants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** The first available player, or null when none is installed. */
export function detectAudioPlayer(
  lookPath: (binary: string) => boolean = defaultLookPath,
): AudioPlayer | null {
  return PLAYER_PREFERENCE.find((p) => lookPath(p)) ?? null;
}

/**
 * Plays Int16 PCM to a host audio device by piping it into a system player.
 *
 * The player process is started lazily on the first write and reused, so a
 * whole reply is one process rather than one per chunk.
 */
export class CommandAudioInjector implements AudioInjector {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly player: AudioPlayer;
  readonly sink: string | undefined;

  private readonly spawnFn: (cmd: string, args: string[]) => ChildProcess;
  private readonly onError: ((message: string) => void) | undefined;
  private proc: ChildProcess | null = null;
  private ended = false;
  private bytes = 0;
  private restarts = 0;

  constructor(opts: CommandAudioInjectorOptions = {}) {
    const lookPath = opts.lookPath ?? defaultLookPath;
    const player = opts.player ?? detectAudioPlayer(lookPath);
    if (!player) {
      throw new Error(
        `No audio player found on PATH (tried ${PLAYER_PREFERENCE.join(", ")}). ` +
          `Install pipewire-utils, pulseaudio-utils or alsa-utils, or pass { player }.`,
      );
    }
    this.player = player;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.channels = opts.channels ?? 1;
    this.sink = opts.sink;
    this.spawnFn = opts.spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] }));
    this.onError = opts.onError;
  }

  /** Bytes handed to the player so far. */
  get bytesWritten(): number {
    return this.bytes;
  }

  /** How many times `cancel()` restarted the player to flush its buffer. */
  get restartCount(): number {
    return this.restarts;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** The argv used to play raw PCM at this injector's format. */
  buildArgs(): string[] {
    const rate = String(this.sampleRate);
    switch (this.player) {
      case "pw-play":
        return [
          "--format=s16",
          `--rate=${rate}`,
          `--channels=${this.channels}`,
          ...(this.sink ? [`--target=${this.sink}`] : []),
          "-",
        ];
      case "paplay":
        return [
          "--raw",
          "--format=s16le",
          `--rate=${rate}`,
          `--channels=${this.channels}`,
          ...(this.sink ? [`--device=${this.sink}`] : []),
        ];
      case "aplay":
        // aplay has no sink concept; routing is an ALSA/PipeWire config concern.
        return ["-q", "-f", "S16_LE", "-r", rate, "-c", String(this.channels), "-t", "raw", "-"];
    }
  }

  write(pcm: Uint8Array): void {
    if (this.ended) throw new Error("CommandAudioInjector: write after end");
    const proc = this.ensureProcess();
    if (!proc.stdin || proc.stdin.destroyed) return;
    try {
      proc.stdin.write(Buffer.from(pcm));
      this.bytes += pcm.length;
    } catch (err) {
      this.onError?.(`audio injection write failed: ${String(err)}`);
    }
  }

  /**
   * Barge-in. A player reading a raw stream has no flush, so the only way to
   * drop what it has already buffered is to kill it; the next `write` starts a
   * fresh one.
   */
  cancel(): void {
    if (!this.proc) return;
    this.restarts += 1;
    this.kill();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    // Close stdin so the player drains what it has, then let it exit on its own.
    try {
      this.proc?.stdin?.end();
    } catch {
      /* already gone */
    }
    this.proc = null;
  }

  private ensureProcess(): ChildProcess {
    if (this.proc && !this.proc.killed) return this.proc;
    const proc = this.spawnFn(this.player, this.buildArgs());
    this.proc = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) this.onError?.(`[${this.player}] ${line}`);
    });
    proc.on("error", (err: Error) => {
      this.onError?.(`failed to start ${this.player}: ${err.message}`);
      this.proc = null;
    });
    proc.on("close", () => {
      if (this.proc === proc) this.proc = null;
    });
    // An EPIPE on a killed player is expected during barge-in, not an error.
    proc.stdin?.on("error", () => undefined);
    return proc;
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin?.destroy();
      proc.kill("SIGKILL"); // SIGTERM lets it drain, which is the opposite of what barge-in wants
    } catch {
      /* already gone */
    }
  }
}

/**
 * Discards everything written to it. The default when no injection transport
 * is configured: the call still runs, is transcribed and recorded, and the
 * agent's replies appear in the transcript — the far end just hears nothing.
 * Far better than refusing to answer the phone.
 */
export class NullAudioInjector implements AudioInjector {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  private bytes = 0;

  constructor(opts: { sampleRate?: number; channels?: 1 | 2 } = {}) {
    this.sampleRate = opts.sampleRate ?? 16000;
    this.channels = opts.channels ?? 1;
  }

  get bytesWritten(): number {
    return this.bytes;
  }

  write(pcm: Uint8Array): void {
    this.bytes += pcm.length;
  }

  cancel(): void {
    /* nothing is queued */
  }

  end(): void {
    /* nothing to release */
  }
}
