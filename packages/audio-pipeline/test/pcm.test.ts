import { test } from "node:test";
import assert from "node:assert/strict";
import { resample, toMono, floatToPcm16, pcm16ToFloats, normalize } from "../src/pcm.js";

test("resample is identity when rates match", () => {
  const input = Float32Array.from([0, 0.5, 1, -0.5, 0]);
  const out = resample(input, 8000, 8000);
  assert.deepEqual([...out], [...input]);
  // and returns a copy, not the same reference
  assert.notEqual(out, input);
});

test("resample preserves rough amplitude and length ratio", () => {
  // 100 samples @ 8k -> 200 samples @ 16k
  const input = new Float32Array(100);
  for (let i = 0; i < 100; i++) input[i] = Math.sin(i / 10);
  const out = resample(input, 8000, 16000);
  assert.equal(out.length, 200);
  assert.ok(Math.abs(Math.max(...out) - Math.max(...input)) < 0.05);
});

test("toMono averages channels", () => {
  const a = Float32Array.from([1, 1, 1]);
  const b = Float32Array.from([3, 3, 3]);
  const m = toMono([a, b]);
  assert.deepEqual([...m], [2, 2, 2]);
});

test("floatToPcm16 / pcm16ToFloats round-trip", () => {
  const mono = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  const buf = floatToPcm16([mono]);
  assert.equal(buf.length, mono.length * 2);
  const back = pcm16ToFloats(buf, 1);
  assert.equal(back.length, 1);
  const channel = back[0]!;
  assert.ok(Math.abs(channel[0]! - 0) < 0.001);
  assert.ok(Math.abs(channel[1]! - 0.5) < 0.001);
  assert.ok(Math.abs(channel[2]! - -0.5) < 0.001);
});

test("normalize downmixes a stereo buffer to mono 16k", () => {
  // Build a stereo buffer where left = 1.0, right = 0.0 -> mono should be ~0.5
  const frames = 4;
  const buf = Buffer.alloc(frames * 2 * 2);
  for (let f = 0; f < frames; f++) {
    buf.writeInt16LE(32767, f * 2 * 2); // left = max
    buf.writeInt16LE(0, (f * 2 + 1) * 2); // right = 0
  }
  const mono = normalize(buf, 2, 16000, 16000);
  assert.equal(mono.length, frames);
  assert.ok(Math.abs(mono[0]! - 0.5) < 0.01);
});
