/**
 * Types for the AssemblyAI Universal-Streaming (v3 WebSocket) protocol.
 *
 * Every name below was verified against the live docs on 2026-08-31:
 *   - https://www.assemblyai.com/docs/streaming/message-sequence
 *   - https://www.assemblyai.com/docs/api-reference/specs/streaming.yaml (AsyncAPI)
 *   - https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures
 *   - https://www.assemblyai.com/docs/streaming/updating-configuration-mid-stream
 *   - https://www.assemblyai.com/docs/streaming/universal-3-5-pro/context-carryover
 *   - https://www.assemblyai.com/docs/api-reference/specs/streaming-token.yaml
 */

/** WebSocket close codes documented for the realtime STT API. */
export enum RealtimeCloseCode {
  /** Normal closure — the server sends this right after `Termination`. */
  Normal = 1000,
  /** Abnormal closure (no close frame) — network drop, handshake failure. */
  Abnormal = 1006,
  /** Missing/invalid Authorization or token, account issues, or (per the rate-limit docs) new-session rate limit. */
  Unauthorized = 1008,
  /** Unexpected server-side error while establishing the connection — retry. */
  InternalError = 1011,
  /** Session Cancelled: catch-all server-side error. */
  SessionCancelled = 3005,
  /** Invalid message type / invalid JSON / inactivity timeout elapsed. */
  InvalidMessage = 3006,
  /** Audio chunk outside 50–1000 ms, or audio sent faster than real time / >5 min buffered. */
  BadAudioChunk = 3007,
  /** 3-hour cap (or `max_session_duration_seconds` of a temp token) reached. */
  SessionExpired = 3008,
  /** Too many concurrent sessions (streaming rate limit). */
  TooManySessions = 3009,
  /** The V2 streaming endpoint has been retired. */
  DeprecatedEndpoint = 410,
}

/** Possible states of a realtime session. */
export type SessionState =
  "idle" | "connecting" | "open" | "reconnecting" | "terminating" | "closed" | "error";

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence: number;
  word_is_final: boolean;
  /** Present on final words when speaker_labels is enabled (may be absent on individual words). */
  speaker?: string;
}

/** Echo of the configuration the server applied (from `Begin.configuration`). */
export interface BeginConfiguration {
  model?: string;
  mode?: string | null;
  api_version?: string;
  speaker_labels?: boolean;
  redact_pii?: boolean;
  filter_profanity?: boolean;
  domain?: string | null;
  voice_focus?: string | null;
  [key: string]: unknown;
}

/** The `Begin` message — sent first once the connection is established. */
export interface BeginMessage {
  type: "Begin";
  id: string;
  /** Unix timestamp (seconds); when reached the server closes with 3008. */
  expires_at: number;
  /** Always check `configuration.model` matches the requested `speech_model`. */
  configuration?: BeginConfiguration;
}

/**
 * `SpeechStarted` — emitted immediately before the first `Turn` of each turn.
 * Universal-3.5 Pro only; Universal Streaming skips it and goes straight to `Turn`.
 */
export interface SpeechStartedMessage {
  type: "SpeechStarted";
  /** Start of the turn in ms relative to the beginning of the audio stream. */
  timestamp: number;
  /** Average word confidence of the initial transcript. */
  confidence: number;
}

/** `Turn` — partial or final transcript of a single speaker turn. */
export interface TurnMessage {
  type: "Turn";
  turn_order: number;
  end_of_turn: boolean;
  turn_is_formatted: boolean;
  transcript: string;
  end_of_turn_confidence: number;
  words: Word[];
  /** Populated only on end_of_turn messages; empty string otherwise (may be null on some builds). */
  utterance?: string | null;
  /** Present when speaker_labels is enabled. */
  speaker_label?: string;
  /** Present when language_detection is enabled. */
  language_code?: string;
  language_confidence?: number;
}

/** A word inside a `SpeakerRevision` — text/timestamps unchanged, only `speaker` revised. */
export interface SpeakerRevisionWord {
  text: string;
  speaker: string;
  start: number;
  end: number;
}

