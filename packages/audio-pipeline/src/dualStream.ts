/**
 * Dual-stream call audio: the two directions of a live phone call, labelled.
 *
 * A call has two independent audio paths and NeuraCall needs both:
 *
 *   remoteIn   far end → us.   What the caller says. Captured off the phone
 *                              (scrcpy), resampled to 16 kHz mono PCM16, gated
 *                              by VAD, and fed to AssemblyAI (and the recorder).
 *   localOut   us → far end.   The agent's TTS voice, pushed back into the call
 *                              so the caller hears it.
 *
 * The two are deliberately *not* symmetric. `remoteIn` is a capture stream we
 * pull and transform; `localOut` is a playback stream we push through an
 * `AudioInjector`, whose transport is a phone-side concern that varies by OEM
 * (see docs/AUDIO-ABI.md). Keeping them behind one `CallAudioSession` with
 * explicit `direction` labels is what lets the orchestrator route far-end audio
 * to STT and agent audio to the phone without ever confusing the two — mixing
 * them up would transcribe our own agent and speak the caller's words back at
 * them.
 *
 * Every chunk that leaves `remoteIn` carries its direction and call identity
 * (`CallAudioChunk`), so a single sink can serve several calls and still route
 * correctly.
 *
 * This module is transport-agnostic on purpose: it knows nothing about scrcpy
 * or adb. `RemoteInStream` is structurally a `PcmSink` (`format`/`push`/`end`),
 * which is exactly what `@neuracall/scrcpy-bridge` writes into, so a
 * `ScrcpyBridge` can be pointed straight at it without either package
 * importing the other's types (scrcpy-bridge already depends on this package,
 * so the dependency must not go the other way).
 */

import { Writable } from "node:stream";
import { floatToPcm16, normalize, type PcmFormat } from "./pcm.js";
import { AudioPipeline, type AudioChunk } from "./pipeline.js";

/** Which side of the call an audio stream carries. */
export type StreamDirection = "remoteIn" | "localOut";

/** Both directions, in a stable order, for iteration and assertions. */
export const STREAM_DIRECTIONS: readonly StreamDirection[] = ["remoteIn", "localOut"] as const;

/**
 * What scrcpy emits with `--audio-codec=raw`: 48 kHz stereo signed 16-bit LE.
 * Used only until the real `format()` arrives from the capture source.
 */
export const SCRCPY_DEFAULT_FORMAT: PcmFormat = {
  sampleRate: 48000,
  channels: 2,
  bitsPerSample: 16,
};

/**
 * A capture source's reported format. Deliberately wider than `PcmFormat`:
 * this is what arrives off the wire (the scrcpy bridge's `WavFormat` satisfies
 * it), so it is narrowed and validated on the way in rather than trusted.
 */
export interface CaptureFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample?: number;
}

/** Identity of the call a stream belongs to. */
export interface CallIdentity {
  /** ADB endpoint of the phone (serial or ip:port). */
  deviceId: string;
  /** Unique id of this call. */
  callId: string;
  /** Realtime channel the audio belongs to, e.g. "cellular" or "whatsapp". */
  channelId: string;
}

/** An `AudioChunk` tagged with its direction and call, as emitted by `remoteIn`. */
export interface CallAudioChunk extends AudioChunk, CallIdentity {
  direction: StreamDirection;
  /** Monotonic index of this chunk within its stream, from 0. */
  seq: number;
}

/**
 * A destination that can put PCM onto the phone's call uplink so the far end
 * hears it. Implementations differ per platform (a virtual mic fed over a
 * loopback sink, a Bluetooth HFP gateway, an on-device helper app); see
 * docs/AUDIO-ABI.md. Phase 5's TTS task supplies the real one.
 *
 * `write` takes Int16 LE PCM at exactly `sampleRate`/`channels` —
 * `LocalOutStream` converts to those before calling, so implementations never
 * resample.
 */
