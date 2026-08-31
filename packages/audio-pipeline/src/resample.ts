/**
 * Sample-rate conversion for Int16 LE mono PCM, one-shot and streaming.
 *
 * This module is load-bearing for the whole product. NeuraCall captures the far
 * end of a call at 16 kHz, but the AssemblyAI Voice Agent websocket accepts
 * input at *exactly* 24 kHz: a session opened against an agent configured for
 * 16 kHz or 8 kHz input dies at `session.ready` time with
 * `{"code":"internal_error","message":"Internal service error"}` and a 1011
 * close. Nothing in that failure names the sample rate, so a wrong-rate bug is
 * indistinguishable from an AssemblyAI outage. Conversion therefore lives in
 * one audited module instead of being open-coded at each call site.
 *
 * Linear interpolation, deliberately, rather than a windowed-sinc/polyphase
 * filter. Call audio is telephony speech: band-limited to roughly 300-3400 Hz
 * by the network long before it reaches us. At 16 kHz the interpolation error
 * lands overwhelmingly above that band, where a phone call carries nothing, and
 * both AssemblyAI's STT and a human listener are indifferent to it. A proper
 * filter would cost real CPU per concurrent call for inaudible gain.
 *
 * The one honest caveat: linear interpolation is a weak anti-alias filter, so
 * downsampling folds any content above the target Nyquist back into the band
 * (48000 -> 24000 aliases anything above 12 kHz). Telephony speech has
 * essentially no energy up there, which is why this is acceptable here and
 * would not be for music.
 *
 * `pcm.ts` also has a `resample()`, on Float32Array. That one is a stage inside
 * `AudioPipeline`, which already holds whole utterances as floats. This one
 * works on the wire format directly, because the AssemblyAI leg never leaves
 * PCM16 and a float round-trip there would only add loss and allocation.
 */

/** Signed 16-bit little-endian mono is the only format handled here. */
const BYTES_PER_SAMPLE = 2;

const INT16_MIN = -32768;
const INT16_MAX = 32767;

/** Shared zero-length result; nothing can mutate it, so sharing is safe. */
const EMPTY = new Uint8Array(0);

/**
 * Convert Int16 LE mono PCM from one sample rate to another.
 *
 * Returns the input itself (not a copy) when the rates match, so the common
 * "already at the right rate" path costs nothing.
 *
 * A trailing odd byte — half a sample, because the caller sliced a stream on a
 * byte boundary — is ignored rather than treated as a sample, which would
 * synthesise a loud garbage value. Use `Pcm16Resampler` for streams whose
 * chunks may split samples: it carries the orphaned byte to the next chunk
 * instead of dropping it.
 */
