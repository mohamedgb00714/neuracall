/**
 * Stored Voice Agents — the REST half of the Voice Agent API.
 *
 * A NeuraCall agent is created once here and then referenced from the socket by
 * id (`session.update {"session":{"agent_id":...}}`), rather than sent inline on
 * every call. That split is not a preference: a BYO-LLM block is **rejected**
 * on `session.update` ("BYO LLM config is not allowed on session.update; define
 * it on a stored agent via POST /v1/agents"), so anything pointing the agent at
 * our own model has to exist as a stored agent first. `agent_id` and inline
 * config are also mutually exclusive in one message, so a session picks one.
 *
 * Verified against the live API on 2026-08-31 (docs/VOICE-AGENT.md):
 *   POST/GET /v1/agents, GET/PATCH/DELETE /v1/agents/{id}
 *
 * The host comes from `config.voiceAgent.restBaseUrl` (agents.* per region,
 * `/v1` included) — the agents API is on its own host family, unreachable from
 * the transcription hosts, and no call site should be assembling either.
 *
 * Two things here exist because they cost real debugging time:
 *
 *  1. **Sample rate.** Input and output must both be PCM16 mono at exactly
 *     24000 Hz. An agent stored with 16000 or 8000 is accepted at create time
 *     with a 200 and then fails at *session start*, hours later, with
 *     `{"code":"internal_error","message":"Internal service error"}` and close
 *     1011 — nothing in that error mentions the rate. So the rate is carried as
 *     a literal type (`VoiceAgentSampleRate`), not a number: the compiler
 *     refuses the mistake at the only moment it is still cheap to notice.
 *     The type alone is not enough, though — it is erased on anything that
 *     arrives as data (a settings file, an IPC payload, a restored draft), and
 *     this client is the last checkpoint before a bad rate is *persisted* and
 *     starts failing every future session. So the rate is also asserted at
 *     runtime, with `assertVoiceAgentSampleRate` naming the internal_error it
 *     would otherwise be debugged as.
 *
 *  2. **DELETE returns 204 with a genuinely empty body.** Calling `.json()` on
 *     it throws a JSON parse error that reads like the delete failed, when it
 *     succeeded. `deleteAgent` never touches the body.
 *
 * Auth on this host is `authorization: Bearer <key>` — unlike /v2 and the LLM
 * Gateway, which take the raw key. The key is only ever put in a request
 * header; errors carry status, URL and response body, never credentials.
 *
 * Naming: the config sub-shapes here are `StoredAgent*` because the socket
 * client in ./voiceAgent.ts already owns `VoiceAgentAudioFormat`,
 * `VoiceAgentTurnDetection` and `VoiceAgentTool` for the *inline* session
 * config. index.ts re-exports both modules with `export *`, and duplicate
 * names there are a compile error, not a merge. The 24 kHz literal itself is
 * @neuracall/config's `VoiceAgentSampleRate`, imported rather than redefined.
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_VOICE_AGENT_VOICE,
  VOICE_AGENT_SAMPLE_RATE,
  type AppConfig,
  type VoiceAgentSampleRate,
} from "@neuracall/config";
import { parseRetryAfter } from "./backoff.js";
import type { FetchLike, SleepFn } from "./prerecorded.js";
import { assertVoiceAgentSampleRate } from "./voiceAgent.js";

/** The only encoding the agent accepts on input and emits on output. */
export type VoiceAgentEncoding = "audio/pcm";

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/** US-accented English voices. */
export type UsEnglishVoiceId = "alba" | "eve" | "george" | "jane" | "jean" | "mary" | "michael";

/** UK-accented English voices. */
export type UkEnglishVoiceId = "anna" | "charles" | "paul" | "vera";

/** Every `voice.voice_id` the API accepts. Anything else is a 400 at create. */
export type VoiceId =
  UsEnglishVoiceId | UkEnglishVoiceId | "giovanni" | "lola" | "juergen" | "rafael" | "estelle";

/** One row of the voice picker: enough to render a grouped dropdown. */
export interface VoiceOption {
  id: VoiceId;
  /** Display name of the spoken language, e.g. "English". */
  language: string;
  /** BCP-47 tag of what the voice speaks, e.g. "en-GB". */
  languageCode: string;
  /** Accent within the language, for grouping. "" when the language has one. */
  accent: string;
}

/**
 * Keyed by VoiceId so a new voice added to the union fails to compile until it
 * is described here — a settings dropdown built off VOICES then cannot silently
 * omit it.
 */
