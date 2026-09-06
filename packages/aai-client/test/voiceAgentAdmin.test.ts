import { test } from "node:test";
import assert from "node:assert/strict";
import { VOICE_AGENT_SAMPLE_RATE, type AppConfig } from "@neuracall/config";
import {
  DEFAULT_AGENT_GREETING,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  VOICES,
  VOICE_IDS,
  VoiceAgentAdminClient,
  VoiceAgentApiError,
  defaultNeuraCallAgent,
  isVoiceId,
  toWireDefinition,
  type StoredAgentAudioFormat,
  type VoiceAgentCreateWire,
  type VoiceAgentDefinition,
  type VoiceAgentListPage,
  type VoiceAgentPatchWire,
} from "../src/voiceAgentAdmin.js";

const KEY = "test-not-a-real-key";

/**
 * The agents API lives on its own host family, so the client reads
 * `voiceAgent.restBaseUrl` (which already carries `/v1`) rather than the
 * transcription host. This fixture is local, and deliberately not the edge
 * host, so a test asserting a URL proves the config was consulted.
 */
const BASE = "https://agents.test.invalid/v1";

function adminConfig(): AppConfig {
  return {
    assemblyai: {
      apiKey: KEY,
      region: "us",
      restBaseUrl: "https://api.assemblyai.com",
      realtimeHost: "streaming.us.assemblyai.com",
      tokenUrl: "https://streaming.us.assemblyai.com/v3/token",
      speechModel: "universal-3-5-pro",
    },
    voiceAgent: {
      restBaseUrl: BASE,
      wsUrl: "wss://agents.test.invalid/v1/ws",
      tokenUrl: "https://agents.test.invalid/v1/token",
      enabled: true,
      voice: "alba",
      sampleRate: VOICE_AGENT_SAMPLE_RATE,
    },
    llm: { model: "test" },
    tts: { model: "test" },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed request body, or undefined for GET/DELETE. */
  body: Record<string, unknown> | undefined;
}

interface Canned {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Send a genuinely empty body, the way a 204 does. */
  empty?: boolean;
}

function harness(responses: Canned[], maxRateLimitRetries?: number) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let i = 0;

  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw === undefined ? undefined : (JSON.parse(String(raw)) as Record<string, unknown>),
    });
    const canned = responses[Math.min(i, responses.length - 1)];
    i += 1;
    assert.ok(canned, `no canned response for request ${i}`);
    const body = canned.empty === true ? null : (canned.text ?? JSON.stringify(canned.json ?? {}));
    return new Response(body, {
      status: canned.status ?? 200,
      headers: canned.headers ?? {},
    });
  };

  return {
    calls,
    sleeps,
    client: new VoiceAgentAdminClient(adminConfig(), {
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...(maxRateLimitRetries === undefined ? {} : { maxRateLimitRetries }),
    }),
  };
}

function page(agents: Array<{ id: string }>, nextCursor?: string): VoiceAgentListPage {
  return {
    agents: agents.map((a) => ({ id: a.id, name: a.id })),
    has_more: nextCursor !== undefined,
    response_metadata: { next_cursor: nextCursor ?? null },
  };
}

const MINIMAL: VoiceAgentDefinition = {
  name: "Front desk",
  systemPrompt: "Answer the phone.",
  voice: "eve",
};

