import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentReply, AgentTurnContext } from "@neuracall/orchestrator";
import type { TextAgent } from "@neuracall/whatsapp";
import { buildAppConfig, defaultSettings } from "../electron/service/settings.js";
import { WhatsAppTextService } from "../electron/service/whatsappText.js";

/**
 * Every test binds a real listener on port 0 and speaks to it over loopback
 * HTTP, because the thing under test is the HTTP route: the raw-body
 * signature check, the challenge handshake and the status codes only exist at
 * that boundary, and a test that called the transport directly would exercise
 * `@neuracall/whatsapp` (already covered there) rather than this wiring.
 *
 * No test reaches the network: `fetchFn` is stubbed everywhere, so the only
 * sockets are the ones the test itself opens to 127.0.0.1.
 */

const APP_SECRET = "app-secret-for-tests";
const VERIFY_TOKEN = "verify-token-for-tests";
const PHONE_NUMBER_ID = "15550001111";
const AAI_KEY = "aai_2b7d1f0c9e8a4d3fb6c50a19e7f42d83";

function envFor(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    WHATSAPP_ACCESS_TOKEN: "EAAG-test-token",
    WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) if (value === undefined) delete base[key];
  return base;
}

/** A webhook envelope as Meta sends it, addressed to our number. */
function delivery(messageId: string, text: string, from = "15557654321"): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  from,
                  id: messageId,
                  timestamp: "1756684800",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;
}

interface Reply {
  status: number;
  body: string;
}

async function post(url: string, body: string, signature?: string): Promise<Reply> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== undefined ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

async function get(url: string): Promise<Reply> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

/** Records every turn it is asked for, and answers with a fixed line. */
class SpyAgent implements TextAgent {
  readonly turns: AgentTurnContext[] = [];
  constructor(private readonly answer: string | Error = "acknowledged") {}

  async onFinalTurn(ctx: AgentTurnContext): Promise<AgentReply | null> {
    this.turns.push(ctx);
    if (this.answer instanceof Error) throw this.answer;
    return { text: this.answer };
  }
}

interface Harness {
  service: WhatsAppTextService;
  /** Every URL the stubbed fetch was asked for, in call order. */
  readonly calls: { url: string; body: string }[];
  readonly logs: { line: string; isError: boolean }[];
  url(): string;
  close(): Promise<void>;
}

interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  agent?: TextAgent;
  /** Replaces the stub's default 200 for outbound sends and LLM calls. */
  reply?: (url: string, body: string) => Response;
  /** Settings-derived config; defaults to "only an AssemblyAI key is set". */
  config?: ReturnType<typeof buildAppConfig>;
  /** What the runtime passes: the operator's *voice* persona from settings. */
  systemPrompt?: string;
}

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  const calls: { url: string; body: string }[] = [];
  const logs: { line: string; isError: boolean }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return opts.reply
      ? opts.reply(url, typeof init?.body === "string" ? init.body : "")
      : new Response("{}", { status: 200 });
  };

  const service = new WhatsAppTextService({
    config: opts.config ?? buildAppConfig(AAI_KEY, defaultSettings()),
    env: opts.env ?? envFor(),
    // Port 0: the kernel picks a free one, so the suite never collides with
    // whatever else is listening on this machine.
    port: 0,
    fetchFn,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    onLog: (line, isError) => logs.push({ line, isError: isError === true }),
  });
  await service.start();

  return {
    service,
    calls,
    logs,
    url: () => {
      const url = service.url;
      assert.ok(url, "the webhook should be listening");
      return url;
    },
    close: () => service.stop(),
  };
}