const VOICE_TABLE: Record<VoiceId, Omit<VoiceOption, "id">> = {
  alba: { language: "English", languageCode: "en-US", accent: "US" },
  eve: { language: "English", languageCode: "en-US", accent: "US" },
  george: { language: "English", languageCode: "en-US", accent: "US" },
  jane: { language: "English", languageCode: "en-US", accent: "US" },
  jean: { language: "English", languageCode: "en-US", accent: "US" },
  mary: { language: "English", languageCode: "en-US", accent: "US" },
  michael: { language: "English", languageCode: "en-US", accent: "US" },
  anna: { language: "English", languageCode: "en-GB", accent: "UK" },
  charles: { language: "English", languageCode: "en-GB", accent: "UK" },
  paul: { language: "English", languageCode: "en-GB", accent: "UK" },
  vera: { language: "English", languageCode: "en-GB", accent: "UK" },
  giovanni: { language: "Italian", languageCode: "it-IT", accent: "" },
  lola: { language: "Spanish", languageCode: "es-ES", accent: "" },
  juergen: { language: "German", languageCode: "de-DE", accent: "" },
  rafael: { language: "Portuguese", languageCode: "pt-BR", accent: "" },
  estelle: { language: "French", languageCode: "fr-FR", accent: "" },
};

/** The voice catalogue, for rendering a settings dropdown. */
export const VOICES: readonly VoiceOption[] = (Object.keys(VOICE_TABLE) as VoiceId[]).map((id) => ({
  id,
  ...VOICE_TABLE[id],
}));

/** Just the ids, in the same order as VOICES. */
export const VOICE_IDS: readonly VoiceId[] = VOICES.map((v) => v.id);

/**
 * The voice used when a caller does not choose one.
 *
 * Taken from @neuracall/config rather than picked again here: `VOICE_AGENT_VOICE`
 * unset resolves to that same value on every other path (config, the desktop
 * settings default), and a second opinion here would mean an agent built by
 * `defaultNeuraCallAgent()` speaks in a different voice than the settings screen
 * says it does. The annotation is the check: a config default that stops being a
 * real voice_id fails to compile here instead of 400ing at create time.
 */
export const DEFAULT_VOICE_ID: VoiceId = DEFAULT_VOICE_AGENT_VOICE;

/** Narrow an arbitrary string (a settings file, a CLI flag) to a VoiceId. */
export function isVoiceId(value: string): value is VoiceId {
  return Object.prototype.hasOwnProperty.call(VOICE_TABLE, value);
}

// ---------------------------------------------------------------------------
// Agent definition (camelCase — what NeuraCall code writes)
// ---------------------------------------------------------------------------

export interface StoredAgentAudioFormat {
  /** Defaults to "audio/pcm", the only encoding the API accepts. */
  encoding?: VoiceAgentEncoding;
  /**
   * Defaults to 24000 and is typed to accept nothing else. See the file header:
   * a wrong rate is a 200 here and a misleading `internal_error` at session
   * start, so it must not be settable by a stray `sampleRate: 16000`.
   */
  sampleRate?: VoiceAgentSampleRate;
  /**
   * Escape hatch for the day another rate is genuinely supported. Named to be
   * unpleasant on purpose; it wins over `sampleRate`. Do not use it to match
   * NeuraCall's 16 kHz capture — resample the audio to 24 kHz instead.
   */
  unsafeSampleRate?: number;
}

/** When the agent decides the caller stopped talking, and whether it yields. */
export interface StoredAgentTurnDetection {
  /** Voice-activity confidence, 0-1. Higher = less sensitive to noise. */
  vadThreshold?: number;
  /** Silence in ms before a turn may end. */
  minSilence?: number;
  /** Silence in ms after which the turn ends regardless. */
  maxSilence?: number;
  /** Barge-in: the caller talking over the agent cuts the reply short. */
  interruptResponse?: boolean;
  /** How long after the caller speaks before the agent interrupts its reply. */
  interruptionDelayMs?: number;
}

