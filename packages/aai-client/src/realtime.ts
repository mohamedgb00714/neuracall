import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AppConfig } from "@neuracall/config";
import {
  RealtimeCloseCode,
  type ClientMessage,
  type BeginMessage,
  type TurnMessage,
  type TerminationMessage,
  type RealtimeParams,
  type SessionState,
  type ServerMessage,
  type UpdateConfigurationFields,
  type ErrorMessage,
  type HeartbeatMessage,
  type TurnEvent,
  type SpeechStartedEvent,
  type SpeakerRevisionEvent,
} from "./types.js";

/** Build the v3 WebSocket URL from connection params. */
function buildWebSocketUrl(host: string, params: RealtimeParams): string {
  const query: Record<string, string> = {
    sample_rate: String(params.sampleRate),
    speech_model: params.speechModel,
  };
  if (params.mode) query["mode"] = params.mode;
  if (params.encoding) query["encoding"] = params.encoding;
  if (params.redact_pii === true) query["redact_pii"] = "true";
  if (params.filter_profanity === true) query["filter_profanity"] = "true";
  if (params.language_detection === true) query["language_detection"] = "true";
  if (params.prompt) query["prompt"] = params.prompt;
  if (params.keyterms_prompt && params.keyterms_prompt.length > 0)
    query["keyterms_prompt"] = JSON.stringify(params.keyterms_prompt);
  if (params.agent_context) query["agent_context"] = params.agent_context;
  if (params.speaker_labels === true) query["speaker_labels"] = "true";
  if (params.max_speakers !== undefined) query["max_speakers"] = String(params.max_speakers);
  if (params.voice_focus) query["voice_focus"] = params.voice_focus;
  if (params.voice_focus_threshold !== undefined)
    query["voice_focus_threshold"] = String(params.voice_focus_threshold);
  if (params.inactivity_timeout !== undefined)
    query["inactivity_timeout"] = String(params.inactivity_timeout);
  // Maps the deprecated singular language_code onto the plural, documented form.
  const codes = params.language_codes ?? (params.language_code ? [params.language_code] : undefined);
  if (codes && codes.length > 0) query["language_codes"] = codes.join(",");
  if (params.domain) query["domain"] = params.domain;
  if (params.session_heartbeat === true) query["session_heartbeat"] = "true";
  if (params.min_turn_silence !== undefined)
    query["min_turn_silence"] = String(params.min_turn_silence);
  if (params.max_turn_silence !== undefined)
    query["max_turn_silence"] = String(params.max_turn_silence);
  if (params.end_of_turn_confidence_threshold !== undefined)
    query["end_of_turn_confidence_threshold"] = String(params.end_of_turn_confidence_threshold);
  if (params.vad_threshold !== undefined) query["vad_threshold"] = String(params.vad_threshold);
  if (params.interruption_delay !== undefined)
    query["interruption_delay"] = String(params.interruption_delay);
  if (params.continuous_partials === true) query["continuous_partials"] = "true";
  if (params.include_partial_turns === true) query["include_partial_turns"] = "true";
  if (params.format_turns === true) query["format_turns"] = "true";
  if (params.previous_context_n_turns !== undefined)
    query["previous_context_n_turns"] = String(params.previous_context_n_turns);
  if (params.redact_pii_policies && params.redact_pii_policies.length > 0)
    query["redact_pii_policies"] = params.redact_pii_policies.join(",");
  if (params.redact_pii_sub) query["redact_pii_sub"] = params.redact_pii_sub;
  if (params.llm_gateway) query["llm_gateway"] = params.llm_gateway;

  const qs = new URLSearchParams(query).toString();
  return `wss://${host}/v3/ws?${qs}`;
}

