/**
 * AssemblyAI Voice Agent session (wss://agents.assemblyai.com/v1/ws).
 *
 * This is a different protocol from the v3 streaming endpoint in realtime.ts,
 * which is why it is a separate class rather than a mode of RealtimeStream:
 * every frame is JSON in both directions (audio travels base64-encoded *inside*
 * JSON, never as a binary frame), the first client frame is a mandatory
 * configuration message, and nothing may be sent until the server answers with
 * `session.ready`.
 *
 * THE CONSTRAINT THAT SHAPED THIS FILE — input audio must be PCM16 mono at
 * EXACTLY 24000 Hz. Verified by experiment against the live API: an agent whose
 * input sample_rate is 16000 or 8000 does not fail with a rate error. It fails
 * at session start with {"code":"internal_error","message":"Internal service
 * error"} and a 1011 close, which is indistinguishable from an AssemblyAI
 * outage and sends the reader hunting for the wrong bug. There is no other
 * signal. So the rate is validated at construction, defaulted to 24000 when the
 * caller omits it, and every failure raised before `session.ready` is decorated
 * with that cause. NeuraCall captures at 16 kHz, so a 16k → 24k resample is
 * mandatory upstream of sendAudio().
 *
 * A BYO-LLM block cannot be sent here: session.update answers `invalid_value`
 * with "BYO LLM config is not allowed on session.update; define it on a stored
 * agent via POST /v1/agents". The inline config type therefore forbids `llm`
 * and the constructor rejects it by name.
 *
 * Events emitted (all payloads are the normalized *Event types below):
 *   open, ready, updated, userTranscript, agentTranscript, replyAudio,
 *   replyStarted, replyDone, speechStarted, speechStopped, toolCall, ended,
 *   message (an unrecognized server frame), warn, error, close.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { WebSocketFactory, WsLike } from "./realtime.js";

/**
 * Default Voice Agent socket: the edge host, matching the default region.
 * A region-pinned deployment passes `config.voiceAgent.wsUrl` as `url` instead
 * — the agents.* hosts are separate per-region deployments, and a stored agent
 * is only visible through the region it was created in.
 */
export const VOICE_AGENT_WS_URL = "wss://agents.assemblyai.com/v1/ws";

/**
 * Browser/mobile token endpoint (`?expires_in_seconds=`). Tokens are one-time
 * use: a reconnect or a session.resume needs a freshly minted one.
 */
export const VOICE_AGENT_TOKEN_URL = "https://agents.assemblyai.com/v1/token";

/**
 * The only sample rate the Voice Agent API accepts, for input and output alike.
 * Not a default — a hard requirement; see the file header for how it fails.
 */
export const VOICE_AGENT_SAMPLE_RATE = 24000;

/** Bytes per sample of the PCM16 the endpoint speaks (mono). */
const BYTES_PER_SAMPLE = 2;

/** How long the server keeps a dropped session resumable. */
export const VOICE_AGENT_RESUME_GRACE_MS = 30_000;

/** Lifecycle states. `ready` is the only one in which audio may be sent. */
export type VoiceAgentState =
  "idle" | "connecting" | "configuring" | "ready" | "ending" | "closed" | "error";

/* ------------------------------------------------------------------ config */

export interface VoiceAgentAudioFormat {
  /** The only encoding the endpoint documents. */
  encoding: "audio/pcm";
  /**
   * Must be VOICE_AGENT_SAMPLE_RATE. Typed `number`, not the literal that
   * @neuracall/config uses, precisely so a rate arriving from env/JSON reaches
   * assertVoiceAgentSampleRate() and gets the real diagnosis instead of being
   * cast past it.
   */
  sample_rate: number;
}

export interface VoiceAgentTurnDetection {
  vad_threshold?: number;
  min_silence?: number;
  max_silence?: number;
  /** Whether user speech barges in on an in-flight reply. */
  interrupt_response?: boolean;
  /** How long after the caller speaks before the agent interrupts its reply. */
  interruption_delay?: number;
}

