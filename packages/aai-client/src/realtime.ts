import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AppConfig } from "@neuracall/config";
import {
  RealtimeCloseCode,
  type ClientMessage,
  type BeginMessage,
  type TurnMessage,
  type SpeechStartedMessage,
  type SpeakerRevisionMessage,
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
  private ws: WebSocket | null = null;
  private authToken: string | undefined;
  private readonly config: AppConfig;
  private readonly params: RealtimeParams;
  private _state: SessionState = "closed";
  private begin: BeginMessage | null = null;
  private closeTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, params: RealtimeParams) {
    super();
    this.config = config;
    this.params = params;
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

  /** Open the WebSocket connection. Audio can be fed once `open` fires. */
  connect(): Promise<void> {
    let ws!: WebSocket;
    return new Promise((resolve, reject) => {
      if (this.ws) {
        reject(new Error("RealtimeStream already connected."));
        return;
      }

      const url = buildWebSocketUrl(
        this.config.assemblyai.realtimeHost,
        this.params,
      );

      // Authentication: temp token goes in the query string; otherwise the
      // raw API key goes in the upgrade header (no Bearer prefix per docs).
      if (this.authToken) {
        const urlWithToken = `${url}&token=${encodeURIComponent(this.authToken)}`;
        ws = new WebSocket(urlWithToken);
      } else {
        ws = new WebSocket(url, {
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

  private handleMessage(raw: WebSocket.RawData): void {
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
        } satisfies SpeakerRevisionEvent);
        break;
      case "LLMGatewayResponse":
        this.emit("llmGatewayResponse", msg);
        break;
      case "Termination":
        this.emit("termination", msg);
        break;
      default:
        this.emit("error", new Error(`Unknown server message type: ${(msg as { type: string }).type}`));
    }
  }

  private handleClose(code: number, reason: Buffer): void {
    this._state = "closed";
    const reasonText = reason.toString();

    if (code === RealtimeCloseCode.TooManySessions) {
      this.emit("error", new Error("Too many concurrent realtime sessions (3009)."));
    } else if (code === RealtimeCloseCode.BadAudioChunk) {
      this.emit("error", new Error("Audio chunk outside 50-1000ms or faster than real-time (3007)."));
    } else if (code === RealtimeCloseCode.Unauthorized) {
      this.emit("error", new Error("Unauthorized realtime session (1008)."));
    } else if (code === RealtimeCloseCode.SessionExpired) {
      this.emit("error", new Error("Realtime session expired after 3-hour cap (3008)."));
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
    utterance: msg.utterance,
    speakerLabel: msg.speaker_label,
    languageCode: msg.language_code,
    languageConfidence: msg.language_confidence,
  };
}

export { buildWebSocketUrl, normalizeTurn };
export type { TerminationMessage };