export interface AudioInjector {
  /** Sample rate the injector expects, in Hz. */
  readonly sampleRate: number;
  /** Channel count the injector expects. */
  readonly channels: 1 | 2;
  /** Enqueue Int16 LE PCM for playback into the call. */
  write(pcm: Uint8Array): void;
  /**
   * Drop anything queued but not yet played. Called on barge-in, when the
   * caller starts talking over the agent. Injectors that cannot flush their
   * buffer may omit this, at the cost of the agent talking over the caller
   * until the queue drains.
   */
  cancel?(): void;
  /** Release the transport at end of call. */
  end?(): void;
}

/**
 * An `AudioInjector` that keeps everything written to it in memory. Used by
 * tests and as a safe stand-in before a real injection transport is wired up,
 * so a call still runs end-to-end (the far end simply hears nothing).
 */
export class MemoryAudioInjector implements AudioInjector {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  /** Every chunk written, in order, minus any dropped by `cancel()`. */
  readonly chunks: Buffer[] = [];
  private ended = false;
  private cancelled = 0;

  constructor(opts: { sampleRate?: number; channels?: 1 | 2 } = {}) {
    this.sampleRate = opts.sampleRate ?? 16000;
    this.channels = opts.channels ?? 1;
  }

  /** Everything written so far, concatenated. */
  get pcm(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get bytes(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0);
  }

  /** How many times `cancel()` dropped queued audio. */
  get cancelCount(): number {
    return this.cancelled;
  }

  get closed(): boolean {
    return this.ended;
  }

  write(pcm: Uint8Array): void {
    if (this.ended) throw new Error("MemoryAudioInjector: write after end");
    this.chunks.push(Buffer.from(pcm));
  }

  cancel(): void {
    this.cancelled += 1;
    this.chunks.length = 0;
  }

  end(): void {
    this.ended = true;
  }
}

export interface RemoteInOptions {
  /** Target rate handed to STT. Default 16000 (what AssemblyAI is opened at). */
  targetSampleRate?: number;
  /** Output chunk length in ms. Default 100 (AssemblyAI's minimum is ~50). */
  chunkMs?: number;
  /** VAD threshold (0..1 RMS). Default 0.01. */
  vadThreshold?: number;
  /** VAD speech-start window in ms. */
  vadStartMs?: number;
  /** VAD trailing-silence hangover in ms. */
  vadHangoverMs?: number;
  /** Forward silent chunks too. Default false — VAD gates what reaches STT. */
  emitSilence?: boolean;
  /** Capture format to assume until `format()` reports the real one. */
  assumeFormat?: PcmFormat;
  /**
   * Called when a source reports a format this pipeline cannot decode (not
   * 16-bit). The reported format is rejected and capture continues with the
   * previous one; without a handler the failure is visible on `formatError`.
   */
  onFormatError?: (err: Error, reported: CaptureFormat) => void;
}

/**
 * The far-end capture path: raw PCM in, labelled 16 kHz mono chunks out.
 *
 * Structurally a `PcmSink`, so `new ScrcpyBridge({ sink: session.remoteIn })`
 * type-checks and works. The underlying `AudioPipeline` is built lazily
 * because the real capture format is only known once the source reports it —
 * scrcpy sends `format()` before the first `push()`, but a source that pushes
 * first still works via `assumeFormat`.
 */
export class RemoteInStream {
  readonly direction: StreamDirection = "remoteIn";
  readonly deviceId: string;
  readonly callId: string;
  readonly channelId: string;

  private readonly opts: RemoteInOptions;
  private readonly sink: Writable;
  private pipeline: AudioPipeline | null = null;
  private inputFormat: PcmFormat;
  private seq = 0;
  private bytesIn = 0;
  private ended = false;
  private lastFormatError: Error | null = null;

  constructor(call: CallIdentity, sink: Writable, opts: RemoteInOptions = {}) {
    this.deviceId = call.deviceId;
    this.callId = call.callId;
    this.channelId = call.channelId;
    this.sink = sink;
    this.opts = opts;
    this.inputFormat = opts.assumeFormat ?? SCRCPY_DEFAULT_FORMAT;
  }

