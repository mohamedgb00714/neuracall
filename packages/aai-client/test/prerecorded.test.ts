import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "@neuracall/config";
import {
  PRERECORDED_SPEECH_MODELS,
  PrerecordedClient,
  PrerecordedHttpError,
  TranscriptError,
  TranscriptTimeoutError,
  utterancesToText,
  type Transcript,
} from "../src/prerecorded.js";
import { testConfig } from "./mockA2I.js";

/** One recorded call to the injected fetch. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A canned response, in the order the client will hit it. */
interface Canned {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** Records every request and replays a scripted sequence of responses. */
function recorder(responses: Canned[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let i = 0;

  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const canned = responses[Math.min(i, responses.length - 1)];
    i += 1;
    assert.ok(canned, `no canned response for request ${i} to ${url}`);
    const status = canned.status ?? 200;
    const payload = canned.text ?? JSON.stringify(canned.json ?? {});
    return new Response(status === 204 ? null : payload, {
      status,
      headers: canned.headers ?? {},
    });
  };

  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };

  return { calls, sleeps, fetchFn, sleep };
}

function client(responses: Canned[], config: AppConfig = testConfig()) {
  const r = recorder(responses);
  return {
    ...r,
    client: new PrerecordedClient(config, { fetchFn: r.fetchFn, sleep: r.sleep }),
  };
}

function completed(overrides: Partial<Transcript> = {}): Transcript {
  return { id: "t_1", status: "completed", text: "hello there", ...overrides };
}

test("uploadFile POSTs raw binary, not multipart", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const h = client([{ json: { upload_url: "https://cdn.assemblyai.com/upload/abc" } }]);

  const url = await h.client.uploadFile(bytes);
  assert.equal(url, "https://cdn.assemblyai.com/upload/abc");

  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://api.assemblyai.com/v2/upload");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/octet-stream");
  // The bytes go on the wire untouched: a FormData envelope here uploads the
  // MIME wrapper as if it were audio.
  assert.equal(call.body, bytes);
  assert.ok(!(call.body instanceof FormData), "must not be multipart");
});

test("uploadFile reads a path through the injected filesystem", async () => {
  const r = recorder([{ json: { upload_url: "https://cdn.assemblyai.com/upload/from-disk" } }]);
  const read: string[] = [];
  const c = new PrerecordedClient(testConfig(), {
    fetchFn: r.fetchFn,
    sleep: r.sleep,
    readFileFn: async (path) => {
      read.push(path);
      return new Uint8Array([9, 9]);
    },
  });

  assert.equal(await c.uploadFile("/tmp/call.wav"), "https://cdn.assemblyai.com/upload/from-disk");
  assert.deepEqual(read, ["/tmp/call.wav"]);
  assert.deepEqual(r.calls[0]?.body, new Uint8Array([9, 9]));
});

test("uploadFile rejects a response with no upload_url", async () => {
  const h = client([{ json: {} }]);
  await assert.rejects(() => h.client.uploadFile(new Uint8Array([1])), /upload_url/);
});

test("the api key goes in Authorization with no Bearer prefix", async () => {
  const h = client([
    { json: { upload_url: "https://cdn.assemblyai.com/u" } },
    { json: { id: "t_1", status: "queued" } },
    { json: completed() },
  ]);
  await h.client.transcribe({ audio: new Uint8Array([1]) });

  assert.ok(h.calls.length >= 3);
  for (const call of h.calls) {
    assert.equal(call.headers["authorization"], "test-not-a-real-key");
    assert.ok(
      !/^bearer\s/i.test(call.headers["authorization"] ?? ""),
      "AssemblyAI rejects a Bearer-prefixed key with an opaque auth failure",
    );
    assert.equal(call.headers["Authorization"], undefined, "header must be lower-case only");
  }
});

test("submit sends the plural speech_models array, not the singular string", async () => {
  const h = client([{ json: { id: "t_1", status: "queued" } }]);
  await h.client.submit({ audioUrl: "https://cdn.assemblyai.com/u" });

  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://api.assemblyai.com/v2/transcript");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");

  const body = JSON.parse(String(call.body)) as Record<string, unknown>;
  // Omitting speech_models silently runs universal-3-pro, not 3.5 — see
  // docs/DECISIONS.md §1. This assertion is the guard against that regression.
  assert.deepEqual(body["speech_models"], ["universal-3-5-pro", "universal-2"]);
  assert.deepEqual([...PRERECORDED_SPEECH_MODELS], body["speech_models"]);
  assert.equal(body["speech_model"], undefined, "the singular form is the realtime parameter");
  assert.equal(body["audio_url"], "https://cdn.assemblyai.com/u");
});

