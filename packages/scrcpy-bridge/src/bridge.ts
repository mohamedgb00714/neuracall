import { EventEmitter } from "node:events";
import { execFileSync, spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { WavStreamReader, type WavFormat } from "./wavStream.js";

/**
 * Anything that accepts PCM16 chunks. `format` (optional) is called once,
 * before the first `push`, with the stream's real sample rate / channel count
 * so the consumer can resample (scrcpy emits 48 kHz stereo).
 */
export interface PcmSink {
  format?(fmt: WavFormat): void;
  push(buf: Uint8Array): void;
  end(): void;
}

/**
 * Values accepted by scrcpy `--audio-source`. "mic" is the phone microphone
 * (our side of a call); the "voice-call*" sources capture the call itself
 * where the OEM allows it (Android 10+).
 */
export type ScrcpyAudioSource =
  | "output"
  | "mic"
  | "playback"
  | "mic-unprocessed"
  | "mic-camcorder"
  | "mic-voice-recognition"
  | "mic-voice-communication"
  | "voice-call"
  | "voice-call-uplink"
  | "voice-call-downlink"
  | "voice-communication"
  | "voice-performance";

/**
 * How captured audio gets from scrcpy into this process.
 *  - "fifo": scrcpy records to a named pipe (mkfifo) that we read without
 *            blocking. No disk, no stdout contamination. Linux/macOS.
 *  - "file": scrcpy records to a temp .wav that we tail-read every 100 ms and
 *            delete on exit. Works everywhere (Windows has no mkfifo).
 *
 * Verified on scrcpy 3.3.4: stdout is unusable (banner + adb output land
 * there), libavformat's `pipe:` protocol emits nothing, and `/dev/fd/N` fails
 * for Node's extra stdio "pipes" (they are socketpairs, which /proc cannot
 * reopen) — a real FIFO path is what works.
 */
export type ScrcpyTransport = "fifo" | "file";

/** The subset of ChildProcess the bridge needs (so tests can fake it). */
export interface ScrcpyChild {
  stdout: Readable | null;
  stderr: Readable | null;
  stdio: ReadonlyArray<Readable | Writable | null | undefined>;
  killed: boolean;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
}

export interface ScrcpySpawn {
  (args: string[], options: { stdio: StdioOptions }): ScrcpyChild;
}

/** Real spawner: the `scrcpy` binary on PATH. */
export const defaultScrcpySpawn: ScrcpySpawn = (args, options) =>
  nodeSpawn("scrcpy", args, options) as unknown as ScrcpyChild;

export interface ScrcpyBridgeOptions {
  /** Returns a running child process for the given scrcpy args (testable). */
  spawn?: ScrcpySpawn;
  /** Destination for the captured PCM frames. */
  sink: PcmSink;
  /** Device endpoint passed to `-s` (serial or ip:port). */
  endpoint: string;
  /** Audio source routed to scrcpy. Default "mic". */
  audioSource?: ScrcpyAudioSource;
  /** Audio transport. Default "file" on Windows, "fifo" elsewhere. */
  transport?: ScrcpyTransport;
  /** Override the FIFO / temp .wav path (tests). */
  recordPath?: string;
  /** Poll interval for the "file" transport in ms. Default 100. */
  tailIntervalMs?: number;
  /** Platform override (tests). */
  platform?: NodeJS.Platform;
}

/** Result of a terminated scrcpy run. */
export interface ScrcpyExit {
  endpoint: string;
  /** Exit code, or null if the process was killed by a signal. */
  code: number | null;
  /** Signal that terminated it, if any. */
  signal: string | null;
}

/** After scrcpy exits, wait this long with no new bytes before finishing. */
const FIFO_DRAIN_QUIET_MS = 60;
const FIFO_DRAIN_MAX_MS = 1000;

/**
 * Manages one scrcpy audio-capture process per device. Spawns scrcpy
 * audio-only, recording raw PCM as a WAV stream to a FIFO (or temp file),
 * parses it and forwards each PCM chunk to the PcmSink. Emits "exit" when
 * scrcpy stops.
 *
 * Events:
 *  - "format" (fmt: WavFormat)     stream sample rate / channels, once
 *  - "frame" (payload: Uint8Array)  raw PCM16 LE bytes, before being pushed
 *  - "exit"  (result: ScrcpyExit)
 *  - "error" (message: string)      scrcpy ERROR/WARN lines, spawn/parse failures
 *  - "log"   (message: string)      other scrcpy output (INFO/DEBUG, banner)
 *
 * Attach an "error" listener: Node throws on unhandled "error" events.
 */
export class ScrcpyBridge extends EventEmitter {
  private readonly opts: ScrcpyBridgeOptions;
  private readonly spawnFn: ScrcpySpawn;
  private transport: ScrcpyTransport;
  private readonly reader = new WavStreamReader();
  private proc: ScrcpyChild | null = null;
  private recordPath: string | null = null;
  private formatSent = false;
  private finished = false;
  private lastDataAt = 0;
  private sinkEnded = false;
  private fifo: { socket: Socket; path: string } | null = null;
  private tail: { timer: NodeJS.Timeout; finish: () => void } | null = null;

  constructor(opts: ScrcpyBridgeOptions) {
    super();
    this.opts = opts;
    this.spawnFn = opts.spawn ?? defaultScrcpySpawn;
    const platform = opts.platform ?? process.platform;
    this.transport = opts.transport ?? (platform === "win32" ? "file" : "fifo");
  }

  /**
   * Build the scrcpy argv for audio-only capture, recording a raw-PCM WAV to
   * `recordPath`. Flags verified against scrcpy 3.3.4 `--help` and a live run:
   * -s, --no-video, --no-window, --no-playback, --audio-source,
   * --audio-codec=raw, --record-format=wav, --record.
   */
  buildArgs(recordPath: string): string[] {
    const source = this.opts.audioSource ?? "mic";
    return [
      "-s",
      this.opts.endpoint,
      "--no-video",
      "--no-window",
      "--no-playback",
      "--audio-source",
      source,
      "--audio-codec",
      "raw",
      "--record-format",
      "wav",
      "--record",
      recordPath,
    ];
  }

  /** Where scrcpy is told to record (a FIFO or a temp .wav). */
  get target(): string | null {
    return this.recordPath;
  }

  /** Transport actually in use (may fall back from "fifo" to "file"). */
  get activeTransport(): ScrcpyTransport {
    return this.transport;
  }

  /** Start scrcpy and begin streaming audio to the sink. */
  start(): void {
    if (this.proc) throw new Error(`scrcpy already running for ${this.opts.endpoint}`);

    this.reader.reset();
    this.formatSent = false;
    this.finished = false;
    this.sinkEnded = false;
    this.lastDataAt = 0;

    if (this.transport === "fifo") {
      const path = this.opts.recordPath ?? tempPath(this.opts.endpoint, "fifo");
      try {
        this.fifo = openFifoReader(path);
      } catch (err) {
        // No mkfifo (unusual POSIX) — degrade to the temp-file transport.
        this.emit("log", `fifo transport unavailable (${String(err)}); using temp file`);
        this.transport = "file";
      }
    }

    if (this.transport === "fifo" && this.fifo) {
      this.recordPath = this.fifo.path;
      const { socket } = this.fifo;
      socket.on("data", (chunk: Buffer) => {
        this.lastDataAt = Date.now();
        this.consume(chunk);
      });
      socket.on("error", (err) => this.emit("error", `capture pipe error: ${err.message}`));
    } else {
      this.recordPath = this.opts.recordPath ?? tempPath(this.opts.endpoint, "wav");
    }

    const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
    const proc = this.spawnFn(this.buildArgs(this.recordPath), { stdio });
    this.proc = proc;

    // scrcpy prints its banner and adb's output on stdout, diagnostics on
    // stderr. Only ERROR/WARN lines become "error"; the rest is "log".
    proc.stdout?.on("data", (chunk: Buffer) => this.forwardLines(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => this.forwardLines(chunk));

    if (this.transport === "file") this.startTail(this.recordPath);

    proc.on("close", (code, signal) => {
      this.proc = null;
      const finish = () => this.finish({ endpoint: this.opts.endpoint, code, signal });
      if (this.fifo) this.drainFifoThen(finish);
      else finish();
    });
    proc.on("error", (err) => {
      // A spawn failure (e.g. scrcpy binary missing) may emit "error" without
      // a matching "close"; clear the handle so a restart does not throw
      // "already running" for a process that never started.
      if (proc === this.proc) this.proc = null;
      this.emit("error", err.message);
    });
  }

  /** Stop scrcpy (SIGTERM — it finalises the recording and exits cleanly). */
  stop(): void {
    const proc = this.proc;
    if (proc && !proc.killed) proc.kill("SIGTERM");
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** Stream format once parsed. */
  get format(): WavFormat | null {
    return this.reader.format;
  }

  private consume(chunk: Uint8Array): void {
    if (this.finished) return;
    const { frames, format } = this.reader.push(chunk);
    if (format && !this.formatSent) {
      this.formatSent = true;
      this.opts.sink.format?.(format);
      this.emit("format", format);
    }
    if (this.reader.error) {
      this.emit("error", `audio stream is not WAV: ${this.reader.error}`);
      this.stop();
      return;
    }
    for (const frame of frames) {
      this.emit("frame", frame);
      this.opts.sink.push(frame);
    }
  }

  private forwardLines(chunk: Buffer): void {
    for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(\[server\] )?(ERROR|WARN)/.test(line)) this.emit("error", line);
      else this.emit("log", line);
    }
  }

  /**
   * scrcpy has exited and closed its end of the FIFO; the bytes it wrote last
   * are still in the pipe buffer and arrive on the next event-loop turns.
   * Wait for a short quiet period before tearing the reader down.
   */
  private drainFifoThen(done: () => void): void {
    const started = Date.now();
    const tick = () => {
      const quiet = Date.now() - this.lastDataAt >= FIFO_DRAIN_QUIET_MS;
      const overdue = Date.now() - started >= FIFO_DRAIN_MAX_MS;
      if (quiet || overdue) done();
      else setTimeout(tick, 20);
    };
    setTimeout(tick, 20);
  }

  private finish(result: ScrcpyExit): void {
    if (this.finished) return;
    // Drain the temp file first: bytes read here must still reach the sink.
    this.tail?.finish();
    this.tail = null;
    this.finished = true;
    if (this.fifo) {
      this.fifo.socket.destroy();
      try {
        unlinkSync(this.fifo.path);
      } catch {
        /* already gone */
      }
      this.fifo = null;
    }
    // A bridge can be started again after scrcpy exits, and the same sink is
    // reused across runs. end() must fire once per run, not once ever — calling
    // it again would be an error for a stream-like sink.
    if (!this.sinkEnded) {
      this.sinkEnded = true;
      this.opts.sink.end();
    }
    this.emit("exit", result);
  }

  /** "file" transport: read whatever scrcpy appended since the last tick. */
  private startTail(path: string): void {
    let fd: number | null = null;
    let offset = 0;
    const tick = () => {
      try {
        if (fd === null) {
          try {
            fd = openSync(path, "r");
          } catch {
            return; // scrcpy has not created the file yet
          }
        }
        const size = fstatSync(fd).size;
        if (size <= offset) return;
        const buf = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        if (n > 0) this.consume(buf.subarray(0, n));
      } catch (err) {
        this.emit("error", `capture file read failed: ${String(err)}`);
      }
    };
    const timer = setInterval(tick, this.opts.tailIntervalMs ?? 100);
    timer.unref?.();
    this.tail = {
      timer,
      finish: () => {
        clearInterval(timer);
        tick(); // drain what was written between the last tick and exit
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      },
    };
  }
}

/**
 * Create a FIFO and open it read+write, non-blocking: holding a write end
 * ourselves means the reader never sees a spurious EOF before scrcpy opens
 * the pipe, and O_NONBLOCK lets libuv poll it like any other pipe.
 */
function openFifoReader(path: string): { socket: Socket; path: string } {
  try {
    unlinkSync(path);
  } catch {
    /* fresh */
  }
  execFileSync("mkfifo", ["-m", "600", path], { stdio: "ignore" });
  const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  const socket = new Socket({ fd, readable: true, writable: false });
  return { socket, path };
}

function tempPath(endpoint: string, ext: string): string {
  const safe = endpoint.replace(/[^A-Za-z0-9._-]/g, "_");
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(tmpdir(), `neuracall-scrcpy-${safe}-${process.pid}-${nonce}.${ext}`);
}
