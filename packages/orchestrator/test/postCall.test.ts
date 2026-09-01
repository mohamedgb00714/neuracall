import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavHeaderMono16 } from "@neuracall/audio-pipeline";
import type { SummarizeOptions, TranscribeOptions, Transcript } from "@neuracall/aai-client";
import { MemoryCallRecordStore } from "../src/callStore.js";
import {
  PostCallProcessor,
  type PostCallResult,
  type PostCallSummarizer,
  type PostCallTranscriber,
} from "../src/postCall.js";
import type { CallRecord } from "../src/types.js";

const SAMPLE_RATE = 16_000;
const MODEL = "claude-sonnet-4-5-20250929";

function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    deviceId: "192.168.1.44:5555",
    channelId: "cellular",
    direction: "inbound",
    state: "ended",
    outcome: "completed",
    remoteParty: "+15550100",
    startedAt: 1000,
    answeredAt: 1100,
    endedAt: 60_000,
    transcript: [],
    audioPath: null,
    states: [{ state: "idle", at: 1000 }],
    ...overrides,
  };
}

/** A real WAV on disk of exactly `seconds` of silence. */
function writeWav(dir: string, name: string, seconds: number): string {
  const dataBytes = Math.round(seconds * SAMPLE_RATE) * 2;
  const path = join(dir, name);
  writeFileSync(
    path,
    Buffer.concat([wavHeaderMono16(SAMPLE_RATE, dataBytes), Buffer.alloc(dataBytes)]),
  );
  return path;
}

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-postcall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function completedTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    id: "tr-1",
    status: "completed",
    text: "Hello there. Hi, I need to reschedule.",
    audio_duration: 42,
    language_code: "en_us",
    utterances: [
      { speaker: "A", text: "Hello there.", start: 0, end: 900, confidence: 0.98, words: [] },
      {
        speaker: "B",
        text: "Hi, I need to reschedule.",
        start: 1000,
        end: 2400,
        confidence: 0.95,
        words: [],
      },
    ],
    ...overrides,
  };
}

/** Records every call it is given; never touches the network. */
class FakeTranscriber implements PostCallTranscriber {
  readonly calls: TranscribeOptions[] = [];

  constructor(private readonly reply: (opts: TranscribeOptions) => Promise<Transcript>) {}

  async transcribe(opts: TranscribeOptions): Promise<Transcript> {
    this.calls.push(opts);
    return await this.reply(opts);
  }
}

class FakeSummarizer implements PostCallSummarizer {
  readonly calls: Array<{ text: string; opts: SummarizeOptions }> = [];

  constructor(private readonly reply: (text: string) => Promise<string>) {}

  async summarize(transcriptText: string, opts: SummarizeOptions): Promise<string> {
    this.calls.push({ text: transcriptText, opts });
    return await this.reply(transcriptText);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("happy path: transcribes, summarises and stores the analysis", async (t) => {
  const dir = tempDir(t);
  const audioPath = writeWav(dir, "call-1.wav", 42);
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath });
  await store.save(call);

  const transcriber = new FakeTranscriber(async () => completedTranscript());
  const summarizer = new FakeSummarizer(async () => "Caller wants to reschedule.");
  const results: PostCallResult[] = [];

  const processor = new PostCallProcessor({
    transcriber,
    summarizer,
    summaryModel: MODEL,
    store,
    onResult: (r) => results.push(r),
  });

  const result = await processor.process(call);

  assert.equal(result.status, "completed");
  assert.equal(result.callId, "call-1");
  assert.equal(result.transcriptId, "tr-1");
  assert.equal(result.text, "Hello there. Hi, I need to reschedule.");
  assert.equal(result.summary, "Caller wants to reschedule.");
  assert.equal(result.summaryModel, MODEL);
  assert.equal(result.audioDurationSec, 42);
  assert.equal(result.languageCode, "en_us");
  assert.deepEqual(
    result.utterances?.map((u) => `${u.speaker}: ${u.text}`),
    ["A: Hello there.", "B: Hi, I need to reschedule."],
  );
  assert.equal(results.length, 1, "onResult fires once per call");

  // Diarization is the whole point of the pre-recorded pass.
  assert.equal(transcriber.calls[0]?.speakerLabels, true);
  assert.deepEqual(transcriber.calls[0]?.audio, { path: audioPath });

  // The summariser sees speaker-prefixed lines, not the flat text.
  assert.equal(
    summarizer.calls[0]?.text,
    "Speaker A: Hello there.\nSpeaker B: Hi, I need to reschedule.",
  );
  assert.equal(summarizer.calls[0]?.opts.model, MODEL);
});