export interface VoiceAgentInputConfig {
  format?: VoiceAgentAudioFormat;
  turn_detection?: VoiceAgentTurnDetection;
  /** Speed-vs-accuracy tradeoff; the agent's pacing presets. */
  transcription_mode?: "min_latency" | "balanced" | "max_accuracy";
  /** `near-field` (close-talking mics) or `far-field` (speakerphone, room). */
  voice_focus?: "near-field" | "far-field";
  /** Voice-focus aggressiveness 0.0-1.0; requires `voice_focus`. */
  voice_focus_threshold?: number;
  /** Recognition biasing terms (the agent-side equivalent of keyterms_prompt). */
  keyterms?: string[];
}

export interface VoiceAgentOutputConfig {
  format?: VoiceAgentAudioFormat;
  /**
   * The voice, as a bare id string such as "alba".
   *
   * This is where the voice lives on `session.update`, and it is NOT where it
   * lives on `POST /v1/agents` — that takes `voice: { voice_id }` at the top
   * level instead. Sending the stored-agent shape here is rejected with
   * `invalid_format`, so `normalizeInlineConfig` accepts the ergonomic
   * top-level form and moves it here.
   */
  voice?: string;
  /** 0-100. */
  volume?: number;
}

export interface VoiceAgentTool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments the model will produce. */
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Inline session configuration — the alternative to a stored `agent_id`. */
export interface VoiceAgentInlineConfig {
  system_prompt?: string;
  greeting?: string;
  /**
   * A voice id such as "eve"; the catalogue lives in voiceAgentAdmin.ts.
   *
   * A bare string, deliberately. `POST /v1/agents` takes `voice: { voice_id }`
   * and it is the obvious thing to write here too, but `session.update` rejects
   * that shape outright with `invalid_format` — the wire wants it under
   * `output.voice`. `normalizeInlineConfig` moves it there, so this stays the
   * one place a caller sets a voice whichever transport is in play.
   */
  voice?: string;
  input?: VoiceAgentInputConfig;
  output?: VoiceAgentOutputConfig;
  tools?: VoiceAgentTool[];
  /**
   * Not sendable here. The server rejects a BYO-LLM block on session.update
   * with `invalid_value`; it only exists on a stored agent created through
   * POST /v1/agents. Typed as `never` so the mistake is a compile error.
   */
  llm?: never;
  [key: string]: unknown;
}

export interface VoiceAgentOptions {
  /** Raw account key. Sent as `authorization: Bearer <key>`; never logged. */
  apiKey?: string;
  /** Pre-minted one-time token (browser pattern); sent as `?token=`. */
  token?: string;
  /** A stored agent (POST /v1/agents). Mutually exclusive with `session`. */
  agentId?: string;
  /** Inline configuration. Mutually exclusive with `agentId`. */
  session?: VoiceAgentInlineConfig;
  /**
   * Declared input rate, for the `agentId` case where the config lives on the
   * server and cannot be inspected. Validated for the caller's benefit.
   */
  inputSampleRate?: number;
  /** Endpoint override — pass `config.voiceAgent.wsUrl` to honour the region. */
  url?: string;
  /** How long connect() waits for `session.ready`. Default 15000 ms. */
  readyTimeoutMs?: number;
  /** How long close() waits for `session.ended` before closing. Default 5000 ms. */
  endTimeoutMs?: number;
}

export interface VoiceAgentDeps {
  wsFactory?: WebSocketFactory;
  now?: () => number;
}

/* ------------------------------------------------- server → client messages */

export interface VoiceAgentReadyMessage {
  type: "session.ready";
  session_id: string;
  config?: Record<string, unknown>;
}

export interface VoiceAgentUpdatedMessage {
  type: "session.updated";
  config?: Record<string, unknown>;
}

/**
 * Field names are intentionally loose: the live capture showed an audio
 * duration and a session duration, but not which spelling the server uses, so
 * both are accepted and normalized.
 */
export interface VoiceAgentEndedMessage {
  type: "session.ended";
  audio_duration?: number;
  session_duration?: number;
  audio_duration_seconds?: number;
  session_duration_seconds?: number;
  [key: string]: unknown;
}

export interface VoiceAgentErrorMessage {
  type: "session.error";
  code: string;
  message: string;
  param?: string;
  session_id?: string;
}

