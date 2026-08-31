/**
 * Pre-recorded transcription — the post-call path.
 *
 * A finished call is uploaded once and transcribed in full, which buys speaker
 * diarization over the whole recording and a second, more accurate pass than
 * the realtime socket could give while the call was still running.
 *
 * Verified against the live docs on 2026-08-31 and recorded in
 * docs/DECISIONS.md §1 and §9:
 *   - https://www.assemblyai.com/docs/api-reference/transcripts/submit
 *   - https://www.assemblyai.com/docs/api-reference/files/upload
 *
 * Auth is the raw API key in `Authorization` with **no `Bearer ` prefix**
 * (§6) — the same rule as the realtime socket.
 */

import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "@neuracall/config";
import { parseRetryAfter } from "./backoff.js";

/**
 * The models requested on every pre-recorded job, in fallback order.
 *
 * This array is not an optimization — it is a correctness requirement.
 * `POST /v2/transcript` takes **plural `speech_models` as an array**, unlike
 * the realtime socket which takes the **singular string `speech_model`**.
 * Omitting it does not select the current flagship: the server applies
 * `["universal-3-pro", "universal-2"]` — 3-*pro*, not 3-5-pro — so a job that
 * leaves it out silently runs an older model and nothing in the response says
 * so. Always send it. See docs/DECISIONS.md §1.
 */
export const PRERECORDED_SPEECH_MODELS: readonly string[] = ["universal-3-5-pro", "universal-2"];

/** Poll interval used when the caller does not choose one. */
export const DEFAULT_POLL_INTERVAL_MS = 3000;
/** Give up on a job after this long by default. Long calls transcribe slowly. */
export const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** Lifecycle of a pre-recorded job. `completed` and `error` are terminal. */
export type TranscriptStatus = "queued" | "processing" | "completed" | "error";

/** A word in the finished transcript. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  /** Present when speaker_labels was enabled. */
  speaker?: string | null;
}

/** One diarized utterance — present only when speaker_labels was enabled. */
export interface TranscriptUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  words: TranscriptWord[];
}

/** The `/v2/transcript` resource, in the subset NeuraCall reads. */
export interface Transcript {
  id: string;
  status: TranscriptStatus;
  audio_url?: string;
  text?: string | null;
  confidence?: number | null;
  audio_duration?: number | null;
  language_code?: string | null;
  words?: TranscriptWord[] | null;
  utterances?: TranscriptUtterance[] | null;
  /** Populated only when status is "error". */
  error?: string | null;
  [key: string]: unknown;
}

/** Fields sent on `POST /v2/transcript`. Snake_case: this is the wire shape. */
interface SubmitBody {
  audio_url: string;
  speech_models: string[];
  punctuate?: boolean;
  format_text?: boolean;
  speaker_labels?: boolean;
  speakers_expected?: number;
  language_detection?: boolean;
  language_code?: string;
  keyterms_prompt?: string[];
  webhook_url?: string;
  webhook_auth_header_name?: string;
  webhook_auth_header_value?: string;
}

export interface SubmitOptions {
  /** A URL the API can fetch — normally the one returned by uploadFile(). */
  audioUrl: string;
  /** Diarization. Requires punctuate; leaving punctuate unset turns it on. */
  speakerLabels?: boolean;
  /** Hint for the diarizer when the speaker count is known (a call: 2). */
  speakersExpected?: number;
  punctuate?: boolean;
  formatText?: boolean;
  /** Mutually exclusive with languageCode. */
  languageDetection?: boolean;
  languageCode?: string;
  /** Domain terms to bias recognition (max 100, <= 50 chars each). */
  keytermsPrompt?: string[];
  /** Delivery callback; polling is skipped entirely when this is used. */
  webhookUrl?: string;
  webhookAuthHeaderName?: string;
  /** A secret. Sent on the wire only; never logged or echoed back. */
  webhookAuthHeaderValue?: string;
  /** Override the model list. Almost never right — see PRERECORDED_SPEECH_MODELS. */
  speechModels?: readonly string[];
  signal?: AbortSignal;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Where the audio for a job comes from. */
export type AudioSource = Uint8Array | { path: string } | { url: string };

export interface TranscribeOptions extends Omit<SubmitOptions, "audioUrl"> {
  audio: AudioSource;
  poll?: PollOptions;
}

/** A non-2xx response from the REST API. */
export class PrerecordedHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`AssemblyAI ${url} failed (HTTP ${status}): ${body}`);
    this.name = "PrerecordedHttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** The job reached status "error"; `message` is the server's own explanation. */
