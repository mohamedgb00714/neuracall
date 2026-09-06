/**
 * The LLM port, plus an OpenAI-compatible adapter.
 *
 * NeuraCall's config is deliberately provider-neutral (`LLM_API_KEY`,
 * `LLM_MODEL`), so the agent depends on the `LlmClient` interface and never on
 * a vendor SDK. `OpenAiCompatibleLlmClient` speaks the `/chat/completions`
 * shape, which covers OpenRouter (and through it Anthropic, OpenAI, Google and
 * the rest), OpenAI directly, Together, Groq, and local servers like Ollama
 * and vLLM. A provider with its own wire format gets its own adapter behind
 * the same interface.
 *
 * Cancellation is first-class rather than an afterthought: `signal` runs all
 * the way through to `fetch`. On a phone call an interrupted reply must stop
 * being generated immediately — a reply the caller has already talked over is
 * worthless, and on a metered API it is worse than worthless.
 */

/** A message as the model sees it. */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** Aborts the request when the caller interrupts. */
  signal?: AbortSignal;
  /** Cap on the reply length. Spoken replies should be short. */
  maxTokens?: number;
  temperature?: number;
}

/** What the agent needs from a language model. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<string>;
}

export interface OpenAiCompatibleLlmClientOptions {
  apiKey: string;
  /** Model identifier as the provider names it. */
  model: string;
  /** API root. Default OpenRouter. */
  baseUrl?: string;
  /** Default reply cap. Default 300 — a spoken turn should be brief. */
  maxTokens?: number;
  temperature?: number;
  /** Extra headers (OpenRouter's HTTP-Referer / X-Title, for instance). */
  headers?: Record<string, string>;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default 20000 — a call cannot wait forever. */
  timeoutMs?: number;
}

/**
 * The API root used when none is configured. Exported so the default TTS can
 * reuse it: a voice has to travel through the same gateway the text does, or
 * an OpenRouter key would be sent to api.openai.com and every reply would fail.
 */
export const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";

/** Speaks the OpenAI `/chat/completions` protocol. */
export class OpenAiCompatibleLlmClient implements LlmClient {
  private readonly opts: OpenAiCompatibleLlmClientOptions;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OpenAiCompatibleLlmClientOptions) {
    if (!opts.apiKey) throw new Error("OpenAiCompatibleLlmClient: apiKey is required");
    if (!opts.model) throw new Error("OpenAiCompatibleLlmClient: model is required");
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async complete(request: LlmRequest): Promise<string> {
    const baseUrl = (this.opts.baseUrl ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
    const timeoutMs = this.opts.timeoutMs ?? 20_000;

    // A slow model must not hold a live call open indefinitely, but a caller
    // interrupting must still win — so combine the deadline with the caller's
    // own signal rather than replacing it.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    const response = await this.fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        ...this.opts.headers,
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? this.opts.maxTokens ?? 300,
        temperature: request.temperature ?? this.opts.temperature ?? 0.7,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `LLM request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ""}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("LLM response did not contain a message.");
    }
    return text.trim();
  }
}

/** Always answers with the same line. For smoke tests and offline demos. */
export class StaticLlmClient implements LlmClient {
  constructor(private readonly reply: string) {}
  async complete(): Promise<string> {
    return this.reply;
  }
}
