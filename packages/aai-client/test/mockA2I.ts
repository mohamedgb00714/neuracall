import { EventEmitter } from "node:events";
import type { AppConfig } from "@neuracall/config";
import type { RealtimeParams } from "../src/types.js";

/** A minimal, real-keyless AppConfig the offline tests construct manually. */
export function testConfig(): AppConfig {
  return {
    assemblyai: {
      apiKey: "test-not-a-real-key",
      region: "us",
      restBaseUrl: "https://api.assemblyai.com",
      realtimeHost: "127.0.0.1", // host is irrelevant: the wsFactory is injected
      tokenUrl: "https://127.0.0.1/v3/token",
      speechModel: "universal-3-5-pro",
    },
    llm: { model: "test" },
    tts: { model: "test" },
  };
}

export const TEST_PARAMS: RealtimeParams = {
  sampleRate: 16000,
  speechModel: "universal-3-5-pro",
  mode: "balanced",
};

/** Numeric WebSocket readyState values, mirroring the `ws` package. */
export const WS_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type MockA2IOptions = {
  /** Audio bytes that must be fed before a final Turn is emitted. Default 0 (emit on first chunk). */
  audioForTurn?: number;
  /** Transcript text put in the final Turn the mock emits. */
  transcript?: string;
  /** Auto-respond to Terminate with Termination and then close. Default true. */
  autoTerminate?: boolean;
  /** Speaker label to put in the mock Turn. */
  speakerLabel?: string;
};

/**
 * An in-memory stand-in for the AssemblyAI v3 realtime endpoint, for offline
 * tests. `socket` is what `RealtimeStream` talks to through its injected
 * WebSocketFactory; the mock records what the client sends and lets the test
 * script server → client messages (Begin, SpeechStarted, Turn, Termination).
 */
export class MockA2I {
  readonly socket: MockSocket;
  /** Every message/audio frame the client sent, in order. */
  sent: Array<string | Buffer> = [];
  /** Bytes of binary (PCM) audio received so far. */
  audioReceived = 0;
  /** True once the client sent a `Terminate` control message. */
  terminateReceived = false;
  /** True once the client's socket was closed/destroyed. */
  clientClosed = false;

  private readonly opts: Required<MockA2IOptions>;

  constructor(opts: MockA2IOptions = {}) {
    this.opts = {
      audioForTurn: 0,
      transcript: "hello world",
      autoTerminate: true,
      speakerLabel: "A",
      ...opts,
    };
    this.socket = new MockSocket(this);
  }

  /** Client → server direction. */
  onClientMessage(data: unknown): void {
    const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : "";
    if (typeof data === "string" || (data instanceof Buffer && isJsonText(text))) {
      const raw: string = typeof data === "string" ? data : text;
      this.sent.push(raw);
      const msg = safeParse(raw);
      if (msg && msg.type === "Terminate") {
        this.terminateReceived = true;
        if (this.opts.autoTerminate) {
          this.sendToClient({
            type: "Termination",
            audio_duration_seconds: 1.2,
            session_duration_seconds: 1.4,
          });
          this.socket.emulateServerClose(1000);
        }
        return;
      }
      return;
    }
    // binary PCM frame
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    this.audioReceived += buf.length;
    this.sent.push(buf);
    this.maybeEmitTurn();
  }

  /** Server → client helper. */
  sendToClient(obj: unknown): void {
    this.socket.emit("message", JSON.stringify(obj));
  }

  emitBegin(id = "mock-session-1"): void {
    this.sendToClient({
      type: "Begin",
      id,
      started_at: 1699999999999,
      audio_updated_at: 1699999999999,
      audio_duration_seconds: 0,
      message_count: 0,
    });
  }

  emitSpeechStarted(timestamp = 100): void {
    this.sendToClient({ type: "SpeechStarted", timestamp, confidence: 0.5 });
  }

  emitTurn(opts: { partial?: boolean; transcript?: string; turnOrder?: number } = {}): void {
    const { partial = false, transcript = this.opts.transcript, turnOrder = 0 } = opts;
    this.sendToClient({
      type: "Turn",
      turn_order: turnOrder,
      end_of_turn: !partial,
      turn_is_formatted: !partial,
      transcript,
      end_of_turn_confidence: partial ? 0 : 0.98,
      words: partial
        ? []
        : transcript.split(" ").map((text, i) => ({
            text,
            start: i * 200,
            end: i * 200 + 180,
            confidence: 0.99,
            word_is_final: true,
            speaker: this.opts.speakerLabel,
          })),
      utterance: partial ? null : transcript,
      speaker_label: this.opts.speakerLabel,
    });
  }

  private maybeEmitTurn(): void {
    if (this.audioReceived >= this.opts.audioForTurn) {
      this.emitSpeechStarted();
      this.emitTurn();
    }
  }
}

/** The socket object `RealtimeStream` uses; pairs with a MockA2I server peer. */
export class MockSocket extends EventEmitter {
  readyState: number = WS_STATE.CONNECTING;
  private readonly server: MockA2I;

  constructor(server: MockA2I) {
    super();
    this.server = server;
    setImmediate(() => {
      if (this.readyState === WS_STATE.CONNECTING) {
        this.readyState = WS_STATE.OPEN;
        this.emit("open");
      }
    });
  }

  send(data: unknown): void {
    this.server.onClientMessage(data);
  }

  close(code?: number, reason?: string): void {
    if (
      this.readyState === WS_STATE.CLOSED ||
      this.readyState === WS_STATE.CLOSING
    ) {
      return;
    }
    this.readyState = WS_STATE.CLOSING;
    this.server.clientClosed = true;
    setImmediate(() => {
      this.readyState = WS_STATE.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    });
  }

  terminate(): void {
    this.server.clientClosed = true;
    this.readyState = WS_STATE.CLOSED;
    setImmediate(() => this.emit("close", 1006, Buffer.from("")));
  }

  /** Server-initiated close (e.g. after Termination). */
  emulateServerClose(code = 1000): void {
    this.server.clientClosed = true;
    this.readyState = WS_STATE.CLOSED;
    this.emit("close", code, Buffer.from(""));
  }
}

function safeParse(raw: string): { type?: string } | null {
  try {
    return JSON.parse(raw) as { type?: string };
  } catch {
    return null;
  }
}

function isJsonText(text: string): boolean {
  return text.trimStart().startsWith("{");
}