test("create POSTs the snake_case wire shape to /v1/agents", async () => {
  const h = harness([{ json: { id: "agent-1", name: "Front desk" } }]);

  const agent = await h.client.createAgent({
    name: "Front desk",
    systemPrompt: "Answer the phone.",
    greeting: "Hello?",
    voice: "charles",
    input: {
      turnDetection: {
        vadThreshold: 0.4,
        minSilence: 300,
        maxSilence: 1500,
        interruptResponse: true,
      },
      transcriptionMode: "max_accuracy",
      voiceFocus: "far-field",
      voiceFocusThreshold: 0.8,
      keyterms: ["NeuraCall", "scrcpy"],
    },
    output: { volume: 80 },
    tools: [
      {
        name: "take_message",
        description: "Record a message for the owner.",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
    llm: {
      baseUrl: "https://llm-gateway.assemblyai.com/v1",
      model: "qwen3.5-4b-32k-fast",
      apiKey: "k",
    },
  });

  assert.equal(agent.id, "agent-1");

  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(call.url, `${BASE}/agents`);

  const body = call.body as unknown as VoiceAgentCreateWire;
  assert.equal(body.name, "Front desk");
  assert.equal(body.system_prompt, "Answer the phone.");
  assert.equal(body.greeting, "Hello?");
  assert.deepEqual(body.voice, { voice_id: "charles" });
  assert.deepEqual(body.input.format, { encoding: "audio/pcm", sample_rate: 24000 });
  assert.deepEqual(body.input.turn_detection, {
    vad_threshold: 0.4,
    min_silence: 300,
    max_silence: 1500,
    interrupt_response: true,
  });
  assert.equal(body.input.transcription_mode, "max_accuracy");
  assert.equal(body.input.voice_focus, "far-field");
  assert.equal(body.input.voice_focus_threshold, 0.8);
  assert.deepEqual(body.input.keyterms, ["NeuraCall", "scrcpy"]);
  assert.deepEqual(body.output, {
    format: { encoding: "audio/pcm", sample_rate: 24000 },
    volume: 80,
  });
  assert.deepEqual(body.tools, [
    {
      name: "take_message",
      description: "Record a message for the owner.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    },
  ]);
  // A single llm config still goes out as the array the API stores.
  assert.deepEqual(body.llm, [
    {
      base_url: "https://llm-gateway.assemblyai.com/v1",
      model: "qwen3.5-4b-32k-fast",
      api_key: "k",
    },
  ]);
  // No camelCase leaked onto the wire.
  assert.ok(!JSON.stringify(body).includes("systemPrompt"));
  assert.ok(!JSON.stringify(body).includes("voiceId"));
});

test("a minimal definition still pins both formats to 24 kHz PCM", () => {
  const wire = toWireDefinition(MINIMAL);
  assert.deepEqual(wire.input.format, { encoding: "audio/pcm", sample_rate: 24000 });
  assert.deepEqual(wire.output.format, { encoding: "audio/pcm", sample_rate: 24000 });
  assert.equal(wire.greeting, undefined);
  assert.equal(wire.tools, undefined);
  assert.equal(wire.llm, undefined);
});

test("only the deliberately-unpleasant escape hatch can change the sample rate", () => {
  const wire = toWireDefinition({
    ...MINIMAL,
    input: { format: { unsafeSampleRate: 16000 } },
  });
  assert.equal(wire.input.format.sample_rate, 16000);
  // The output is untouched by an input override.
  assert.equal(wire.output.format.sample_rate, VOICE_AGENT_SAMPLE_RATE);
});

test("a 16 kHz sampleRate does not compile", () => {
  // The guard that matters here is the type, so the assertion is the directive
  // below, checked by `npm run pretest`: if VoiceAgentSampleRate ever widens to
  // `number`, this @ts-expect-error becomes unused and the build fails. Without
  // it, deleting the literal type leaves every runtime test green.
  const format: StoredAgentAudioFormat = {
    // @ts-expect-error 16000 is not assignable to VoiceAgentSampleRate — an
    // agent stored at 16000 fails at session start with `internal_error`.
    sampleRate: 16000,
  };
  assert.ok(format);
});

test("a 16 kHz sampleRate that arrives as data is refused before it is stored", () => {
  // The type is erased on anything deserialized, and this client is the last
  // checkpoint before the rate is persisted server-side. Cast the way a settings
  // file or an IPC payload reaches the mapper.
  const fromDisk = JSON.parse('{"sampleRate":16000}') as StoredAgentAudioFormat;

  assert.throws(
    () => toWireDefinition({ ...MINIMAL, input: { format: fromDisk } }),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      // The message must name the failure the server actually reports, or it
      // gets debugged as an AssemblyAI outage.
      assert.match(err.message, /internal_error/);
      assert.match(err.message, /24000/);
      return true;
    },
  );
  // The escape hatch is still an escape hatch.
  assert.equal(
    toWireDefinition({ ...MINIMAL, output: { format: { unsafeSampleRate: 16000 } } }).output.format
      .sample_rate,
    16000,
  );
});

test("the agents host takes Bearer auth, unlike the raw-key /v2 API", async () => {
  const h = harness([{ json: { id: "agent-1", name: "x" } }]);
  await h.client.createAgent(MINIMAL);

  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.headers["authorization"], `Bearer ${KEY}`);
  assert.equal(call.headers["content-type"], "application/json");
});

test("get fetches one agent by id, url-encoded", async () => {
  const h = harness([{ json: { id: "a b/c", name: "x" } }]);
  const agent = await h.client.getAgent("a b/c");
  assert.equal(agent.id, "a b/c");
  assert.equal(h.calls[0]?.url, `${BASE}/agents/a%20b%2Fc`);
  assert.equal(h.calls[0]?.method, "GET");
  assert.equal(h.calls[0]?.body, undefined);
});

test("update PATCHes only the fields supplied", async () => {
  const h = harness([{ json: { id: "agent-1", name: "Renamed" } }]);
  await h.client.updateAgent("agent-1", { name: "Renamed", voice: "vera" });

  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.method, "PATCH");
  assert.equal(call.url, `${BASE}/agents/agent-1`);
  assert.deepEqual(call.body, { name: "Renamed", voice: { voice_id: "vera" } });
});