/** A single speaker-label revision inside `SpeakerRevision`. */
export interface SpeakerRevision {
  /** Matches the `turn_order` of the original Turn being corrected. */
  turn_order: number;
  speaker_label: string | null;
  words: SpeakerRevisionWord[];
}

/** `SpeakerRevision` — refines speaker labels on earlier turns; sent once, right before `Termination`. */
export interface SpeakerRevisionMessage {
  type: "SpeakerRevision";
  revisions: SpeakerRevision[];
}

/** `Heartbeat` — every 5 s when `session_heartbeat=true`. */
export interface HeartbeatMessage {
  type: "Heartbeat";
  total_audio_received_ms: number;
  total_duration_ms: number;
  realtime_factor: number;
  max_speech_probability: number;
}

/** `LLMGatewayResponse` — emitted per finalized turn when llm_gateway is configured. */
export interface LLMGatewayResponseMessage {
  type: "LLMGatewayResponse";
  turn_order: number;
  transcript: string;
  data: unknown;
}

/** `Termination` — sent by the server after it receives `Terminate`; always the last message. */
export interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  /** Wall-clock seconds the connection was open — this is what is billed. */
  session_duration_seconds: number;
}

/** `Error` — text frame sent immediately before the server closes on a failure. */
export interface ErrorMessage {
  type: "Error";
  /** The WebSocket then closes with this same value as its close code. */
  error_code: number;
  error: string;
}

/** Union of all server→client messages. */
export type ServerMessage =
  | BeginMessage
  | SpeechStartedMessage
  | TurnMessage
  | SpeakerRevisionMessage
  | HeartbeatMessage
  | LLMGatewayResponseMessage
  | TerminationMessage
  | ErrorMessage;

/**
 * Outbound (client→server) messages. Audio is sent as raw binary frames;
 * controls are JSON text frames.
 */
export type ClientMessage =
  | { type: "Terminate" }
  | { type: "ForceEndpoint" }
  | { type: "KeepAlive" }
  | UpdateConfigurationMessage;

/** Fields accepted by `UpdateConfiguration` (all optional; the message is a delta). */
export interface UpdateConfigurationFields {
  /** U3.5 Pro only. Max 1750 chars. */
  prompt?: string;
  /** Replaces the current list. Max 100 terms, each <= 50 chars. `[]` clears. */
  keyterms_prompt?: string[];
  /** The agent's most recent spoken reply (U3.5 Pro only, max 1750 chars). Replaces the previous value. */
  agent_context?: string;
  /** U3.5 Pro only. */
  mode?: "min_latency" | "balanced" | "max_accuracy";
  min_turn_silence?: number;
  max_turn_silence?: number;
  /** Universal Streaming only. */
  end_of_turn_confidence_threshold?: number;
  /** U3.5 Pro only. */
  continuous_partials?: boolean;
  vad_threshold?: number;
  /** U3.5 Pro only, 0-1000 ms. */
  interruption_delay?: number;
  /** U3.5 Pro only. `[]` clears steering. */
  language_codes?: string[];
  session_heartbeat?: boolean;
}

export interface UpdateConfigurationMessage extends UpdateConfigurationFields {
  type: "UpdateConfiguration";
}

/** Latency/accuracy preset (U3.5 Pro). */
export type RealtimeMode = "min_latency" | "balanced" | "max_accuracy";

/** Audio encodings accepted on the socket. */
export type RealtimeEncoding = "pcm_s16le" | "pcm_mulaw" | "opus" | "ogg_opus" | "aac";