/** The subset of the `ws` WebSocket the client actually uses (for test seams). */
export interface WsLike extends EventEmitter {
  readonly readyState: number;
  send(data: string | Buffer | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** Build a WebSocket as `ws` does, so a mock can be injected in tests. */
export type WebSocketFactory = (url: string, opts?: { headers?: Record<string, string> }) => WsLike;

/** The real `ws` WebSocket honours WsLike. */
const realWsFactory: WebSocketFactory = (url, opts) => new WebSocket(url, opts);

/**
 * A single realtime STT session backed by the AssemblyAI v3 WebSocket.
 *
 * Authentication: server-side clients pass the raw API key in the `Authorization`
 * header on upgrade; browser/mobile clients provide a `?token=` query string
 * (see mintRealtimeToken). The API key is never embedded in the URL.
 *
 * Termination is explicit: call close({terminate: true}) to send `Terminate`
 * and await `Termination`, otherwise the session stays billable until the
 * 3-hour cap.
 *
 * Error semantics: an irrecoverable stream failure is emitted on `error`
 * (a server Error frame, an unauthorized/expired/cancelled close, a rejected
 * connect). `error` is a special Node event name — emitting it with no
 * listener throws — so consumers MUST attach an `error` listener. Recoverable
 * protocol noise (a non-JSON frame, an unknown server message type, a 3007
 * chunk-size correction) is instead emitted on `notice`, which never throws
 * and always preserves the diagnostic data.
 */
export class RealtimeStream extends EventEmitter {
  private ws: WsLike | null = null;
  private authToken: string | undefined;
  private readonly config: AppConfig;
  private readonly params: RealtimeParams;
  private readonly wsFactory: WebSocketFactory;
  private _state: SessionState = "closed";
  private begin: BeginMessage | null = null;
  /** Settles an in-flight connect() when the socket is closed mid-handshake. */
  private connectReject: ((err: Error) => void) | null = null;
  /** Recommended PCM bytes per send; corrected downward on 3007 (bad chunk size). */
  private chunkBytes: number;

  constructor(
    config: AppConfig,
    params: RealtimeParams,
    deps: { wsFactory?: WebSocketFactory } = {},
  ) {
    super();
    this.config = config;
    this.params = params;
    this.wsFactory = deps.wsFactory ?? realWsFactory;
    // Default to ~100 ms of mono16 PCM (3200 bytes at 16 kHz) — comfortably
    // inside the valid 50–1000 ms range so a 3007 correction can halve it.
    this.chunkBytes = Math.max(1600, Math.floor((params.sampleRate * 2) / 10));
  }

  /** Authenticate with a pre-minted token (browser/mobile pattern). */
  withToken(token: string): this {
    this.authToken = token;
    return this;
  }

  get state(): SessionState {
    return this._state;
  }

  get sessionId(): string | null {
    return this.begin?.id ?? null;
  }

  /** Recommended PCM bytes per send (corrected down on 3007 bad-chunk closes). */
  get chunkSizeBytes(): number {
    return this.chunkBytes;
  }

  /** Open the WebSocket connection. Audio can be fed once `open` fires. */
  connect(): Promise<void> {
    let ws!: WsLike;
    return new Promise((resolve, reject) => {
      if (this.ws) {
        reject(new Error("RealtimeStream already connected."));
        return;
      }

      const url = buildWebSocketUrl(this.config.assemblyai.realtimeHost, this.params);

      // Authentication: temp token goes in the query string; otherwise the
      // raw API key goes in the upgrade header (no Bearer prefix per docs).
      if (this.authToken) {
        const urlWithToken = `${url}&token=${encodeURIComponent(this.authToken)}`;
        ws = this.wsFactory(urlWithToken);
      } else {
        ws = this.wsFactory(url, {
          headers: { authorization: this.config.assemblyai.apiKey },
        });
      }
      this.ws = ws;
      this._state = "connecting";

      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        this.connectReject = null;
      };
      const onOpen = () => {
        this._state = "open";
        this.emit("open", {});
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        this._state = "error";
        if (this.listenerCount("error") > 0) this.emit("error", err);
        cleanup();
        reject(err);
      };
      // Lets close()/destroy() reject a connect() that is still awaiting a
      // socket open, so the promise never hangs forever on a cancelled connect.
      this.connectReject = (err: Error) => {
        cleanup();
        reject(err);
      };

      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("message", (data) => this.handleMessage(data));
      ws.on("close", (code, reason) => this.handleClose(code, reason));
    });
  }

  /** Feed a PCM16 chunk (50-1000 ms worth at the configured sample rate). */
  sendAudio(chunk: Buffer | Uint8Array): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(chunk);
    return true;
  }