test("a patch that touches input re-sends the 24 kHz format", async () => {
  const h = harness([{ json: { id: "agent-1", name: "x" } }]);
  await h.client.updateAgent("agent-1", { input: { turnDetection: { interruptResponse: false } } });

  const body = h.calls[0]?.body as unknown as VoiceAgentPatchWire;
  assert.deepEqual(body.input?.format, { encoding: "audio/pcm", sample_rate: 24000 });
  assert.deepEqual(body.input?.turn_detection, { interrupt_response: false });
  assert.equal(body.output, undefined);
});

test("delete tolerates the 204 with a genuinely empty body", async () => {
  const h = harness([{ status: 204, empty: true }]);

  // Parsing the body would reject here, which is the whole point of the test.
  await h.client.deleteAgent("agent-1");

  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.method, "DELETE");
  assert.equal(call.url, `${BASE}/agents/agent-1`);
  assert.equal(call.headers["content-type"], undefined);
});

test("listAgents follows next_cursor across pages", async () => {
  const h = harness([
    { json: page([{ id: "a1" }, { id: "a2" }], "cur-2") },
    { json: page([{ id: "a3" }], "cur-3") },
    { json: page([{ id: "a4" }]) },
  ]);

  const agents = await h.client.listAgents({ limit: 2 });
  assert.deepEqual(
    agents.map((a) => a.id),
    ["a1", "a2", "a3", "a4"],
  );
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0]?.url, `${BASE}/agents?limit=2`);
  assert.equal(h.calls[1]?.url, `${BASE}/agents?limit=2&cursor=cur-2`);
  assert.equal(h.calls[2]?.url, `${BASE}/agents?limit=2&cursor=cur-3`);
});

test("listAgents stops on has_more:false even when a cursor is still present", async () => {
  const h = harness([
    { json: { agents: [{ id: "a1" }], has_more: false, response_metadata: { next_cursor: "x" } } },
  ]);
  const agents = await h.client.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.url, `${BASE}/agents`);
});

test("a server repeating one cursor does not page forever", async () => {
  const h = harness([{ json: page([{ id: "a1" }], "same") }]);
  const agents = await h.client.listAgents();
  // First page, then the page named by "same", then the guard trips.
  assert.equal(h.calls.length, 2);
  assert.equal(agents.length, 2);
});

test("listAgentsPage returns the raw page, cursor metadata included", async () => {
  const h = harness([{ json: page([{ id: "a1" }], "cur-2") }]);
  const result = await h.client.listAgentsPage({ cursor: "cur-1" });
  assert.equal(result.has_more, true);
  assert.equal(result.response_metadata?.next_cursor, "cur-2");
  assert.equal(h.calls[0]?.url, `${BASE}/agents?cursor=cur-1`);
});

test("a non-2xx raises the typed error with status and body", async () => {
  const h = harness([{ status: 400, text: '{"error":"voice is required"}' }]);
  await assert.rejects(
    () => h.client.createAgent(MINIMAL),
    (err: unknown) => {
      assert.ok(err instanceof VoiceAgentApiError);
      assert.equal(err.name, "VoiceAgentApiError");
      assert.equal(err.status, 400);
      assert.match(err.body, /voice is required/);
      assert.equal(err.url, `${BASE}/agents`);
      // The key travels in a header and must never reach an error or a log.
      assert.ok(!err.message.includes(KEY));
      assert.ok(!err.body.includes(KEY));
      return true;
    },
  );
});

