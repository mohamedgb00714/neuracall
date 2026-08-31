import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAppConfig,
  defaultSettings,
  probeSettings,
  type NeuraCallSettings,
  type ProbeReport,
} from "../electron/service/settings.js";

/**
 * Three distinct long keys, so an assertion that finds one in a probe result
 * can say which layer leaked it. Each is over the 8-character floor
 * `scrubResult` applies, as any real key is.
 */
const AAI_KEY = "aai_5f3a91c0b7e24d8fa0c16b2d4e7f8091";
const LLM_KEY = "sk-or-v1-9f3c7a1e08b24d6ea5c0f1b73d29e845";
const TTS_KEY = "sk-openai-4b1d90c7e6a3418fbb27d05f8c6a91e2";
const ALL_KEYS = [AAI_KEY, LLM_KEY, TTS_KEY] as const;

/** OpenAI TTS needs a key and a model to be selected at all; give it both. */
function settingsWithKeys(): NeuraCallSettings {
  const settings = defaultSettings();
  settings.llm.apiKey = LLM_KEY;
  settings.llm.model = "anthropic/claude-sonnet-4";
  settings.tts.provider = "openai";
  settings.tts.apiKey = TTS_KEY;
  settings.tts.model = "gpt-4o-mini-tts";
  return settings;
}

interface Stub {
  fetchFn: typeof fetch;
  /** Every URL the probes asked for, in call order. */
  readonly urls: string[];
}

/** A fetch that never touches the network and records what it was asked for. */
function stubFetch(reply: (url: string) => Response | Promise<Response>): Stub {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return reply(url);
  };
  return { fetchFn, urls };
}

function run(settings: NeuraCallSettings, stub: Stub, key = AAI_KEY): Promise<ProbeReport> {
  return probeSettings(buildAppConfig(key, settings), settings, {
    fetchFn: stub.fetchFn,
    timeoutMs: 1000,
  });
}

/** The assertion the whole redaction design exists for. */
function assertNoKeys(report: ProbeReport): void {
  const json = JSON.stringify(report);
  for (const key of ALL_KEYS) {
    assert.ok(!json.includes(key), `a configured key reached the renderer: ${json}`);
  }
}

test("a provider that echoes the key back in its error does not leak it", async () => {
  // Provider error bodies and reason phrases are not required to be discreet,
  // and several really do quote the offending credential back.
  const stub = stubFetch((url) => {
    const key = url.includes("assemblyai") ? AAI_KEY : url.includes("openai") ? TTS_KEY : LLM_KEY;
    return new Response(JSON.stringify({ error: `invalid api key ${key}` }), {
      status: 401,
      statusText: `Unauthorized (key ${key})`,
    });
  });

  const report = await run(settingsWithKeys(), stub);

  assert.equal(report.assemblyai.ok, false);
  assert.equal(report.llm.ok, false);
  assert.equal(report.tts.ok, false);
  for (const result of [report.assemblyai, report.llm, report.tts]) {
    for (const key of ALL_KEYS) {
      assert.ok(!result.detail.includes(key), `key in detail: ${result.detail}`);
    }
    assert.ok(result.detail.includes("***"), `the key should be masked, not dropped: ${result.detail}`);
  }
  assertNoKeys(report);
});

test("a key quoted inside a transport error does not leak either", async () => {
  const stub = stubFetch((url) => {
    throw new Error(`connect ECONNREFUSED while presenting ${url.includes("assemblyai") ? AAI_KEY : LLM_KEY}`);
  });

  const report = await run(settingsWithKeys(), stub);
  assert.equal(report.assemblyai.ok, false);
  assert.ok(report.assemblyai.detail.includes("could not reach"));
  assertNoKeys(report);
});

test("one provider's key is scrubbed out of another provider's answer", async () => {
  // A misconfigured base URL can point the LLM probe at a host that happens to
  // quote a key the operator also uses elsewhere. Every result is scrubbed of
  // every configured key, not just its own.
  const stub = stubFetch(
    () => new Response("{}", { status: 500, statusText: `upstream said ${AAI_KEY} / ${TTS_KEY}` }),
  );

  const report = await run(settingsWithKeys(), stub);
  assertNoKeys(report);
});

