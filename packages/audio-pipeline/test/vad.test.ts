import { test } from "node:test";
import assert from "node:assert/strict";
import { EnergyVad, rms } from "../src/vad.js";

// A 20ms frame at 16k = 320 samples.
function frame(value: number, len = 320): Float32Array {
  const f = new Float32Array(len);
  // Use a small oscillating signal so RMS is stable, not a flat DC offset that
  // energy-based VAD can mistake for speech.
  for (let i = 0; i < len; i++) f[i] = value * Math.sin(i / 8);
  return f;
}

test("rms reflects amplitude", () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.ok(rms(frame(0.5)) < rms(frame(1)));
  assert.ok(rms(frame(0.5)) > 0.01);
});

test("VAD stays silent through quiet frames", () => {
  const vad = new EnergyVad({ sampleRate: 16000, threshold: 0.01 });
  for (let i = 0; i < 20; i++) {
    assert.equal(vad.process(frame(0.001)), false);
  }
  assert.equal(vad.isActive, false);
});

test("VAD activates on speech and requires a start window", () => {
  const vad = new EnergyVad({ sampleRate: 16000, threshold: 0.01, startMs: 40 });
  // First frame of loud speech should not flip active yet (startMs not reached)
  assert.equal(vad.process(frame(0.3)), false);
  assert.equal(vad.isActive, false);
  // Second loud frame crosses the ~40ms start window
  assert.equal(vad.process(frame(0.3)), true);
  assert.equal(vad.isActive, true);
});

test("VAD holds active through a short pause (hangover) then drops", () => {
  const vad = new EnergyVad({ sampleRate: 16000, threshold: 0.01, startMs: 20, hangoverMs: 20 });
  vad.process(frame(0.3));
  vad.process(frame(0.3));
  assert.equal(vad.isActive, true);
  // One quiet frame is within the 20ms (1-frame) hangover -> still active
  assert.equal(vad.process(frame(0.001)), true);
  assert.equal(vad.isActive, true);
  // Second quiet frame exceeds the hangover -> drops
  assert.equal(vad.process(frame(0.001)), false);
  assert.equal(vad.isActive, false);
});

test("VAD.reset returns to silence", () => {
  const vad = new EnergyVad({ sampleRate: 16000, threshold: 0.01, startMs: 20 });
  vad.process(frame(0.3));
  vad.process(frame(0.3));
  assert.ok(vad.isActive);
  vad.reset();
  assert.equal(vad.isActive, false);
});

test("VAD rejects a non-positive sample rate", () => {
  assert.throws(() => new EnergyVad({ sampleRate: 0 }), /positive sample rate/);
});
