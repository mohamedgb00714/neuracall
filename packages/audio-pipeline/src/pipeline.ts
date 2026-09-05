import type { Writable } from "node:stream";
import { normalize, floatToPcm16 } from "./pcm.js";
import { EnergyVad } from "./vad.js";

/**
 * A finished chunk of mono Int16 PCM ready to hand to the realtime client.
 * `pcm` is a full 16-bit little-endian mono buffer at `sampleRate`.
 */
export interface AudioChunk {
  /** Final sample rate after resampling. */
  sampleRate: number;
  /** Int16 LE mono PCM bytes. */
  pcm: Uint8Array;
  /** True if this is the first chunk of a new voice utterance. */
  utteranceStart: boolean;
  /** True if this is the final chunk of a voice utterance. */
  utteranceEnd: boolean;
}

export interface AudioPipelineOptions {
  /** Source audio sample rate. */
  inputSampleRate: number;
  /** Source channel count. */
  inputChannels: 1 | 2;
  /** Target sample rate fed to AssemblyAI (default 16000). */
  targetSampleRate?: number;
  /** Output chunk length in ms (default 100). AssemblyAI minimum is ~100ms. */
  chunkMs?: number;
  /** VAD threshold (0..1 RMS). Default 0.01. */
  vadThreshold?: number;
  /** VAD speech start window in ms. Default 80. */
  vadStartMs?: number;
  /** VAD trailing-silence hangover in ms. Default 250. */
  vadHangoverMs?: number;
  /** Emit silent chunks too? Default false (VAD gates output). */
  emitSilence?: boolean;
}

const DEFAULT_CHUNK_MS = 100;

/**
 * Streaming voice pipeline: normalise incoming Int16 PCM to a mono buffer at
 * the target rate, gate it through a 20ms-frame energy VAD, and emit fixed-size
 * (e.g. 100ms) mono PCM chunks with utterance-start/end flags. Output chunks
 * are written to a Node Writable (objectMode) that expects AudioChunk.
 */
export class AudioPipeline {
  private readonly inputSampleRate: number;
  private readonly inputChannels: 1 | 2;
  private readonly targetSampleRate: number;
  private readonly chunkMs: number;
  private readonly emitSilence: boolean;
  private readonly vad: EnergyVad;
  private pending: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private lastEmitted: AudioChunk | null = null;
  private inUtterance = false;

  constructor(
    opts: AudioPipelineOptions,
    private readonly out: Writable,
  ) {
    this.inputSampleRate = opts.inputSampleRate;
    this.inputChannels = opts.inputChannels;
    this.targetSampleRate = opts.targetSampleRate ?? 16000;
    this.chunkMs = opts.chunkMs ?? DEFAULT_CHUNK_MS;
    this.emitSilence = opts.emitSilence ?? false;
    this.vad = new EnergyVad({
      sampleRate: this.targetSampleRate,
      threshold: opts.vadThreshold ?? 0.01,
      startMs: opts.vadStartMs,
      hangoverMs: opts.vadHangoverMs,
    });
  }

  get chunkSamples(): number {
    return Math.round((this.chunkMs / 1000) * this.targetSampleRate);
  }

  /** Push a buffer of raw Int16 PCM from the source (stereo or mono). */
  push(buf: Uint8Array): void {
    const mono = normalize(
      Buffer.from(buf),
      this.inputChannels,
      this.inputSampleRate,
      this.targetSampleRate,
    );
    this.pending = concat(this.pending, mono);
    this.drain();
  }

  /** Flush any trailing samples at end of stream / end of call. */
  end(): void {
    if (this.pending.length > 0) this.drain(true);
    this.vad.reset();
    this.inUtterance = false;
  }

  private drain(flush = false): void {
    const size = this.chunkSamples;
    while (this.pending.length >= size || (flush && this.pending.length > 0)) {
      const frame = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(frame.length);
      this.processChunk(frame);
    }
  }

  /** VAD the chunk at 20ms frame resolution; emit it when voice is present. */
  private processChunk(frame: Float32Array): void {
    const frameSamples = this.vad.requiredFrameSamples;
    let active = false;
    for (let i = 0; i < frame.length; i += frameSamples) {
      const sub = frame.subarray(i, i + frameSamples);
      if (this.vad.process(sub)) active = true;
    }

    const start = active && !this.inUtterance;
    if (start) this.inUtterance = true;

    const shouldEmit = active || this.emitSilence;
    if (shouldEmit) {
      const chunk: AudioChunk = {
        sampleRate: this.targetSampleRate,
        pcm: floatToPcm16([frame]),
        utteranceStart: start,
        utteranceEnd: false,
      };
      this.lastEmitted = chunk;
      this.out.write(chunk);
    }

    // An utterance ends when this frame carried no speech and the VAD hangover
    // has elapsed. This must run independently of chunk emission: with
    // emitSilence=true (the default) every frame is emitted and a
    // `else if (!active)` would be unreachable, leaving inUtterance stuck true
    // forever and consumers seeing one unbroken, never-ending utterance.
    if (this.inUtterance && !active && !this.vad.isActive) {
      if (this.lastEmitted && !this.lastEmitted.utteranceEnd) {
        this.lastEmitted.utteranceEnd = true;
      }
      this.inUtterance = false;
    }
  }
}

function concat(
  a: Float32Array<ArrayBufferLike>,
  b: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBufferLike> {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
