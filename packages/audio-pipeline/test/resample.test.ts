import { test } from "node:test";
import assert from "node:assert/strict";
import { resamplePcm16, Pcm16Resampler } from "../src/resample.js";

/** What NeuraCall captures off the phone. */
const CAPTURE = 16000;
/** The only input rate the AssemblyAI Voice Agent websocket accepts. */
const AGENT = 24000;

test("identity conversion hands back the very same buffer", () => {
  const pcm = sine(1000, CAPTURE, 256);
  assert.equal(resamplePcm16(pcm, CAPTURE, CAPTURE), pcm);

  const streaming = new Pcm16Resampler(AGENT, AGENT);
  assert.equal(streaming.process(pcm), pcm);
  assert.equal(streaming.flush().length, 0);
});

test("16k -> 24k emits exactly ceil(n * 1.5) samples", () => {
  for (const n of [0, 1, 2, 3, 7, 160, 320, 321, 1000, 4801]) {
    const out = resamplePcm16(sine(1000, CAPTURE, n), CAPTURE, AGENT);
    assert.equal(
      sampleCount(out),
      Math.ceil(n * 1.5),
      `${n} samples at 16k should become ceil(${n} * 1.5) = ${Math.ceil(n * 1.5)} at 24k`,
    );
  }
  // Stated concretely, because this is the number the call budget depends on:
  // one 20 ms capture chunk (320 samples @ 16 kHz) is one 20 ms agent chunk
  // (480 samples @ 24 kHz). No accumulation, no drift.
  assert.equal(sampleCount(resamplePcm16(sine(1000, CAPTURE, 320), CAPTURE, AGENT)), 480);
});

test("the other NeuraCall rate pairs land on their exact sample counts", () => {
  const cases: Array<[from: number, to: number, n: number, expected: number]> = [
    [AGENT, CAPTURE, 480, 320], // agent audio back down for the recorder
    [AGENT, CAPTURE, 481, 321], // ceil(481 * 2/3) = 321
    [8000, AGENT, 100, 300], // narrowband capture up to the agent rate
    [48000, AGENT, 100, 50], // scrcpy's native 48k down to the agent rate
    [48000, CAPTURE, 100, 34], // ceil(100 / 3)
    [8000, CAPTURE, 100, 200],
  ];
  for (const [from, to, n, expected] of cases) {
    const out = resamplePcm16(sine(500, from, n), from, to);
    assert.equal(sampleCount(out), expected, `${n} samples ${from} -> ${to}`);
  }
});

test("a constant signal survives conversion unchanged", () => {
  // Every interpolation between two equal samples is that sample, so a DC
  // level is the one case where the exact output is known sample by sample.
  const dc = pcm16(new Array<number>(64).fill(-4321));
  const up = samplesOf(resamplePcm16(dc, CAPTURE, AGENT));
  assert.equal(up.length, 96);
  assert.ok(
    up.every((v) => v === -4321),
    "a DC level must not wobble",
  );
});

test("round-tripping a sine through 24k preserves its frequency", () => {
  // Linear interpolation attenuates the top of the band, hence the per-tone
  // gain floors; the *frequency* must survive intact at every tone.
  for (const { hz, minGain } of [
    { hz: 440, minGain: 0.98 },
    { hz: 1000, minGain: 0.95 },
    { hz: 3000, minGain: 0.8 },
  ]) {
    const original = sine(hz, CAPTURE, 8000); // 500 ms
    const up = resamplePcm16(original, CAPTURE, AGENT);
    const back = resamplePcm16(up, AGENT, CAPTURE);
    assert.equal(sampleCount(up), 12000);
    assert.equal(sampleCount(back), 8000);

    const measuredUp = zeroCrossingHz(samplesOf(up), AGENT);
    const measuredBack = zeroCrossingHz(samplesOf(back), CAPTURE);
    assert.ok(Math.abs(measuredUp - hz) / hz < 0.01, `24k copy read ${measuredUp} Hz, want ${hz}`);
    assert.ok(
      Math.abs(measuredBack - hz) / hz < 0.01,
      `round-trip read ${measuredBack} Hz, want ${hz}`,
    );

    const gain = rms(samplesOf(back)) / rms(samplesOf(original));
    assert.ok(gain > minGain && gain < 1.05, `${hz} Hz round-trip gain was ${gain.toFixed(3)}`);
  }
});

