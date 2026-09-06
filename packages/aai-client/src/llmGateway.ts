/**
 * AssemblyAI LLM Gateway — the post-call summary path.
 *
 * This is what NeuraCall uses instead of `auto_chapters` and `summarization`
 * on `POST /v2/transcript`: both are deprecated (docs/DECISIONS.md §9), and
 * the replacement is to transcribe first and POST the transcript text here.
 * The upside is that the summary prompt is ours, so it can be changed without
 * re-transcribing the call.
 *
 * Auth is the same raw API key as the rest of the API, in `Authorization`
 * with **no `Bearer ` prefix** (§6). The gateway is billed per token on the
 * same account, so nothing extra needs configuring.
 *
 * The request shape is OpenAI-compatible: POST /v1/chat/completions.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig, Region } from "@neuracall/config";
import { parseRetryAfter } from "./backoff.js";
import type { FetchLike, SleepFn } from "./prerecorded.js";

/**
 * Gateway host per region, mirroring endpointsForRegion(): only US and EU
 * clusters exist, and "edge" (the default region) uses the US host, exactly as
 * "edge" uses the US REST host.
 */
const GATEWAY_HOST: Record<Region, string> = {
  us: "https://llm-gateway.assemblyai.com",
  eu: "https://llm-gateway.eu.assemblyai.com",
  edge: "https://llm-gateway.assemblyai.com",
};

/** The gateway base URL for a region. Never hardcode this at a call site. */
export function llmGatewayBaseUrl(region: Region): string {
  return GATEWAY_HOST[region];
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason?: string | null;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletion {
  id?: string;
  model?: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
  [key: string]: unknown;
}

export interface ChatOptions {
  /**
   * Required, deliberately. Gateway model ids are exact versioned strings
   * ("claude-sonnet-4-5-20250929" and the like) that are added and retired far
   * faster than this package is released, so a baked-in default would rot into
   * a 400 on a call that already cost money to record. The caller supplies it
   * from config (`AppConfig.llm.model`) where an operator can change it.
   */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface SummarizeOptions {
  /** See ChatOptions.model — required for the same reason. */
  model: string;
  /** Overrides the default call-summary instruction. */
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Default instruction for summarize(). Deliberately about calls, not text. */
export const DEFAULT_SUMMARY_PROMPT =
  "You are summarizing a recorded phone call. Write a concise summary covering " +
  "what the caller wanted, what was agreed, and any follow-up actions with who " +
  "owns them. Use only what the transcript states; do not invent details.";

/** A non-2xx response from the gateway. */
export class LlmGatewayError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`LLM Gateway ${url} failed (HTTP ${status}): ${body}`);
    this.name = "LlmGatewayError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface LlmGatewayDeps {
  fetchFn?: FetchLike;
  sleep?: SleepFn;
  now?: () => number;
  /** Override the derived host. For tests and self-hosted proxies only. */
  baseUrl?: string;
  /** How many times a 429 is waited out before it surfaces. Default 3. */
  maxRateLimitRetries?: number;
}

/** Fallback wait when a 429 arrives without a Retry-After header. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 2000;
/** Hard bound on one chat call; better to fail than hold the app open forever. */
const DEFAULT_CHAT_TIMEOUT_MS = 30_000;

const defaultSleep: SleepFn = async (ms, signal) => {
  await delay(ms, undefined, signal === undefined ? undefined : { signal });
};

export class LlmGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly maxRateLimitRetries: number;

  constructor(config: AppConfig, deps: LlmGatewayDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? llmGatewayBaseUrl(config.assemblyai.region)).replace(
      /\/+$/,
      "",
    );
    this.apiKey = config.assemblyai.apiKey;
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.maxRateLimitRetries = deps.maxRateLimitRetries ?? 3;
  }

  /** Raw chat completion, for callers that need the full response. */
  async chat(opts: ChatOptions): Promise<ChatCompletion> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
    };
    if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;
    if (opts.temperature !== undefined) body["temperature"] = opts.temperature;

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(opts.signal);
      // Bound the whole call so an uncredited reply cannot hold the process
      // open forever (app quit hang) or pin a socket on a dead peer. A caller
      // signal still wins sooner when it exists.
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(DEFAULT_CHAT_TIMEOUT_MS)])
        : AbortSignal.timeout(DEFAULT_CHAT_TIMEOUT_MS);
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        // The server's own Retry-After beats any schedule we could invent.
        const waitMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
        await this.sleep(waitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, signal);
        continue;
      }
      if (!res.ok) throw new LlmGatewayError(res.status, url, await safeText(res));
      return (await res.json()) as ChatCompletion;
    }
  }

  /** Summarize a finished call's transcript. Returns the assistant's text. */
  async summarize(transcriptText: string, opts: SummarizeOptions): Promise<string> {
    const completion = await this.chat({
      model: opts.model,
      messages: [
        { role: "system", content: opts.systemPrompt ?? DEFAULT_SUMMARY_PROMPT },
        { role: "user", content: transcriptText },
      ],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      signal: opts.signal,
    });
    return firstMessageContent(completion);
  }
}

/** The assistant text of a completion, or "" when the model returned nothing. */
export function firstMessageContent(completion: ChatCompletion): string {
  const choice = completion.choices[0];
  return choice?.message.content ?? "";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined || !signal.aborted) return;
  const reason: unknown = signal.reason;
  throw reason instanceof Error ? reason : new Error("Aborted");
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(unreadable body)";
  }
}
