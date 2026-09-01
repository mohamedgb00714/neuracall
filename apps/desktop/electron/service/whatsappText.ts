/**
 * The WhatsApp text bridge, as the desktop app hosts it.
 *
 * `@neuracall/whatsapp` is deliberately transport-shaped and opens nothing:
 * inbound is not a connection this process makes, it is Meta POSTing to a URL
 * the *host* owns. This file is that host — the HTTP route, the agent, and the
 * lifecycle that ties both to the app's own.
 *
 * Three constraints shaped it:
 *
 *  - **It is inert unless configured.** `getWhatsAppConfig` returning null
 *    means no listener, no port, no router — one log line and nothing else. A
 *    desktop app that opened a socket for a feature the operator never asked
 *    for would be an unannounced attack surface on their machine, which is the
 *    whole reason text is opt-in.
 *  - **The signature is checked over the bytes that arrived.** See
 *    `handleWebhook` below; this is the single detail that decides whether the
 *    endpoint is authenticated or merely appears to be.
 *  - **It binds loopback.** Meta must reach the callback URL from the public
 *    internet, but *how* is the operator's deployment decision — a tunnel, or a
 *    reverse proxy that terminates TLS. Binding 0.0.0.0 on their behalf would
 *    publish an unauthenticated-until-verified endpoint to every device on the
 *    LAN without anyone choosing it, so the host is configurable and the
 *    default is 127.0.0.1.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "@neuracall/config";
import { LlmGatewayClient, firstMessageContent } from "@neuracall/aai-client";
import {
  LlmCallAgent,
  OpenAiCompatibleLlmClient,
  type LlmClient,
  type LlmRequest,
  type SynthesizedSpeech,
  type TtsClient,
} from "@neuracall/agent";
import {
  CloudApiTransport,
  TextMessageRouter,
  getWhatsAppConfig,
  type InboundTextMessage,
  type TextAgent,
  type WhatsAppTextConfig,
} from "@neuracall/whatsapp";

/** Value `.env.example` ships for every unset key; treat it as unconfigured. */
const PLACEHOLDER = "replace-me";

/**
 * Fallback model on the LLM Gateway. This account is entitled to exactly one
 * id; every other one comes back as HTTP 400 "Your account does not have
 * access to this LLM Gateway model", so this is a working default rather than
 * a preference. `WHATSAPP_TEXT_MODEL` overrides it when the entitlement grows.
 */
const GATEWAY_MODEL = "qwen3.5-4b-32k-fast";

/** Loopback. Overridden with WHATSAPP_WEBHOOK_HOST — see the header comment. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * Default webhook port. A fixed default is safe *because* the bind is
 * loopback-only: it is the address an operator points their tunnel at, not
 * something the internet can reach on its own.
 */
const DEFAULT_PORT = 8787;

/** Default callback path. Must match the URL configured in the Meta app. */
const DEFAULT_PATH = "/whatsapp/webhook";

/**
 * Cap on a webhook body. Meta's deliveries are a few kilobytes; anything past
 * this is not a message and must not be buffered on the strength of a
 * signature that has not been checked yet.
 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * The agent is writing, not speaking, so the voice-oriented default prompt in
 * `LlmCallAgent` would be wrong here — it tells the model to spell numbers out
 * loud and keep to a sentence or two of speech.
 */
const DEFAULT_TEXT_SYSTEM_PROMPT = [
  "You are answering WhatsApp messages on behalf of this business.",
  "Your replies are read, not spoken, so keep them to a few short sentences.",
  "Write plain conversational text: no markdown, no headings, no bullet lists.",
  "Answer only from what you know; if you do not know something, say so plainly and offer to take a message.",
].join(" ");

/** Which brain is answering, for the status line. */
export type WhatsAppAgentKind = "llm" | "gateway" | "external" | "none";

