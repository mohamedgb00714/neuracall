import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { AudioPipeline, type AudioChunk } from "../src/pipeline.js";

function collect(): { out: Writable; chunks: AudioChunk[] } {
  const chunks: AudioChunk[] = [];
  const out = new Writable({
    objectMode: true,
    write(chunk: AudioChunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return { out, chunks };
}

/** Sine buffer at 0.5 amplitude so RMS is well above VAD threshold. */
function sine(samples: number, amplitude = 16000): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    b.writeInt16LE(Math.round(amplitude * Math.sin(i / 10)), i * 2);
  }
  return b;
}

const SILENCE = Buffer.alloc(1600 * 2); // 100ms zeros @16k mono
// 100ms chunk at 16k = 1600 samples. Feed 3 chunks (300ms) of speech.
const SPEECH_3 = sine(1600 * 3, 16000);

test("pipeline emits fixed-size speech chunks and flags utterance boundaries", () => {
  const { out, chunks } = collect();
  const p = new AudioPipeline(
    {
      inputSampleRate: 16000,
      inputChannels: 1,
      chunkMs: 100,
      vadThreshold: 0.01,
      vadStartMs: 40,
      vadHangoverMs: 20,
    },
    out,
  );
  // 300ms speech, then 300ms silence. A 20ms hangover closes the utterance
  // within the first silent chunk, so the trailing silence is gated and the
  // last emitted speech chunk is flagged as the utterance end.
  p.push(SPEECH_3);
  p.push(SILENCE);
  p.push(SILENCE);
  p.push(SILENCE);
  p.end();

  assert.ok(chunks.length > 0, "expected speech chunks to be emitted");
  assert.equal(chunks[0]!.pcm.length, 1600 * 2, "chunks are 100ms @16k mono");
  assert.equal(chunks[0]!.utteranceStart, true, "first voice chunk starts an utterance");
  // After hangover closes the run, the last emitted speech chunk is the tail.
  const lastSpeech = chunks[chunks.length - 1]!;
  assert.equal(lastSpeech.utteranceEnd, true);
});

test("pipeline gates away pure silence when emitSilence is false", () => {
  const { out, chunks } = collect();
  const p = new AudioPipeline(
    { inputSampleRate: 16000, inputChannels: 1, chunkMs: 100, vadThreshold: 0.01 },
    out,
  );
  p.push(SILENCE);
  p.push(SILENCE);
  p.end();
  assert.equal(chunks.length, 0);
});

test("pipeline resamples stereo 44.1k input to mono 16k output", () => {
  const { out, chunks } = collect();
  const p = new AudioPipeline(
    {
      inputSampleRate: 44100,
      inputChannels: 2,
      targetSampleRate: 16000,
      chunkMs: 100,
      vadThreshold: 0.01,
    },
    out,
  );
  // 44100 frames of stereo 44.1k Int16 = 44100 * 2ch * 2bytes = 176400 bytes
  const stereo = Buffer.alloc(44100 * 2 * 2);
  for (let i = 0; i < 44100; i++) {
    stereo.writeInt16LE(Math.round(20000 * Math.sin(i / 20)), i * 2 * 2); // left
    stereo.writeInt16LE(Math.round(20000 * Math.sin(i / 20)), (i * 2 + 1) * 2); // right
  }
  p.push(stereo);
  p.end();

  // 44100 -> 16000 resample = 16000 mono samples => 10 chunks of 1600 samples
  assert.equal(chunks.length, 10);
  for (const c of chunks) assert.equal(c.sampleRate, 16000);
});

test("VAD gates output for a loud-but-flat (non-speech) signal", () => {
  // A constant high DC offset has near-zero RMS over the frame, so it is
  // treated as silence — we measure energy, not instantaneous amplitude.
  const { out, chunks } = collect();
  const p = new AudioPipeline(
    { inputSampleRate: 16000, inputChannels: 1, chunkMs: 100, vadThreshold: 0.01 },
    out,
  );
  const flatLoud = Buffer.alloc(1600 * 2);
  for (let i = 0; i < 1600; i++) flatLoud.writeInt16LE(30000, i * 2);
  p.push(flatLoud);
  p.end();
  assert.equal(chunks.length, 0);
});

test("emitSilence=true still resets the utterance when silence returns (no unbroken utterance)", () => {
  // Regression: with emitSilence=true (the default in the orchestrator) *every*
  // frame is emitted, so the old `else if (inUtterance && !active)` end-detection
  // was unreachable — inUtterance stayed true forever and consumers saw a single
  // never-ending utterance. emitSilence must not defeat turn endpointing.
  const { out, chunks } = collect();
  const p = new AudioPipeline(
    {
      inputSampleRate: 16000,
      inputChannels: 1,
      chunkMs: 100,
      vadThreshold: 0.01,
      vadStartMs: 40,
      vadHangoverMs: 20,
      emitSilence: true,
    },
    out,
  );
  // 300ms of speech, then 300ms of silence, then another 300ms of speech.
  p.push(SPEECH_3); // 3 speech chunks
  p.push(SILENCE); // 1
  p.push(SILENCE); // 1
  p.push(SILENCE); // 1
  p.push(SPEECH_3); // 3
  p.push(SILENCE); // 1
  p.push(SILENCE); // 1
  p.push(SILENCE); // 1
  p.end();

  // With emitSilence every 100ms frame is emitted and counted.
  assert.equal(chunks.length, 12, "all 1200ms of frames are emitted");
  assert.equal(chunks[0]!.utteranceStart, true, "first voice chunk starts an utterance");

  // The hangover closes the first utterance *on a silent chunk*, so the last
  // speech chunk of run one carries utteranceEnd. Two runs must produce exactly
  // two utterance ends — the second run proves inUtterance was reset rather
  // than left stuck from the first.
  const ends = chunks.filter((c) => c.utteranceEnd).length;
  const starts = chunks.filter((c) => c.utteranceStart).length;
  assert.equal(starts, 2, "each run starts an utterance exactly once");
  assert.equal(ends, 2, "each run ends an utterance exactly once — inUtterance resets");

  // Run two starts on the first speech chunk after the interleaving silence.
  const firstStart = chunks.findIndex((c) => c.utteranceStart);
  const secondStart = chunks.findIndex((c, i) => i > firstStart && c.utteranceStart);
  assert.equal(secondStart, 6, "run two starts right after the 3-chunk silence");
});