  /** Send a control message, e.g. { type: "ForceEndpoint" }. */
  sendControl(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("RealtimeStream is not open — cannot send control message.");
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Push an updated prompt / agent_context / keyterms mid-session. */
  updateConfiguration(update: Partial<UpdateConfigurationFields>): void {
    this.sendControl({ type: "UpdateConfiguration", ...update });
  }

  /** Ask the server to finalize the current turn immediately (own-VAD / push-to-talk). */
  forceEndpoint(): void {
    this.sendControl({ type: "ForceEndpoint" });
  }

  /** Reset the server's `inactivity_timeout` timer during long silences. */
  keepAlive(): void {
    this.sendControl({ type: "KeepAlive" });
  }

  /**
   * Close the session. With terminate=true sends `Terminate` and waits for the
   * server's `Termination` before closing the socket — required to end billing.
   */
  async close(opts: { terminate?: boolean; force?: boolean } = {}): Promise<void> {
    const { terminate = true, force = false } = opts;
    if (!this.ws) {
      this._state = "closed";
      return;
    }

    if (terminate && this.ws.readyState === WebSocket.OPEN) {
      this._state = "terminating";
      try {
        this.sendControl({ type: "Terminate" });
      } catch {
        // fall through to force close below
      }

      if (!force) {
        // Wait for the server's Termination message (bounded) before closing.
        await new Promise<void>((resolve) => {
          if (this._state !== "terminating") {
            resolve();
            return;
          }
          const t = setTimeout(() => {
            this.emit("warn", "Timeout waiting for Termination; force-closing.");
            resolve();
          }, 8000);
          const onClose = () => {
            clearTimeout(t);
            resolve();
          };
          this.ws!.once("close", onClose);
          // Also resolve when the socket naturally closes via Termination flow
          this.once("termination", () => {
            clearTimeout(t);
            this.ws!.off("close", onClose);
            resolve();
          });
        });
      }
    }

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      // If the handshake is still in flight, no open/error will follow the
      // close — settle the pending connect() now so it cannot hang forever.
      if (this.ws.readyState === WebSocket.CONNECTING) {
        this.connectReject?.(new Error("Connection closed before it opened."));
      }
      this.ws.close();
    }
    this._state = "closed";
  }

  /**
   * Check that the server actually gave us the model we asked for.
   *
   * Getting `speech_model` wrong (sending the pre-recorded API's plural
   * `speech_models`, or a model string with a typo) does not fail the
   * connection — the socket opens and transcribes with whatever the server
   * picked. Since the Pro-only features the agent loop depends on
   * (`agent_context`, `SpeechStarted`, `mode`) then silently do nothing, the
   * `Begin.configuration` echo is the only signal that anything is wrong.
   * See docs/DECISIONS.md §1.
   */
  private verifyServedModel(begin: BeginMessage): void {
    const served = begin.configuration?.model;
    const requested = this.params.speechModel;
    if (typeof served !== "string" || served === requested) return;
    this.emit(
      "warn",
      `AssemblyAI is serving "${served}" but "${requested}" was requested. ` +
        `Features specific to the requested model will silently not apply. ` +
        `Check the speech_model parameter (realtime uses the singular form).`,
    );
  }

