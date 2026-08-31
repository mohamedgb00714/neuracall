/**
 * Simple energy-based voice activity detector. Decisions are made per fixed
 * 20ms analysis frame; start-window and hangover are stated in milliseconds
 * and converted to frame counts. This keeps VAD timing correct regardless of
 * how the caller slices its audio.
 */

export interface VadOptions {
  /** RMS amplitude threshold above which a frame counts as speech. Default 0.01. */
  threshold?: number;
  /** Milliseconds of above-threshold speech required to open a voiced run. */
  startMs?: number;
  /** Milliseconds of trailing silence still counted as part of the run. */
  hangoverMs?: number;
  /** Sample rate of the frames being tested (for ms->frames math). */
  sampleRate: number;
  /** Length of one analysis frame in ms. Default 20. */
  frameMs?: number;
}

const DEFAULT_START = 80;
const DEFAULT_HANGOVER = 250;
const DEFAULT_FRAME_MS = 20;

/**
 * Stateful VAD. Feed it mono Float32 frames of `frameSamples` (one analysis
 * frame each); process() returns whether voice is currently active and flips
 * state as start-window and hangover are crossed.
 */
export class EnergyVad {
  private readonly threshold: number;
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly startFrames: number;
  private readonly hangoverFrames: number;
  private armed = false; // speech seen but start-window not yet reached
  private active = false; // currently inside a voiced run
  private speechRuns = 0;
  private silenceRuns = 0;

  constructor(opts: VadOptions) {
    if (opts.sampleRate <= 0) throw new Error("VAD needs a positive sample rate");
    this.threshold = opts.threshold ?? 0.01;
    this.sampleRate = opts.sampleRate;
    const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
    if (frameMs <= 0) throw new Error("VAD needs a positive frameMs");
    this.frameSamples = Math.max(1, Math.round((frameMs / 1000) * this.sampleRate));
    this.startFrames = Math.max(1, Math.round((opts.startMs ?? DEFAULT_START) / frameMs));
    this.hangoverFrames = Math.max(0, Math.round((opts.hangoverMs ?? DEFAULT_HANGOVER) / frameMs));
  }

  /** The number of samples one analysis frame holds at the configured rate. */
  get requiredFrameSamples(): number {
    return this.frameSamples;
  }

  /** Process one mono analysis frame. Returns whether voice is active now. */
  process(frame: Float32Array): boolean {
    const speech = rms(frame) >= this.threshold;
    if (speech) {
      this.silenceRuns = 0;
      this.speechRuns += 1;
      if (!this.active && this.speechRuns >= this.startFrames) {
        this.active = true;
      }
    } else {
      this.speechRuns = 0;
      if (this.active) {
        this.silenceRuns += 1;
        if (this.silenceRuns > this.hangoverFrames) {
          this.active = false;
        }
      }
    }
    return this.active;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Reset to the silent state (e.g. when a call ends). */
  reset(): void {
    this.armed = false;
    this.active = false;
    this.speechRuns = 0;
    this.silenceRuns = 0;
  }
}

/**
 * AC-coupled root-mean-square of a mono Float32 frame. The mean is subtracted
 * first so a DC offset (hardware bias, silent-but-loud constant signal) does
 * not masquerade as speech; we measure the energy of the *variation*.
 */
export function rms(frame: Float32Array): number {
  const n = frame.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += frame[i]!;
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = frame[i]! - mean;
    varSum += d * d;
  }
  return Math.sqrt(varSum / n);
}