test("a 404 on delete surfaces rather than being swallowed with the body", async () => {
  const h = harness([{ status: 404, text: "not found" }]);
  await assert.rejects(
    () => h.client.deleteAgent("gone"),
    (err: unknown) => {
      assert.ok(err instanceof VoiceAgentApiError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("a 429 is waited out for exactly the Retry-After the server gave", async () => {
  const h = harness([
    { status: 429, headers: { "retry-after": "7" }, text: "slow down" },
    { json: { id: "agent-1", name: "x" } },
  ]);

  const agent = await h.client.createAgent(MINIMAL);
  assert.equal(agent.id, "agent-1");
  assert.deepEqual(h.sleeps, [7000]);
  assert.equal(h.calls.length, 2);
});

test("a persistent 429 surfaces once the retry budget is spent", async () => {
  const h = harness([{ status: 429, text: "rate limited" }], 2);

  await assert.rejects(
    () => h.client.listAgentsPage(),
    (err: unknown) => {
      assert.ok(err instanceof VoiceAgentApiError);
      assert.equal(err.status, 429);
      return true;
    },
  );
  assert.equal(h.calls.length, 3);
  // No Retry-After header: it falls back to its own wait rather than hammering.
  assert.equal(h.sleeps.length, 2);
  assert.ok(h.sleeps.every((ms) => ms > 0));
});

test("an aborted signal stops the request before it is sent", async () => {
  const h = harness([{ json: { id: "never", name: "x" } }]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => h.client.getAgent("agent-1", controller.signal),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    },
  );
  assert.equal(h.calls.length, 0);
});

test("the default NeuraCall agent runs at 24000 Hz on both sides", () => {
  const def = defaultNeuraCallAgent();
  assert.equal(def.input?.format?.sampleRate, VOICE_AGENT_SAMPLE_RATE);
  assert.equal(def.output?.format?.sampleRate, VOICE_AGENT_SAMPLE_RATE);

  const wire = toWireDefinition(def);
  assert.equal(wire.input.format.sample_rate, 24000);
  assert.equal(wire.output.format.sample_rate, 24000);
  assert.equal(wire.input.format.encoding, "audio/pcm");
  assert.equal(wire.output.format.encoding, "audio/pcm");
});

test("the default agent barges in and greets", () => {
  const def = defaultNeuraCallAgent();
  assert.equal(def.input?.turnDetection?.interruptResponse, true);
  assert.equal(def.greeting, DEFAULT_AGENT_GREETING);
  assert.equal(def.systemPrompt, DEFAULT_AGENT_SYSTEM_PROMPT);
  assert.ok(isVoiceId(def.voice));
  // The prompt is for speech, so it must ask for short turns and no markdown.
  assert.match(def.systemPrompt, /short sentences/);
  assert.match(def.systemPrompt, /no markdown/);
});

test("default agent options override without losing the pinned rate", () => {
  const def = defaultNeuraCallAgent({
    name: "Shop line",
    voice: "estelle",
    greeting: "Bonjour.",
    extraInstructions: "The shop closes at 18:00.",
    keyterms: ["NeuraCall"],
  });
  assert.equal(def.name, "Shop line");
  assert.equal(def.voice, "estelle");
  assert.equal(def.greeting, "Bonjour.");
  assert.match(def.systemPrompt, /closes at 18:00/);
  assert.ok(def.systemPrompt.startsWith(DEFAULT_AGENT_SYSTEM_PROMPT));
  assert.deepEqual(def.input?.keyterms, ["NeuraCall"]);
  assert.equal(toWireDefinition(def).input.format.sample_rate, 24000);
});

test("the voice table covers every id and carries language and accent", () => {
  assert.equal(VOICES.length, VOICE_IDS.length);
  assert.equal(new Set(VOICE_IDS).size, VOICE_IDS.length);
  assert.deepEqual([...VOICE_IDS].sort(), [
    "alba",
    "anna",
    "charles",
    "estelle",
    "eve",
    "george",
    "giovanni",
    "jane",
    "jean",
    "juergen",
    "lola",
    "mary",
    "michael",
    "paul",
    "rafael",
    "vera",
  ]);
  const paul = VOICES.find((v) => v.id === "paul");
  assert.deepEqual(paul, { id: "paul", language: "English", languageCode: "en-GB", accent: "UK" });
  const lola = VOICES.find((v) => v.id === "lola");
  assert.equal(lola?.language, "Spanish");
  assert.ok(VOICES.every((v) => v.language !== "" && v.languageCode !== ""));
});

test("isVoiceId rejects anything the API would 400 on", () => {
  assert.equal(isVoiceId("eve"), true);
  assert.equal(isVoiceId("Eve"), false);
  assert.equal(isVoiceId("nova"), false);
  assert.equal(isVoiceId("toString"), false);
});

test("the host follows the config's region rather than a hardcoded one", async () => {
  const calls: string[] = [];
  const config = adminConfig();
  config.voiceAgent.restBaseUrl = "https://agents.eu.assemblyai.com/v1";
  const client = new VoiceAgentAdminClient(config, {
    fetchFn: async (url) => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    },
  });
  await client.listAgentsPage();
  assert.equal(calls[0], "https://agents.eu.assemblyai.com/v1/agents");
});

test("the base URL can be overridden for a proxy, trailing slash and all", async () => {
  const calls: string[] = [];
  const client = new VoiceAgentAdminClient(adminConfig(), {
    baseUrl: "https://proxy.internal/agents-api/v1/",
    fetchFn: async (url) => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    },
  });
  await client.getAgent("agent-1");
  assert.equal(calls[0], "https://proxy.internal/agents-api/v1/agents/agent-1");
});