export type VoiceAgentServerMessage =
  | VoiceAgentReadyMessage
  | VoiceAgentUpdatedMessage
  | VoiceAgentEndedMessage
  | VoiceAgentErrorMessage
  | { type: "input.speech.started" }
  | { type: "input.speech.stopped" }
  | { type: "transcript.user.delta"; delta: string; item_id?: string }
  | { type: "transcript.user"; text: string; item_id?: string }
  | { type: "reply.started"; reply_id: string; item_id?: string }
  | { type: "reply.audio"; data: string }
  | {
      type: "transcript.agent.delta";
      reply_id: string;
      item_id?: string;
      delta: string;
      start_ms?: number;
      end_ms?: number;
    }
  | {
      type: "transcript.agent";
      reply_id: string;
      item_id?: string;
      text: string;
      interrupted?: boolean;
    }
  | { type: "reply.done"; reply_id: string; status: "completed" | "interrupted" }
  | { type: "tool.call"; call_id: string; name: string; arguments: unknown };

/* ------------------------------------------------- client → server messages */

export type VoiceAgentClientMessage =
  | { type: "session.update"; session: Record<string, unknown> }
  | { type: "session.resume"; session_id: string }
  | { type: "session.end" }
  | { type: "input.audio"; audio: string }
  | { type: "tool.result"; call_id: string; result: string }
  | { type: "reply.create"; instructions?: string };

/* -------------------------------------------------------- normalized events */

export interface VoiceAgentReadyEvent {
  sessionId: string;
  config: Record<string, unknown> | null;
  /** True when this session came back through session.resume. */
  resumed: boolean;
}

export interface VoiceAgentUserTranscriptEvent {
  text: string;
  /** false for `transcript.user.delta`, true for `transcript.user`. */
  final: boolean;
  itemId: string | null;
}

export interface VoiceAgentAgentTranscriptEvent {
  text: string;
  /** false for `transcript.agent.delta`, true for `transcript.agent`. */
  final: boolean;
  replyId: string;
  itemId: string | null;
  startMs: number | null;
  endMs: number | null;
  /** Only meaningful on the final event: the user barged in mid-reply. */
  interrupted: boolean;
}

export interface VoiceAgentReplyStartedEvent {
  replyId: string;
  itemId: string | null;
}

export interface VoiceAgentReplyDoneEvent {
  replyId: string;
  status: "completed" | "interrupted";
}

export interface VoiceAgentToolCallEvent {
  callId: string;
  name: string;
  /** Exactly what the server sent (a JSON string in every observed call). */
  raw: unknown;
  /** `raw` parsed when it was a JSON object, else null. */
  arguments: Record<string, unknown> | null;
}

export interface VoiceAgentEndedEvent {
  audioDurationSeconds: number | null;
  sessionDurationSeconds: number | null;
}

export interface VoiceAgentCloseEvent {
  code: number;
  reason: string;
}

/** A `session.error` frame, carrying the server's own code/param. */
export class VoiceAgentError extends Error {
  readonly code: string;
  readonly param: string | undefined;
  readonly sessionId: string | undefined;

  constructor(code: string, message: string, param?: string, sessionId?: string) {
    super(message);
    this.name = "VoiceAgentError";
    this.code = code;
    this.param = param;
    this.sessionId = sessionId;
  }
}

/**
 * Reject a sample rate that is not 24000, naming the failure it actually
 * produces. This message is the whole point of the check: the server's own
 * report of a wrong rate is an "internal_error", so anyone who trusts the
 * server's wording debugs a nonexistent outage instead of their resampler.
 */
export function assertVoiceAgentSampleRate(rate: number, field: string): void {
  if (rate === VOICE_AGENT_SAMPLE_RATE) return;
  throw new RangeError(
    `${field}=${rate} is invalid: the AssemblyAI Voice Agent API accepts PCM16 mono at ` +
      `exactly ${VOICE_AGENT_SAMPLE_RATE} Hz for both input and output. A session opened at ` +
      `${rate} Hz does NOT report a sample-rate problem — it fails at session start with the ` +
      `misleading {"code":"internal_error","message":"Internal service error"} and a 1011 close, ` +
      `which reads as an AssemblyAI outage. Resample to ${VOICE_AGENT_SAMPLE_RATE} Hz before ` +
      `sending audio (NeuraCall captures at 16000 Hz, so a 16k->24k step is mandatory).`,
  );
}

/** Appended to any failure seen before `session.ready`, where the rate bites. */
const READY_FAILURE_HINT =
  `If this is "internal_error"/1011, the most likely cause is audio configured at a rate other ` +
  `than ${VOICE_AGENT_SAMPLE_RATE} Hz: the Voice Agent API reports a wrong input sample rate as ` +
  `a generic internal error, never as a rate error.`;