test("the analysis lands on the stored record without disturbing the rest of it", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: writeWav(dir, "call-1.wav", 30) });
  await store.save(call);

  const processor = new PostCallProcessor({
    transcriber: new FakeTranscriber(async () => completedTranscript()),
    store,
  });
  await processor.process(call);

  const stored = await store.get("call-1");
  assert.equal(stored?.postCall?.status, "completed");
  assert.equal(stored?.postCall?.transcriptId, "tr-1");
  assert.equal(stored?.outcome, "completed", "existing fields must survive untouched");
  assert.equal(stored?.remoteParty, "+15550100");
});

test("a record updated after the call ended is not clobbered by the write-back", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const snapshot = record({ audioPath: writeWav(dir, "call-1.wav", 30) });
  await store.save(snapshot);
  // Something else enriches the record while the upload is in flight.
  await store.save({ ...snapshot, remoteParty: "+15550199", error: "enriched" });

  const processor = new PostCallProcessor({
    transcriber: new FakeTranscriber(async () => completedTranscript()),
    store,
  });
  await processor.process(snapshot);

  const stored = await store.get("call-1");
  assert.equal(stored?.remoteParty, "+15550199");
  assert.equal(stored?.error, "enriched");
  assert.equal(stored?.postCall?.status, "completed");
});

test("a transcription failure is recorded, not thrown, and the call record survives", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: writeWav(dir, "call-1.wav", 30) });
  await store.save(call);

  const errors: Array<{ result: PostCallResult; cause: unknown }> = [];
  const processor = new PostCallProcessor({
    transcriber: new FakeTranscriber(async () => {
      throw new Error("AssemblyAI /v2/upload failed (HTTP 503): upstream");
    }),
    store,
    onError: (result, cause) => errors.push({ result, cause }),
  });

  const result = await processor.process(call);

  assert.equal(result.status, "failed");
  assert.equal(result.error, "AssemblyAI /v2/upload failed (HTTP 503): upstream");
  assert.equal(result.audioDurationSec, 30, "what we knew before the failure is kept");
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.cause instanceof Error, "the raw throw reaches the callback");

  const stored = await store.get("call-1");
  assert.equal(stored?.outcome, "completed", "the call record must not be lost");
  assert.equal(stored?.postCall?.status, "failed");
});

test("a summary failure keeps the transcript that was already paid for", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: writeWav(dir, "call-1.wav", 30) });
  await store.save(call);

  const errors: PostCallResult[] = [];
  const processor = new PostCallProcessor({
    transcriber: new FakeTranscriber(async () => completedTranscript()),
    summarizer: new FakeSummarizer(async () => {
      throw new Error("LLM Gateway failed (HTTP 400): unknown model");
    }),
    summaryModel: MODEL,
    store,
    onError: (result) => errors.push(result),
  });

  const result = await processor.process(call);

  assert.equal(result.status, "completed");
  assert.equal(result.transcriptId, "tr-1");
  assert.equal(result.summary, undefined);
  assert.equal(result.summaryError, "LLM Gateway failed (HTTP 400): unknown model");
  assert.equal(errors.length, 1, "a partial failure is still reported");
});

test("a missing audio file is skipped without an upload", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: join(dir, "never-written.wav") });
  await store.save(call);

  const transcriber = new FakeTranscriber(async () => completedTranscript());
  const processor = new PostCallProcessor({ transcriber, store });

  const result = await processor.process(call);

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "audio-missing");
  assert.equal(transcriber.calls.length, 0, "nothing may be uploaded");
  assert.equal((await store.get("call-1"))?.postCall?.skipReason, "audio-missing");
});

test("a call with no recording at all is skipped", async () => {
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: null });
  await store.save(call);

  const transcriber = new FakeTranscriber(async () => completedTranscript());
  const processor = new PostCallProcessor({ transcriber, store });

  const result = await processor.process(call);

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "no-audio");
  assert.equal(transcriber.calls.length, 0);
});

test("a recording below the minimum duration is skipped", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: writeWav(dir, "call-1.wav", 2) });
  await store.save(call);

  const transcriber = new FakeTranscriber(async () => completedTranscript());
  const processor = new PostCallProcessor({ transcriber, store });

  const result = await processor.process(call);

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "too-short");
  assert.match(result.skipDetail ?? "", /2\.00s/);
  assert.equal(transcriber.calls.length, 0, "a 2-second WAV is not worth an upload");
});

