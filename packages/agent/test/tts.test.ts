import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { wavHeaderMono16 } from "@neuracall/audio-pipeline";
import type { AppConfig } from "@neuracall/config";
import { SilentTts } from "../src/tts.js";
import {
  CommandTts,
  ElevenLabsTts,
  OpenAiCompatibleTts,
  createTtsClient,
  decodeWav,
  detectTtsCommand,
  elevenLabsOutputRate,
  selectTtsClient,
  type TtsChild,
  type TtsSpawn,
} from "../src/ttsProviders.js";

const KEY = "sk-secret-key";

// --------------------------------------------------------------- fetch fakes

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A `fetch` that records every call and answers from `handler`. */
function fakeFetch(handler: FetchHandler): { fetchFn: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchFn = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** A `fetch` that never answers, so only the signal can end the request. */
const hangingFetch = ((_input: unknown, init: RequestInit = {}) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as unknown as typeof fetch;

/** Int16 LE PCM of `samples` samples, every one equal to `value`. */
function constantPcm(samples: number, value: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

function audioResponse(pcm: Buffer): Response {
  const body = new Uint8Array(pcm.byteLength);
  body.set(pcm);
  return new Response(body.buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": "audio/pcm" },
  });
}

function bodyOf(call: RecordedRequest | undefined): Record<string, unknown> {
  assert.ok(call, "expected a request to have been made");
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headersOf(call: RecordedRequest | undefined): Record<string, string> {
  assert.ok(call, "expected a request to have been made");
  return (call.init.headers ?? {}) as Record<string, string>;
}

// --------------------------------------------------------------- spawn fakes

/** The bits of a child process `CommandTts` touches. */
class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly signals: string[] = [];
  private readonly written: Buffer[] = [];

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.written.push(Buffer.from(chunk));
        cb();
      },
    });
  }

  get stdinText(): string {
    return Buffer.concat(this.written).toString();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

interface SpawnCall {
  cmd: string;
  args: string[];
  child: FakeChild;
}

/**
 * A spawner whose `onSpawn` stands in for the engine. It runs on a later tick
 * so `CommandTts` has attached its listeners first, exactly as a real process
 * would behave.
 */
function fakeSpawn(onSpawn: (call: SpawnCall) => void): { spawnFn: TtsSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnFn: TtsSpawn = (cmd, args) => {
    const child = new FakeChild();
    const call: SpawnCall = { cmd, args, child };
    calls.push(call);
    setImmediate(() => onSpawn(call));
    return child as unknown as TtsChild;
  };
  return { spawnFn, calls };
}

/** The `-w` / `--output_file` argument the engine is told to write. */
function outPathOf(args: string[]): string {
  const i = args.findIndex((a) => a === "-w" || a === "--output_file");
  const path = args[i + 1];
  assert.ok(path, `no output path in ${args.join(" ")}`);
  return path;
}

/** An engine that writes a mono WAV of `samples` constant samples and exits 0. */
function writesWav(rate: number, samples: number, value = 1000): (call: SpawnCall) => void {
  return ({ args, child }) => {
    const data = constantPcm(samples, value);
    writeFileSync(outPathOf(args), Buffer.concat([wavHeaderMono16(rate, data.length), data]));
    child.emit("close", 0, null);
  };
}

/** RIFF/WAVE header for interleaved 16-bit stereo (the mono writer only does 1ch). */
function stereoWav(rate: number, left: number[], right: number[]): Buffer {
  const frames = Math.min(left.length, right.length);
  const data = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) {
    data.writeInt16LE(left[f]!, f * 4);
    data.writeInt16LE(right[f]!, f * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function onlyOnPath(...installed: string[]): (binary: string) => boolean {
  return (binary) => installed.includes(binary);
}

function readInt16(pcm: Uint8Array, index: number): number {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).readInt16LE(index * 2);
}

// ------------------------------------------------------------ OpenAI-compatible

test("OpenAiCompatibleTts posts the documented body with a Bearer key", async () => {
  const { fetchFn, calls } = fakeFetch(() => audioResponse(constantPcm(240, 500)));
  const tts = new OpenAiCompatibleTts({
    apiKey: KEY,
    model: "gpt-4o-mini-tts",
    voice: "verse",
    sampleRate: 24000,
    fetchFn,
  });

  await tts.synthesize({ text: "  hello there  " });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headersOf(calls[0])["authorization"], `Bearer ${KEY}`);
  assert.deepEqual(bodyOf(calls[0]), {
    model: "gpt-4o-mini-tts",
    voice: "verse",
    input: "hello there",
    response_format: "pcm",
  });
});

test("OpenAiCompatibleTts honours a custom baseUrl and trims its trailing slash", async () => {
  const { fetchFn, calls } = fakeFetch(() => audioResponse(constantPcm(10, 1)));
  const tts = new OpenAiCompatibleTts({
    apiKey: KEY,
    model: "tts-1",
    baseUrl: "http://127.0.0.1:8080/v1/",
    fetchFn,
  });

  await tts.synthesize({ text: "hi" });

  assert.equal(calls[0]?.url, "http://127.0.0.1:8080/v1/audio/speech");
});

test("OpenAiCompatibleTts passes 24 kHz PCM straight through when that is what was asked for", async () => {
  const pcm = constantPcm(1200, -3000);
  const { fetchFn } = fakeFetch(() => audioResponse(pcm));
  const tts = new OpenAiCompatibleTts({ apiKey: KEY, model: "tts-1", sampleRate: 24000, fetchFn });

  const speech = await tts.synthesize({ text: "hi" });

  assert.equal(speech.sampleRate, 24000);
  assert.equal(speech.channels, 1);
  assert.deepEqual(Buffer.from(speech.pcm), pcm);
});

test("OpenAiCompatibleTts resamples 24 kHz down to the requested 16 kHz", async () => {
  const { fetchFn } = fakeFetch(() => audioResponse(constantPcm(2400, 1000)));
  const tts = new OpenAiCompatibleTts({ apiKey: KEY, model: "tts-1", fetchFn });

  const speech = await tts.synthesize({ text: "hi" });

  assert.equal(speech.sampleRate, 16000);
  assert.equal(speech.pcm.length, 1600 * 2, "0.1 s at 16 kHz");
  // A constant signal must survive resampling as the same constant.
  assert.ok(Math.abs(readInt16(speech.pcm, 800) - 1000) <= 2);
});

test("OpenAiCompatibleTts drops a half sample rather than shifting the stream", async () => {
  const { fetchFn } = fakeFetch(() =>
    audioResponse(Buffer.concat([constantPcm(3, 7), Buffer.of(0x01)])),
  );
  const tts = new OpenAiCompatibleTts({ apiKey: KEY, model: "tts-1", sampleRate: 24000, fetchFn });

  const speech = await tts.synthesize({ text: "hi" });

  assert.equal(speech.pcm.length, 6);
});

test("OpenAiCompatibleTts aborts the HTTP request when the caller interrupts", async () => {
  const controller = new AbortController();
  const tts = new OpenAiCompatibleTts({ apiKey: KEY, model: "tts-1", fetchFn: hangingFetch });

  const pending = tts.synthesize({ text: "a long reply", signal: controller.signal });
  controller.abort();

  await assert.rejects(pending);
});

test("OpenAiCompatibleTts discards audio that arrived after the interruption", async () => {
  const controller = new AbortController();
  const { fetchFn } = fakeFetch(() => {
    controller.abort();
    return audioResponse(constantPcm(100, 1));
  });
  const tts = new OpenAiCompatibleTts({ apiKey: KEY, model: "tts-1", fetchFn });

  await assert.rejects(tts.synthesize({ text: "hi", signal: controller.signal }));
});

test("OpenAiCompatibleTts reports a failed request without leaking the key", async () => {
  const { fetchFn } = fakeFetch(
    () => new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" }),
  );
  const tts = new OpenAiCompatibleTts({ apiKey: KEY, model: "tts-1", fetchFn });

  await assert.rejects(tts.synthesize({ text: "hi" }), (err: Error) => {
    assert.match(err.message, /429/);
    assert.match(err.message, /quota exceeded/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test("OpenAiCompatibleTts never calls the API for empty text", async () => {
  const { fetchFn, calls } = fakeFetch(() => audioResponse(constantPcm(10, 1)));
  const tts = new OpenAiCompatibleTts({ apiKey: KEY, model: "tts-1", fetchFn });

  const speech = await tts.synthesize({ text: "   " });

  assert.equal(calls.length, 0);
  assert.equal(speech.pcm.length, 0);
  assert.equal(speech.sampleRate, 16000);
});

test("OpenAiCompatibleTts requires a key and a model", () => {
  assert.throws(() => new OpenAiCompatibleTts({ apiKey: "", model: "tts-1" }), /apiKey/);
  assert.throws(() => new OpenAiCompatibleTts({ apiKey: KEY, model: "" }), /model/);
});

// ------------------------------------------------------------------ ElevenLabs

test("ElevenLabsTts posts to the voice endpoint with the xi-api-key header", async () => {
  const { fetchFn, calls } = fakeFetch(() => audioResponse(constantPcm(160, 200)));
  const tts = new ElevenLabsTts({
    apiKey: KEY,
    voiceId: "voice-42",
    model: "eleven_turbo_v2_5",
    fetchFn,
  });

  await tts.synthesize({ text: "hello" });

  assert.equal(
    calls[0]?.url,
    "https://api.elevenlabs.io/v1/text-to-speech/voice-42?output_format=pcm_16000",
  );
  const headers = headersOf(calls[0]);
  assert.equal(headers["xi-api-key"], KEY);
  assert.equal(headers["authorization"], undefined, "ElevenLabs does not use Bearer auth");
  assert.deepEqual(bodyOf(calls[0]), { text: "hello", model_id: "eleven_turbo_v2_5" });
});

test("ElevenLabsTts asks for the closest supported PCM rate at or above the target", () => {
  assert.equal(elevenLabsOutputRate(16000), 16000);
  assert.equal(elevenLabsOutputRate(8000), 8000);
  assert.equal(elevenLabsOutputRate(12000), 16000);
  assert.equal(elevenLabsOutputRate(48000), 44100);
});

test("ElevenLabsTts resamples when the target rate is not one ElevenLabs emits", async () => {
  const { fetchFn, calls } = fakeFetch(() => audioResponse(constantPcm(1600, 4000)));
  const tts = new ElevenLabsTts({ apiKey: KEY, sampleRate: 12000, fetchFn });

  const speech = await tts.synthesize({ text: "hello" });

  assert.match(String(calls[0]?.url), /output_format=pcm_16000/);
  assert.equal(speech.sampleRate, 12000);
  assert.equal(speech.pcm.length, 1200 * 2);
  assert.ok(Math.abs(readInt16(speech.pcm, 600) - 4000) <= 2);
});

test("ElevenLabsTts uses the stock voice and turbo model when none are configured", async () => {
  const { fetchFn, calls } = fakeFetch(() => audioResponse(constantPcm(10, 1)));
  const tts = new ElevenLabsTts({ apiKey: KEY, fetchFn });

  await tts.synthesize({ text: "hello" });

  assert.match(String(calls[0]?.url), /text-to-speech\/21m00Tcm4TlvDq8ikWAM\?/);
  assert.equal(bodyOf(calls[0])["model_id"], "eleven_turbo_v2_5");
  assert.equal(tts.outputRate, 16000);
});

test("ElevenLabsTts aborts the HTTP request when the caller interrupts", async () => {
  const controller = new AbortController();
  const tts = new ElevenLabsTts({ apiKey: KEY, fetchFn: hangingFetch });

  const pending = tts.synthesize({ text: "a long reply", signal: controller.signal });
  controller.abort();

  await assert.rejects(pending);
});

test("ElevenLabsTts reports a failed request", async () => {
  const { fetchFn } = fakeFetch(
    () => new Response("voice not found", { status: 404, statusText: "Not Found" }),
  );
  const tts = new ElevenLabsTts({ apiKey: KEY, fetchFn });

  await assert.rejects(tts.synthesize({ text: "hi" }), /404.*voice not found/s);
});

// --------------------------------------------------------------- local command

test("CommandTts builds espeak-ng argv that writes a WAV file", () => {
  const tts = new CommandTts({
    engine: "espeak-ng",
    voice: "en-gb",
    wordsPerMinute: 170,
    spawnFn: fakeSpawn(() => undefined).spawnFn,
  });

  assert.deepEqual(tts.buildArgs("hi there", "/tmp/x.wav"), [
    "-w",
    "/tmp/x.wav",
    "-v",
    "en-gb",
    "-s",
    "170",
    "--",
    "hi there",
  ]);
  assert.equal(tts.textOnStdin, false);
});

test("CommandTts builds pico2wave argv with the language flag", () => {
  const tts = new CommandTts({ engine: "pico2wave", voice: "en-US" });

  assert.deepEqual(tts.buildArgs("hi", "/tmp/x.wav"), [
    "-w",
    "/tmp/x.wav",
    "-l",
    "en-US",
    "--",
    "hi",
  ]);
});

test("CommandTts builds piper argv and feeds the text on stdin", async () => {
  const { spawnFn, calls } = fakeSpawn(writesWav(16000, 160));
  const tts = new CommandTts({ engine: "piper", modelPath: "/voices/en.onnx", spawnFn });

  assert.equal(tts.textOnStdin, true);
  await tts.synthesize({ text: "hi" });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.cmd, "piper");
  assert.deepEqual(call.args.slice(0, 2), ["--model", "/voices/en.onnx"]);
  assert.equal(call.args[2], "--output_file");
  assert.equal(call.child.stdinText, "hi\n");
  assert.ok(!call.args.includes("hi"), "piper takes no text argument");
});

test("CommandTts refuses piper without a voice model", () => {
  assert.throws(() => new CommandTts({ engine: "piper" }), /modelPath/);
});

test("CommandTts decodes the engine's WAV and resamples it to the requested rate", async () => {
  // espeak-ng's native rate is 22.05 kHz; the call wants 16 kHz.
  const { spawnFn, calls } = fakeSpawn(writesWav(22050, 2205, 1500));
  const tts = new CommandTts({ engine: "espeak-ng", spawnFn });

  const speech = await tts.synthesize({ text: "hello" });

  assert.equal(speech.sampleRate, 16000);
  assert.equal(speech.channels, 1);
  assert.equal(speech.pcm.length, 1600 * 2, "0.1 s at 16 kHz");
  assert.ok(Math.abs(readInt16(speech.pcm, 800) - 1500) <= 2);
  const outPath = outPathOf(calls[0]?.args ?? []);
  assert.equal(existsSync(dirname(outPath)), false, "the temp directory is removed");
});

test("CommandTts passes an already-matching WAV through unresampled", async () => {
  const { spawnFn } = fakeSpawn(writesWav(16000, 320, -2000));
  const tts = new CommandTts({ engine: "pico2wave", spawnFn });

  const speech = await tts.synthesize({ text: "hello" });

  assert.equal(speech.pcm.length, 320 * 2);
  assert.equal(readInt16(speech.pcm, 0), -2000);
  assert.equal(readInt16(speech.pcm, 319), -2000);
});

test("decodeWav downmixes a stereo engine output to mono", () => {
  const speech = decodeWav(stereoWav(16000, [1000, 1000], [3000, 3000]), 16000);

  assert.equal(speech.channels, 1);
  assert.equal(speech.pcm.length, 4);
  assert.ok(Math.abs(readInt16(speech.pcm, 0) - 2000) <= 2);
});

test("decodeWav rejects a format the pipeline cannot carry", () => {
  assert.throws(() => decodeWav(Buffer.from("not a wav at all"), 16000), /RIFF/);
});

test("CommandTts surfaces a failing engine with its stderr", async () => {
  const { spawnFn } = fakeSpawn(({ child }) => {
    child.stderr.write("espeak-ng: unknown voice\n");
    child.emit("close", 1, null);
  });
  const tts = new CommandTts({ engine: "espeak-ng", spawnFn });

  await assert.rejects(tts.synthesize({ text: "hello" }), /exit code 1.*unknown voice/s);
});

test("CommandTts surfaces a binary that is not installed", async () => {
  const { spawnFn } = fakeSpawn(({ child }) => child.emit("error", new Error("spawn ENOENT")));
  const tts = new CommandTts({ engine: "espeak", spawnFn });

  await assert.rejects(tts.synthesize({ text: "hello" }), /failed to start espeak/);
});

test("CommandTts kills the engine mid-synthesis when the caller interrupts", async () => {
  const controller = new AbortController();
  // An engine that never finishes on its own: only the kill can end this.
  const { spawnFn, calls } = fakeSpawn(() => controller.abort());
  const tts = new CommandTts({ engine: "espeak-ng", spawnFn });

  await assert.rejects(tts.synthesize({ text: "a long reply", signal: controller.signal }));

  assert.deepEqual(calls[0]?.child.signals, ["SIGKILL"], "SIGTERM would let it finish speaking");
  const outPath = outPathOf(calls[0]?.args ?? []);
  assert.equal(existsSync(dirname(outPath)), false, "the temp directory is removed on abort too");
});

test("CommandTts does not spawn anything for an already-aborted turn", async () => {
  const { spawnFn, calls } = fakeSpawn(writesWav(16000, 16));
  const tts = new CommandTts({ engine: "espeak-ng", spawnFn });

  await assert.rejects(tts.synthesize({ text: "hi", signal: AbortSignal.abort() }));

  assert.equal(calls.length, 0);
});

test("CommandTts returns silence for empty text without spawning", async () => {
  const { spawnFn, calls } = fakeSpawn(writesWav(16000, 16));
  const tts = new CommandTts({ engine: "espeak-ng", spawnFn });

  const speech = await tts.synthesize({ text: "  " });

  assert.equal(calls.length, 0);
  assert.equal(speech.pcm.length, 0);
});

test("detectTtsCommand prefers espeak-ng and falls back down the list", () => {
  assert.equal(detectTtsCommand(onlyOnPath("espeak-ng", "espeak", "pico2wave")), "espeak-ng");
  assert.equal(detectTtsCommand(onlyOnPath("espeak", "pico2wave")), "espeak");
  assert.equal(detectTtsCommand(onlyOnPath("pico2wave")), "pico2wave");
  assert.equal(detectTtsCommand(onlyOnPath()), null);
});

test("CommandTts skips piper during auto-detection when no voice model is configured", () => {
  const lookPath = onlyOnPath("piper", "pico2wave");

  assert.equal(new CommandTts({ lookPath }).engine, "pico2wave");
  assert.equal(new CommandTts({ lookPath, modelPath: "/voices/en.onnx" }).engine, "piper");
});

test("CommandTts explains itself when no engine is installed", () => {
  assert.throws(() => new CommandTts({ lookPath: onlyOnPath() }), /No local speech engine/);
});

// -------------------------------------------------------------------- selection

function config(tts: AppConfig["tts"]): Pick<AppConfig, "tts"> {
  return { tts };
}

test("selectTtsClient uses the OpenAI-compatible path for a keyed non-ElevenLabs model", () => {
  const selection = selectTtsClient(config({ apiKey: KEY, model: "gpt-4o-mini-tts" }), {
    env: { TTS_VOICE: "verse" },
    lookPath: onlyOnPath(),
  });

  assert.equal(selection.provider, "openai");
  assert.ok(selection.client instanceof OpenAiCompatibleTts);
  assert.match(selection.description, /gpt-4o-mini-tts/);
  assert.ok(!selection.description.includes(KEY));
});

test("selectTtsClient routes eleven_* models to ElevenLabs with TTS_VOICE as the voice id", () => {
  const selection = selectTtsClient(config({ apiKey: KEY, model: "eleven_flash_v2_5" }), {
    env: { TTS_VOICE: "voice-42" },
    lookPath: onlyOnPath(),
  });

  assert.equal(selection.provider, "elevenlabs");
  assert.ok(selection.client instanceof ElevenLabsTts);
  assert.match(selection.description, /voice-42/);
});

test("selectTtsClient obeys an explicit TTS_PROVIDER", () => {
  const selection = selectTtsClient(config({ apiKey: KEY, model: "eleven_flash_v2_5" }), {
    env: { TTS_PROVIDER: "openai" },
    lookPath: onlyOnPath(),
  });

  assert.equal(selection.provider, "openai");
});

test("selectTtsClient falls back to a local engine when there is no API key", () => {
  const selection = selectTtsClient(config({ model: "replace-me" }), {
    env: {},
    lookPath: onlyOnPath("espeak-ng"),
  });

  assert.equal(selection.provider, "command");
  assert.equal((selection.client as CommandTts).engine, "espeak-ng");
});

test("selectTtsClient falls back to a local engine when a keyed provider is unusable", () => {
  // A key with a placeholder model: nothing to send to OpenAI, but espeak is here.
  const selection = selectTtsClient(config({ apiKey: KEY, model: "replace-me" }), {
    env: {},
    lookPath: onlyOnPath("espeak"),
  });

  assert.equal(selection.provider, "command");
});

test("selectTtsClient falls back to silence rather than failing the call", () => {
  const selection = selectTtsClient(config({ model: "replace-me" }), {
    env: {},
    lookPath: onlyOnPath(),
  });

  assert.equal(selection.provider, "silent");
  assert.ok(selection.client instanceof SilentTts);
});

test("selectTtsClient honours TTS_SAMPLE_RATE and TTS_COMMAND", () => {
  const selection = selectTtsClient(config({ model: "replace-me" }), {
    env: { TTS_SAMPLE_RATE: "8000", TTS_COMMAND: "pico2wave" },
    lookPath: onlyOnPath("espeak-ng", "pico2wave"),
  });

  assert.equal((selection.client as CommandTts).engine, "pico2wave");
  assert.equal((selection.client as CommandTts).sampleRate, 8000);
});

test("createTtsClient returns a usable client for an empty configuration", async () => {
  const client = createTtsClient(config({ model: "replace-me" }), {
    env: {},
    lookPath: onlyOnPath(),
  });

  const speech = await client.synthesize({ text: "two words" });

  assert.equal(speech.channels, 1);
  assert.ok(speech.pcm.length > 0, "SilentTts still produces the right duration of silence");
});

test("SilentTts still produces silence of the right length", async () => {
  const speech = await new SilentTts({ sampleRate: 16000, wordsPerMinute: 120 }).synthesize({
    text: "one two three four",
  });

  assert.equal(speech.sampleRate, 16000);
  assert.equal(speech.pcm.length, Math.round((4 / 120) * 60 * 16000) * 2);
  assert.ok(speech.pcm.every((b) => b === 0));
});

test("an unrecognised TTS_COMMAND degrades to silence instead of failing every utterance", () => {
  // A typo in an env var must not produce a provider that reports success and
  // then spawns a binary with no arguments on every turn of a live call.
  const selection = selectTtsClient(
    { tts: { model: "replace-me" } },
    { env: { TTS_COMMAND: "festival" }, lookPath: () => false },
  );
  assert.equal(selection.provider, "silent");
});

test("CommandTts refuses an engine it cannot build argv for", () => {
  assert.throws(
    () => new CommandTts({ engine: "festival" as never, lookPath: () => true }),
    /unsupported engine/,
  );
});

test("a hosted voice left in the environment is not handed to the local engine", () => {
  // TTS_VOICE means an OpenAI voice name or an ElevenLabs id; espeak would
  // read it as a language code and fail on every utterance.
  const selection = selectTtsClient(
    { tts: { model: "replace-me" } },
    { env: { TTS_VOICE: "alloy" }, lookPath: (b) => b === "espeak-ng" },
  );
  assert.equal(selection.provider, "command");
  const client = selection.client as CommandTts;
  assert.ok(
    !client.buildArgs("hi", "/tmp/o.wav").includes("alloy"),
    "the hosted voice must not reach espeak's -v flag",
  );

  // A voice chosen for the local engine still gets through.
  const scoped = selectTtsClient(
    { tts: { model: "replace-me" } },
    { env: { TTS_COMMAND_VOICE: "en-gb" }, lookPath: (b) => b === "espeak-ng" },
  );
  assert.ok((scoped.client as CommandTts).buildArgs("hi", "/tmp/o.wav").includes("en-gb"));
});
