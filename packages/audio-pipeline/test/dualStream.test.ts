import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  CallAudioSession,
  LocalOutStream,
  MemoryAudioInjector,
  RemoteInStream,
  STREAM_DIRECTIONS,
  type CallAudioChunk,
} from "../src/dualStream.js";

const CALL = { deviceId: "192.168.1.44:5555", callId: "call-1", channelId: "cellular" };

/** Collects every labelled chunk the pipeline emits. */
function collector(): { sink: Writable; chunks: CallAudioChunk[] } {
  const chunks: CallAudioChunk[] = [];
  const sink = new Writable({
    objectMode: true,
    write(chunk: CallAudioChunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return { sink, chunks };
}

/**
 * Synthesize a sine as Int16 LE PCM. `freq: 0` gives digital silence, which
 * the VAD must gate out.
 */
function tone(
  ms: number,
  opts: { freq?: number; rate?: number; channels?: 1 | 2; amplitude?: number } = {},
): Buffer {
  const rate = opts.rate ?? 48000;
  const channels = opts.channels ?? 2;
  const amplitude = opts.amplitude ?? 0.5;
  const freq = opts.freq ?? 0;
  const frames = Math.round((ms / 1000) * rate);
  const buf = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    const v = freq === 0 ? 0 : Math.sin((2 * Math.PI * freq * f) / rate) * amplitude;
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    for (let c = 0; c < channels; c++) buf.writeInt16LE(s, (f * channels + c) * 2);
  }
  return buf;
}

/**
 * A stand-in speech recogniser that genuinely decodes the audio it is given,
 * so the test proves far-end audio reaches STT *intact* rather than merely
 * that some bytes arrived. Words are encoded as tones; the recogniser
 * estimates each utterance's frequency by counting zero crossings and looks it
 * up in the codebook — the audio equivalent of an echo test.
 */
const CODEBOOK: Array<{ freq: number; word: string }> = [
  { freq: 400, word: "hello" },
  { freq: 800, word: "world" },
];

class ToneRecognizer {
  readonly received: CallAudioChunk[] = [];

  get sink(): Writable {
    return new Writable({
      objectMode: true,
      write: (chunk: CallAudioChunk, _enc, cb) => {
        this.received.push(chunk);
        cb();
      },
    });
  }

  /** Group the chunks into utterances and decode each into a word. */
  transcribe(): string {
    const words: string[] = [];
    let current: CallAudioChunk[] = [];
    for (const chunk of this.received) {
      if (chunk.utteranceStart && current.length > 0) {
        words.push(decode(current));
        current = [];
      }
      current.push(chunk);
      if (chunk.utteranceEnd) {
        words.push(decode(current));
        current = [];
      }
    }
    if (current.length > 0) words.push(decode(current));
    return words.join(" ");
  }
}

/**
 * Nearest codebook word for a run of chunks, by zero-crossing frequency.
 * The VAD holds an utterance open through its hangover, so a run ends with
 * silent chunks; they carry no pitch and are dropped before estimating, the
 * way a real recogniser would not measure silence.
 */
function decode(chunks: CallAudioChunk[]): string {
  const voiced = chunks.filter((c) => peak(c.pcm) > 1000);
  const pcm = Buffer.concat((voiced.length > 0 ? voiced : chunks).map((c) => Buffer.from(c.pcm)));
  const rate = chunks[0]!.sampleRate;
  const samples = Math.floor(pcm.length / 2);
  let crossings = 0;
  let prev = pcm.readInt16LE(0);
  for (let i = 1; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    prev = s;
  }
  const seconds = samples / rate;
  const freq = crossings / 2 / seconds;
  let best = CODEBOOK[0]!;
  for (const entry of CODEBOOK) {
    if (Math.abs(entry.freq - freq) < Math.abs(best.freq - freq)) best = entry;
  }
  return best.word;
}

/** Largest absolute sample in an Int16 LE buffer. */
function peak(pcm: Uint8Array): number {
  const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let max = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    max = Math.max(max, Math.abs(buf.readInt16LE(i)));
  }
  return max;
}

test("a call session exposes exactly the two labelled streams", () => {
  const { sink } = collector();
  const session = new CallAudioSession({ ...CALL, sink });

  assert.deepEqual([...STREAM_DIRECTIONS], ["remoteIn", "localOut"]);
  assert.equal(session.remoteIn.direction, "remoteIn");
  assert.equal(session.localOut.direction, "localOut");
  assert.ok(session.remoteIn instanceof RemoteInStream);
  assert.ok(session.localOut instanceof LocalOutStream);

  // Addressable by label, and each stream knows which call it belongs to.
  assert.equal(session.stream("remoteIn"), session.remoteIn);
  assert.equal(session.stream("localOut"), session.localOut);
  for (const dir of STREAM_DIRECTIONS) {
    const stream = session.stream(dir);
    assert.equal(stream.direction, dir);
    assert.equal(stream.deviceId, CALL.deviceId);
    assert.equal(stream.callId, CALL.callId);
    assert.equal(stream.channelId, CALL.channelId);
  }
});

test("remoteIn is structurally a scrcpy PcmSink", () => {
  const { sink } = collector();
  const session = new CallAudioSession({ ...CALL, sink });
  // ScrcpyBridge calls exactly these three on its sink.
  assert.equal(typeof session.remoteIn.format, "function");
  assert.equal(typeof session.remoteIn.push, "function");
  assert.equal(typeof session.remoteIn.end, "function");
});

test("remoteIn chunks are labelled, mono 16 kHz, and sequenced", () => {
  const { sink, chunks } = collector();
  const session = new CallAudioSession({ ...CALL, sink });
  session.remoteIn.format({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
  session.remoteIn.push(tone(600, { freq: 400 }));

  assert.ok(chunks.length >= 6, `expected >= 6 chunks, got ${chunks.length}`);
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.direction, "remoteIn");
    assert.equal(chunk.deviceId, CALL.deviceId);
    assert.equal(chunk.callId, CALL.callId);
    assert.equal(chunk.channelId, CALL.channelId);
    assert.equal(chunk.sampleRate, 16000);
    assert.equal(chunk.seq, i);
    // 100 ms of mono Int16 at 16 kHz.
    assert.equal(chunk.pcm.length, 3200);
  });
  assert.equal(chunks[0]!.utteranceStart, true);
});