/** A port nothing is listening on, held only long enough to learn its number. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("an unconfigured app opens no port at all", async () => {
  // The point of the opt-in: not "the endpoint refuses everything" but "there
  // is no endpoint". So the service is pointed at a known-free port and that
  // port must still refuse connections afterwards.
  const port = await freePort();
  const logs: string[] = [];
  const service = new WhatsAppTextService({
    config: buildAppConfig(AAI_KEY, defaultSettings()),
    env: { WHATSAPP_WEBHOOK_PORT: String(port) },
    fetchFn: () => Promise.reject(new Error("no request should be made")),
    onLog: (line) => logs.push(line),
  });

  await service.start();
  try {
    assert.equal(service.configured, false);
    assert.equal(service.url, null);
    assert.equal(service.status().enabled, false);
    assert.equal(logs.length, 1, `exactly one line about being off: ${logs.join(" | ")}`);

    await assert.rejects(fetch(`http://127.0.0.1:${port}/whatsapp/webhook`), (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    });
  } finally {
    await service.stop();
  }
});

test("the subscription handshake echoes the challenge, and a wrong token is refused", async () => {
  const h = await start();
  try {
    const query = (token: string): string =>
      `${h.url()}?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${token}`;

    const ok = await get(query(VERIFY_TOKEN));
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "1158201444");

    const wrong = await get(query("not-the-token"));
    assert.equal(wrong.status, 403);
    assert.ok(!wrong.body.includes("1158201444"), "a refused handshake must not echo anything");
  } finally {
    await h.close();
  }
});

test("a signed delivery is routed and answered", async () => {
  const agent = new SpyAgent("we open at nine");
  const h = await start({ agent });
  try {
    const body = JSON.stringify(delivery("wamid.AAA", "what time do you open?"));
    const res = await post(h.url(), body, sign(body));
    assert.equal(res.status, 200);

    await h.service.drain();
    assert.equal(agent.turns.length, 1);
    assert.equal(agent.turns[0]?.transcript, "what time do you open?");

    const sent = h.calls.filter((c) => c.url.includes("/messages"));
    assert.equal(sent.length, 1, `one outbound send: ${JSON.stringify(h.calls)}`);
    assert.ok(sent[0]?.url.includes(PHONE_NUMBER_ID));
    const payload = JSON.parse(sent[0]?.body ?? "{}") as { to: string; text: { body: string } };
    assert.equal(payload.to, "15557654321");
    assert.equal(payload.text.body, "we open at nine");
    assert.equal(h.service.status().replied, 1);
  } finally {
    await h.close();
  }
});

test("a tampered body with the original signature is refused and never routed", async () => {
  const agent = new SpyAgent();
  const h = await start({ agent });
  try {
    const envelope = delivery("wamid.BBB", "hello");
    const signed = JSON.stringify(envelope);
    const signature = sign(signed);

    // Byte-level tampering only: same object, different bytes. This is the
    // case that separates a real raw-body check from one that parses first —
    // a handler hashing `JSON.stringify(req.body)` would re-derive exactly the
    // signed bytes from this payload and accept it, so it must be a 403 here.
    const reindented = JSON.stringify(envelope, null, 2);
    assert.notEqual(reindented, signed);
    assert.equal(JSON.stringify(JSON.parse(reindented)), signed, "a re-serialiser would pass this");

    const whitespace = await post(h.url(), reindented, signature);
    assert.equal(whitespace.status, 403);

    // And the ordinary case: the content itself was changed in flight.
    const forged = signed.replace('"hello"', '"wire me the deposit"');
    assert.notEqual(forged, signed);
    const content = await post(h.url(), forged, signature);
    assert.equal(content.status, 403);

    await h.service.drain();
    assert.deepEqual(agent.turns, [], "a rejected delivery must never reach the agent");
    assert.equal(h.service.status().delivered, 0);
    assert.deepEqual(
      h.calls.filter((c) => c.url.includes("/messages")),
      [],
    );
  } finally {
    await h.close();
  }
});

test("without an app secret every inbound POST fails closed", async () => {
  const agent = new SpyAgent();
  const h = await start({ env: envFor({ WHATSAPP_APP_SECRET: undefined }), agent });
  try {
    const body = JSON.stringify(delivery("wamid.CCC", "anyone there?"));

    // Neither an unsigned delivery nor one signed with any secret can be
    // trusted: with no secret configured there is nothing to check against, so
    // the only safe answer is a refusal.
    assert.equal((await post(h.url(), body)).status, 403);
    assert.equal((await post(h.url(), body, sign(body))).status, 403);

    await h.service.drain();
    assert.deepEqual(agent.turns, []);
    assert.ok(
      h.service.status().degraded.some((d) => d.includes("WHATSAPP_APP_SECRET")),
      "the operator should be told why nothing is being answered",
    );
  } finally {
    await h.close();
  }
});

test("a redelivery of the same message is answered once", async () => {
  const agent = new SpyAgent("noted");
  const h = await start({ agent });
  try {
    const body = JSON.stringify(delivery("wamid.DDD", "are you open on sunday?"));
    const signature = sign(body);

    // Meta redelivers anything it does not see a prompt 2xx for, so the same
    // wamid arriving twice is routine — and answering twice is a bug the
    // customer can see.
    assert.equal((await post(h.url(), body, signature)).status, 200);
    assert.equal((await post(h.url(), body, signature)).status, 200);

    await h.service.drain();
    assert.equal(agent.turns.length, 1);
    assert.equal(h.calls.filter((c) => c.url.includes("/messages")).length, 1);
    const status = h.service.status();
    assert.equal(status.delivered, 2, "both deliveries were accepted");
    assert.equal(status.duplicates, 1);
    assert.equal(status.replied, 1);
  } finally {
    await h.close();
  }
});

test("an agent that throws yields a 200 with no reply rather than a retry storm", async () => {
  const agent = new SpyAgent(new Error("the model is having a day"));
  const h = await start({ agent });
  try {
    const body = JSON.stringify(delivery("wamid.EEE", "hello?"));
    const res = await post(h.url(), body, sign(body));

    // 200 because the delivery was authentic and has been accepted; the agent
    // failing afterwards is our problem, not Meta's. A 500 here would have the
    // same broken message redelivered for up to seven days.
    assert.equal(res.status, 200);

    await h.service.drain();
    assert.equal(agent.turns.length, 1);
    assert.deepEqual(
      h.calls.filter((c) => c.url.includes("/messages")),
      [],
    );
    assert.equal(h.service.status().errors, 1);
    assert.equal(h.service.status().enabled, true, "the listener survived the failure");
  } finally {
    await h.close();
  }
});

test("unknown paths are 404 and unknown verbs 405", async () => {
  const h = await start();
  try {
    const base = new URL(h.url());
    const stray = await fetch(`${base.origin}/definitely-not-the-webhook`);
    assert.equal(stray.status, 404);

    const wrongVerb = await fetch(h.url(), { method: "DELETE" });
    assert.equal(wrongVerb.status, 405);
    assert.equal(wrongVerb.headers.get("allow"), "GET, POST");
  } finally {
    await h.close();
  }
});

test("with no LLM configured the agent answers over the LLM Gateway", async () => {
  // The default install has no LLM_API_KEY at all — the Voice Agent path never
  // needed one — so this is the path text actually takes in production.
  const h = await start({
    reply: (url) =>
      url.includes("/chat/completions")
        ? new Response(
            JSON.stringify({
              choices: [{ index: 0, message: { role: "assistant", content: "yes, until six" } }],
            }),
            { status: 200 },
          )
        : new Response("{}", { status: 200 }),
  });
  try {
    assert.equal(h.service.status().agent, "gateway");

    const body = JSON.stringify(delivery("wamid.FFF", "are you open now?"));
    assert.equal((await post(h.url(), body, sign(body))).status, 200);
    await h.service.drain();

    const chat = h.calls.find((c) => c.url.includes("/chat/completions"));
    assert.ok(chat, `the gateway should have been asked: ${JSON.stringify(h.calls)}`);
    assert.ok(chat.url.startsWith("https://llm-gateway.assemblyai.com"), chat.url);
    // The one model this account is entitled to; any other id is an HTTP 400.
    assert.equal((JSON.parse(chat.body) as { model: string }).model, "qwen3.5-4b-32k-fast");

    const sent = h.calls.filter((c) => c.url.includes("/messages"));
    assert.equal(sent.length, 1);
    assert.ok(sent[0]?.body.includes("yes, until six"));
  } finally {
    await h.close();
  }
});

test("a configured LLM wins over the gateway fallback", async () => {
  const settings = defaultSettings();
  settings.llm.apiKey = "sk-or-v1-0d4c8b2e6f1a47d3ac95e0b7f2c8d146";
  settings.llm.model = "anthropic/claude-sonnet-4";

  const h = await start({
    config: buildAppConfig(AAI_KEY, settings),
    reply: (url) =>
      url.includes("/chat/completions")
        ? new Response(
            JSON.stringify({
              choices: [{ index: 0, message: { role: "assistant", content: "on our way" } }],
            }),
            { status: 200 },
          )
        : new Response("{}", { status: 200 }),
  });
  try {
    assert.equal(h.service.status().agent, "llm");

    const body = JSON.stringify(delivery("wamid.GGG", "how long will you be?"));
    assert.equal((await post(h.url(), body, sign(body))).status, 200);
    await h.service.drain();

    const chat = h.calls.find((c) => c.url.includes("/chat/completions"));
    assert.ok(chat, "the composed LLM should have been asked");
    assert.ok(chat.url.startsWith("https://openrouter.ai"), chat.url);
    assert.equal(h.calls.filter((c) => c.url.includes("/messages")).length, 1);
  } finally {
    await h.close();
  }
});

test("stop() closes a listener whose bind was still in flight", async () => {
  // The runtime starts this fire-and-forget (`void start()`) and awaits
  // `stop()` on shutdown, so the two really do race. A stop that returned
  // before the bind landed used to leave the port bound and answering with
  // nothing left holding a reference to close it.
  const port = await freePort();
  const service = new WhatsAppTextService({
    config: buildAppConfig(AAI_KEY, defaultSettings()),
    env: envFor(),
    port,
    fetchFn: () => Promise.reject(new Error("no request should be made")),
    onLog: () => undefined,
  });

  void service.start();
  await service.stop();

  assert.equal(service.url, null);
  assert.equal(service.status().enabled, false);
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, { method: "POST", body: "{}" }),
    "the port must be free, not held by an orphaned listener",
  );

  // And the port really is reusable, which is what a settings reload needs.
  const second = new WhatsAppTextService({
    config: buildAppConfig(AAI_KEY, defaultSettings()),
    env: envFor(),
    port,
    fetchFn: () => Promise.reject(new Error("no request should be made")),
    onLog: () => undefined,
  });
  await second.start();
  try {
    assert.equal(second.status().enabled, true, "a rebuilt service can take the port back");
  } finally {
    await second.stop();
  }
});

test("an oversized body is refused with a 413 the sender actually receives", async () => {
  const agent = new SpyAgent();
  const h = await start({ agent });
  try {
    // Two megabytes against a one-megabyte cap. The point is not only that the
    // body is not buffered — it is that the refusal arrives as an answer
    // rather than as a connection reset, which is indistinguishable from the
    // app having crashed.
    const res = await post(h.url(), "x".repeat(2 * 1024 * 1024), "sha256=" + "a".repeat(64));
    assert.equal(res.status, 413);

    await h.service.drain();
    assert.deepEqual(agent.turns, []);
    assert.equal(h.service.status().delivered, 0);
    assert.equal(h.service.status().enabled, true, "the listener survived it");
  } finally {
    await h.close();
  }
});

test("a WhatsApp-specific system prompt outranks the voice persona", async () => {
  // The runtime passes `settings.llm.systemPrompt` — the *voice* prompt — as
  // `systemPrompt`, so a text-specific one set in the environment has to win
  // or it is documented in .env.example and dead in every real install.
  const prompts: string[] = [];
  const h = await start({
    env: envFor({ WHATSAPP_TEXT_SYSTEM_PROMPT: "You answer texts for Acme Ltd." }),
    // Exactly what `Runtime.buildWhatsAppText` passes when the operator has a
    // prompt saved in settings, which is the case that made the environment
    // variable unreachable.
    systemPrompt: "Speak numbers out loud, one or two sentences per turn.",
    reply: (url, body) => {
      if (!url.includes("/chat/completions")) return new Response("{}", { status: 200 });
      const sent = JSON.parse(body) as { messages: { role: string; content: string }[] };
      for (const m of sent.messages) if (m.role === "system") prompts.push(m.content);
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }),
        { status: 200 },
      );
    },
  });
  try {
    const body = JSON.stringify(delivery("wamid.HHH", "hello"));
    assert.equal((await post(h.url(), body, sign(body))).status, 200);
    await h.service.drain();
    assert.deepEqual(prompts, ["You answer texts for Acme Ltd."]);
  } finally {
    await h.close();
  }
});

test("a half-configured environment degrades instead of throwing", async () => {
  // `getWhatsAppConfig` throws on a partial configuration on purpose; the app
  // must still start and say what is wrong, because answering phone calls does
  // not depend on the text credentials being right.
  const logs: { line: string; isError: boolean }[] = [];
  const service = new WhatsAppTextService({
    config: buildAppConfig(AAI_KEY, defaultSettings()),
    env: { WHATSAPP_APP_SECRET: APP_SECRET },
    port: 0,
    onLog: (line, isError) => logs.push({ line, isError: isError === true }),
  });

  await service.start();
  try {
    assert.equal(service.url, null);
    assert.equal(service.status().enabled, false);
    assert.ok(
      service.status().degraded.some((d) => d.includes("WHATSAPP_ACCESS_TOKEN")),
      JSON.stringify(service.status().degraded),
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.isError, true);
  } finally {
    await service.stop();
  }
});