export class TranscriptError extends Error {
  readonly transcriptId: string;

  constructor(transcriptId: string, message: string) {
    super(`Transcript ${transcriptId} failed: ${message}`);
    this.name = "TranscriptError";
    this.transcriptId = transcriptId;
  }
}

/** The job was still running when the caller's deadline passed. */
export class TranscriptTimeoutError extends Error {
  readonly transcriptId: string;
  readonly lastStatus: TranscriptStatus;

  constructor(transcriptId: string, timeoutMs: number, lastStatus: TranscriptStatus) {
    super(
      `Transcript ${transcriptId} still "${lastStatus}" after ${timeoutMs}ms; giving up polling`,
    );
    this.name = "TranscriptTimeoutError";
    this.transcriptId = transcriptId;
    this.lastStatus = lastStatus;
  }
}

/** The slice of `fetch` this client uses, so tests can run offline. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Cancellable sleep, injected so tests do not spend real seconds polling. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface PrerecordedDeps {
  fetchFn?: FetchLike;
  sleep?: SleepFn;
  /** Clock for poll deadlines. */
  now?: () => number;
  /** Reads a local audio file. Injected so uploads are testable without disk. */
  readFileFn?: (path: string) => Promise<Uint8Array>;
  /** How many times a 429 is waited out before it surfaces. Default 3. */
  maxRateLimitRetries?: number;
}

const defaultSleep: SleepFn = async (ms, signal) => {
  await delay(ms, undefined, signal === undefined ? undefined : { signal });
};