export function resamplePcm16(input: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  assertRates(fromRate, toRate, "resamplePcm16");
  if (fromRate === toRate) {
    // The odd byte has to be dropped here too, not just on the converting
    // path. Otherwise the contract above holds at 16k -> 24k and breaks at
    // 24k -> 24k, and the break is downstream: VoiceAgent.sendAudio() throws a
    // RangeError on a byte count that is not a whole number of samples, so a
    // chunk sliced mid-sample would kill a call only when the capture rate
    // happened to already match the agent's.
    return input.length % BYTES_PER_SAMPLE === 0 ? input : input.subarray(0, input.length - 1);
  }

  // Delegating to the streaming resampler is not laziness: it is what
  // guarantees that a whole buffer converted at once and the same buffer
  // converted chunk by chunk produce byte-identical output. Two separate
  // implementations of the same interpolation would drift apart the first time
  // one of them was "optimised".
  const resampler = new Pcm16Resampler(fromRate, toRate);
  const head = resampler.process(input);
  const tail = resampler.flush();
  if (tail.length === 0) return head;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

/**
 * Streaming Int16 LE mono resampler that carries interpolation state across
 * chunks.
 *
 * This class exists for exactly one reason. Resampling each chunk
 * independently — `resamplePcm16(chunk, 16000, 24000)` per chunk — restarts the
 * fractional read position at 0 and duplicates the chunk's final sample to
 * cover the missing right-hand neighbour. That inserts a small step
 * discontinuity at every chunk boundary. Live call audio arrives in 10-20 ms
 * chunks, so those steps repeat 50-100 times a second: a periodic click train,
 * i.e. an audible buzz laid over the caller's voice and over anything the
 * agent says. It also feeds STT a signal with strong energy at the chunk rate.
 *
 * So the phase (`outIndex`, the global output-sample counter) and the last
 * input sample of the previous chunk (`prev`) are kept between calls, and each
 * chunk holds back the output samples whose right-hand neighbour has not
 * arrived yet — one for 16k -> 24k, but `ceil(toRate / fromRate)` in general,
 * so six at 8k -> 48k and none when downsampling. The held-back tail is emitted
 * by `flush()` at end of stream.
 * The result is bit-identical to converting the whole stream in one call —
 * which is what `test/resample.test.ts` asserts, and the regression that must
 * never come back.
 *
 * One instance per direction per call; `reset()` (or `flush()`) returns it to
 * the start-of-stream state for reuse.
 */
export class Pcm16Resampler {
  readonly fromRate: number;
  readonly toRate: number;

  /** Rates match: bytes pass straight through and no interpolation phase is kept. */
  private readonly identity: boolean;
  /** Global index of the next output sample. This is the carried phase. */
  private outIndex = 0;
  /** Input samples consumed so far; `prev` sits at index `inTotal - 1`. */
  private inTotal = 0;
  /** Last input sample consumed, the left neighbour for the next chunk. */
  private prev = 0;
  /** Low byte of a sample split across a chunk boundary, awaiting its high byte. */
  private pendingByte: number | undefined = undefined;
  /** Identity path only: bytes passed through, so the counters stay honest. */
  private identityBytes = 0;

  constructor(fromRate: number, toRate: number) {
    assertRates(fromRate, toRate, "Pcm16Resampler");
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.identity = fromRate === toRate;
  }

  /** Input samples consumed since the last reset. */
  get inputSamples(): number {
    return this.inTotal;
  }

  /** Output samples emitted since the last reset, excluding a pending flush. */
  get outputSamples(): number {
    return this.outIndex;
  }

  /**
   * Convert one chunk. Returns the Int16 LE bytes ready to send now, which is
   * everything except the trailing output sample(s) still waiting on the next
   * chunk's first sample; `flush()` releases those.
   *
   * The returned array is freshly allocated and exactly as long as its backing
   * buffer, except on the identity path, which returns the input itself.
   */
  process(input: Uint8Array): Uint8Array {
    if (this.identity) {
      // No phase to carry, but the counters must still report what went
      // through: a caller sizing a send budget off `inputSamples` would read
      // zero forever, and only when the two rates happened to match. Bytes are
      // accumulated rather than samples so that chunks split mid-sample add up
      // to the right total instead of losing a sample per odd chunk.
      this.identityBytes += input.length;
      this.inTotal = Math.floor(this.identityBytes / BYTES_PER_SAMPLE);
      this.outIndex = this.inTotal;
      return input;
    }

    const buf = this.withCarriedByte(input);
    const n = Math.floor(buf.length / BYTES_PER_SAMPLE);
    // A stream sliced on odd byte offsets leaves half a sample behind; keep it
    // for the next chunk rather than dropping it, or every odd-sized chunk
    // would shift the stream's byte parity and turn the rest into noise.
    this.pendingByte = buf.length % BYTES_PER_SAMPLE === 1 ? buf[buf.length - 1] : undefined;
    if (n === 0) return EMPTY;

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const inBase = this.inTotal;
    // Output positions strictly below this have both interpolation neighbours
    // inside this chunk (or in `prev`); the rest wait for the next one.
    const limit = inBase + n - 1;

    // Bounded by (samples in) / (input samples per output sample) + 1; the
    // slack absorbs the boundary case where the phase starts just before this
    // chunk's first sample.
    const capacity = Math.ceil((n * this.toRate) / this.fromRate) + 2;
    const out = new Uint8Array(capacity * BYTES_PER_SAMPLE);
    const outView = new DataView(out.buffer);
    let written = 0;

    for (;;) {
      // Position is derived from the global output index every iteration
      // instead of being accumulated. Adding a step repeatedly would let
      // rounding error build up over a long call until the stream drifted off
      // the whole-buffer result, and `(j * fromRate) / toRate` is exact for the
      // integer rates involved.
      const pos = (this.outIndex * this.fromRate) / this.toRate;
      if (pos >= limit) break;
      const rel = pos - inBase;
      const i0 = Math.floor(rel);
      const frac = rel - i0;
      // i0 === -1 means this output falls between the previous chunk's last
      // sample and this chunk's first: precisely the seam a per-chunk
      // resampler gets wrong.
      const a = i0 < 0 ? this.prev : view.getInt16(i0 * BYTES_PER_SAMPLE, true);
      const b = view.getInt16((i0 + 1) * BYTES_PER_SAMPLE, true);
      outView.setInt16(written * BYTES_PER_SAMPLE, lerpInt16(a, b, frac), true);
      written += 1;
      this.outIndex += 1;
    }

    this.prev = view.getInt16((n - 1) * BYTES_PER_SAMPLE, true);
    this.inTotal += n;

    const bytes = written * BYTES_PER_SAMPLE;
    // `slice`, not `subarray`: the scratch buffer is allocated with a couple of
    // samples of slack, and a view over it would hand the caller an array whose
    // `.buffer` is longer than the audio. `new Int16Array(chunk.buffer)` is the
    // obvious way to read samples back — voiceAgent.ts copies its decoded
    // chunks for exactly this reason — and it would pick up the slack as
    // trailing garbage. The one-shot path already returns exact-length arrays,
    // so without this the two entry points differ in a way nothing states.
    return bytes === out.length ? out : out.slice(0, bytes);
  }

  /**
   * End of stream: emit the output samples `process()` held back, and reset.
   *
   * Every held-back output sits at an input position in `[inTotal - 1,
   * inTotal)` — that is the only reason it was held back — so both of its
   * interpolation neighbours clamp to the final input sample and its value is
   * exactly that sample. Hence the loop writes `prev` rather than
   * interpolating: it is the same answer, and it is what a one-shot conversion
   * of the whole stream produces for its tail.
   *
   * Resetting here means a resampler can be reused for the next utterance
   * without leaking the previous one's phase into it.
   */
  flush(): Uint8Array {
    if (this.identity) {
      this.reset();
      return EMPTY;
    }
    const total = Math.ceil((this.inTotal * this.toRate) / this.fromRate);
    const remaining = Math.max(0, total - this.outIndex);
    const out = new Uint8Array(remaining * BYTES_PER_SAMPLE);
    const view = new DataView(out.buffer);
    for (let i = 0; i < remaining; i++) {
      view.setInt16(i * BYTES_PER_SAMPLE, this.prev, true);
    }
    this.reset();
    return out;
  }

  /** Drop all carried state. Use between calls, or after a stream is torn down. */
  reset(): void {
    this.outIndex = 0;
    this.inTotal = 0;
    this.prev = 0;
    this.pendingByte = undefined;
    this.identityBytes = 0;
  }

  /** Prepend the half sample left over from the previous chunk, if any. */
  private withCarriedByte(input: Uint8Array): Uint8Array {
    const carry = this.pendingByte;
    if (carry === undefined) return input;
    const merged = new Uint8Array(input.length + 1);
    merged[0] = carry;
    merged.set(input, 1);
    return merged;
  }
}

/**
 * Linear interpolation between two Int16 samples, rounded and clamped.
 *
 * The clamp is only a guard against floating-point overshoot of an ulp at
 * `frac` near 0 or 1: `DataView.setInt16` wraps silently, so an out-of-range
 * value would turn a peak into full-scale noise of the opposite sign.
 */
function lerpInt16(a: number, b: number, frac: number): number {
  const v = Math.round(a + (b - a) * frac);
  if (v < INT16_MIN) return INT16_MIN;
  if (v > INT16_MAX) return INT16_MAX;
  return v;
}

/**
 * Reject rates that would silently produce garbage: 0 and NaN both make the
 * position arithmetic non-finite, which would emit a buffer of zeros — silence
 * that looks like a dead microphone rather than a configuration error.
 */
function assertRates(fromRate: number, toRate: number, where: string): void {
  if (!Number.isFinite(fromRate) || fromRate <= 0) {
    throw new Error(
      `${where}: fromRate must be a positive, finite sample rate (got ${String(fromRate)})`,
    );
  }
  if (!Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(
      `${where}: toRate must be a positive, finite sample rate (got ${String(toRate)})`,
    );
  }
}
