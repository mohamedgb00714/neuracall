import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import {
  ScrcpyBridge,
  defaultScrcpySpawn,
  type PcmSink,
  type ScrcpyAudioSource,
  type ScrcpyExit,
  type ScrcpySpawn,
  type WavFormat,
} from "@neuracall/scrcpy-bridge";
import { AudioPipeline, type AudioChunk } from "@neuracall/audio-pipeline";

export type FeedAudio = (
  deviceId: string,
  channelId: string,
  chunk: Buffer,
) => boolean;

export interface DeviceAudioCaptureOptions {
  /** Forwards a converted PCM16 (mono, `targetSampleRate`) chunk to the open realtime session. */
  feed: FeedAudio;
  /** Spawns the scrcpy child process (testable). Default: real `scrcpy` on PATH. */
  spawn?: ScrcpySpawn;
  /** Sample rate the realtime session expects. Default 16000. */
  targetSampleRate?: number;
  /** Output chunk size in ms. Default 100 (AssemblyAI's recommended minimum). */
  chunkMs?: number;
}

export interface CaptureSession {
  deviceId: string;
  channelId: string;
  endpoint: string;
  source: ScrcpyAudioSource;
  attachedAt: number;
  /** Stream format reported by scrcpy, once known (48 kHz stereo in practice). */
  format?: WavFormat;
}

/**
 * Owns one scrcpy audio-capture bridge per device. scrcpy delivers 48 kHz
 * stereo PCM16; each chunk is downmixed and resampled to mono at the session
 * rate (16 kHz) by an AudioPipeline and forwarded straight into the open
 * realtime STT session for that device/channel — the live-audio leg between
 * the phone and transcription.
 *
 * Events:
 *  - "start"  (session: CaptureSession)
 *  - "format" (session: CaptureSession)          stream format now known
 *  - "exit"   (session: CaptureSession, result: ScrcpyExit)
 *  - "log"    (endpoint: string, line: string)   routine scrcpy output
 *  - "error"  (endpoint: string, line: string)   scrcpy ERROR/WARN or spawn failure
 */
export class DeviceAudioCapture extends EventEmitter {
  private readonly opts: DeviceAudioCaptureOptions;
  private readonly bridges = new Map<string, ScrcpyBridge>();
  private readonly sessions = new Map<string, CaptureSession>();

  constructor(opts: DeviceAudioCaptureOptions) {
    super();
    this.opts = opts;
  }

  /**
   * Begin capturing a device's audio into the given realtime session.
   * Multiple channels on the same endpoint are not supported (one bridge per
   * device), so a duplicate attach throws.
   */
  attach(
    endpoint: string,
    deviceId: string,
    channelId: string,
    source: ScrcpyAudioSource = "mic",
  ): CaptureSession {
    if (this.bridges.has(endpoint)) {
      throw new Error(`Audio capture already running for ${endpoint}`);
    }
    const session: CaptureSession = {
      deviceId,
      channelId,
      endpoint,
      source,
      attachedAt: Date.now(),
    };
    const bridge = new ScrcpyBridge({
      spawn: this.opts.spawn ?? defaultScrcpySpawn,
      endpoint,
      audioSource: source,
      sink: this.makeSink(session),
    });
    this.bridges.set(endpoint, bridge);
    this.sessions.set(endpoint, session);

    // An "error" listener is mandatory: an unhandled EventEmitter "error"
    // would otherwise throw and take the main process down.
    bridge.on("error", (line: string) => this.emit("error", endpoint, line));
    bridge.on("log", (line: string) => this.emit("log", endpoint, line));
    bridge.on("exit", (result: ScrcpyExit) => {
      this.bridges.delete(endpoint);
      this.sessions.delete(endpoint);
      this.emit("exit", session, result);
    });

    try {
      bridge.start();
    } catch (err) {
      this.bridges.delete(endpoint);
      this.sessions.delete(endpoint);
      throw err;
    }
    this.emit("start", session);
    return session;
  }

  detach(endpoint: string): boolean {
    const bridge = this.bridges.get(endpoint);
    if (!bridge) return false;
    bridge.stop();
    return true;
  }

  has(endpoint: string): boolean {
    return this.bridges.has(endpoint);
  }

  get(endpoint: string): CaptureSession | undefined {
    return this.sessions.get(endpoint);
  }

  /**
   * PCM in (scrcpy's native format) → mono 16 kHz PCM16 chunks → session out.
   * The pipeline is built lazily once the WAV header tells us the real
   * sample rate / channel count.
   */
  private makeSink(session: CaptureSession): PcmSink {
    const { deviceId, channelId } = session;
    let pipeline: AudioPipeline | null = null;
    const out = new Writable({
      objectMode: true,
      write: (chunk: AudioChunk, _enc, cb) => {
        this.opts.feed(deviceId, channelId, Buffer.from(chunk.pcm));
        cb();
      },
    });
    const build = (fmt: WavFormat) => {
      session.format = fmt;
      pipeline = new AudioPipeline(
        {
          inputSampleRate: fmt.sampleRate,
          inputChannels: fmt.channels === 1 ? 1 : 2,
          targetSampleRate: this.opts.targetSampleRate ?? 16000,
          chunkMs: this.opts.chunkMs ?? 100,
          // Keep the stream continuous: AssemblyAI's endpointing wants silence too.
          emitSilence: true,
        },
        out,
      );
      this.emit("format", session);
    };
    return {
      format: build,
      push: (buf: Uint8Array) => {
        // Defensive default if scrcpy ever omits the header: 48 kHz stereo.
        if (!pipeline) build({ formatTag: 1, channels: 2, sampleRate: 48000, bitsPerSample: 16, blockAlign: 4 });
        pipeline!.push(buf);
      },
      end: () => {
        pipeline?.end();
        // Session stays open; the capture simply stops feeding it.
      },
    };
  }

  getStatus(): CaptureSession[] {
    return [...this.sessions.values()];
  }

  /** Stop every capture bridge. */
  stopAll(): void {
    for (const endpoint of [...this.bridges.keys()]) this.detach(endpoint);
  }

  get running(): number {
    return this.bridges.size;
  }
}