/** The real `ws` WebSocket honours WsLike, exactly as in realtime.ts. */
const realWsFactory: WebSocketFactory = (url, opts) => new WebSocket(url, opts);

/**
 * One Voice Agent conversation.
 *
 * Lifecycle: connect() opens the socket, sends `session.update` (or
 * `session.resume`) as the very first frame, and resolves only once the server
 * answers `session.ready`. Audio may be sent from that point until close().
 */
export class VoiceAgentSession extends EventEmitter {
  private ws: WsLike | null = null;
  private readonly opts: VoiceAgentOptions;
  private readonly wsFactory: WebSocketFactory;
  private readonly now: () => number;
  private readonly inlineConfig: Record<string, unknown> | null;
  private readonly readyTimeoutMs: number;
  private readonly endTimeoutMs: number;

  private _state: VoiceAgentState = "idle";
  private _sessionId: string | null = null;
  private authToken: string | undefined;
  /** True once a session.ready has been seen, so a later send is a race, not misuse. */
  private everReady = false;
  /** Wall clock of the last close, for the 30 s resume grace window. */
  private closedAt: number | null = null;
  /** Guards finalize(): teardown must run exactly once per socket. */
  private finalized = true;
  private pending: PendingConnect | null = null;
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(options: VoiceAgentOptions, deps: VoiceAgentDeps = {}) {
    super();
    if (options.agentId && options.session) {
      throw new Error(
        "agentId and an inline session config are mutually exclusive on session.update: " +
          "send one or the other, never both.",
      );
    }
    if (!options.agentId && !options.session) {
      throw new Error(
        "A VoiceAgentSession needs either an agentId (a stored agent) or an inline session config; " +
          "session.update cannot be empty.",
      );
    }
    if (!options.apiKey && !options.token) {
      throw new Error(
        "A VoiceAgentSession needs an apiKey (server-side) or a pre-minted token (browser).",
      );
    }
    if (options.session && "llm" in options.session && options.session["llm"] !== undefined) {
      throw new Error(
        "A BYO-LLM block is rejected on session.update (invalid_value): define it on a stored " +
          "agent via POST /v1/agents and connect with that agentId instead.",
      );
    }
    if (options.inputSampleRate !== undefined) {
      assertVoiceAgentSampleRate(options.inputSampleRate, "inputSampleRate");
    }

    this.opts = options;
    this.wsFactory = deps.wsFactory ?? realWsFactory;
    this.now = deps.now ?? Date.now;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    this.endTimeoutMs = options.endTimeoutMs ?? 5_000;
    this.inlineConfig = options.session ? normalizeInlineConfig(options.session) : null;
    if (options.token) this.authToken = options.token;
  }

  /** Authenticate with a pre-minted one-time token (browser/mobile pattern). */
  withToken(token: string): this {
    this.authToken = token;
    return this;
  }

  get state(): VoiceAgentState {
    return this._state;
  }

  /** Server session id, available from `session.ready`; the key for resume(). */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** True while audio may be sent. */
  get isReady(): boolean {
    return this._state === "ready";
  }

  /** Whether the resume grace window is still open (advisory; server decides). */
  get resumable(): boolean {
    if (!this._sessionId || this.closedAt === null) return false;
    return this.now() - this.closedAt <= VOICE_AGENT_RESUME_GRACE_MS;
  }

  /**
   * Open the socket and configure the session. Resolves on `session.ready`,
   * which is deliberately the only signal callers wait on: everything the
   * session can do is illegal before it.
   */
  connect(): Promise<VoiceAgentReadyEvent> {
    const session: Record<string, unknown> = this.opts.agentId
      ? { agent_id: this.opts.agentId }
      : { ...(this.inlineConfig ?? {}) };
    return this.openSocket({ type: "session.update", session }, false);
  }

