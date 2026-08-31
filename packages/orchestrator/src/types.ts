/**
 * The contracts the orchestrator wires together. Everything the orchestrator
 * touches that involves hardware, the network or money is an interface here,
 * so the whole call loop can be driven by fakes in a test without a phone, a
 * WebSocket or an AssemblyAI bill.
 */

import type { ChannelKind } from "@neuracall/device-manager";
import type { CallState } from "./stateMachine.js";

/** Who started the call. */
export type CallDirection = "inbound" | "outbound";

/** How a call finished. Set once, when the call reaches `ended`. */
export type CallOutcome =
  /** Ran to completion and hung up normally. */
  | "completed"
  /** Detected and answered, but something broke mid-call. */
  | "failed"
  /** Rang but was never answered (caller gave up, or answering failed). */
  | "missed"
  /** Deliberately declined. */
  | "rejected";

/** One utterance in a call's transcript. */
export interface TranscriptEntry {
  /** Who said it. */
  speaker: "caller" | "agent";
  text: string;
  /** ms since epoch. */
  at: number;
  /** Server `turn_order` for caller turns, so revisions can be matched up. */
  turnOrder?: number;
}

/** The persisted record of a call. One row per call. */
export interface CallRecord {
  callId: string;
  deviceId: string;
  /** "cellular" | "whatsapp". */
  channelId: ChannelKind;
  direction: CallDirection;
  /** The state the call is in (or finished in). */
  state: CallState;
  outcome: CallOutcome | null;
  /** The other party, when known. */
  remoteParty: string | null;
  /** ms since epoch, when the call was first seen. */
  startedAt: number;
  /** ms since epoch, when it was answered. */
  answeredAt: number | null;
  /** ms since epoch, when it ended. */
  endedAt: number | null;
  transcript: TranscriptEntry[];
  /** Path of the recorded WAV, when recording is enabled. */
  audioPath: string | null;
  /** Every state transition, for debugging a call after the fact. */
  states: Array<{ state: CallState; at: number; reason?: string }>;
  /** Set when the call failed. */
  error?: string;
}

/**
 * Persistence for call records. Deliberately narrow: the Phase 6 CRM task
 * swaps in a SQLite-backed implementation behind this same interface, so
 * nothing in the orchestrator needs to change when it does.
 *
 * `save` is an upsert keyed by `callId` and is called repeatedly as a call
 * progresses, so a crash mid-call still leaves a record of how far it got.
 */
export interface CallRecordStore {
  save(record: CallRecord): Promise<void>;
  get(callId: string): Promise<CallRecord | undefined>;
  list(opts?: { deviceId?: string; limit?: number }): Promise<CallRecord[]>;
}

/** What the agent is told about a finished caller turn. */
export interface AgentTurnContext {
  callId: string;
  deviceId: string;
  channelId: ChannelKind;
  /** The caller's finalized utterance. */
  transcript: string;
  turnOrder: number;
  /** The conversation so far, oldest first, including this turn. */
  history: TranscriptEntry[];
}

/** An agent's reply to a caller turn. */
export interface AgentReply {
  /** What to say. Used for `agent_context` biasing even when audio is absent. */
  text: string;
  /** Synthesised speech to play into the call. Omit and nothing is heard. */
  audio?: Uint8Array;
  /** Rate of `audio`. Defaults to the localOut stream's configured rate. */
  sampleRate?: number;
  /** Channels of `audio`. Defaults to the localOut stream's configured value. */
  channels?: 1 | 2;
  /** Terms to bias the next turn toward (names, SKUs, account numbers). */
  keyterms?: string[];
  /** End the call after this reply has played. */
  hangUp?: boolean;
}

/**
 * The conversational brain. Phase 5's agent task supplies the real one (LLM +
 * TTS); the orchestrator only needs "a finalized caller turn goes in, an
 * optional reply comes out".
 *
 * Returning null means "say nothing" — the caller is still talking, or the
 * turn was noise.
 */
export interface CallAgent {
  onFinalTurn(ctx: AgentTurnContext): Promise<AgentReply | null>;
  /** Optional greeting spoken as soon as the call is answered. */
  onAnswered?(ctx: Omit<AgentTurnContext, "transcript" | "turnOrder">): Promise<AgentReply | null>;
  /** Called once the call is over, for cleanup / summarisation. */
  onCallEnded?(record: CallRecord): Promise<void>;
}

/** Anything the far-end capture can be pointed at (a scrcpy `PcmSink`). */
export interface CapturePcmSink {
  format?(fmt: { sampleRate: number; channels: number; bitsPerSample?: number }): void;
  push(buf: Uint8Array): void;
  end(): void;
}

/** A running capture that can be stopped. */
export interface CaptureHandle {
  stop(): void;
}

/**
 * Starts far-end audio capture for a device. The production implementation
 * drives scrcpy (`ScrcpyAudioCapture`); tests supply one that pushes recorded
 * PCM so the whole loop runs offline.
 */
export interface AudioCapture {
  start(opts: { deviceId: string; sink: CapturePcmSink }): Promise<CaptureHandle>;
}