test("streamed chunks resample identically to the whole buffer (no boundary click)", () => {
  // The regression this whole class exists to prevent. A per-chunk resampler
  // restarts its phase every chunk, which puts a step discontinuity at each
  // boundary — 50-100 clicks a second on a live call. Byte equality with the
  // one-shot conversion is the strongest available statement that no such step
  // was introduced.
  const whole = sine(1000, CAPTURE, 4800); // 300 ms
  const expected = resamplePcm16(whole, CAPTURE, AGENT);
  const chunks = split(whole, 320); // 10 ms chunks, as scrcpy delivers them

  const streaming = new Pcm16Resampler(CAPTURE, AGENT);
  const parts = chunks.map((c) => streaming.process(c));
  parts.push(streaming.flush());
  assert.deepEqual(concat(parts), expected);

  // ...and the naive alternative really does differ, so the assertion above
  // has teeth rather than being trivially true.
  const naive = concat(chunks.map((c) => resamplePcm16(c, CAPTURE, AGENT)));
  assert.equal(naive.length, expected.length);
  assert.notDeepEqual(naive, expected);
});

test("interpolated values are linear, not nearest-neighbour or truncated", () => {
  // Without this the suite pins only sample *counts* and statistics, and every
  // value assertion is either DC (any interpolator preserves it) or a
  // comparison of the code against itself. Replacing `Math.round` with
  // `Math.trunc` — a plausible "optimisation", and one that biases every
  // interpolated sample toward zero — used to pass all of it.
  //
  // 16k -> 24k reads input positions 0, 2/3, 4/3, 2, ... so the fractions are
  // exactly 0, 2/3 and 1/3 and the expected values are computable by hand.
  const input = pcm16([0, 3000, -3000, 9000]);
  const got = Array.from(samplesOf(resamplePcm16(input, CAPTURE, AGENT)));
  assert.deepEqual(got, [
    0, // pos 0     -> in[0]
    2000, // pos 2/3   -> 0 + 3000 * 2/3
    1000, // pos 4/3   -> 3000 + (-3000 - 3000) * 1/3
    -3000, // pos 2     -> in[2]
    5000, // pos 8/3   -> -3000 + (9000 - -3000) * 2/3
    9000, // pos 10/3  -> past the last sample, so it holds in[3]
  ]);

  // Rounding, not truncation: 1 and 2 interpolate to 1.667 and 1.333, which
  // truncate to 1/1 but round to 2/1. Truncation would put a half-LSB DC bias
  // toward zero on every interpolated sample of every call.
  assert.deepEqual(Array.from(samplesOf(resamplePcm16(pcm16([1, 2]), CAPTURE, AGENT))), [1, 2, 2]);
  assert.deepEqual(
    Array.from(samplesOf(resamplePcm16(pcm16([-1, -2]), CAPTURE, AGENT))),
    [-1, -2, -2],
  );
});

test("streaming holds back at most one sample, and never accumulates latency", () => {
  const streaming = new Pcm16Resampler(CAPTURE, AGENT);
  const chunk = sine(700, CAPTURE, 320); // 20 ms
  const counts: number[] = [];
  for (let i = 0; i < 30; i++) counts.push(sampleCount(streaming.process(chunk)));

  // The first chunk is one sample short: its last output needs the next
  // chunk's first sample. Every chunk after it is a full 20 ms at 24 kHz.
  assert.equal(counts[0], 479);
  assert.deepEqual(new Set(counts.slice(1)), new Set([480]));

  const tail = sampleCount(streaming.flush());
  assert.equal(counts.reduce((a, b) => a + b, 0) + tail, Math.ceil(30 * 320 * 1.5));
});

test("streaming survives chunks that split a sample across the boundary", () => {
  const whole = sine(1200, CAPTURE, 2000);
  const expected = resamplePcm16(whole, CAPTURE, AGENT);

  // Byte counts chosen so most chunks end mid-sample; the 1-byte chunk also
  // exercises the "no complete sample at all" path.
  const sizes = [1, 3, 7, 13, 101, 5, 999];
  const streaming = new Pcm16Resampler(CAPTURE, AGENT);
  const parts: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < whole.length) {
    const size = sizes[i++ % sizes.length]!;
    parts.push(streaming.process(whole.subarray(offset, offset + size)));
    offset += size;
  }
  parts.push(streaming.flush());
  assert.deepEqual(concat(parts), expected);
});

test("a trailing odd byte is ignored, not decoded as a sample", () => {
  const even = sine(900, CAPTURE, 200);
  const odd = new Uint8Array(even.length + 1);
  odd.set(even);
  odd[even.length] = 0xff; // half of a sample that never arrived

  assert.deepEqual(resamplePcm16(odd, CAPTURE, AGENT), resamplePcm16(even, CAPTURE, AGENT));
  // A lone byte is not a sample and must not become one.
  assert.equal(resamplePcm16(Uint8Array.from([0x7f]), CAPTURE, AGENT).length, 0);

  // ...including when the rates already match. The fast path used to hand the
  // odd byte straight back, so a chunk sliced mid-sample survived 24k -> 24k
  // and died at VoiceAgent.sendAudio(), which throws a RangeError on a byte
  // count that is not a whole number of samples. Same input, same contract, at
  // every rate pair.
  assert.deepEqual(resamplePcm16(odd, AGENT, AGENT), even);
  assert.equal(resamplePcm16(Uint8Array.from([0x7f]), AGENT, AGENT).length, 0);
});