  /**
   * Re-attach to a dropped session within the 30-second grace window. The first
   * frame is `session.resume` rather than `session.update`: the server still
   * holds the configuration and the conversation history.
   */
  resume(sessionId?: string): Promise<VoiceAgentReadyEvent> {
    const id = sessionId ?? this._sessionId;
    if (!id) {
      return Promise.reject(
        new Error("resume() needs a session_id; none was captured from session.ready."),
      );
    }
    if (this.closedAt !== null && this.now() - this.closedAt > VOICE_AGENT_RESUME_GRACE_MS) {
      // Advisory only — the server is the authority on its own grace window,
      // and a clock skew here should not block a resume that would work.
      this.emit(
        "warn",
        `Resuming ${VOICE_AGENT_RESUME_GRACE_MS} ms grace window has elapsed; the server may ` +
          `refuse this session.resume and a fresh connect() will be needed.`,
      );
    }
    return this.openSocket({ type: "session.resume", session_id: id }, true);
  }

  /**
   * Feed one PCM16 mono chunk at 24 kHz. Base64-encoded into `input.audio`.
   *
   * Before the session has ever been ready this THROWS rather than queueing.
   * Queueing was rejected on purpose: this is live microphone audio, so a
   * buffer drained at ready would replay speech the agent's VAD then treats as
   * current, mistiming the first turn — and because connect() resolves only at
   * `session.ready`, a correct caller cannot reach this path at all. After the
   * session has ended the call returns false instead, since a chunk in flight
   * when the far end hangs up is an ordinary race, not a bug.
   */
  sendAudio(pcm: Uint8Array): boolean {
    if (this._state !== "ready") {
      if (this.everReady) return false;
      throw new Error(
        `sendAudio() before session.ready (state=${this._state}). Await connect(), which ` +
          `resolves when the server sends session.ready; audio sent earlier is discarded.`,
      );
    }
    if (pcm.byteLength === 0) return true;
    if (pcm.byteLength % BYTES_PER_SAMPLE !== 0) {
      throw new RangeError(
        `sendAudio() got ${pcm.byteLength} bytes, which is not a whole number of PCM16 samples; ` +
          `a split sample misaligns every sample after it. Audio must be PCM16 mono at ` +
          `${VOICE_AGENT_SAMPLE_RATE} Hz.`,
      );
    }
    return this.send({
      type: "input.audio",
      audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
    });
  }

  /**
   * Answer a `tool.call`. The server requires `result` to be a JSON-encoded
   * STRING; a bare object is rejected. Objects are stringified here, strings
   * are passed through on the assumption the caller already encoded one.
   */
  sendToolResult(callId: string, result: unknown): boolean {
    const encoded = typeof result === "string" ? result : JSON.stringify(result ?? null);
    return this.send({ type: "tool.result", call_id: callId, result: encoded });
  }

  /** Force a reply out of turn, optionally steering it with instructions. */
  createReply(instructions?: string): boolean {
    return this.send({
      type: "reply.create",
      ...(instructions === undefined ? {} : { instructions }),
    });
  }

  /**
   * End the session. `session.end` is sent first and the server's
   * `session.ended` is awaited (bounded) so the final durations are observed
   * before the socket goes away. Idempotent: repeat calls are no-ops.
   */
  async close(opts: { end?: boolean; force?: boolean } = {}): Promise<void> {
    const { end = true, force = false } = opts;
    const ws = this.ws;
    if (!ws) {
      this.finalize(1000, "already closed");
      return;
    }

    // `session.end` is only meaningful once the server has said session.ready:
    // there is no session to end before that, and the `session.ended` awaited
    // below can never arrive, so a close during the handshake would stall for
    // the whole endTimeoutMs before the socket is released.
    if (end && this.everReady && ws.readyState === WebSocket.OPEN && this._state !== "ending") {
      this._state = "ending";
      // Subscribe before sending: the server is free to answer session.ended
      // (and close) inside the same tick, and a listener attached afterwards
      // would wait out the full timeout for an event that already happened.
      const ended = force ? null : this.awaitEnded(ws);
      this.send({ type: "session.end" });
      if (ended) await ended;
    }

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    this.finalize(1000, "closed by client");
  }

  /** Force-close without the `session.end` handshake (error paths only). */
  destroy(): void {
    const ws = this.ws;
    try {
      ws?.terminate();
    } catch {
      /* already gone */
    }
    this.finalize(1006, "destroyed");
  }

  /* ----------------------------------------------------------- internals */