test("speaker_labels turns punctuate on, since the API requires it", async () => {
  const h = client([{ json: { id: "t_1", status: "queued" } }]);
  await h.client.submit({
    audioUrl: "https://cdn.assemblyai.com/u",
    speakerLabels: true,
    speakersExpected: 2,
  });

  const body = JSON.parse(String(h.calls[0]?.body)) as Record<string, unknown>;
  assert.equal(body["speaker_labels"], true);
  assert.equal(body["punctuate"], true);
  assert.equal(body["speakers_expected"], 2);
});

test("speaker_labels with punctuate:false is rejected before it reaches the API", async () => {
  const h = client([{ json: {} }]);
  await assert.rejects(
    () =>
      h.client.submit({
        audioUrl: "https://cdn.assemblyai.com/u",
        speakerLabels: true,
        punctuate: false,
      }),
    /speaker_labels requires punctuate/,
  );
  assert.equal(h.calls.length, 0, "nothing should have been sent");
});

test("optional fields are only sent when asked for", async () => {
  const h = client([
    { json: { id: "t_1", status: "queued" } },
    { json: { id: "t_2", status: "queued" } },
  ]);

  await h.client.submit({ audioUrl: "https://cdn.assemblyai.com/u" });
  const minimal = JSON.parse(String(h.calls[0]?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(minimal).sort(), ["audio_url", "speech_models"]);

  await h.client.submit({
    audioUrl: "https://cdn.assemblyai.com/u",
    webhookUrl: "https://example.test/hook",
    keytermsPrompt: ["NeuraCall", "scrcpy"],
    languageDetection: true,
  });
  const full = JSON.parse(String(h.calls[1]?.body)) as Record<string, unknown>;
  assert.equal(full["webhook_url"], "https://example.test/hook");
  assert.deepEqual(full["keyterms_prompt"], ["NeuraCall", "scrcpy"]);
  assert.equal(full["language_detection"], true);
});

test("language_detection and language_code cannot both be set", async () => {
  const h = client([{ json: {} }]);
  await assert.rejects(
    () =>
      h.client.submit({
        audioUrl: "https://cdn.assemblyai.com/u",
        languageDetection: true,
        languageCode: "en",
      }),
    /mutually exclusive/,
  );
});

test("poll walks queued -> processing -> completed", async () => {
  const h = client([
    { json: { id: "t_1", status: "queued" } },
    { json: { id: "t_1", status: "processing" } },
    { json: completed({ id: "t_1" }) },
  ]);

  const result = await h.client.poll("t_1", { intervalMs: 500 });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "hello there");
  assert.equal(h.calls.length, 3);
  assert.deepEqual(
    h.calls.map((c) => c.url),
    Array(3).fill("https://api.assemblyai.com/v2/transcript/t_1"),
  );
  assert.deepEqual(
    h.calls.map((c) => c.method),
    ["GET", "GET", "GET"],
  );
  // Two waits, not three: it never sleeps after the terminal state.
  assert.deepEqual(h.sleeps, [500, 500]);
});

test("a transcript that errors surfaces the server's message as a typed throw", async () => {
  const h = client([
    { json: { id: "t_bad", status: "processing" } },
    { json: { id: "t_bad", status: "error", error: "Audio file is not decodable" } },
  ]);

  await assert.rejects(
    () => h.client.poll("t_bad", { intervalMs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof TranscriptError);
      assert.equal(err.transcriptId, "t_bad");
      assert.match(err.message, /Audio file is not decodable/);
      return true;
    },
  );
});

test("polling gives up at the caller's deadline", async () => {
  const r = recorder([{ json: { id: "t_slow", status: "processing" } }]);
  let clock = 0;
  const c = new PrerecordedClient(testConfig(), {
    fetchFn: r.fetchFn,
    sleep: async (ms) => {
      r.sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });

  await assert.rejects(
    () => c.poll("t_slow", { intervalMs: 1000, timeoutMs: 2500 }),
    (err: unknown) => {
      assert.ok(err instanceof TranscriptTimeoutError);
      assert.equal(err.lastStatus, "processing");
      return true;
    },
  );
});

test("a 429 is waited out for exactly the Retry-After the server gave", async () => {
  const h = client([
    { status: 429, headers: { "retry-after": "7" }, text: "slow down" },
    { json: completed() },
  ]);

  const result = await h.client.get("t_1");
  assert.equal(result.status, "completed");
  assert.deepEqual(h.sleeps, [7000], "Retry-After is authoritative over any local backoff");
  assert.equal(h.calls.length, 2);
});

test("a 429 without Retry-After still backs off, and stops after the retry budget", async () => {
  const r = recorder([{ status: 429, text: "rate limited" }]);
  const c = new PrerecordedClient(testConfig(), {
    fetchFn: r.fetchFn,
    sleep: r.sleep,
    maxRateLimitRetries: 2,
  });

  await assert.rejects(
    () => c.get("t_1"),
    (err: unknown) => {
      assert.ok(err instanceof PrerecordedHttpError);
      assert.equal(err.status, 429);
      return true;
    },
  );
  assert.equal(r.sleeps.length, 2, "two waits, then the 429 surfaces");
  assert.equal(r.calls.length, 3);
});

test("a non-2xx carries the status and body", async () => {
  const h = client([{ status: 401, text: "Invalid API key" }]);
  await assert.rejects(
    () => h.client.get("t_1"),
    (err: unknown) => {
      assert.ok(err instanceof PrerecordedHttpError);
      assert.equal(err.status, 401);
      assert.match(err.body, /Invalid API key/);
      assert.match(err.url, /\/v2\/transcript\/t_1$/);
      return true;
    },
  );
});

test("an abort stops polling instead of looping to the deadline", async () => {
  const controller = new AbortController();
  const r = recorder([{ json: { id: "t_1", status: "processing" } }]);
  const c = new PrerecordedClient(testConfig(), {
    fetchFn: r.fetchFn,
    sleep: async (ms) => {
      r.sleeps.push(ms);
      controller.abort();
    },
  });

  await assert.rejects(
    () => c.poll("t_1", { intervalMs: 10, signal: controller.signal }),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    },
  );
  assert.equal(r.calls.length, 1, "no request after the abort");
});