test("all three probes pass when the providers answer", async () => {
  const stub = stubFetch((url) =>
    url.includes("/v3/token")
      ? new Response(JSON.stringify({ token: "tmp-token" }), { status: 200 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 }),
  );

  const report = await run(settingsWithKeys(), stub);
  assert.equal(report.assemblyai.ok, true, report.assemblyai.detail);
  assert.ok(report.assemblyai.detail.includes("streaming.assemblyai.com"));
  assert.equal(report.llm.ok, true, report.llm.detail);
  assert.ok(report.llm.detail.includes("openrouter.ai"));
  assert.equal(report.tts.ok, true, report.tts.detail);
  assert.ok(report.tts.detail.includes("api.openai.com"));

  assert.deepEqual(stub.urls.slice().sort(), [
    "https://api.openai.com/v1/models",
    "https://openrouter.ai/api/v1/models",
    "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60",
  ]);
  assertNoKeys(report);
});

test("a 200 with no token is a failure, not a pass", async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
  const report = await run(settingsWithKeys(), stub);
  assert.equal(report.assemblyai.ok, false);
  assert.ok(report.assemblyai.detail.includes("no token"));
});

test("a provider without /models still counts as reachable", async () => {
  // Plenty of OpenAI-compatible servers do not implement the listing; the probe
  // only set out to prove the host answers.
  const stub = stubFetch((url) =>
    url.includes("/v3/token")
      ? new Response(JSON.stringify({ token: "tmp-token" }), { status: 200 })
      : new Response("", { status: 404 }),
  );

  const report = await run(settingsWithKeys(), stub);
  assert.equal(report.llm.ok, true, report.llm.detail);
  assert.ok(report.llm.detail.includes("no /models listing"));
});

test("an unconfigured provider is reported without a request being made", async () => {
  const stub = stubFetch(() => {
    throw new Error("no probe should have been attempted");
  });
  const settings = defaultSettings();
  settings.tts.provider = "silent";

  const report = await run(settings, stub, "");
  assert.equal(report.assemblyai.ok, false);
  assert.ok(report.assemblyai.detail.includes("ASSEMBLYAI_API_KEY"));
  assert.equal(report.llm.ok, false);
  assert.ok(report.llm.detail.includes("no API key stored"));
  assert.equal(report.tts.ok, false);
  assert.deepEqual(stub.urls, [], "a probe with nothing to check must not hit the network");
});

test("a key without a model is reported as such, not probed", async () => {
  const stub = stubFetch(() => new Response("{}", { status: 200 }));
  const settings = defaultSettings();
  settings.llm.apiKey = LLM_KEY;
  settings.tts.provider = "silent";

  const report = await run(settings, stub, "");
  assert.equal(report.llm.ok, false);
  assert.ok(report.llm.detail.includes("no model set"));
  assertNoKeys(report);
});

test("the probe honours a custom base URL and trims its trailing slashes", async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const settings = settingsWithKeys();
  settings.llm.baseUrl = "http://127.0.0.1:11434/v1//";
  settings.tts.baseUrl = "http://127.0.0.1:8880/v1/";

  const report = await run(settings, stub, "");
  assert.ok(stub.urls.includes("http://127.0.0.1:11434/v1/models"), stub.urls.join(", "));
  assert.ok(stub.urls.includes("http://127.0.0.1:8880/v1/models"), stub.urls.join(", "));
  assert.equal(report.llm.ok, true, report.llm.detail);
});

test("buildAppConfig re-derives the endpoints from the chosen region", () => {
  const settings = settingsWithKeys();
  settings.assemblyai.region = "eu";

  const config = buildAppConfig(AAI_KEY, settings);
  assert.equal(config.assemblyai.realtimeHost, "streaming.eu.assemblyai.com");
  assert.equal(config.assemblyai.restBaseUrl, "https://api.eu.assemblyai.com");
  assert.equal(config.assemblyai.tokenUrl, "https://streaming.eu.assemblyai.com/v3/token");
  assert.equal(config.llm.apiKey, LLM_KEY);
  assert.equal(config.tts.apiKey, TTS_KEY);

  // An empty key must be omitted rather than passed through as "": the agent
  // treats a present-but-empty key as configured.
  const bare = buildAppConfig(AAI_KEY, defaultSettings());
  assert.ok(!("apiKey" in bare.llm));
  assert.ok(!("apiKey" in bare.tts));
});
