import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig, Region } from "@neuracall/config";
import {
  DEFAULT_SUMMARY_PROMPT,
  LlmGatewayClient,
  LlmGatewayError,
  firstMessageContent,
  llmGatewayBaseUrl,
  type ChatMessage,
} from "../src/llmGateway.js";
import { testConfig } from "./mockA2I.js";

/** The gateway model is caller-supplied on purpose; tests pick an arbitrary id. */
const MODEL = "claude-sonnet-4-5-20250929";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface Canned {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function completion(content: string): unknown {
  return {
    id: "chatcmpl-1",
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  };
}

function harness(responses: Canned[], config: AppConfig = testConfig()) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let i = 0;

  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const canned = responses[Math.min(i, responses.length - 1)];
    i += 1;
    assert.ok(canned, `no canned response for request ${i}`);
    return new Response(canned.text ?? JSON.stringify(canned.json ?? {}), {
      status: canned.status ?? 200,
      headers: canned.headers ?? {},
    });
  };

  return {
    calls,
    sleeps,
    client: new LlmGatewayClient(config, {
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
  };
}

function configForRegion(region: Region): AppConfig {
  const base = testConfig();
  return { ...base, assemblyai: { ...base.assemblyai, region } };
}

test("the gateway host is derived from the region, US and EU separately", () => {
  assert.equal(llmGatewayBaseUrl("us"), "https://llm-gateway.assemblyai.com");
  assert.equal(llmGatewayBaseUrl("eu"), "https://llm-gateway.eu.assemblyai.com");
  // "edge" is US REST plus geo-routed streaming; the gateway follows REST.
  assert.equal(llmGatewayBaseUrl("edge"), "https://llm-gateway.assemblyai.com");
});

test("a US config posts to the US gateway", async () => {
  const h = harness([{ json: completion("summary") }], configForRegion("us"));
  await h.client.summarize("transcript", { model: MODEL });
  assert.equal(h.calls[0]?.url, "https://llm-gateway.assemblyai.com/v1/chat/completions");
});

test("an EU config keeps call data in the EU gateway", async () => {
  const h = harness([{ json: completion("résumé") }], configForRegion("eu"));
  await h.client.summarize("transcript", { model: MODEL });
  assert.equal(h.calls[0]?.url, "https://llm-gateway.eu.assemblyai.com/v1/chat/completions");
});

test("an edge config falls back to the US gateway", async () => {
  const h = harness([{ json: completion("summary") }], configForRegion("edge"));
  await h.client.summarize("transcript", { model: MODEL });
  assert.equal(h.calls[0]?.url, "https://llm-gateway.assemblyai.com/v1/chat/completions");
});

test("the raw api key is sent with no Bearer prefix", async () => {
  const h = harness([{ json: completion("summary") }]);
  await h.client.chat({ model: MODEL, messages: [{ role: "user", content: "hi" }] });

  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["authorization"], "test-not-a-real-key");
  assert.ok(!/^bearer\s/i.test(call.headers["authorization"] ?? ""));
  assert.equal(call.headers["content-type"], "application/json");
});

test("summarize sends a system prompt plus the transcript, and returns the text", async () => {
  const h = harness([{ json: completion("Caller wanted a refund; agent agreed.") }]);

  const summary = await h.client.summarize("Speaker A: Hello?\nSpeaker B: Hi.", {
    model: MODEL,
    maxTokens: 300,
  });
  assert.equal(summary, "Caller wanted a refund; agent agreed.");

  const body = h.calls[0]?.body;
  assert.ok(body);
  assert.equal(body["model"], MODEL);
  assert.equal(body["max_tokens"], 300);
  const messages = body["messages"] as ChatMessage[];
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, DEFAULT_SUMMARY_PROMPT);
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[1]?.content, "Speaker A: Hello?\nSpeaker B: Hi.");
});

test("a caller's system prompt replaces the default", async () => {
  const h = harness([{ json: completion("ok") }]);
  await h.client.summarize("t", { model: MODEL, systemPrompt: "List only the action items." });
  const messages = h.calls[0]?.body["messages"] as ChatMessage[];
  assert.equal(messages[0]?.content, "List only the action items.");
});

test("optional generation parameters are omitted unless set", async () => {
  const h = harness([{ json: completion("ok") }, { json: completion("ok") }]);

  await h.client.chat({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(Object.keys(h.calls[0]?.body ?? {}).sort(), ["messages", "model"]);

  await h.client.chat({
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 64,
    temperature: 0.2,
  });
  assert.equal(h.calls[1]?.body["temperature"], 0.2);
  assert.equal(h.calls[1]?.body["max_tokens"], 64);
});

test("a 429 is waited out for the Retry-After the server gave", async () => {
  const h = harness([
    { status: 429, headers: { "retry-after": "12" }, text: "rate limited" },
    { json: completion("late but fine") },
  ]);

  const summary = await h.client.summarize("t", { model: MODEL });
  assert.equal(summary, "late but fine");
  assert.deepEqual(h.sleeps, [12_000]);
  assert.equal(h.calls.length, 2);
});

test("a persistent 429 surfaces once the retry budget is spent", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const c = new LlmGatewayClient(testConfig(), {
    fetchFn: async (url) => {
      calls.push(url);
      return new Response("rate limited", { status: 429 });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxRateLimitRetries: 2,
  });

  await assert.rejects(
    () => c.chat({ model: MODEL, messages: [] }),
    (err: unknown) => {
      assert.ok(err instanceof LlmGatewayError);
      assert.equal(err.status, 429);
      return true;
    },
  );
  assert.equal(calls.length, 3);
  // No Retry-After header: it falls back to its own wait rather than hammering.
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms > 0));
});

