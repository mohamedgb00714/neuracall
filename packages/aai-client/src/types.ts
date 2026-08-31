/**
 * Types for the AssemblyAI realtime (v3 WebSocket) protocol, verified against
 * the live docs (https://www.assemblyai.com/docs/streaming/message-sequence).
 */

/** WebSocket close codes documented for the realtime STT API. */
export enum RealtimeCloseCode {
  Unauthorized = 1008, // missing/invalid Authorization or token
  SessionCancelled = 3005, // server-side error
  InvalidMessage = 3006, // invalid message type / JSON
  BadAudioChunk = 3007, // chunk outside 50-1000ms or faster than real-time
  SessionExpired = 3008, // 3-hour cap
  TooManySessions = 3009, // too many concurrent sessions
}

/** Possible states of a realtime session. */
export type SessionState =
  | "connecting"
  | "open"
  | "terminating"
  | "closed"
  | "error";

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence: number;
  word_is_final: boolean;
  /** Present on final words when speaker_labels is enabled. */
  speaker?: string;
}

/** The `Begin` message — sent first once the connection is established. */
export interface BeginMessage {
  type: "Begin";
  id: string;
  expires_at: number;
}

/** `SpeechStarted` — emitted when speech onset is detected. */
export interface SpeechStartedMessage {
  type: "SpeechStarted";
  timestamp: number;
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
  utterance: string | null;
  /** Present when speaker_labels is enabled. */
  speaker_label?: string;
  /** Present when language_detection is enabled. */
  language_code?: string;
  language_confidence?: number;
}

/** A single speaker-label revision inside `SpeakerRevision`. */
export interface SpeakerRevision {
  turn_order: number;
  speaker_label: string;
  words: Word[];
}

/** `SpeakerRevision` — refines speaker labels on earlier turns at session close. */
export interface SpeakerRevisionMessage {
  type: "SpeakerRevision";
  revisions: SpeakerRevision[];
}

/** `LLMGatewayResponse` — emitted per finalized turn when llm_gateway is configured. */
export interface LLMGatewayResponseMessage {
  type: "LLMGatewayResponse";
  turn_order: number;
  transcript: string;
  data: unknown;
}

/** `Termination` — sent by the server after it receives `Terminate`. */
export interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  session_duration_seconds: number;
}

/** Union of all server→client messages. */
export type ServerMessage =
  | BeginMessage
  | SpeechStartedMessage
  | TurnMessage
  | SpeakerRevisionMessage
  | LLMGatewayResponseMessage
  | TerminationMessage;

/**
 * Outbound (client→server) messages. Audio is sent as raw binary frames;
 * controls are JSON.
 */
export type ClientMessage =
  | { type: "Terminate" }
  | { type: "ForceEndpoint" }
  | { type: "KeepAlive" }
  | UpdateConfigurationMessage;

export interface UpdateConfigurationMessage {
  type: "UpdateConfiguration";
  /** May only be present id a subkey is included. */
  prompt?: string;
  keyterms_prompt?: string[];
  agent_context?: string;
  min_turn_silence?: number;
  max_turn_silence?: number;
  continuous_partials?: boolean;
  vad_threshold?: number;
  interruption_delay?: number;
}

/** Parameters for opening a realtime session (verified against live docs). */
export interface RealtimeParams {
  /** Sample rate of the PCM16 mono audio fed to the socket. Default 16000. */
  sampleRate: number;
  /** Required. The realtime speech model, e.g. "universal-3-5-pro". */
  speechModel: string;
  /** Latency/accuracy preset: "min_latency" | "balanced" | "max_accuracy". */
  mode?: "min_latency" | "balanced" | "max_accuracy";
  /** Encoding: "pcm_s16le" (default) or "pcm_mulaw". */
  encoding?: "pcm_s16le" | "pcm_mulaw";
  /** PII redaction (final turns only). */
  redact_pii?: boolean;
  /** Profanity filter. */
  filter_profanity?: boolean;
  /** Bias transcription toward a language (U3.5 Pro). */
  language_code?: string;
  /** Return language_code + language_confidence on Turn events. */
  language_detection?: boolean;
  /** Natural-language guidance describing the audio / steering behavior. */
  prompt?: string;
  /** Up to 100 domain terms to bias recognition (realtime). */
  keyterms_prompt?: string[];
  /** The agent's last spoken reply, to bias the next user turn. */
  agent_context?: string;
  /** Speaker diarization (U3.5 Pro realtime). */
  speaker_labels?: boolean;
  /** Max speakers when diarization is enabled (1-10). */
  max_speakers?: number;
  /** Background-noise suppression: "near-field" | "far-field". */
  voice_focus?: "near-field" | "far-field";
  /** Voice-focus threshold 0.0-1.0 (requires voice_focus). */
  voice_focus_threshold?: number;
  /** Inactivity timeout in seconds (5-3600). */
  inactivity_timeout?: number;
}

/** Normalized turn event delivered to subscribers. */
export interface TurnEvent {
  turnOrder: number;
  final: boolean;
  formatted: boolean;
  transcript: string;
  endOfTurnConfidence: number;
  words: Word[];
  utterance: string | null;
  speakerLabel?: string;
  languageCode?: string;
  languageConfidence?: number;
}

/** Normalized SpeechStarted event delivered to subscribers. */
export interface SpeechStartedEvent {
  timestamp: number;
  confidence: number;
}

/** Normalized speaker revision delivered to subscribers. */
export interface SpeakerRevisionEvent {
  revisions: SpeakerRevision[];
}