export interface VoiceAgentInput {
  format?: StoredAgentAudioFormat;
  turnDetection?: StoredAgentTurnDetection;
  /** Speed-vs-accuracy tradeoff; the agent's pacing presets. */
  transcriptionMode?: "min_latency" | "balanced" | "max_accuracy";
  /**
   * Isolate the caller's voice before transcription. `near-field` for
   * close-talking mics, `far-field` for speakerphone/laptop/room capture.
   */
  voiceFocus?: "near-field" | "far-field";
  /** Voice-focus aggressiveness 0.0-1.0; requires `voiceFocus`. */
  voiceFocusThreshold?: number;
  /** Domain terms biasing recognition — names, products, street names. */
  keyterms?: readonly string[];
}

export interface VoiceAgentOutput {
  format?: StoredAgentAudioFormat;
  /** Playback volume, 0-100. */
  volume?: number;
}

/** A tool the agent may call; arrives back as `tool.call` on the socket. */
export interface StoredAgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Passed through to the wire untouched. */
  parameters?: Record<string, unknown>;
}

/**
 * BYO LLM. Only ever accepted here, on a stored agent — `session.update`
 * rejects it with `invalid_value`. `apiKey` is a secret: it is sent once and
 * never read back or logged.
 */
export interface VoiceAgentLlm {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** An agent as NeuraCall describes it. Mapped to snake_case on the way out. */
export interface VoiceAgentDefinition {
  name: string;
  systemPrompt: string;
  /** Spoken before the caller says anything. Omit for a silent open. */
  greeting?: string;
  voice: VoiceId;
  input?: VoiceAgentInput;
  output?: VoiceAgentOutput;
  tools?: readonly StoredAgentTool[];
  /** One config, or the array the API stores. Always sent as an array. */
  llm?: VoiceAgentLlm | readonly VoiceAgentLlm[];
}

/** A PATCH body: every field optional, same meanings as above. */
export type VoiceAgentPatch = Partial<VoiceAgentDefinition>;

// ---------------------------------------------------------------------------
// Wire shapes (snake_case — exactly what crosses the network)
// ---------------------------------------------------------------------------

export interface StoredAgentAudioFormatWire {
  encoding: VoiceAgentEncoding;
  sample_rate: number;
}

export interface StoredAgentTurnDetectionWire {
  vad_threshold?: number;
  min_silence?: number;
  max_silence?: number;
  interrupt_response?: boolean;
  interruption_delay?: number;
}

export interface VoiceAgentInputWire {
  format: StoredAgentAudioFormatWire;
  turn_detection?: StoredAgentTurnDetectionWire;
  transcription_mode?: "min_latency" | "balanced" | "max_accuracy";
  voice_focus?: "near-field" | "far-field";
  voice_focus_threshold?: number;
  keyterms?: string[];
}

export interface VoiceAgentOutputWire {
  format: StoredAgentAudioFormatWire;
  volume?: number;
}

export interface VoiceAgentVoiceWire {
  voice_id: VoiceId;
}

export interface StoredAgentToolWire {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface VoiceAgentLlmWire {
  base_url: string;
  model: string;
  api_key: string;
}

/** The `POST /v1/agents` body. */
export interface VoiceAgentCreateWire {
  name: string;
  system_prompt: string;
  greeting?: string;
  voice: VoiceAgentVoiceWire;
  input: VoiceAgentInputWire;
  output: VoiceAgentOutputWire;
  tools?: StoredAgentToolWire[];
  llm?: VoiceAgentLlmWire[];
}

/** The `PATCH /v1/agents/{id}` body — only the fields the caller supplied. */
export type VoiceAgentPatchWire = Partial<VoiceAgentCreateWire>;

/**
 * A stored agent as the API returns it. Snake_case, because it is the response
 * verbatim; the index signature keeps fields we do not model yet readable.
 */
export interface VoiceAgent extends VoiceAgentPatchWire {
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** One page of `GET /v1/agents`. */
export interface VoiceAgentListPage {
  agents: VoiceAgent[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string | null } | null;
}

// ---------------------------------------------------------------------------
// camelCase → wire
// ---------------------------------------------------------------------------

/**
 * Resolve one audio format, defaulting the rate to the only one that works.
 *
 * `sampleRate` is checked at runtime as well as by its type: the type is erased
 * on anything deserialized (settings, IPC, a draft restored from disk), and a
 * bad rate stored here is not noticed until a session start fails as
 * `internal_error`. `unsafeSampleRate` deliberately bypasses the check — that
 * is what it is for.
 */
function toWireFormat(format: StoredAgentAudioFormat | undefined): StoredAgentAudioFormatWire {
  const encoding = format?.encoding ?? "audio/pcm";
  const unsafe = format?.unsafeSampleRate;
  if (unsafe !== undefined) return { encoding, sample_rate: unsafe };

  const sampleRate = format?.sampleRate ?? VOICE_AGENT_SAMPLE_RATE;
  assertVoiceAgentSampleRate(sampleRate, "format.sampleRate");
  return { encoding, sample_rate: sampleRate };
}

function toWireInput(input: VoiceAgentInput | undefined): VoiceAgentInputWire {
  const wire: VoiceAgentInputWire = { format: toWireFormat(input?.format) };
  const td = input?.turnDetection;
  if (td !== undefined) {
    const detection: StoredAgentTurnDetectionWire = {};
    if (td.vadThreshold !== undefined) detection.vad_threshold = td.vadThreshold;
    if (td.minSilence !== undefined) detection.min_silence = td.minSilence;
    if (td.maxSilence !== undefined) detection.max_silence = td.maxSilence;
    if (td.interruptResponse !== undefined) detection.interrupt_response = td.interruptResponse;
    if (td.interruptionDelayMs !== undefined) detection.interruption_delay = td.interruptionDelayMs;
    wire.turn_detection = detection;
  }
  if (input?.keyterms !== undefined && input.keyterms.length > 0) {
    wire.keyterms = [...input.keyterms];
  }
  if (input?.transcriptionMode !== undefined) {
    wire.transcription_mode = input.transcriptionMode;
  }
  if (input?.voiceFocus !== undefined) wire.voice_focus = input.voiceFocus;
  if (input?.voiceFocusThreshold !== undefined) {
    wire.voice_focus_threshold = input.voiceFocusThreshold;
  }
  return wire;
}

function toWireOutput(output: VoiceAgentOutput | undefined): VoiceAgentOutputWire {
  const wire: VoiceAgentOutputWire = { format: toWireFormat(output?.format) };
  if (output?.volume !== undefined) wire.volume = output.volume;
  return wire;
}

function toWireTools(tools: readonly StoredAgentTool[]): StoredAgentToolWire[] {
  return tools.map((tool) => {
    const wire: StoredAgentToolWire = { name: tool.name, description: tool.description };
    if (tool.parameters !== undefined) wire.parameters = tool.parameters;
    return wire;
  });
}

function toWireLlm(llm: VoiceAgentLlm | readonly VoiceAgentLlm[]): VoiceAgentLlmWire[] {
  const configs = Array.isArray(llm) ? (llm as readonly VoiceAgentLlm[]) : [llm as VoiceAgentLlm];
  return configs.map((c) => ({ base_url: c.baseUrl, model: c.model, api_key: c.apiKey }));
}

/** Map a definition to the create body. Exported so a caller can inspect it. */
export function toWireDefinition(def: VoiceAgentDefinition): VoiceAgentCreateWire {
  const wire: VoiceAgentCreateWire = {
    name: def.name,
    system_prompt: def.systemPrompt,
    voice: { voice_id: def.voice },
    input: toWireInput(def.input),
    output: toWireOutput(def.output),
  };
  if (def.greeting !== undefined) wire.greeting = def.greeting;
  if (def.tools !== undefined && def.tools.length > 0) wire.tools = toWireTools(def.tools);
  if (def.llm !== undefined) wire.llm = toWireLlm(def.llm);
  return wire;
}

/**
 * Map a partial definition to a PATCH body.
 *
 * `input` and `output` are replaced wholesale by the server, so touching either
 * one re-sends its `format` — patching just `turn_detection` and letting the
 * format fall away would leave the agent on whatever rate the server defaults
 * to, and that failure only shows up at the next session start.
 */
export function toWirePatch(patch: VoiceAgentPatch): VoiceAgentPatchWire {
  const wire: VoiceAgentPatchWire = {};
  if (patch.name !== undefined) wire.name = patch.name;
  if (patch.systemPrompt !== undefined) wire.system_prompt = patch.systemPrompt;
  if (patch.greeting !== undefined) wire.greeting = patch.greeting;
  if (patch.voice !== undefined) wire.voice = { voice_id: patch.voice };
  if (patch.input !== undefined) wire.input = toWireInput(patch.input);
  if (patch.output !== undefined) wire.output = toWireOutput(patch.output);
  if (patch.tools !== undefined) wire.tools = toWireTools(patch.tools);
  if (patch.llm !== undefined) wire.llm = toWireLlm(patch.llm);
  return wire;
}

// ---------------------------------------------------------------------------
// The default NeuraCall agent
// ---------------------------------------------------------------------------

/**
 * The house system prompt. Written for *speech*: no markdown, no lists, no
 * spelled-out URLs, and short turns — a model that writes a paragraph makes the
 * caller wait through it with no way to skim, and barge-in only helps if there
 * is something worth interrupting.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "You are answering a live phone call on behalf of the person who owns this number.",
  "Speak the way people speak on the phone: one or two short sentences per turn, plain words, no lists,",
  "no markdown, no emoji, and never read out formatting.",
  "Ask one question at a time and wait for the answer.",
  "Find out who is calling and what they need, then either answer briefly or take a message.",
  "Read names, phone numbers and addresses back to confirm them.",
  "Never invent facts about the owner, their availability, prices or commitments; if you do not know,",
  "say you will pass the question on.",
  "If the caller asks for something you cannot do, say so plainly and offer to take a message.",
  "End the call politely once the caller has nothing further.",
].join(" ");

/** The default opening line. Short: the caller is waiting to hear a human. */
export const DEFAULT_AGENT_GREETING = "Hello, thanks for calling. How can I help?";

export interface DefaultAgentOptions {
  /** Stored agent name, shown in the dashboard. */
  name?: string;
  voice?: VoiceId;
  /** Replaces DEFAULT_AGENT_SYSTEM_PROMPT entirely. */
  systemPrompt?: string;
  /** Appended to the system prompt — the usual way to add house specifics. */
  extraInstructions?: string;
  greeting?: string;
  /** Names, products and places the caller is likely to say. */
  keyterms?: readonly string[];
  tools?: readonly StoredAgentTool[];
  llm?: VoiceAgentLlm | readonly VoiceAgentLlm[];
}

/**
 * A sensible NeuraCall agent: brief spoken replies, barge-in on, and both audio
 * formats pinned to 24 kHz PCM. Everything here is overridable, but the
 * defaults are the ones verified to actually start a session.
 */
export function defaultNeuraCallAgent(opts: DefaultAgentOptions = {}): VoiceAgentDefinition {
  const base = opts.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT;
  const def: VoiceAgentDefinition = {
    name: opts.name ?? "NeuraCall phone assistant",
    systemPrompt:
      opts.extraInstructions === undefined ? base : `${base}\n\n${opts.extraInstructions}`,
    greeting: opts.greeting ?? DEFAULT_AGENT_GREETING,
    voice: opts.voice ?? DEFAULT_VOICE_ID,
    input: {
      format: { encoding: "audio/pcm", sampleRate: VOICE_AGENT_SAMPLE_RATE },
      turnDetection: {
        vadThreshold: 0.5,
        // A caller pausing mid-sentence on a mobile is normal; 400 ms of
        // silence is a breath, not a finished turn.
        minSilence: 400,
        maxSilence: 1200,
        // Barge-in: on a phone call, talking over the agent must stop it.
        interruptResponse: true,
      },
      ...(opts.keyterms !== undefined && opts.keyterms.length > 0
        ? { keyterms: [...opts.keyterms] }
        : {}),
    },
    output: {
      format: { encoding: "audio/pcm", sampleRate: VOICE_AGENT_SAMPLE_RATE },
      volume: 100,
    },
  };
  if (opts.tools !== undefined && opts.tools.length > 0) def.tools = opts.tools;
  if (opts.llm !== undefined) def.llm = opts.llm;
  return def;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** A non-2xx response from the Voice Agent REST API. Never carries the key. */
export class VoiceAgentApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`Voice Agent API ${url} failed (HTTP ${status}): ${body}`);
    this.name = "VoiceAgentApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface VoiceAgentAdminDeps {
  fetchFn?: FetchLike;
  sleep?: SleepFn;
  now?: () => number;
  /** Override the host. For tests and self-hosted proxies only. */
  baseUrl?: string;
  /** How many times a 429 is waited out before it surfaces. Default 3. */
  maxRateLimitRetries?: number;
}

export interface ListAgentsOptions {
  /** Page size asked of the server; it may return fewer. */
  limit?: number;
  /** Start from a cursor rather than the first page. */
  cursor?: string;
  /**
   * Stop after this many requests. A guard, not a feature: it bounds the loop
   * if the server ever reports has_more with a cursor it already gave us.
   * Default 50.
   */
  maxPages?: number;
  signal?: AbortSignal;
}

/** Fallback wait when a 429 arrives without a Retry-After header. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 2000;

const defaultSleep: SleepFn = async (ms, signal) => {
  await delay(ms, undefined, signal === undefined ? undefined : { signal });
};

export class VoiceAgentAdminClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly maxRateLimitRetries: number;

  constructor(config: AppConfig, deps: VoiceAgentAdminDeps = {}) {
    // Never hardcode a host: the region decides US vs EU data residency, and
    // config.voiceAgent.restBaseUrl already carries the /v1 prefix, so every
    // path below is relative to it ("/agents", not "/v1/agents").
    this.baseUrl = (deps.baseUrl ?? config.voiceAgent.restBaseUrl).replace(/\/+$/, "");
    this.apiKey = config.assemblyai.apiKey;
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.maxRateLimitRetries = deps.maxRateLimitRetries ?? 3;
  }

  /** Create a stored agent. The returned `id` is what a session references. */
  async createAgent(def: VoiceAgentDefinition, signal?: AbortSignal): Promise<VoiceAgent> {
    const res = await this.send("/agents", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(toWireDefinition(def)),
      signal,
    });
    return (await res.json()) as VoiceAgent;
  }