  /** Force-close without waiting (only for error paths). */
  destroy(): void {
    this.connectReject?.(new Error("Session destroyed before it opened."));
    this._state = "closed";
    try {
      this.ws?.terminate();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  /**
   * Emit an `error` event for an irrecoverable stream failure.
   *
   * `error` is Node-special: emitting it with no listener throws. That is the
   * intended contract here — a broken stream is a fatal condition the caller
   * should handle, so an unhandled one must fail loudly rather than vanish.
   * Recoverable protocol noise (non-JSON frames, unknown message types, chunk
   * corrections) never goes through this helper: it is emitted as `notice`, a
   * non-special event name that cannot throw, so a consumer that only listens
   * for `open`/`final`/etc. is never crashed by recoverable conditions.
   */
  private emitError(err: Error): void {
    this.emit("error", err);
  }

  /**
   * Emit a recoverable-protocol diagnostic on the non-crashing `notice` event.
   * `notice` is not the special `error` name, so EventEmitter never throws
   * regardless of what the consumer subscribed to; the data is always kept.
   */
  private emitNotice(err: Error): void {
    this.emit("notice", err);
  }

  private handleMessage(raw: string | Buffer | Uint8Array | ArrayBuffer): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      this.emitNotice(new Error("Received non-JSON message from server."));
      return;
    }

    switch (msg.type) {
      case "Begin":
        this.begin = msg;
        this.verifyServedModel(msg);
        this.emit("begin", msg);
        break;
      case "SpeechStarted":
        this.emit("speechStarted", {
          timestamp: msg.timestamp,
          confidence: msg.confidence,
        } satisfies SpeechStartedEvent);
        break;
      case "Turn":
        this.emit("turn", normalizeTurn(msg));
        break;
      case "SpeakerRevision":
        this.emit("speakerRevision", {
          revisions: msg.revisions,
          turnOrders: msg.revisions.map((r) => r.turn_order),
        } satisfies SpeakerRevisionEvent);
        break;
      case "Heartbeat":
        this.emit("heartbeat", msg satisfies HeartbeatMessage);
        break;
      case "LLMGatewayResponse":
        this.emit("llmGatewayResponse", msg);
        break;
      case "Error":
        // The server sends this text frame immediately before closing with the
        // same error_code; surface the real reason instead of a generic
        // 'Unknown server message type'.
        this.emitError(serverErrorMessage(msg));
        break;
      case "Termination":
        this.emit("termination", msg);
        break;
      default:
        this.emitNotice(
          new Error(`Unknown server message type: ${(msg as { type: string }).type}`),
        );
    }
  }

  private handleClose(code: number, reason: Buffer): void {
    this._state = "closed";
    const reasonText = reason.toString();

    if (code === RealtimeCloseCode.TooManySessions) {
      this.emitError(new Error("Too many concurrent realtime sessions (3009)."));
    } else if (code === RealtimeCloseCode.BadAudioChunk) {
      // 3007 = chunk outside 50–1000 ms (or faster than real time). Shrink the
      // recommended chunk size toward the 50 ms floor so the caller re-feeds at
      // a valid size instead of crashing the session.
      const floor = Math.max(64, Math.floor(this.params.sampleRate / 10));
      const corrected = Math.max(floor, Math.floor(this.chunkBytes / 2));
      this.emit(
        "warn",
        `Server rejected audio chunk (3007); reducing chunk size to ${corrected} bytes.`,
      );
      this.chunkBytes = corrected;
      this.emitNotice(
        new Error(
          `Audio chunk outside 50-1000ms or faster than real-time (3007); chunk size corrected to ${corrected} bytes.`,
        ),
      );
    } else if (code === RealtimeCloseCode.Unauthorized) {
      this.emitError(new Error("Unauthorized realtime session (1008)."));
    } else if (code === RealtimeCloseCode.SessionExpired) {
      this.emitError(new Error("Realtime session expired after 3-hour cap (3008)."));
    } else if (code === RealtimeCloseCode.SessionCancelled) {
      this.emitError(new Error("Session cancelled on the server (3005)."));
    } else if (code === RealtimeCloseCode.InvalidMessage) {
      this.emitError(new Error("Invalid message / inactivity timeout (3006)."));
    }

    this.emit("close", { code, reason: reasonText });
  }
}

function normalizeTurn(msg: TurnMessage): TurnEvent {
  return {
    turnOrder: msg.turn_order,
    final: msg.end_of_turn,
    formatted: msg.turn_is_formatted,
    transcript: msg.transcript,
    endOfTurnConfidence: msg.end_of_turn_confidence,
    words: msg.words,
    utterance: msg.utterance ?? null,
    speakerLabel: msg.speaker_label,
    languageCode: msg.language_code,
    languageConfidence: msg.language_confidence,
  };
}

export { buildWebSocketUrl, normalizeTurn };
export type { TerminationMessage };

/** Build the Error event's message from the server's `Error` text frame. */
function serverErrorMessage(msg: ErrorMessage): Error {
  const err = new Error(`Realtime server error ${msg.error_code}: ${msg.error}`);
  (err as { errorCode?: number }).errorCode = msg.error_code;
  return err;
}