  private openSocket(
    first: VoiceAgentClientMessage,
    resumed: boolean,
  ): Promise<VoiceAgentReadyEvent> {
    if (this.ws) {
      return Promise.reject(new Error("VoiceAgentSession is already connected."));
    }

    return new Promise<VoiceAgentReadyEvent>((resolve, reject) => {
      let ws: WsLike;
      try {
        ws = this.createSocket();
      } catch (err) {
        this._state = "error";
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.ws = ws;
      this.finalized = false;
      this.everReady = false;
      this._state = "connecting";
      this.pending = { resolve, reject, resumed, settled: false };

      this.readyTimer = setTimeout(() => {
        this.failPending(
          new Error(
            `Timed out after ${this.readyTimeoutMs} ms waiting for session.ready. ${READY_FAILURE_HINT}`,
          ),
        );
        this.destroy();
      }, this.readyTimeoutMs);
      this.readyTimer.unref?.();

      ws.on("open", () => {
        // The configuration frame MUST be the first thing on the wire; sending
        // it synchronously here leaves no window for another frame to precede it.
        this._state = "configuring";
        this.emit("open", {});
        this.send(first);
      });
      ws.on("message", (data: unknown) => this.handleMessage(data));
      ws.on("error", (err: Error) => {
        if (this.pending) this.failPending(decorateBeforeReady(err));
        else this.reportError(err);
      });
      ws.on("close", (code: number, reason: unknown) =>
        this.handleClose(typeof code === "number" ? code : 1006, bufferText(reason)),
      );
    });
  }

  private createSocket(): WsLike {
    const url = this.opts.url ?? VOICE_AGENT_WS_URL;
    // Auth: a one-time token goes in the query string (browsers cannot set
    // upgrade headers); server-side the raw key goes in the header, with the
    // `Bearer ` prefix this endpoint requires — unlike the v3 streaming host.
    if (this.authToken) {
      const sep = url.includes("?") ? "&" : "?";
      return this.wsFactory(`${url}${sep}token=${encodeURIComponent(this.authToken)}`);
    }
    return this.wsFactory(url, {
      headers: { authorization: `Bearer ${this.opts.apiKey ?? ""}` },
    });
  }

  /** Serialize one client frame. Returns false when the socket cannot take it. */
  private send(msg: VoiceAgentClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  private awaitEnded(ws: WsLike): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off("ended", finish);
        ws.off("close", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        this.emit("warn", "Timed out waiting for session.ended; closing the socket anyway.");
        finish();
      }, this.endTimeoutMs);
      timer.unref?.();
      this.once("ended", finish);
      ws.once("close", finish);
    });
  }

  private handleMessage(raw: unknown): void {
    let msg: VoiceAgentServerMessage;
    try {
      msg = JSON.parse(bufferText(raw)) as VoiceAgentServerMessage;
    } catch {
      this.reportError(new Error("Received non-JSON frame from the Voice Agent endpoint."));
      return;
    }

    switch (msg.type) {
      case "session.ready": {
        this._sessionId = msg.session_id;
        this._state = "ready";
        this.everReady = true;
        const event: VoiceAgentReadyEvent = {
          sessionId: msg.session_id,
          config: msg.config ?? null,
          resumed: this.pending?.resumed ?? false,
        };
        this.emit("ready", event);
        this.settlePending(event);
        break;
      }
      case "session.updated":
        this.emit("updated", msg.config ?? null);
        break;
      case "session.error": {
        const err = new VoiceAgentError(msg.code, msg.message, msg.param, msg.session_id);
        if (this.pending) {
          this.failPending(decorateBeforeReady(err));
          // A refused handshake must not leave the socket behind. Only some
          // rejections close it: "internal_error" arrives with a 1011, but the
          // documented `invalid_value` on session.update does not, and the
          // orphaned socket then makes every later connect()/resume() fail with
          // "already connected". Release it exactly as the ready timeout does.
          this.destroy();
        } else this.reportError(err);
        break;
      }
      case "session.ended":
        this.emit("ended", {
          audioDurationSeconds: pickNumber(msg, "audio_duration", "audio_duration_seconds"),
          sessionDurationSeconds: pickNumber(msg, "session_duration", "session_duration_seconds"),
        } satisfies VoiceAgentEndedEvent);
        break;
      case "input.speech.started":
        this.emit("speechStarted", {});
        break;
      case "input.speech.stopped":
        this.emit("speechStopped", {});
        break;
      case "transcript.user.delta":
        this.emit("userTranscript", {
          text: msg.delta,
          final: false,
          itemId: msg.item_id ?? null,
        } satisfies VoiceAgentUserTranscriptEvent);
        break;
      case "transcript.user":
        this.emit("userTranscript", {
          text: msg.text,
          final: true,
          itemId: msg.item_id ?? null,
        } satisfies VoiceAgentUserTranscriptEvent);
        break;
      case "reply.started":
        this.emit("replyStarted", {
          replyId: msg.reply_id,
          itemId: msg.item_id ?? null,
        } satisfies VoiceAgentReplyStartedEvent);
        break;
      case "reply.audio":
        this.handleReplyAudio(msg.data);
        break;
      case "transcript.agent.delta":
        this.emit("agentTranscript", {
          text: msg.delta,
          final: false,
          replyId: msg.reply_id,
          itemId: msg.item_id ?? null,
          startMs: msg.start_ms ?? null,
          endMs: msg.end_ms ?? null,
          interrupted: false,
        } satisfies VoiceAgentAgentTranscriptEvent);
        break;
      case "transcript.agent":
        this.emit("agentTranscript", {
          text: msg.text,
          final: true,
          replyId: msg.reply_id,
          itemId: msg.item_id ?? null,
          startMs: null,
          endMs: null,
          interrupted: msg.interrupted ?? false,
        } satisfies VoiceAgentAgentTranscriptEvent);
        break;
      case "reply.done":
        this.emit("replyDone", {
          replyId: msg.reply_id,
          status: msg.status,
        } satisfies VoiceAgentReplyDoneEvent);
        break;
      case "tool.call":
        this.emit("toolCall", {
          callId: msg.call_id,
          name: msg.name,
          raw: msg.arguments,
          arguments: parseArguments(msg.arguments),
        } satisfies VoiceAgentToolCallEvent);
        break;
      default:
        // Unlike realtime.ts, an unrecognized frame is NOT an error here: the
        // agents API is young and adds event types, and turning a new one into
        // an "error" would break working calls. Surface it and carry on.
        this.emit("warn", `Unhandled Voice Agent frame: ${(msg as { type: string }).type}`);
        this.emit("message", msg);
    }
  }

  /**
   * `reply.audio` carries base64 PCM16 mono 24 kHz in `data` (NOT `audio`;
   * that is the *inbound* field name). Observed chunks were 480 bytes = 10 ms.
   *
   * The decoded bytes are copied into a standalone Uint8Array rather than
   * handed out as the Buffer: Buffer.from(base64) of a small chunk is carved
   * out of Node's shared 8 KB pool, so a consumer doing
   * `new Int16Array(chunk.buffer)` — the obvious way to get samples — would
   * read the whole pool instead of this chunk.
   */
  private handleReplyAudio(data: unknown): void {
    if (typeof data !== "string") {
      this.reportError(new Error("reply.audio arrived without a base64 `data` field."));
      return;
    }
    const decoded = Buffer.from(data, "base64");
    const pcm = new Uint8Array(decoded.byteLength);
    pcm.set(decoded);
    this.emit("replyAudio", pcm);
  }

  private handleClose(code: number, reason: string): void {
    if (this.pending) {
      this.failPending(
        decorateBeforeReady(
          new Error(
            `Socket closed with ${code} before session.ready${reason ? `: ${reason}` : "."}`,
          ),
        ),
      );
    }
    this.finalize(code, reason);
  }

  /**
   * Release the socket exactly once per connection. Everything that can end a
   * session — close(), destroy(), a server close frame, a failed handshake —
   * funnels through here, so listeners are detached and "close" is emitted a
   * single time no matter how many of those happen at once.
   */
  private finalize(code: number, reason: string): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    // A failed handshake keeps "error": it is the more informative of the two,
    // and the socket being gone is already visible through `ws === null`.
    const nextState: VoiceAgentState = this._state === "error" ? "error" : "closed";
    this.closedAt = this.now();
    ws?.removeAllListeners();
    // Then put one listener back, which does nothing.
    //
    // `ws` reports a failure of a socket that never finished connecting by
    // emitting "error" a tick or more after terminate() returns — so it lands
    // here, after the line above has detached everything. An EventEmitter with
    // no "error" listener *throws*, and this runs on Electron's main process,
    // so a connect timeout on a flaky network took the whole app down. There is
    // nothing left to report to: the caller's connect() was already settled by
    // failPending below, and this session is finished either way.
    ws?.on("error", () => {});
    // Settle a connect() that is still waiting. Detaching the listeners above
    // is the point of no return: nothing can deliver session.ready any more,
    // and the socket's own "close" — which the real `ws` reports a tick or more
    // AFTER close()/terminate() returns — can no longer reach handleClose. A
    // close() or destroy() during the handshake would otherwise leave the
    // caller awaiting a promise that never settles. No sample-rate hint here:
    // every path where the rate is the likely cause (server close, socket
    // error, session.error, ready timeout) rejects with its own decorated
    // message before reaching this line, so this fallback only fires on a
    // teardown the caller asked for, where that hint would misdirect.
    this.failPending(
      new Error(
        `The session was closed (code ${code}) before session.ready, so connect() cannot ` +
          `complete.${reason ? ` Reason: ${reason}.` : ""}`,
      ),
    );
    this._state = nextState;
    this.emit("close", { code, reason } satisfies VoiceAgentCloseEvent);
  }

  private settlePending(event: VoiceAgentReadyEvent): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending = null;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    pending.resolve(event);
  }

  private failPending(err: Error): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending = null;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this._state = "error";
    pending.reject(err);
  }

  /**
   * Report an error without being able to kill the host process.
   *
   * Node throws ERR_UNHANDLED_ERROR when "error" is emitted with no listener,
   * which has already turned one recoverable AssemblyAI hiccup in this repo
   * into a crash of the process hosting it. Nothing in this class depends on
   * anyone subscribing, so an unlistened error is dropped rather than thrown.
   */
  private reportError(err: Error): void {
    if (this.listenerCount("error") === 0) return;
    this.emit("error", err);
  }
}