export interface WhatsAppTextServiceOptions {
  /** Supplies the AssemblyAI key the gateway fallback runs on, and LLM_API_KEY/LLM_MODEL. */
  config: AppConfig;
  /** Environment the feature is read from. Tests pass their own object. */
  env?: NodeJS.ProcessEnv;
  /** Overrides WHATSAPP_WEBHOOK_PORT. Tests pass 0 for an ephemeral port. */
  port?: number;
  /** Overrides WHATSAPP_WEBHOOK_HOST. */
  host?: string;
  /** Replaces the built-in agent entirely. Reported as "external". */
  agent?: TextAgent;
  /** OpenAI-compatible API root for the composed LLM path. */
  llmBaseUrl?: string;
  /**
   * The agent's persona, when the operator has one. Outranked by
   * WHATSAPP_TEXT_SYSTEM_PROMPT and falling back to a text-shaped default,
   * because the runtime passes the voice prompt here.
   */
  systemPrompt?: string;
  /** Injected so tests never reach the network. */
  fetchFn?: typeof fetch;
  /** Operator-visible log. Defaults to the console. */
  onLog?: (line: string, isError?: boolean) => void;
}

export interface WhatsAppTextStatus {
  /** True once the listener is bound and messages are being answered. */
  enabled: boolean;
  /** Whether WHATSAPP_* credentials are present at all. */
  configured: boolean;
  /** Where the webhook is bound, or null when nothing is listening. */
  url: string | null;
  /** Why it will not answer, or empty when it will. */
  degraded: string[];
  agent: WhatsAppAgentKind;
  /** Deliveries accepted, replies sent, redeliveries dropped, failures. */
  delivered: number;
  replied: number;
  duplicates: number;
  errors: number;
}

/**
 * A TtsClient that synthesises nothing.
 *
 * `LlmCallAgent` is the shared brain and always builds a spoken reply, but this
 * one is typed into a chat window. `SilentTts` would allocate a silence buffer
 * sized to the reply — real memory for audio nobody will ever play.
 */
class NoSpeechTts implements TtsClient {
  async synthesize(): Promise<SynthesizedSpeech> {
    return { pcm: new Uint8Array(0), sampleRate: 16000, channels: 1 };
  }
}

/**
 * The AssemblyAI LLM Gateway behind the agent's `LlmClient` port.
 *
 * This is what makes text work out of the box: the Voice Agent path needs no
 * `LLM_API_KEY`, so the default install has none, and an agent that silently
 * never replies is the exact failure the Voice Agent work just removed from
 * the voice path. The gateway bills the AssemblyAI key the app already
 * requires.
 */
class LlmGatewayTextClient implements LlmClient {
  constructor(
    private readonly gateway: LlmGatewayClient,
    private readonly model: string,
  ) {}