test("a non-2xx carries the status and body", async () => {
  const h = harness([{ status: 400, text: "model 'nope' not found" }]);
  await assert.rejects(
    () => h.client.chat({ model: "nope", messages: [] }),
    (err: unknown) => {
      assert.ok(err instanceof LlmGatewayError);
      assert.equal(err.status, 400);
      assert.match(err.body, /not found/);
      return true;
    },
  );
});

test("an aborted signal stops the request before it is sent", async () => {
  const h = harness([{ json: completion("never") }]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => h.client.chat({ model: MODEL, messages: [], signal: controller.signal }),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    },
  );
  assert.equal(h.calls.length, 0);
});

test("an abort during the 429 backoff is not retried away", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const c = new LlmGatewayClient(testConfig(), {
    fetchFn: async (url) => {
      calls.push(url);
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    },
    sleep: async () => {
      controller.abort();
    },
  });

  await assert.rejects(
    () => c.chat({ model: MODEL, messages: [], signal: controller.signal }),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    },
  );
  assert.equal(calls.length, 1, "no second attempt after the abort");
});

test("the caller's signal is composed into the fetch signal, so an in-flight call can still be cancelled", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | null | undefined;
  const c = new LlmGatewayClient(testConfig(), {
    fetchFn: (_url, init) =>
      // Never resolves; the only way out is the composed signal aborting.
      new Promise<Response>((_resolve, reject) => {
        seen = init?.signal;
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  });

  const pending = c.chat({ model: MODEL, messages: [], signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  assert.ok(seen instanceof AbortSignal, "fetch receives a real signal");
  // Since committing to AbortSignal.any the signal is composite, not the
  // caller's own instance — the caller's abort must still abort it.
  assert.notEqual(seen, controller.signal);

  controller.abort();
  await assert.rejects(pending, (err: unknown) => {
    assert.equal((err as Error).name, "AbortError");
    return true;
  });
});

test("a caller abort wins over a fetch that never settles", async () => {
  const controller = new AbortController();
  const c = new LlmGatewayClient(testConfig(), {
    fetchFn: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  });

  const pending = c.chat({ model: MODEL, messages: [], signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, (err: unknown) => {
    assert.equal((err as Error).name, "AbortError");
    return true;
  });
});

test("chat() composes AbortSignal.timeout(30s) into the fetch signal, with or without a caller signal", async () => {
  const original = globalThis.AbortSignal.timeout;
  const calls: Array<[number, ...unknown[]]> = [];
  const signature = original.bind(AbortSignal);
  globalThis.AbortSignal.timeout = (...args: Parameters<typeof original>) => {
    calls.push(args);
    return signature(...args);
  };
  const signals: Array<AbortSignal | null | undefined> = [];
  const c = new LlmGatewayClient(testConfig(), {
    fetchFn: (_url, init) => {
      signals.push(init?.signal);
      return Promise.resolve(new Response(JSON.stringify(completion("ok")), { status: 200 }));
    },
  });

  try {
    await c.chat({ model: MODEL, messages: [] });
    await c.chat({ model: MODEL, messages: [], signal: new AbortController().signal });
  } finally {
    globalThis.AbortSignal.timeout = original;
  }

  // The 30s bound is always part of the composite (or the whole signal for a
  // bare call), so an uncredited reply cannot hold the process open forever.
  assert.equal(calls.length, 2, "a deadline is composed per attempt");
  assert.deepEqual(calls.map(([ms]) => ms), [30_000, 30_000]);
  assert.ok(signals.every((s) => s instanceof AbortSignal));
});

test("a completion with no choices yields an empty string, not a crash", () => {
  assert.equal(firstMessageContent({ choices: [] }), "");
  assert.equal(
    firstMessageContent({
      choices: [{ index: 0, message: { role: "assistant", content: "text" } }],
    }),
    "text",
  );
});

test("the base URL can be overridden without touching the region", async () => {
  const calls: string[] = [];
  const c = new LlmGatewayClient(testConfig(), {
    baseUrl: "https://proxy.internal/gw/",
    fetchFn: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(completion("ok")), { status: 200 });
    },
  });
  await c.chat({ model: MODEL, messages: [] });
  assert.equal(calls[0], "https://proxy.internal/gw/v1/chat/completions");
});