export class PrerecordedClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly readFileFn: (path: string) => Promise<Uint8Array>;
  private readonly maxRateLimitRetries: number;

  constructor(config: AppConfig, deps: PrerecordedDeps = {}) {
    // Never hardcode a host: the region decides US vs EU data residency.
    this.baseUrl = config.assemblyai.restBaseUrl.replace(/\/+$/, "");
    this.apiKey = config.assemblyai.apiKey;
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.readFileFn = deps.readFileFn ?? ((path) => readFile(path));
    this.maxRateLimitRetries = deps.maxRateLimitRetries ?? 3;
  }

  /**
   * Upload audio and get back the private URL to transcribe.
   *
   * The body is the **raw bytes** with `content-type:
   * application/octet-stream`. This endpoint is not multipart — wrapping the
   * audio in a FormData part uploads the MIME envelope as if it were audio and
   * the job fails later, during transcription, with an unhelpful message.
   *
   * @param audio Raw bytes, or a path to read them from.
   */
  async uploadFile(audio: Uint8Array | string, signal?: AbortSignal): Promise<string> {
    const bytes = typeof audio === "string" ? await this.readFileFn(audio) : audio;
    const res = await this.send("/v2/upload", {
      method: "POST",
      headers: {
        authorization: this.apiKey,
        "content-type": "application/octet-stream",
      },
      // fetch's BodyInit only admits a view over a plain ArrayBuffer, while a
      // Buffer read off disk is typed over ArrayBufferLike. The bytes go out
      // untouched; copying a whole recording to satisfy the type would not.
      body: bytes as BodyInit,
      signal,
    });

    const data = (await res.json()) as { upload_url?: string };
    if (data.upload_url === undefined || data.upload_url === "") {
      throw new Error("AssemblyAI upload response did not include an upload_url.");
    }
    return data.upload_url;
  }

  /** Queue a transcription job. Returns immediately, before it has run. */
  async submit(opts: SubmitOptions): Promise<Transcript> {
    const res = await this.send("/v2/transcript", {
      method: "POST",
      headers: {
        authorization: this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildSubmitBody(opts)),
      signal: opts.signal,
    });
    return (await res.json()) as Transcript;
  }

  /** Fetch a job once, whatever state it is in. */
  async get(id: string, signal?: AbortSignal): Promise<Transcript> {
    const res = await this.send(`/v2/transcript/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { authorization: this.apiKey },
      signal,
    });
    return (await res.json()) as Transcript;
  }

  /**
   * Poll a job until it is `completed`, throwing on `error` or on the caller's
   * deadline. Prefer a webhook for long recordings; this exists for the desktop
   * app, which has nowhere to receive one.
   */
  async poll(id: string, opts: PollOptions = {}): Promise<Transcript> {
    const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = this.now() + timeoutMs;

    for (;;) {
      throwIfAborted(opts.signal);
      const transcript = await this.get(id, opts.signal);

      if (transcript.status === "completed") return transcript;
      if (transcript.status === "error") {
        throw new TranscriptError(id, transcript.error ?? "no error message returned");
      }
      if (this.now() >= deadline) {
        throw new TranscriptTimeoutError(id, timeoutMs, transcript.status);
      }
      await this.sleep(intervalMs, opts.signal);
    }
  }

  /** upload → submit → poll, the whole post-call path in one call. */
  async transcribe(opts: TranscribeOptions): Promise<Transcript> {
    const { audio, poll, ...submitOpts } = opts;
    const audioUrl = await this.resolveAudioUrl(audio, opts.signal);
    const job = await this.submit({ ...submitOpts, audioUrl });
    return await this.poll(job.id, { ...poll, signal: poll?.signal ?? opts.signal });
  }

  private async resolveAudioUrl(audio: AudioSource, signal?: AbortSignal): Promise<string> {
    if (audio instanceof Uint8Array) return await this.uploadFile(audio, signal);
    if ("url" in audio) return audio.url;
    return await this.uploadFile(audio.path, signal);
  }

  /**
   * One HTTP call, with 429s waited out rather than failed.
   *
   * A `Retry-After` from the server is authoritative — it knows its own
   * capacity — so it is reused verbatim via parseRetryAfter rather than
   * re-derived from a local backoff schedule.
   */
  private async send(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const signal = init.signal ?? undefined;

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      const res = await this.fetchFn(url, init);

      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        const waitMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
        await this.sleep(waitMs ?? DEFAULT_POLL_INTERVAL_MS, signal);
        continue;
      }
      if (!res.ok) throw new PrerecordedHttpError(res.status, url, await safeText(res));
      return res;
    }
  }
}

/** Build the wire body, applying the constraints the API enforces server-side. */
function buildSubmitBody(opts: SubmitOptions): SubmitBody {
  const speakerLabels = opts.speakerLabels === true;
  // Diarization is rejected without punctuation, and the failure arrives as a
  // 400 with no mention of punctuate. Default it on rather than let that happen.
  const punctuate = opts.punctuate ?? (speakerLabels ? true : undefined);
  if (speakerLabels && punctuate === false) {
    throw new Error("speaker_labels requires punctuate: true.");
  }
  if (opts.languageDetection === true && opts.languageCode !== undefined) {
    throw new Error("language_detection and language_code are mutually exclusive.");
  }

  const body: SubmitBody = {
    audio_url: opts.audioUrl,
    speech_models: [...(opts.speechModels ?? PRERECORDED_SPEECH_MODELS)],
  };

  if (punctuate !== undefined) body.punctuate = punctuate;
  if (opts.formatText !== undefined) body.format_text = opts.formatText;
  if (speakerLabels) body.speaker_labels = true;
  if (opts.speakersExpected !== undefined) body.speakers_expected = opts.speakersExpected;
  if (opts.languageDetection !== undefined) body.language_detection = opts.languageDetection;
  if (opts.languageCode !== undefined) body.language_code = opts.languageCode;
  if (opts.keytermsPrompt !== undefined && opts.keytermsPrompt.length > 0) {
    body.keyterms_prompt = opts.keytermsPrompt;
  }
  if (opts.webhookUrl !== undefined) body.webhook_url = opts.webhookUrl;
  if (opts.webhookAuthHeaderName !== undefined) {
    body.webhook_auth_header_name = opts.webhookAuthHeaderName;
  }
  if (opts.webhookAuthHeaderValue !== undefined) {
    body.webhook_auth_header_value = opts.webhookAuthHeaderValue;
  }
  return body;
}

/** Flatten a diarized transcript into speaker-prefixed lines for the LLM. */
export function utterancesToText(transcript: Transcript): string {
  const utterances = transcript.utterances;
  if (utterances === undefined || utterances === null || utterances.length === 0) {
    return transcript.text ?? "";
  }
  return utterances.map((u) => `Speaker ${u.speaker}: ${u.text}`).join("\n");
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