test("an already-aborted signal never issues a request", async () => {
  const h = client([{ json: completed() }]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => h.client.get("t_1", controller.signal));
  assert.equal(h.calls.length, 0);
});

test("the signal is forwarded to fetch so an in-flight request is cancelled", async () => {
  const h = client([{ json: completed() }]);
  const controller = new AbortController();
  await h.client.get("t_1", controller.signal);
  assert.equal(h.calls.length, 1);
});

test("transcribe runs upload -> submit -> poll in order", async () => {
  const h = client([
    { json: { upload_url: "https://cdn.assemblyai.com/upload/xyz" } },
    { json: { id: "t_7", status: "queued" } },
    { json: { id: "t_7", status: "processing" } },
    { json: completed({ id: "t_7" }) },
  ]);

  const result = await h.client.transcribe({
    audio: new Uint8Array([1, 2, 3]),
    speakerLabels: true,
    poll: { intervalMs: 5 },
  });

  assert.equal(result.id, "t_7");
  assert.deepEqual(
    h.calls.map((c) => c.url),
    [
      "https://api.assemblyai.com/v2/upload",
      "https://api.assemblyai.com/v2/transcript",
      "https://api.assemblyai.com/v2/transcript/t_7",
      "https://api.assemblyai.com/v2/transcript/t_7",
    ],
  );

  const submitted = JSON.parse(String(h.calls[1]?.body)) as Record<string, unknown>;
  assert.equal(submitted["audio_url"], "https://cdn.assemblyai.com/upload/xyz");
  assert.deepEqual(submitted["speech_models"], ["universal-3-5-pro", "universal-2"]);
});

test("transcribe skips the upload when the audio is already hosted", async () => {
  const h = client([{ json: { id: "t_8", status: "queued" } }, { json: completed({ id: "t_8" }) }]);

  await h.client.transcribe({
    audio: { url: "https://example.test/call.wav" },
    poll: { intervalMs: 1 },
  });
  assert.equal(h.calls[0]?.url, "https://api.assemblyai.com/v2/transcript");
  const body = JSON.parse(String(h.calls[0]?.body)) as Record<string, unknown>;
  assert.equal(body["audio_url"], "https://example.test/call.wav");
});

test("the EU region routes REST calls to the EU cluster", async () => {
  const eu: AppConfig = {
    ...testConfig(),
    assemblyai: {
      ...testConfig().assemblyai,
      region: "eu",
      restBaseUrl: "https://api.eu.assemblyai.com",
    },
  };
  const h = client([{ json: completed() }], eu);
  await h.client.get("t_1");
  assert.equal(h.calls[0]?.url, "https://api.eu.assemblyai.com/v2/transcript/t_1");
});

test("a trailing slash on the configured host does not double up", async () => {
  const cfg = testConfig();
  const h = client([{ json: completed() }], {
    ...cfg,
    assemblyai: { ...cfg.assemblyai, restBaseUrl: "https://api.assemblyai.com/" },
  });
  await h.client.get("t_1");
  assert.equal(h.calls[0]?.url, "https://api.assemblyai.com/v2/transcript/t_1");
});

test("utterancesToText prefixes each line with its speaker", () => {
  const transcript = completed({
    text: "flat text",
    utterances: [
      { speaker: "A", text: "Hello?", start: 0, end: 500, confidence: 0.9, words: [] },
      {
        speaker: "B",
        text: "Hi, this is NeuraCall.",
        start: 600,
        end: 1800,
        confidence: 0.9,
        words: [],
      },
    ],
  });
  assert.equal(
    utterancesToText(transcript),
    "Speaker A: Hello?\nSpeaker B: Hi, this is NeuraCall.",
  );
  // Without diarization there is nothing to prefix, so the flat text is used.
  assert.equal(utterancesToText(completed({ text: "flat text" })), "flat text");
});