test("a file that is not a PCM WAV is skipped rather than uploaded", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "call-1.wav");
  writeFileSync(path, Buffer.alloc(200_000, 7));
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: path });
  await store.save(call);

  const transcriber = new FakeTranscriber(async () => completedTranscript());
  const processor = new PostCallProcessor({ transcriber, store });

  const result = await processor.process(call);

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "audio-unreadable");
  assert.equal(transcriber.calls.length, 0);
});

test("without a model, summarisation is skipped and only summarisation", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const call = record({ audioPath: writeWav(dir, "call-1.wav", 30) });
  await store.save(call);

  const summarizer = new FakeSummarizer(async () => "never reached");
  const processor = new PostCallProcessor({
    transcriber: new FakeTranscriber(async () => completedTranscript()),
    summarizer,
    store,
  });

  const result = await processor.process(call);

  assert.equal(result.status, "completed", "no model must not fail the whole analysis");
  assert.equal(result.transcriptId, "tr-1");
  assert.equal(result.summary, undefined);
  assert.equal(result.summaryModel, undefined);
  assert.equal(result.summaryError, undefined, "not configured is not a failure");
  assert.equal(summarizer.calls.length, 0, "the gateway is never called without a model id");
});

test("the queue serialises calls: one upload is in flight at a time", async (t) => {
  const dir = tempDir(t);
  const store = new MemoryCallRecordStore();
  const first = record({ callId: "a", audioPath: writeWav(dir, "a.wav", 30) });
  const second = record({ callId: "b", audioPath: writeWav(dir, "b.wav", 30) });
  await store.save(first);
  await store.save(second);

  const gates = new Map<string, ReturnType<typeof deferred<Transcript>>>();
  let concurrent = 0;
  let peak = 0;
  const started: string[] = [];

  const transcriber = new FakeTranscriber(async (opts) => {
    const path = "path" in opts.audio ? opts.audio.path : "?";
    const id = path.endsWith("a.wav") ? "a" : "b";
    started.push(id);
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    const gate = deferred<Transcript>();
    gates.set(id, gate);
    try {
      return await gate.promise;
    } finally {
      concurrent -= 1;
    }
  });

  const processor = new PostCallProcessor({ transcriber, store });
  const pendingA = processor.process(first);
  const pendingB = processor.process(second);

  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["a"], "the second call waits for the first");
  assert.equal(processor.active, 1);
  assert.equal(processor.pending, 1);

  gates.get("a")?.resolve(completedTranscript({ id: "tr-a" }));
  assert.equal((await pendingA).transcriptId, "tr-a");

  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["a", "b"]);
  gates.get("b")?.resolve(completedTranscript({ id: "tr-b" }));
  assert.equal((await pendingB).transcriptId, "tr-b");

  assert.equal(peak, 1, "default concurrency is one call at a time");
  await processor.drain();
  assert.equal(processor.active, 0);
  assert.equal(processor.pending, 0);
  assert.equal((await store.get("a"))?.postCall?.transcriptId, "tr-a");
  assert.equal((await store.get("b"))?.postCall?.transcriptId, "tr-b");
});

test("a store that throws does not lose the analysis or reject", async (t) => {
  const dir = tempDir(t);
  const call = record({ audioPath: writeWav(dir, "call-1.wav", 30) });
  const store = new MemoryCallRecordStore();
  await store.save(call);
  const failing = {
    save: async (): Promise<void> => {
      throw new Error("disk full");
    },
    get: store.get.bind(store),
    list: store.list.bind(store),
  };

  const errors: PostCallResult[] = [];
  const processor = new PostCallProcessor({
    transcriber: new FakeTranscriber(async () => completedTranscript()),
    store: failing,
    onError: (result) => errors.push(result),
  });

  const result = await processor.process(call);

  assert.equal(result.status, "completed");
  assert.equal(result.transcriptId, "tr-1");
  assert.equal(result.persistError, "disk full");
  assert.equal(errors.length, 1);
});

/**
 * Turn the event loop until `ready()` holds. The processor probes the file
 * before it uploads, so "has the next call started" is several ticks away, not
 * one — polling keeps the assertion about ordering rather than about timing.
 */
/**
 * Wait for a condition, bounded by wall-clock time rather than by event-loop
 * turns.
 *
 * A `setImmediate` budget looks equivalent and is not: what this waits on is
 * real work (reading a WAV off disk, then the queue picking up the next job),
 * and on a loaded machine a hundred immediate-ticks can drain in well under a
 * millisecond while that work has not even started. That made this suite fail
 * roughly one run in four when the CPU was busy — which is precisely when CI
 * runs it — and pass every time in isolation.
 */
async function waitFor(ready: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`condition never became true within ${timeoutMs}ms`);
}
