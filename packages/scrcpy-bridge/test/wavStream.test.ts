import { test } from "node:test";
import assert from "node:assert/strict";
import { WavStreamReader, wavHeader } from "../src/wavStream.js";

const FMT = { channels: 2, sampleRate: 48000, bitsPerSample: 16 };

function collect(reader: WavStreamReader, chunks: Buffer[]): { pcm: Buffer; formatSeen: number } {
  const out: Uint8Array[] = [];
  let formatSeen = 0;
  for (const c of chunks) {
    const r = reader.push(c);
    if (r.format) formatSeen++;
    out.push(...r.frames);
  }
  return { pcm: Buffer.concat(out.map((u) => Buffer.from(u))), formatSeen };
}

test("parses header then streams PCM from a single chunk", () => {
  const reader = new WavStreamReader();
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  const { pcm: got, formatSeen } = collect(reader, [Buffer.concat([wavHeader(FMT), pcm])]);
  assert.deepEqual([...got], [...pcm]);
  assert.equal(formatSeen, 1);
  assert.deepEqual(reader.format, {
    formatTag: 1,
    channels: 2,
    sampleRate: 48000,
    bitsPerSample: 16,
    blockAlign: 4,
  });
  assert.ok(reader.streaming);
});

test("header split across many tiny chunks still syncs", () => {
  const reader = new WavStreamReader();
  const all = Buffer.concat([wavHeader(FMT), Buffer.from([9, 8, 7, 6])]);
  const chunks: Buffer[] = [];
  for (let i = 0; i < all.length; i += 3) chunks.push(all.subarray(i, i + 3));
  const { pcm, formatSeen } = collect(reader, chunks);
  assert.deepEqual([...pcm], [9, 8, 7, 6]);
  assert.equal(formatSeen, 1);
});

test("ignores text before the RIFF signature (scrcpy banner / adb output)", () => {
  const reader = new WavStreamReader();
  const junk = Buffer.from("/usr/share/scrcpy/scrcpy-server: 1 file pushed\nscrcpy 3.3.4 <https://…>\n");
  const { pcm } = collect(reader, [junk, wavHeader(FMT), Buffer.from([1, 1])]);
  assert.deepEqual([...pcm], [1, 1]);
});

test("skips unknown chunks (LIST/INFO) between fmt and data, honouring padding", () => {
  const reader = new WavStreamReader();
  const header = wavHeader(FMT);
  const fmtPart = header.subarray(0, 36); // RIFF…fmt chunk
  const list = Buffer.alloc(8 + 5 + 1); // odd-sized chunk => 1 pad byte
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(5, 4);
  const data = header.subarray(36); // "data" + size
  const { pcm } = collect(reader, [fmtPart, list, data, Buffer.from([4, 2])]);
  assert.deepEqual([...pcm], [4, 2]);
});

test("placeholder data size (0xFFFFFFFF) is ignored and PCM flows until EOF", () => {
  const reader = new WavStreamReader();
  const { pcm } = collect(reader, [
    wavHeader(FMT, 0xffffffff),
    Buffer.alloc(10, 1),
    Buffer.alloc(10, 2),
  ]);
  assert.equal(pcm.length, 20);
});

test("fails cleanly on a data chunk before fmt", () => {
  const reader = new WavStreamReader();
  const bad = Buffer.alloc(20);
  bad.write("RIFF", 0, "ascii");
  bad.write("WAVE", 8, "ascii");
  bad.write("data", 12, "ascii");
  const r = reader.push(bad);
  assert.equal(r.frames.length, 0);
  assert.match(reader.error!, /before fmt/);
  // further pushes are dropped
  assert.equal(reader.push(Buffer.from([1, 2])).frames.length, 0);
});

test("non-WAVE RIFF is skipped and a later real WAV syncs", () => {
  const reader = new WavStreamReader();
  const fake = Buffer.from("RIFFxxxxAVI ", "ascii");
  const { pcm } = collect(reader, [fake, wavHeader(FMT), Buffer.from([7])]);
  assert.deepEqual([...pcm], [7]);
});

test("reset returns to sync state", () => {
  const reader = new WavStreamReader();
  collect(reader, [wavHeader(FMT), Buffer.from([1])]);
  reader.reset();
  assert.equal(reader.format, null);
  assert.equal(reader.streaming, false);
});