  /** Fetch one stored agent. */
  async getAgent(id: string, signal?: AbortSignal): Promise<VoiceAgent> {
    const res = await this.send(`/agents/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.headers(false),
      signal,
    });
    return (await res.json()) as VoiceAgent;
  }

  /** One page, cursor and all. Use listAgents() unless you are paging by hand. */
  async listAgentsPage(opts: ListAgentsOptions = {}): Promise<VoiceAgentListPage> {
    const query = new URLSearchParams();
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.cursor !== undefined) query.set("cursor", opts.cursor);
    const qs = query.toString();
    const suffix = qs === "" ? "" : `?${qs}`;

    const res = await this.send(`/agents${suffix}`, {
      method: "GET",
      headers: this.headers(false),
      signal: opts.signal,
    });
    return (await res.json()) as VoiceAgentListPage;
  }

  /**
   * Every stored agent, following `response_metadata.next_cursor` until the
   * server stops setting `has_more`. An account has a handful of agents, so
   * collecting them is cheaper than making every caller write this loop.
   */
  async listAgents(opts: ListAgentsOptions = {}): Promise<VoiceAgent[]> {
    const maxPages = opts.maxPages ?? 50;
    const all: VoiceAgent[] = [];
    const seen = new Set<string>();
    let cursor = opts.cursor;

    for (let page = 0; page < maxPages; page += 1) {
      const body: ListAgentsOptions = {
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      };
      if (cursor !== undefined) body.cursor = cursor;
      if (opts.signal !== undefined) body.signal = opts.signal;

      const result = await this.listAgentsPage(body);
      all.push(...(result.agents ?? []));

      const next = result.response_metadata?.next_cursor;
      // A repeated cursor would page forever; stop rather than loop.
      if (result.has_more !== true || next === undefined || next === null || next === "") break;
      if (seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return all;
  }

  /** Patch a stored agent. Only the fields present in `patch` are sent. */
  async updateAgent(id: string, patch: VoiceAgentPatch, signal?: AbortSignal): Promise<VoiceAgent> {
    const res = await this.send(`/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify(toWirePatch(patch)),
      signal,
    });
    return (await res.json()) as VoiceAgent;
  }

  /**
   * Delete a stored agent.
   *
   * The response is 204 with an empty body. Reading it as JSON throws
   * "Unexpected end of JSON input", which reads like the delete failed when it
   * did not — so the body is never touched here. Returns nothing on purpose.
   */
  async deleteAgent(id: string, signal?: AbortSignal): Promise<void> {
    await this.send(`/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(false),
      signal,
    });
  }

  /** This host wants `Bearer <key>`, unlike /v2 which wants the raw key. */
  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (json) headers["content-type"] = "application/json";
    return headers;
  }

  /**
   * One HTTP call, with 429s waited out rather than failed. A `Retry-After`
   * from the server is authoritative — it knows its own capacity — so it is
   * reused verbatim rather than re-derived from a local schedule.
   */
  private async send(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const signal = init.signal ?? undefined;

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      const res = await this.fetchFn(url, init);

      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        const waitMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
        await this.sleep(waitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, signal);
        continue;
      }
      if (!res.ok) throw new VoiceAgentApiError(res.status, url, await safeText(res));
      return res;
    }
  }
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