test("remoteIn gates silence out of the STT path", () => {
  const { sink, chunks } = collector();
  const session = new CallAudioSession({ ...CALL, sink });
  session.remoteIn.format({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
  session.remoteIn.push(tone(1000, { freq: 0 }));

  assert.equal(chunks.length, 0);
  assert.ok(session.remoteIn.bytesReceived > 0, "silence still reached the stream");
});

test("audio fed into remoteIn arrives at STT intact and decodes to the spoken words", () => {
  const stt = new ToneRecognizer();
  const session = new CallAudioSession({ ...CALL, sink: stt.sink });
  session.remoteIn.format({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });

  // "hello", a pause long enough to end the turn, then "world".
  session.remoteIn.push(tone(500, { freq: 400 }));
  session.remoteIn.push(tone(700, { freq: 0 }));
  session.remoteIn.push(tone(500, { freq: 800 }));
  session.remoteIn.push(tone(700, { freq: 0 }));
  session.remoteIn.end();

  assert.equal(stt.transcribe(), "hello world");
  assert.ok(
    stt.received.every((c) => c.direction === "remoteIn"),
    "the agent's own audio must never enter the STT path",
  );
});

test("remoteIn rebuilds the pipeline when the source renegotiates its rate", () => {
  const { sink, chunks } = collector();
  const session = new CallAudioSession({ ...CALL, sink });

  session.remoteIn.format({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
  session.remoteIn.push(tone(400, { freq: 400 }));
  const afterFirst = chunks.length;

  session.remoteIn.format({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
  assert.deepEqual(session.remoteIn.captureFormat, {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
  });

  session.remoteIn.push(tone(400, { freq: 400, rate: 16000, channels: 1 }));
  assert.ok(chunks.length > afterFirst, "audio kept flowing after the format change");
  // Still emitting at the STT rate, whatever the source does.
  assert.ok(chunks.every((c) => c.sampleRate === 16000));
});

test("remoteIn rejects a format it cannot decode instead of emitting noise", () => {
  const { sink } = collector();
  const errors: Error[] = [];
  const session = new CallAudioSession({
    ...CALL,
    sink,
    remoteIn: { onFormatError: (err) => errors.push(err) },
  });

  session.remoteIn.format({ sampleRate: 44100, channels: 2, bitsPerSample: 24 });

  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /24-bit/);
  assert.ok(session.remoteIn.formatError);
  // The bad format was not adopted.
  assert.equal(session.remoteIn.captureFormat.sampleRate, 48000);
});

test("localOut converts agent audio to the injector's format", () => {
  const injector = new MemoryAudioInjector({ sampleRate: 8000, channels: 1 });
  const session = new CallAudioSession({ ...CALL, sink: collector().sink, localOut: { injector } });

  // 100 ms of 16 kHz mono TTS -> 100 ms of 8 kHz mono, so half the bytes.
  session.localOut.speak(tone(100, { freq: 400, rate: 16000, channels: 1 }), {
    sampleRate: 16000,
    channels: 1,
  });

  assert.equal(injector.bytes, 1600);
  assert.equal(session.localOut.bytesWritten, 1600);
});

test("localOut passes PCM through untouched when it already matches the injector", () => {
  const injector = new MemoryAudioInjector({ sampleRate: 16000, channels: 1 });
  const session = new CallAudioSession({ ...CALL, sink: collector().sink, localOut: { injector } });
  const pcm = tone(100, { freq: 400, rate: 16000, channels: 1 });

  session.localOut.speak(pcm, { sampleRate: 16000, channels: 1 });

  assert.ok(injector.pcm.equals(pcm));
});

test("the agent counts as speaking until its audio has actually played out", () => {
  let clock = 10_000;
  const injector = new MemoryAudioInjector({ sampleRate: 16000, channels: 1 });
  const session = new CallAudioSession({
    ...CALL,
    sink: collector().sink,
    localOut: { injector, now: () => clock },
  });
  const out = session.localOut;

  const generation = out.beginUtterance();
  // One second of speech, written in a few microseconds.
  out.speak(tone(1000, { freq: 400, rate: 16000, channels: 1 }), {
    sampleRate: 16000,
    channels: 1,
    generation,
  });
  out.endUtterance();

  // Writing is finished, but the caller has heard none of it yet — barge-in
  // must still be possible.
  assert.equal(out.isSpeaking, true);
  assert.equal(out.pendingPlaybackMs, 1000);

  clock += 400;
  assert.equal(out.isSpeaking, true);
  assert.equal(out.pendingPlaybackMs, 600);

  clock += 700; // past the end of the audio
  assert.equal(out.isSpeaking, false);
  assert.equal(out.pendingPlaybackMs, 0);
});

test("queued agent audio plays back to back rather than overlapping", () => {
  const clock = 10_000;
  const injector = new MemoryAudioInjector({ sampleRate: 16000, channels: 1 });
  const session = new CallAudioSession({
    ...CALL,
    sink: collector().sink,
    localOut: { injector, now: () => clock },
  });
  const out = session.localOut;
  const speech = tone(500, { freq: 400, rate: 16000, channels: 1 });

  out.beginUtterance();
  out.speak(speech, { sampleRate: 16000, channels: 1 });
  out.speak(speech, { sampleRate: 16000, channels: 1 });

  // Two half-second chunks queued at the same instant take a full second.
  assert.equal(out.pendingPlaybackMs, 1000);
});

test("barge-in cancels the agent and drops audio from the interrupted utterance", () => {
  const injector = new MemoryAudioInjector({ sampleRate: 16000, channels: 1 });
  const session = new CallAudioSession({ ...CALL, sink: collector().sink, localOut: { injector } });
  const out = session.localOut;

  const generation = out.beginUtterance();
  assert.equal(out.isSpeaking, true);
  out.speak(tone(100, { freq: 400, rate: 16000, channels: 1 }), {
    sampleRate: 16000,
    channels: 1,
    generation,
  });
  assert.ok(injector.bytes > 0);

  // The caller talks over the agent.
  out.cancel();
  assert.equal(out.isSpeaking, false);
  assert.equal(injector.cancelCount, 1);
  assert.equal(injector.bytes, 0, "queued agent audio was dropped");

  // TTS for the interrupted utterance keeps arriving; it must not be played.
  const accepted = out.speak(tone(100, { freq: 400, rate: 16000, channels: 1 }), {
    sampleRate: 16000,
    channels: 1,
    generation,
  });
  assert.equal(accepted, false);
  assert.equal(injector.bytes, 0);

  // The reply to what the caller just said plays normally.
  const next = out.beginUtterance();
  assert.notEqual(next, generation);
  assert.equal(
    out.speak(tone(100, { freq: 800, rate: 16000, channels: 1 }), {
      sampleRate: 16000,
      channels: 1,
      generation: next,
    }),
    true,
  );
  assert.ok(injector.bytes > 0);
});

test("closing a session ends both directions and is idempotent", () => {
  const injector = new MemoryAudioInjector();
  const { sink } = collector();
  const session = new CallAudioSession({ ...CALL, sink, localOut: { injector } });

  session.close();
  session.close();

  assert.equal(session.closed, true);
  assert.equal(session.remoteIn.closed, true);
  assert.equal(session.localOut.closed, true);
  assert.equal(injector.closed, true);
  assert.throws(() => session.remoteIn.push(tone(20, { freq: 400 })), /push after end/);
  assert.equal(session.localOut.speak(Buffer.alloc(320)), false);
});