test("the returned array is never a window onto a longer buffer", () => {
  // `new Int16Array(chunk.buffer)` is the obvious way to read samples back, so
  // a view over an over-allocated scratch buffer would surface the slack as
  // trailing garbage. The streaming path over-allocates by design; it must not
  // leak that.
  const streaming = new Pcm16Resampler(CAPTURE, AGENT);
  for (const bytes of [640, 642, 2, 1998]) {
    const out = streaming.process(sine(1000, CAPTURE, bytes / 2));
    assert.equal(out.byteOffset, 0, "output must start at its buffer's origin");
    assert.equal(out.buffer.byteLength, out.byteLength, "output must own exactly its own bytes");
  }
  const tail = streaming.flush();
  assert.equal(tail.buffer.byteLength, tail.byteLength);
});

test("identity counters report what actually went through", () => {
  // These read zero only when the rates happen to match, which is the worst
  // possible time for a byte budget to silently stop counting.
  const streaming = new Pcm16Resampler(AGENT, AGENT);
  streaming.process(new Uint8Array(960));
  assert.equal(streaming.inputSamples, 480);
  assert.equal(streaming.outputSamples, 480);

  // Chunks split mid-sample must still add up, not lose a sample per chunk.
  streaming.reset();
  streaming.process(new Uint8Array(3));
  streaming.process(new Uint8Array(3));
  assert.equal(streaming.inputSamples, 3, "6 bytes across two odd chunks is 3 samples");

  // flush() resets on this path too, or a reused instance keeps counting up.
  streaming.flush();
  assert.equal(streaming.inputSamples, 0);
  assert.equal(streaming.outputSamples, 0);
});

test("flush resets, so an instance is reusable across calls", () => {
  const first = sine(800, CAPTURE, 640);
  const second = sine(1500, CAPTURE, 640);
  const streaming = new Pcm16Resampler(CAPTURE, AGENT);

  const runA = concat([streaming.process(first), streaming.flush()]);
  const runB = concat([streaming.process(second), streaming.flush()]);
  assert.deepEqual(runA, resamplePcm16(first, CAPTURE, AGENT));
  assert.deepEqual(runB, resamplePcm16(second, CAPTURE, AGENT));

  streaming.process(first);
  streaming.reset();
  assert.equal(streaming.inputSamples, 0);
  assert.equal(streaming.outputSamples, 0);
  assert.deepEqual(
    concat([streaming.process(second), streaming.flush()]),
    resamplePcm16(second, CAPTURE, AGENT),
  );
});

test("non-positive or non-finite rates throw instead of emitting silence", () => {
  const pcm = sine(1000, CAPTURE, 64);
  for (const bad of [0, -1, -16000, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => resamplePcm16(pcm, bad, AGENT),
      /fromRate must be a positive, finite sample rate/,
      `fromRate ${String(bad)}`,
    );
    assert.throws(
      () => resamplePcm16(pcm, CAPTURE, bad),
      /toRate must be a positive, finite sample rate/,
      `toRate ${String(bad)}`,
    );
    assert.throws(() => new Pcm16Resampler(bad, AGENT), /positive, finite sample rate/);
    assert.throws(() => new Pcm16Resampler(CAPTURE, bad), /positive, finite sample rate/);
  }
});

// --- helpers -------------------------------------------------------------

/** Int16 LE bytes from sample values. */
function pcm16(samples: readonly number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((v, i) => view.setInt16(i * 2, v, true));
  return out;
}

/** Sample values from Int16 LE bytes. */
function samplesOf(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function sampleCount(bytes: Uint8Array): number {
  return Math.floor(bytes.length / 2);
}

function sine(hz: number, rate: number, samples: number, amplitude = 0.5): Uint8Array {
  const values: number[] = [];
  for (let i = 0; i < samples; i++) {
    values.push(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude * 32767));
  }
  return pcm16(values);
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
  return parts;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Frequency of a clean tone, from sign changes. Exact enough for a pure sine. */
function zeroCrossingHz(samples: Int16Array, rate: number): number {
  let crossings = 0;
  let last = 0;
  for (const v of samples) {
    if (v === 0) continue;
    const sign = v > 0 ? 1 : -1;
    if (last !== 0 && sign !== last) crossings += 1;
    last = sign;
  }
  return (crossings * rate) / (2 * samples.length);
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / Math.max(1, samples.length));
}