/** Connection query parameters for `/v3/ws` (verified against the AsyncAPI spec). */
export interface RealtimeParams {
  /** Sample rate of the PCM audio fed to the socket (8000-96000). Default 16000. */
  sampleRate: number;
  /** The realtime speech model, e.g. "universal-3-5-pro". */
  speechModel: string;
  /** Latency/accuracy preset (U3.5 Pro only). */
  mode?: RealtimeMode;
  /** Encoding: "pcm_s16le" (default), "pcm_mulaw", "opus", "ogg_opus", "aac". */
  encoding?: RealtimeEncoding;
  /** Steer transcription toward these languages (U3.5 Pro only), e.g. ["en","fr"]. */
  language_codes?: string[];
  /** @deprecated Use `language_codes`. Mapped to `language_codes=[code]`. */
  language_code?: string;
  /** Return language_code + language_confidence on Turn events. */
  language_detection?: boolean;
  /** Domain specialization, e.g. "medical-v1". */
  domain?: string;
  /** Emit `Heartbeat` every 5 s. */
  session_heartbeat?: boolean;
  /** Silence (ms) before a speculative end-of-turn check (50-10000). */
  min_turn_silence?: number;
  /** Max silence (ms) before the turn is forced to end. */
  max_turn_silence?: number;
  /** Universal Streaming only. */
  end_of_turn_confidence_threshold?: number;
  /** VAD confidence threshold 0-1. */
  vad_threshold?: number;
  /** First-partial delay 0-1000 ms (U3.5 Pro only). */
  interruption_delay?: number;
  /** Steady-cadence partials during long turns (U3.5 Pro only). */
  continuous_partials?: boolean;
  /** Emit partial turns (default true; false when redact_pii). */
  include_partial_turns?: boolean;
  /** Universal Streaming only. */
  format_turns?: boolean;
  /** Natural-language context describing the audio (U3.5 Pro only, max 1750 chars). */
  prompt?: string;
  /** Up to 100 domain terms (<= 50 chars each) to bias recognition. */
  keyterms_prompt?: string[];
  /** The agent's opening greeting / last reply, to bias the next user turn (U3.5 Pro only). */
  agent_context?: string;
  /** Advanced: prior conversation entries carried as context (0-100; server default 5). */
  previous_context_n_turns?: number;
  /** Speaker diarization. */
  speaker_labels?: boolean;
  /** Hard cap on speaker labels when diarization is enabled (1-10). */
  max_speakers?: number;
  /** Background-noise suppression: "near-field" | "far-field". */
  voice_focus?: "near-field" | "far-field";
  /** Voice-focus aggressiveness 0.0-1.0 (requires voice_focus). */
  voice_focus_threshold?: number;
  /** PII redaction (final turns only). */
  redact_pii?: boolean;
  /** PII policies (requires redact_pii). */
  redact_pii_policies?: string[];
  /** "entity_name" | "hash" (requires redact_pii). */
  redact_pii_sub?: "entity_name" | "hash";
  /** Profanity filter. */
  filter_profanity?: boolean;
  /** JSON-stringified LLM Gateway configuration applied per final turn. */
  llm_gateway?: string;
  /** Inactivity timeout in seconds (5-3600). */
  inactivity_timeout?: number;
}

/** Normalized turn event delivered to subscribers. */
export interface TurnEvent {
  /** Raw `turn_order` from the server (restarts at 0 on every new session/reconnect). */
  turnOrder: number;
  /** `end_of_turn` */
  final: boolean;
  /** `turn_is_formatted` */
  formatted: boolean;
  transcript: string;
  endOfTurnConfidence: number;
  words: Word[];
  utterance: string | null;
  speakerLabel?: string;
  languageCode?: string;
  languageConfidence?: number;
  /** Server session id (`Begin.id`) this turn belongs to. */
  sessionId?: string;
  /** Reconnect generation (0 for the first session). Use with `turnOrder` to dedupe. */
  generation?: number;
}

/** Normalized SpeechStarted event delivered to subscribers. */
export interface SpeechStartedEvent {
  timestamp: number;
  confidence: number;
}

/** Normalized speaker revision delivered to subscribers. */
export interface SpeakerRevisionEvent {
  revisions: SpeakerRevision[];
  /** `turn_order` values referenced by the revisions, for matching against prior `turn` events. */
  turnOrders: number[];
}

/** Normalized Heartbeat event. */
export interface HeartbeatEvent {
  totalAudioReceivedMs: number;
  totalDurationMs: number;
  realtimeFactor: number;
  maxSpeechProbability: number;
}