  async complete(request: LlmRequest): Promise<string> {
    const completion = await this.gateway.chat({
      model: this.model,
      messages: request.messages,
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return firstMessageContent(completion);
  }
}

/** Answers nothing. Used when no key at all is available to answer with. */
class SilentTextAgent implements TextAgent {
  async onFinalTurn(): Promise<null> {
    return null;
  }
}

/**
 * Hosts the WhatsApp text bridge for the desktop app: an HTTP route for Meta's
 * webhook, the Cloud API transport behind it, and the agent that answers.
 *
 * Built eagerly (so status can be reported before anything is bound) but inert
 * until `start()`, and inert forever when the feature is unconfigured.
 */
export class WhatsAppTextService {
  private readonly opts: WhatsAppTextServiceOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly path: string;
  private readonly host: string;
  /** null when WHATSAPP_WEBHOOK_PORT is set to something that is not a port. */
  private readonly port: number | null;
  private readonly whatsapp: WhatsAppTextConfig | null;
  /** A half-configured environment: recorded, never thrown at the app. */
  private readonly configError: string | null;
  private readonly agentKind: WhatsAppAgentKind;
  private readonly agentNote: string | null;

  private transport: CloudApiTransport | null = null;
  private router: TextMessageRouter | null = null;
  private server: Server | null = null;
  /**
   * An in-flight `start()`. The runtime starts this bridge fire-and-forget
   * (`void start()`), so a `stop()` can arrive while the bind is still landing;
   * without something to await, the close would find no server, return, and the
   * bind would then succeed into an object nobody holds a reference to — a
   * listener still answering webhooks that no later `stop()` can reach.
   */
  private starting: Promise<void> | null = null;
  private boundPort = 0;
  private delivered = 0;
  private replied = 0;
  private duplicates = 0;
  private errors = 0;

  constructor(opts: WhatsAppTextServiceOptions) {
    this.opts = opts;
    this.env = opts.env ?? process.env;

    // A partly-set environment is a deployment mistake `getWhatsAppConfig`
    // throws on. Answering calls must not depend on the text credentials being
    // right, so it becomes a degraded reason instead of a failed launch.
    let whatsapp: WhatsAppTextConfig | null = null;
    let configError: string | null = null;
    try {
      whatsapp = getWhatsAppConfig(this.env);
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
    this.whatsapp = whatsapp;
    this.configError = configError;

    this.host = opts.host ?? text(this.env, "WHATSAPP_WEBHOOK_HOST") ?? DEFAULT_HOST;
    this.path = normalisePath(text(this.env, "WHATSAPP_WEBHOOK_PATH") ?? DEFAULT_PATH);
    this.port = opts.port ?? parsePort(text(this.env, "WHATSAPP_WEBHOOK_PORT"));

    const chosen = this.chooseAgentKind();
    this.agentKind = chosen.kind;
    this.agentNote = chosen.note;
  }

  /** Whether the WHATSAPP_* credentials are present. */
  get configured(): boolean {
    return this.whatsapp !== null;
  }

  /** Base URL of the bound listener, or null while nothing is listening. */
  get url(): string | null {
    if (!this.server?.listening) return null;
    const host = this.host.includes(":") ? `[${this.host}]` : this.host;
    return `http://${host}:${this.boundPort}${this.path}`;
  }

  /**
   * Bind the webhook and start answering. Never throws: a port already in use
   * must cost the operator their text bridge, not their phone calls.
   */
  async start(): Promise<void> {
    if (this.server) return;
    // Concurrent callers share one bind rather than racing two onto the port.
    this.starting ??= this.open().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async open(): Promise<void> {
    const config = this.whatsapp;
    if (!config) {
      // The single line requirement 1 allows: enough for an operator to see
      // why nothing happens, and no port, no listener, no router behind it.
      this.log(
        this.configError ??
          "WhatsApp text is off (no WHATSAPP_* credentials) — no webhook port is opened.",
        this.configError !== null,
      );
      return;
    }
    if (this.port === null) {
      this.log(
        `WHATSAPP_WEBHOOK_PORT is not a valid port (${String(this.env["WHATSAPP_WEBHOOK_PORT"])}) — the webhook is not listening.`,
        true,
      );
      return;
    }

    const transport = new CloudApiTransport({
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      ...(config.appSecret !== undefined ? { appSecret: config.appSecret } : {}),
      ...(config.verifyToken !== undefined ? { verifyToken: config.verifyToken } : {}),
      ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
      ...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
      onError: (err) => {
        this.errors += 1;
        this.log(err.message, true);
      },
    });

    const lineId = text(this.env, "WHATSAPP_DEVICE_ID") ?? `whatsapp:${config.phoneNumberId}`;
    const router = new TextMessageRouter({
      agent: this.buildAgent(),
      transport,
      deviceId: lineId,
      // One device is one line, so the package's default gives every contact
      // texting this number the *same* conversation — continuous with a voice
      // call on that line, and cross-talk the moment two customers write in at
      // once. The desktop app cannot know which handset owns this number, so
      // it takes the safe half of that trade: a thread per contact.
      conversationDeviceId: (msg: InboundTextMessage) => `${lineId}:${msg.from}`,
      onReply: () => {
        this.replied += 1;
      },
      onDuplicate: () => {
        this.duplicates += 1;
      },
      onError: (msg, err) => {
        this.errors += 1;
        this.log(`reply to ${msg.from} failed: ${err.message}`, true);
      },
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // The handler owns every failure: an exception escaping here becomes an
      // 'uncaughtException' and takes the whole app — calls included — down.
      void this.handle(req, res).catch((err: unknown) => {
        this.errors += 1;
        this.log(`webhook handler failed: ${String(err)}`, true);
        if (!res.headersSent) send(res, 500, "error\n");
        else res.end();
      });
    });

    this.transport = transport;
    this.router = router;

    try {
      // Subscribing costs nothing until the bind below lets traffic in, and
      // keeping both inside the try is what makes `start()` genuinely
      // non-throwing for the runtime's fire-and-forget call.
      await router.start();
      await listen(server, this.port, this.host);
      this.server = server;
      this.boundPort = boundPortOf(server, this.port);
      this.log(`webhook listening on ${this.url}`);
      for (const reason of this.status().degraded) this.log(reason, true);
    } catch (err) {
      this.transport = null;
      this.router = null;
      await router.stop().catch(() => undefined);
      this.log(`webhook failed to bind on ${this.host}:${this.port}: ${String(err)}`, true);
    }
  }

  /** Close the listener and let the turns already in flight finish. */
  async stop(): Promise<void> {
    // Let a bind that is still in flight land first, so there is a server here
    // to close; see `starting`.
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = null;
    if (server) await close(server);
    await this.router?.stop().catch(() => undefined);
    this.router = null;
    this.transport = null;
  }

  /** Wait for every message already accepted to be answered. */
  async drain(): Promise<void> {
    await this.router?.drain();
  }

  status(): WhatsAppTextStatus {
    const degraded: string[] = [];
    if (this.configError) degraded.push(this.configError);
    else if (!this.whatsapp) {
      degraded.push(
        "WhatsApp text is off — set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID to turn it on.",
      );
    } else {
      if (this.port === null) {
        degraded.push("WHATSAPP_WEBHOOK_PORT is not a valid port — the webhook cannot bind.");
      }
      if (!this.whatsapp.appSecret) {
        degraded.push(
          "WHATSAPP_APP_SECRET is not set — inbound messages are rejected, because an unsigned " +
            "delivery cannot be told from anyone on the internet posting as this business.",
        );
      }
      if (!this.whatsapp.verifyToken) {
        degraded.push(
          "WHATSAPP_VERIFY_TOKEN is not set — Meta's subscription handshake will be refused.",
        );
      }
      if (this.agentNote) degraded.push(this.agentNote);
    }

    return {
      enabled: this.server?.listening === true,
      configured: this.whatsapp !== null,
      url: this.url,
      degraded,
      agent: this.agentKind,
      delivered: this.delivered,
      replied: this.replied,
      duplicates: this.duplicates,
      errors: this.errors,
    };
  }

  // ------------------------------------------------------------- routing

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (normalisePath(url.pathname) !== this.path) {
      send(res, 404, "not found\n");
      return;
    }

    if (req.method === "GET") {
      this.challenge(url, res);
      return;
    }
    if (req.method === "POST") {
      await this.deliver(req, res);
      return;
    }

    res.setHeader("allow", "GET, POST");
    send(res, 405, "method not allowed\n");
  }

  /** Meta's subscription handshake: echo `hub.challenge`, or refuse. */
  private challenge(url: URL, res: ServerResponse): void {
    const challenge = this.transport?.verifyChallenge({
      "hub.mode": url.searchParams.get("hub.mode") ?? undefined,
      "hub.challenge": url.searchParams.get("hub.challenge") ?? undefined,
      "hub.verify_token": url.searchParams.get("hub.verify_token") ?? undefined,
    });
    if (challenge === null || challenge === undefined) {
      // A wrong token is someone probing the endpoint, so it gets no detail.
      send(res, 403, "forbidden\n");
      return;
    }
    send(res, 200, challenge);
  }

  /** One webhook delivery. */
  private async deliver(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      send(res, 503, "not ready\n");
      return;
    }

    // THE detail this whole file exists to get right: the signature covers the
    // *bytes Meta sent*, so they are buffered here and handed over untouched.
    // Parsing first and re-serialising `JSON.stringify(body)` produces a
    // different byte string — key order, spacing and unicode escaping all
    // change — so the HMAC would never match, and "fixing" that by hashing the
    // re-serialised form instead verifies our own output rather than Meta's,
    // which authenticates nobody. Nothing may read this body before the check.
    const raw = await readRawBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      // The unread remainder of the body makes this connection unusable for a
      // second request, so it is closed — but only once the 413 has actually
      // been written, which is the whole reason the body reader did not
      // destroy it itself.
      res.setHeader("connection", "close");
      res.once("finish", () => req.destroy());
      send(res, 413, "payload too large\n");
      return;
    }

    const result = transport.handleWebhook(raw, headerOf(req, CloudApiTransport.signatureHeader));
    if (!result.accepted) {
      // "no-app-secret" and "bad-signature" are both a refusal to trust the
      // sender; a body that will never parse is the sender's mistake.
      send(res, result.reason === "malformed-body" ? 400 : 403, "forbidden\n");
      return;
    }

    this.delivered += 1;
    // 200 now, work afterwards. Meta redelivers anything that is not 2xx for up
    // to seven days, so waiting for the agent — or reporting its failure as a
    // 500 — turns one slow or poisonous message into a retry storm. The
    // transport has already dispatched to the router, which remembers the
    // message id before it asks the agent and never rejects, so a throwing
    // agent is an `onError` line here and one unanswered message there.
    send(res, 200, "EVENT_RECEIVED");
  }

  // -------------------------------------------------------------- agent

  /**
   * Pick the brain. The composed LLM wins when the operator configured one;
   * otherwise the LLM Gateway keeps text working on the AssemblyAI key.
   */
  private chooseAgentKind(): { kind: WhatsAppAgentKind; note: string | null } {
    if (this.opts.agent) return { kind: "external", note: null };

    const { apiKey, model } = this.opts.config.llm;
    if (apiKey && model && model !== PLACEHOLDER) return { kind: "llm", note: null };

    if (this.opts.config.assemblyai.apiKey) {
      return {
        kind: "gateway",
        note: null,
      };
    }
    return {
      kind: "none",
      note:
        "No LLM and no AssemblyAI key — WhatsApp messages are received and acknowledged " +
        "but nothing answers them.",
    };
  }

  private buildAgent(): TextAgent {
    if (this.opts.agent) return this.opts.agent;
    const llm = this.buildLlmClient();
    if (!llm) return new SilentTextAgent();
    return new LlmCallAgent({
      llm,
      tts: new NoSpeechTts(),
      // The text-specific prompt outranks the caller's: the runtime passes the
      // *voice* persona from settings, and that is the prompt this file exists
      // to not use verbatim — it is written for something spoken aloud. An
      // operator who set WHATSAPP_TEXT_SYSTEM_PROMPT would otherwise find it
      // silently ignored on every install that has a voice prompt configured.
      systemPrompt:
        text(this.env, "WHATSAPP_TEXT_SYSTEM_PROMPT") ??
        this.opts.systemPrompt ??
        DEFAULT_TEXT_SYSTEM_PROMPT,
    });
  }

  private buildLlmClient(): LlmClient | null {
    const { llm, assemblyai } = this.opts.config;
    if (this.agentKind === "llm" && llm.apiKey) {
      return new OpenAiCompatibleLlmClient({
        apiKey: llm.apiKey,
        model: llm.model,
        ...(this.opts.llmBaseUrl ? { baseUrl: this.opts.llmBaseUrl } : {}),
        ...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
      });
    }
    if (this.agentKind === "gateway" && assemblyai.apiKey) {
      const gateway = new LlmGatewayClient(this.opts.config, {
        ...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
      });
      return new LlmGatewayTextClient(
        gateway,
        text(this.env, "WHATSAPP_TEXT_MODEL") ?? GATEWAY_MODEL,
      );
    }
    return null;
  }

  private log(line: string, isError = false): void {
    if (this.opts.onLog) {
      this.opts.onLog(line, isError);
      return;
    }
    if (isError) console.warn(`[whatsapp-text] ${line}`);
    else console.info(`[whatsapp-text] ${line}`);
  }
}

/** Buffer the request body, or null when it exceeds `limit`. */
function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop accumulating, but leave the socket alive: the refusal still has
        // to be written to it, and destroying here reaches the sender as a
        // connection reset instead of an answer. The caller closes it after.
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** A header as a single value; node hands duplicates over as an array. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Bind, reporting a failure to the caller rather than as an asynchronous
 * 'error' event nobody is listening for. Same shape as `createHealthServer`.
 */
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    // Keep-alive sockets otherwise hold the server open long past the point
    // the process wanted to exit.
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** The port actually bound; `port: 0` asked the kernel to choose one. */
function boundPortOf(server: Server, requested: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null
    ? (address as AddressInfo).port
    : requested;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Trailing slashes are the one normalisation worth doing on a callback URL. */
function normalisePath(path: string): string {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** A port, or null when the value is set but is not one. Absent means default. */
function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

/** An environment value that is actually set, placeholders excluded. */
function text(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const value = raw.trim();
  if (value === "" || value.includes(PLACEHOLDER)) return undefined;
  return value;
}