  /** Rate of the chunks this stream emits (what STT must be opened at). */
  get sampleRate(): number {
    return this.opts.targetSampleRate ?? 16000;
  }

  /** The capture format currently assumed or reported. */
  get captureFormat(): PcmFormat {
    return { ...this.inputFormat };
  }

  /** The last format a source reported that had to be rejected, if any. */
  get formatError(): Error | null {
    return this.lastFormatError;
  }

  /** Chunks emitted so far. */
  get chunkCount(): number {
    return this.seq;
  }

  /** Raw capture bytes received so far. */
  get bytesReceived(): number {
    return this.bytesIn;
  }

  get closed(): boolean {
    return this.ended;
  }

  /**
   * Report the capture source's real format — this is `PcmSink.format`, the
   * method the scrcpy bridge calls once before the first `push`.
   *
   * A format that arrives mid-stream (a source that re-negotiates) rebuilds
   * the pipeline, which resets VAD state and drops the few hundred ms still
   * buffered in the old one. That is the right trade against feeding STT
   * audio decoded at the wrong rate, which corrupts the whole rest of the call.
   *
   * A non-16-bit format is rejected rather than adopted: the pipeline decodes
   * Int16 only, so accepting it would turn every later chunk into noise.
   */
  format(fmt: CaptureFormat): void {
    if (fmt.bitsPerSample !== undefined && fmt.bitsPerSample !== 16) {
      const err = new Error(
        `RemoteInStream(${this.callId}): capture source reported ${fmt.bitsPerSample}-bit audio; ` +
          `only 16-bit PCM is supported. Keeping ${this.inputFormat.sampleRate} Hz / ` +
          `${this.inputFormat.channels}ch.`,
      );
      this.lastFormatError = err;
      this.opts.onFormatError?.(err, fmt);
      return;
    }

    // The pipeline downmixes to mono, so anything above stereo can be decoded
    // as stereo pairs without affecting the result beyond the extra channels.
    const channels: 1 | 2 = fmt.channels <= 1 ? 1 : 2;
    const same =
      fmt.sampleRate === this.inputFormat.sampleRate && channels === this.inputFormat.channels;
    this.inputFormat = { sampleRate: fmt.sampleRate, channels, bitsPerSample: 16 };
    if (same) return;
    this.pipeline = null; // rebuilt with the new format on the next push
  }

  /** Push raw Int16 LE PCM from the capture source. */
  push(buf: Uint8Array): void {
    if (this.ended) throw new Error(`RemoteInStream(${this.callId}): push after end`);
    this.bytesIn += buf.length;
    this.ensurePipeline().push(buf);
  }

