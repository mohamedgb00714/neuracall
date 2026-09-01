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
  if (params.language_code) query["language_code"] = params.language_code;
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
 */
export class RealtimeStream extends EventEmitter {
  private ws: WsLike | null = null;
  private authToken: string | undefined;
  private readonly config: AppConfig;
  private readonly params: RealtimeParams;
  private readonly wsFactory: WebSocketFactory;
  private _state: SessionState = "closed";
  private begin: BeginMessage | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
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
      };
      const onOpen = () => {
        this._state = "open";
        this.emit("open", {});
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        this._state = "error";
        this.emit("error", err);
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
  updateConfiguration(update: {
    prompt?: string;
    keyterms_prompt?: string[];
    agent_context?: string;
    min_turn_silence?: number;
    max_turn_silence?: number;
    continuous_partials?: boolean;
    vad_threshold?: number;
    interruption_delay?: number;
  }): void {
    this.sendControl({ type: "UpdateConfiguration", ...update });
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
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this._state = "closed";
    try {
      this.ws?.terminate();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  private handleMessage(raw: string | Buffer | Uint8Array | ArrayBuffer): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      this.emit("error", new Error("Received non-JSON message from server."));
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
      case "LLMGatewayResponse":
        this.emit("llmGatewayResponse", msg);
        break;
      case "Termination":
        this.emit("termination", msg);
        break;
      default:
        this.emit(
          "error",
          new Error(`Unknown server message type: ${(msg as { type: string }).type}`),
        );
    }
  }

  private handleClose(code: number, reason: Buffer): void {
    this._state = "closed";
    const reasonText = reason.toString();

    if (code === RealtimeCloseCode.TooManySessions) {
      this.emit("error", new Error("Too many concurrent realtime sessions (3009)."));
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
      this.emit(
        "error",
        new Error(
          `Audio chunk outside 50-1000ms or faster than real-time (3007); chunk size corrected to ${corrected} bytes.`,
        ),
      );
    } else if (code === RealtimeCloseCode.Unauthorized) {
      this.emit("error", new Error("Unauthorized realtime session (1008)."));
    } else if (code === RealtimeCloseCode.SessionExpired) {
      this.emit("error", new Error("Realtime session expired after 3-hour cap (3008)."));
    } else if (code === RealtimeCloseCode.SessionCancelled) {
      this.emit("error", new Error("Session cancelled on the server (3005)."));
    } else if (code === RealtimeCloseCode.InvalidMessage) {
      this.emit("error", new Error("Invalid message / inactivity timeout (3006)."));
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
