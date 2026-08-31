import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  CallRecorder,
  WAV_HEADER_BYTES,
  parseWavHeader,
  recordingPaths,
  safePathSegment,
  tee,
  wavHeaderMono16,
  type CallRecorderOptions,
  type RecordingMetadata,
} from "../src/recorder.js";
import { AudioPipeline, type AudioChunk } from "../src/pipeline.js";

const SAMPLE_RATE = 16000;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "neuracall-rec-"));
}

/** `ms` of Int16 mono PCM at 16 kHz. */
function speech(ms: number, freq = 440): Buffer {
  const frames = Math.round((ms / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.sin((2 * Math.PI * freq * f) / SAMPLE_RATE) * 0.5;
    buf.writeInt16LE(Math.round(v * 32767), f * 2);
  }
  return buf;
}

function newRecorder(dir: string, opts: Partial<CallRecorderOptions> = {}): CallRecorder {
  return new CallRecorder({
    baseDir: dir,
    deviceId: "192.168.1.44:5555",
    callId: "call-1",
    channelId: "cellular",
    sampleRate: SAMPLE_RATE,
    ...opts,
  });
}

test("a synthetic PCM buffer yields a valid WAV and its metadata sidecar", () => {
  const dir = scratch();
  try {
    const recorder = newRecorder(dir);
    const pcm = speech(500);
    recorder.write(pcm);
    const meta = recorder.close({ remoteParty: "+15551234567", direction: "inbound" });

    // The WAV parses and describes exactly the audio we wrote.
    const wav = readFileSync(recorder.wavPath);
    const header = parseWavHeader(wav);
    assert.equal(header.formatTag, 1, "PCM");
    assert.equal(header.channels, 1);
    assert.equal(header.sampleRate, SAMPLE_RATE);
    assert.equal(header.bitsPerSample, 16);
    assert.equal(header.blockAlign, 2);
    assert.equal(header.byteRate, SAMPLE_RATE * 2);
    assert.equal(header.dataBytes, pcm.length);
    assert.equal(header.frames, pcm.length / 2, "8000 samples for 500 ms at 16 kHz");
    assert.equal(header.dataOffset, WAV_HEADER_BYTES);
    assert.equal(wav.length, WAV_HEADER_BYTES + pcm.length);
    // RIFF size covers everything after the first 8 bytes.
    assert.equal(header.riffBytes, wav.length - 8);
    // The samples on disk are the ones we handed over, unmodified.
    assert.ok(wav.subarray(WAV_HEADER_BYTES).equals(pcm));

    // The sidecar describes the call.
    const sidecar = JSON.parse(readFileSync(recorder.metadataPath, "utf8")) as RecordingMetadata;
    assert.deepEqual(sidecar, meta);
    assert.equal(sidecar.version, 1);
    assert.equal(sidecar.deviceId, "192.168.1.44:5555");
    assert.equal(sidecar.callId, "call-1");
    assert.equal(sidecar.channelId, "cellular");
    assert.equal(sidecar.direction, "inbound");
    assert.equal(sidecar.remoteParty, "+15551234567");
    assert.equal(sidecar.bytes, pcm.length);
    assert.equal(sidecar.durationSeconds, 0.5);
    assert.equal(sidecar.truncated, false);
    assert.equal(sidecar.channels, 1);
    assert.equal(sidecar.bitsPerSample, 16);
    assert.ok(Date.parse(sidecar.startedAt) <= Date.parse(sidecar.endedAt));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the file on disk is a playable WAV mid-call, before close", () => {
  const dir = scratch();
  try {
    // Flush on every write so the header is patched as audio arrives.
    const recorder = newRecorder(dir, { flushBytes: 1, flushIntervalMs: 0 });
    recorder.write(speech(200));

    // Simulate the process dying here: whatever is on disk must still parse.
    const partial = parseWavHeader(readFileSync(recorder.wavPath));
    assert.equal(partial.dataBytes, 200 * (SAMPLE_RATE / 1000) * 2);
    assert.equal(partial.frames, 3200);

    recorder.write(speech(200));
    const later = parseWavHeader(readFileSync(recorder.wavPath));
    assert.equal(later.frames, 6400, "the header tracks the growing file");
    recorder.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the recording is capped at maxSeconds instead of filling the disk", () => {
  const dir = scratch();
  try {
    const hits: number[] = [];
    const recorder = newRecorder(dir, {
      maxSeconds: 0.1, // 1600 samples = 3200 bytes
      onMaxDuration: (r) => hits.push(r.bytes),
    });

    assert.equal(recorder.write(speech(50)), true, "under the cap");
    assert.equal(recorder.write(speech(200)), false, "the chunk crossing the cap is trimmed");
    assert.equal(recorder.write(speech(50)), false, "later writes are refused");

    assert.equal(recorder.truncated, true);
    assert.equal(recorder.bytes, 3200);
    assert.equal(hits.length, 1, "onMaxDuration fires once");

    const meta = recorder.close();
    assert.equal(meta.truncated, true);
    assert.equal(meta.bytes, 3200);
    assert.equal(meta.durationSeconds, 0.1);
    assert.equal(parseWavHeader(readFileSync(recorder.wavPath)).frames, 1600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an odd trailing byte is held back rather than shifting every later sample", () => {
  const dir = scratch();
  try {
    const recorder = newRecorder(dir);
    // Split a 4-byte (2-sample) run across two writes on an odd boundary.
    recorder.write(Buffer.from([0x01, 0x02, 0x03]));
    assert.equal(recorder.bytes, 2, "the dangling half-sample is not counted yet");
    recorder.write(Buffer.from([0x04]));
    assert.equal(recorder.bytes, 4);

    recorder.close();
    const wav = readFileSync(recorder.wavPath);
    assert.equal(parseWavHeader(wav).frames, 2);
    assert.ok(wav.subarray(WAV_HEADER_BYTES).equals(Buffer.from([0x01, 0x02, 0x03, 0x04])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable destination fails loudly at construction", () => {
  const dir = scratch();
  try {
    const locked = join(dir, "locked");
    writeFileSync(join(dir, "placeholder"), "x");
    chmodSync(dir, 0o500); // read + execute, no write
    assert.throws(
      () => newRecorder(locked),
      /recordings directory is not writable|cannot create/,
    );
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call id that collides with an existing recording is refused", () => {
  const dir = scratch();
  try {
    const first = newRecorder(dir);
    first.close();
    // Overwriting would destroy an existing call's audio.
    assert.throws(() => newRecorder(dir), /cannot create/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close is idempotent and refuses later writes", () => {
  const dir = scratch();
  try {
    const recorder = newRecorder(dir);
    recorder.write(speech(100));
    const first = recorder.close();
    const second = recorder.close();
    assert.equal(first, second, "the same metadata is returned");
    assert.equal(recorder.closed, true);
    assert.throws(() => recorder.write(speech(10)), /write after close/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the recorded WAV holds exactly the audio that was sent to STT", () => {
  const dir = scratch();
  try {
    const recorder = newRecorder(dir);
    const toStt: Buffer[] = [];
    const sttSink = new Writable({
      objectMode: true,
      write(chunk: AudioChunk, _enc, cb) {
        toStt.push(Buffer.from(chunk.pcm));
        cb();
      },
    });

    // One pipeline output feeding both the live transcript and the recording.
    const fanout = tee([sttSink, recorder.createWritable({ closeOnFinish: false })]);
    const pipeline = new AudioPipeline(
      { inputSampleRate: 48000, inputChannels: 2, targetSampleRate: SAMPLE_RATE },
      fanout,
    );

    // 48 kHz stereo in, as scrcpy delivers it.
    const frames = 48000;
    const stereo = Buffer.alloc(frames * 2 * 2);
    for (let f = 0; f < frames; f++) {
      const s = Math.round(Math.sin((2 * Math.PI * 440 * f) / 48000) * 0.5 * 32767);
      stereo.writeInt16LE(s, f * 4);
      stereo.writeInt16LE(s, f * 4 + 2);
    }
    pipeline.push(stereo);
    pipeline.end();
    recorder.close();

    const transcribed = Buffer.concat(toStt);
    assert.ok(transcribed.length > 0, "audio reached the STT path");
    const wav = readFileSync(recorder.wavPath);
    assert.equal(parseWavHeader(wav).dataBytes, transcribed.length);
    assert.ok(
      wav.subarray(WAV_HEADER_BYTES).equals(transcribed),
      "the recording is byte-identical to what was transcribed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chunk at the wrong sample rate errors instead of recording at the wrong speed", async () => {
  const dir = scratch();
  try {
    const recorder = newRecorder(dir);
    const writable = recorder.createWritable();
    // Streams surface a failed write on the next tick, not inline.
    const failure = new Promise<Error>((resolve) => writable.once("error", resolve));

    writable.write({
      sampleRate: 48000,
      pcm: speech(20),
      utteranceStart: true,
      utteranceEnd: false,
    } satisfies AudioChunk);

    const err = await failure;
    assert.match(err.message, /chunk sample rate 48000 != recorder 16000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordings land in a private per-device directory", () => {
  const dir = scratch();
  try {
    const recorder = newRecorder(dir);
    recorder.close();

    const paths = recordingPaths(dir, "192.168.1.44:5555", "call-1");
    assert.equal(recorder.wavPath, paths.wavPath);
    assert.equal(recorder.metadataPath, paths.metadataPath);
    // The ip:port is sanitised into one safe path segment.
    assert.match(recorder.wavPath, /recordings[/\\]192\.168\.1\.44_5555[/\\]call-1\.wav$/);

    if (process.platform !== "win32") {
      assert.equal(statSync(recorder.dir).mode & 0o777, 0o700);
      assert.equal(statSync(recorder.wavPath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ids that cannot form a filename are rejected rather than escaping the directory", () => {
  assert.equal(safePathSegment("192.168.1.44:5555"), "192.168.1.44_5555");
  assert.equal(safePathSegment("../../etc/passwd"), ".._.._etc_passwd");
  assert.throws(() => safePathSegment("..", "callId"), /cannot be used as a file name/);
  assert.throws(() => safePathSegment("", "deviceId"), /cannot be used as a file name/);
});

test("wavHeaderMono16 round-trips through parseWavHeader", () => {
  const header = wavHeaderMono16(8000, 1234);
  assert.equal(header.length, WAV_HEADER_BYTES);
  const parsed = parseWavHeader(header);
  assert.equal(parsed.sampleRate, 8000);
  assert.equal(parsed.dataBytes, 1234);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.byteRate, 16000);
});

test("parseWavHeader rejects things that are not PCM WAVs", () => {
  assert.throws(() => parseWavHeader(Buffer.from("not a wav at all")), /not a RIFF\/WAVE/);
  const noData = Buffer.concat([wavHeaderMono16(16000, 0).subarray(0, 36)]);
  assert.throws(() => parseWavHeader(noData), /no data chunk/);
});