  /** Flush trailing audio and mark the stream finished. Idempotent. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.pipeline?.end();
  }

  private ensurePipeline(): AudioPipeline {
    if (this.pipeline) return this.pipeline;
    this.pipeline = new AudioPipeline(
      {
        inputSampleRate: this.inputFormat.sampleRate,
        inputChannels: this.inputFormat.channels,
        targetSampleRate: this.opts.targetSampleRate ?? 16000,
        chunkMs: this.opts.chunkMs ?? 100,
        vadThreshold: this.opts.vadThreshold ?? 0.01,
        vadStartMs: this.opts.vadStartMs,
        vadHangoverMs: this.opts.vadHangoverMs,
        emitSilence: this.opts.emitSilence ?? false,
      },
      this.labeller(),
    );
    return this.pipeline;
  }

  /**
   * Tags each pipeline chunk with direction + call identity before the sink.
   *
   * The label is assigned onto the chunk rather than spread into a copy, on
   * purpose: `AudioPipeline` marks the end of an utterance by setting
   * `utteranceEnd` on the chunk it emitted *previously*, once the following
   * silence proves the utterance is over. Copying here would hand the sink a
   * detached object and every end-of-utterance flag would be lost.
   */
  private labeller(): Writable {
    return new Writable({
      objectMode: true,
      write: (chunk: AudioChunk, _enc, cb) => {
        const labelled = Object.assign(chunk, {
          direction: this.direction,
          deviceId: this.deviceId,
          callId: this.callId,
          channelId: this.channelId,
          seq: this.seq++,
        }) as CallAudioChunk;
        try {
          this.sink.write(labelled);
          cb();
        } catch (err) {
          cb(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
  }
}

export interface LocalOutOptions {
  /** Where agent audio goes. Defaults to a `MemoryAudioInjector` (heard by nobody). */
  injector?: AudioInjector;
  /** Rate of PCM handed to `speak()` when not stated per call. Default 16000. */
  defaultSampleRate?: number;
  /** Channels of PCM handed to `speak()` when not stated. Default 1. */
  defaultChannels?: 1 | 2;
  /** Clock (ms since epoch), injectable for tests. */
  now?: () => number;
}

/**
 * The agent playback path: TTS PCM in, injector-native PCM out.
 *
 * Resampling happens here, once, so injectors stay dumb. `cancel()` implements
 * barge-in: it drops whatever the injector still has queued and bumps a
 * generation counter, so audio from an utterance that was interrupted is
 * discarded even if it is still being written chunk by chunk.
 */
export class LocalOutStream {
  readonly direction: StreamDirection = "localOut";
  readonly deviceId: string;
  readonly callId: string;
  readonly channelId: string;
  readonly injector: AudioInjector;

  private readonly defaultSampleRate: number;
  private readonly defaultChannels: 1 | 2;
  private readonly now: () => number;
  /** Bumped by `cancel()`; writes tagged with an older generation are dropped. */
  private generation = 0;
  /** True while TTS for the current utterance is still being handed to us. */
  private utteranceOpen = false;
  /** When the audio written so far will have finished playing (ms epoch). */
  private playingUntil = 0;
  private bytesOut = 0;
  private ended = false;

  constructor(call: CallIdentity, opts: LocalOutOptions = {}) {
    this.deviceId = call.deviceId;
    this.callId = call.callId;
    this.channelId = call.channelId;
    this.injector = opts.injector ?? new MemoryAudioInjector();
    this.defaultSampleRate = opts.defaultSampleRate ?? 16000;
    this.defaultChannels = opts.defaultChannels ?? 1;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Whether the caller can still hear the agent — either TTS is still being
   * handed to us, or audio already written is still playing out.
   *
   * The second half is what makes barge-in work. Writing a second of speech to
   * the injector takes microseconds, so a flag cleared when the last byte is
   * written would be false again long before the caller has heard any of it,
   * and an interruption would never be detected. Playback is tracked by
   * duration instead: bytes written, divided by the injector's byte rate.
   */
  get isSpeaking(): boolean {
    if (this.ended) return false;
    return this.utteranceOpen || this.now() < this.playingUntil;
  }

  /** Milliseconds of agent audio still queued to play. */
  get pendingPlaybackMs(): number {
    return Math.max(0, this.playingUntil - this.now());
  }

  /** The current utterance generation; changes whenever `cancel()` fires. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Bytes handed to the injector so far. */
  get bytesWritten(): number {
    return this.bytesOut;
  }

  get closed(): boolean {
    return this.ended;
  }

  /**
   * Start an agent utterance and return its generation token. Pass the token
   * to `speak()` so that audio produced by a TTS request that has since been
   * interrupted is dropped instead of played over the caller.
   */
  beginUtterance(): number {
    this.utteranceOpen = true;
    return this.generation;
  }

  /**
   * No more `speak()` calls are coming for this utterance. The agent is still
   * "speaking" until the audio already written has played out — see
   * `isSpeaking`.
   */
  endUtterance(): void {
    this.utteranceOpen = false;
  }

  /**
   * Play PCM into the call. Returns false when the chunk was dropped because
   * its utterance was cancelled, or the stream is closed.
   *
   * `pcm` is Int16 LE at `opts.sampleRate`/`opts.channels` (defaulting to the
   * stream's configured TTS format); it is converted to the injector's format
   * before being written.
   */
  speak(
    pcm: Uint8Array,
    opts: { sampleRate?: number; channels?: 1 | 2; generation?: number } = {},
  ): boolean {
    if (this.ended) return false;
    if (opts.generation !== undefined && opts.generation !== this.generation) {
      return false; // interrupted mid-utterance — discard
    }
    if (pcm.length === 0) return true;

    const sourceRate = opts.sampleRate ?? this.defaultSampleRate;
    const sourceChannels = opts.channels ?? this.defaultChannels;
    const out = convertPcm(pcm, sourceRate, sourceChannels, this.injector);
    this.injector.write(out);
    this.bytesOut += out.length;

    // Queued audio plays after whatever is already queued, so the deadline
    // extends from the later of "now" and the current end of the queue.
    const byteRate = this.injector.sampleRate * this.injector.channels * 2;
    const durationMs = byteRate > 0 ? (out.length / byteRate) * 1000 : 0;
    this.playingUntil = Math.max(this.now(), this.playingUntil) + durationMs;
    return true;
  }

  /**
   * Barge-in: stop the agent immediately and drop anything queued. Safe to
   * call when the agent is not speaking.
   */
  cancel(): void {
    this.generation += 1;
    this.utteranceOpen = false;
    this.playingUntil = 0;
    this.injector.cancel?.();
  }

  /** Release the injector at end of call. Idempotent. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.utteranceOpen = false;
    this.playingUntil = 0;
    this.injector.end?.();
  }
}

/** Convert Int16 PCM to exactly what an injector expects. */
function convertPcm(
  pcm: Uint8Array,
  sourceRate: number,
  sourceChannels: 1 | 2,
  injector: AudioInjector,
): Buffer {
  const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const identical = sourceRate === injector.sampleRate && sourceChannels === injector.channels;
  if (identical) return Buffer.from(buf);
  const mono = normalize(buf, sourceChannels, sourceRate, injector.sampleRate);
  return injector.channels === 2 ? floatToPcm16([mono, mono]) : floatToPcm16([mono]);
}

export interface CallAudioSessionOptions extends CallIdentity {
  /** Where labelled `remoteIn` chunks go (STT feeder, recorder tee, ...). */
  sink: Writable;
  /** Far-end capture tuning. */
  remoteIn?: RemoteInOptions;
  /** Agent playback wiring. */
  localOut?: LocalOutOptions;
}

/**
 * Both directions of one call's audio, labelled and addressable.
 *
 * The orchestrator holds one of these per active call: it points the capture
 * bridge at `session.remoteIn`, feeds `session.remoteIn`'s output chunks to
 * AssemblyAI and the recorder via `sink`, and hands agent TTS to
 * `session.localOut`. `close()` tears both down.
 */
export class CallAudioSession {
  readonly deviceId: string;
  readonly callId: string;
  readonly channelId: string;
  readonly remoteIn: RemoteInStream;
  readonly localOut: LocalOutStream;

  constructor(opts: CallAudioSessionOptions) {
    this.deviceId = opts.deviceId;
    this.callId = opts.callId;
    this.channelId = opts.channelId;
    const identity: CallIdentity = {
      deviceId: opts.deviceId,
      callId: opts.callId,
      channelId: opts.channelId,
    };
    this.remoteIn = new RemoteInStream(identity, opts.sink, opts.remoteIn);
    this.localOut = new LocalOutStream(identity, opts.localOut);
  }

  /** The two streams keyed by direction — what the "labelled streams" API means. */
  get streams(): { remoteIn: RemoteInStream; localOut: LocalOutStream } {
    return { remoteIn: this.remoteIn, localOut: this.localOut };
  }

  /** Look a stream up by its label. */
  stream(direction: "remoteIn"): RemoteInStream;
  stream(direction: "localOut"): LocalOutStream;
  stream(direction: StreamDirection): RemoteInStream | LocalOutStream;
  stream(direction: StreamDirection): RemoteInStream | LocalOutStream {
    return direction === "remoteIn" ? this.remoteIn : this.localOut;
  }

  get closed(): boolean {
    return this.remoteIn.closed && this.localOut.closed;
  }

  /** End both directions. Idempotent. */
  close(): void {
    this.remoteIn.end();
    this.localOut.end();
  }
}