interface PendingConnect {
  resolve: (event: VoiceAgentReadyEvent) => void;
  reject: (err: Error) => void;
  resumed: boolean;
  settled: boolean;
}

/**
 * Fill in the audio formats the caller left out, and validate the ones they
 * supplied. Omission is the common way to get 24 kHz wrong — the server's
 * default is not guaranteed to match what the caller is actually capturing —
 * so the rate is always stated explicitly on the wire.
 */
export function normalizeInlineConfig(config: VoiceAgentInlineConfig): Record<string, unknown> {
  const input: VoiceAgentInputConfig = { ...(config.input ?? {}) };
  const output: VoiceAgentOutputConfig = { ...(config.output ?? {}) };

  if (input.format)
    assertVoiceAgentSampleRate(input.format.sample_rate, "input.format.sample_rate");
  else input.format = { encoding: "audio/pcm", sample_rate: VOICE_AGENT_SAMPLE_RATE };

  if (output.format)
    assertVoiceAgentSampleRate(output.format.sample_rate, "output.format.sample_rate");
  else output.format = { encoding: "audio/pcm", sample_rate: VOICE_AGENT_SAMPLE_RATE };

  // The voice belongs under `output` on this transport. Accepting it at the top
  // level and moving it here is not sugar: the stored-agent API really does
  // take `voice: { voice_id }` at the top level, so a caller who has written
  // one is all but certain to write the other, and the server's answer to that
  // is a bare `invalid_format` naming nothing.
  if (config.voice !== undefined) {
    if (typeof config.voice !== "string") {
      throw new Error(
        'Inline `voice` must be a voice id string such as "alba". ' +
          "The `{ voice_id }` object is the stored-agent shape (POST /v1/agents); " +
          "session.update rejects it as invalid_format.",
      );
    }
    output.voice = config.voice;
  }

  const normalized: Record<string, unknown> = { ...config, input, output };
  delete normalized["llm"];
  // `voice` now lives on `output`; leaving the top-level copy in place is the
  // exact shape the server refuses.
  delete normalized["voice"];
  return normalized;
}

/** Tool arguments arrive JSON-encoded; hand back an object when they parse. */
function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pickNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function bufferText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data ?? "");
}

/** Attach the sample-rate cause to anything that goes wrong pre-ready. */
function decorateBeforeReady(err: Error): Error {
  if (err.message.includes(READY_FAILURE_HINT)) return err;
  const decorated =
    err instanceof VoiceAgentError
      ? new VoiceAgentError(
          err.code,
          `${err.message} ${READY_FAILURE_HINT}`,
          err.param,
          err.sessionId,
        )
      : new Error(`${err.message} ${READY_FAILURE_HINT}`);
  return decorated;
}
