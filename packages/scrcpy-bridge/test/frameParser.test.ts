import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ScrcpyFrameReader,
  SCRCPY_FRAME_HEADER_SIZE,
} from "../src/frameParser.js";

/** Build a single scrcpy audio frame: 12-byte header + payload. */
function buildFrame(payload: number[], pts = 0, config = false): Buffer {
  const header = Buffer.alloc(SCRCPY_FRAME_HEADER_SIZE);
  let b0 = 0x80; // media packet
  if (config) b0 |= 0x40;
  // PTS (61-bit, big-endian, top 5 bits in byte 0 low bits):
  if (pts !== 0) b0 |= (pts >>> 56) & 0x1f;
  header[0] = b0;
  let p = pts;
  for (let i = 7; i >= 1; i--) {
    header[i] = p & 0xff;
    p = Math.floor(p / 256);
  }
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, Buffer.from(payload)]);
}

test("parser yields one raw audio frame from a complete packet", () => {
  const reader = new ScrcpyFrameReader();
  const pcm = [1, 2, 3, 4, 5, 6]; // 6 bytes PCM
  const frame = buildFrame(pcm, 1234);
  const frames = reader.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.media, true);
  assert.equal(frames[0]!.config, false);
  assert.equal(frames[0]!.pts, 1234);
  assert.deepEqual([...frames[0]!.payload], pcm);
});

test("parser handles a frame split across multiple chunks", () => {
  const reader = new ScrcpyFrameReader();
  const frame = buildFrame([9, 8, 7, 6, 5]);
  const mid = Math.floor(frame.length / 2);
  assert.equal(reader.push(frame.subarray(0, mid)).length, 0);
  assert.ok(reader.bufferedBytes > 0);
  const frames = reader.push(frame.subarray(mid));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!.payload], [9, 8, 7, 6, 5]);
});

test("parser separates two back-to-back frames in one chunk", () => {
  const reader = new ScrcpyFrameReader();
  const a = buildFrame([1, 1, 1], 10);
  const b = buildFrame([2, 2], 20);
  const frames = reader.push(Buffer.concat([a, b]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.pts, 10);
  assert.equal(frames[1]!.pts, 20);
  assert.deepEqual([...frames[1]!.payload], [2, 2]);
});

test("parser skips a configuration packet but yields media payload", () => {
  const reader = new ScrcpyFrameReader();
  const cfg = buildFrame([], 0, true);
  const audio = buildFrame([5, 5, 5], 5);
  const frames = reader.push(Buffer.concat([cfg, audio]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.config, true);
  assert.equal(frames[1]!.config, false);
});

test("passthrough mode returns the raw bytes as one frame", () => {
  const reader = new ScrcpyFrameReader({ passthrough: true });
  const frames = reader.push(Uint8Array.from([7, 7, 7]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!.payload], [7, 7, 7]);
});

test("parser does not emit anything for an incomplete header", () => {
  const reader = new ScrcpyFrameReader();
  const frames = reader.push(Uint8Array.from([0x80, 0, 0]));
  assert.equal(frames.length, 0);
  assert.equal(reader.bufferedBytes, 3);
});
