/**
 * An in-memory stand-in for the AssemblyAI v3 realtime endpoint.
 *
 * This is the outermost edge on the transcription side: the real
 * `RealtimeStream` and `RealtimeSessionManager` run on top of it, so the whole
 * v3 protocol — the URL and query parameters, `Begin`, `Turn`, `Terminate` /
 * `Termination`, close codes — is genuinely exercised. Nothing here talks to
 * the network, needs a key, or costs anything.
 *
 * `FakeA2IFleet` hands out one socket per `open()`, which is what makes a
 * concurrent-call test possible: each call gets its own session and the test
 * can assert that no audio or transcript crossed between them.
 */

import { EventEmitter } from "node:events";

/** Numeric WebSocket readyState values, mirroring the `ws` package. */
export const WS_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/** One simulated realtime session. */
export class FakeA2ISession extends EventEmitter {
  readonly socket: FakeA2ISocket;
  /** The `wss://…/v3/ws?…` URL the client connected to. */
  readonly url: string;
  /** Binary PCM bytes received. */
  audioBytes = 0;
  /** JSON control messages received, parsed. */
  readonly controls: Array<Record<string, unknown>> = [];
  /** True once the client sent `Terminate` — the thing that stops billing. */
  terminateReceived = false;
  /** True once the socket closed for any reason. */
  closed = false;
  private turnOrder = 0;

  constructor(url: string) {
    super();
    this.url = url;
    this.socket = new FakeA2ISocket(this);
  }

  /** Every `UpdateConfiguration` delta the client pushed. */
  get configUpdates(): Array<Record<string, unknown>> {
    return this.controls.filter((c) => c["type"] === "UpdateConfiguration");
  }

  /** Client → server. */
  receive(data: unknown): void {
    if (typeof data === "string") {
      const parsed = safeParse(data);
      if (!parsed) return;
      this.controls.push(parsed);
      if (parsed["type"] === "Terminate") {
        this.terminateReceived = true;
        this.send({
          type: "Termination",
          audio_duration_seconds: 1,
          session_duration_seconds: 1,
        });
        this.socket.serverClose(1000);
      }
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    this.audioBytes += buf.length;
    this.emit("audio", buf);
  }

  /** Server → client. */
  send(message: unknown): void {
    this.socket.deliver(JSON.stringify(message));
  }

  /** Open the session, as the server does immediately after the upgrade. */
  begin(id = "fake-session"): void {
    this.send({
      type: "Begin",
      id,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      configuration: { model: "universal-3-5-pro" },
    });
  }

  /** Emit a finalized caller turn. */
  finalTurn(transcript: string): void {
    this.send({ type: "SpeechStarted", timestamp: 100, confidence: 0.9 });
    this.send({
      type: "Turn",
      turn_order: this.turnOrder++,
      end_of_turn: true,
      turn_is_formatted: true,
      transcript,
      end_of_turn_confidence: 0.98,
      words: transcript.split(" ").map((text, i) => ({
        text,
        start: i * 200,
        end: i * 200 + 180,
        confidence: 0.99,
        word_is_final: true,
      })),
      utterance: transcript,
    });
  }

  /** Emit a partial (mid-utterance) turn. */
  partialTurn(transcript: string): void {
    this.send({
      type: "Turn",
      turn_order: this.turnOrder,
      end_of_turn: false,
      turn_is_formatted: false,
      transcript,
      end_of_turn_confidence: 0,
      words: [],
      utterance: null,
    });
  }

  /** Drop the connection with a close code, as the server would on an error. */
  failWith(code: number): void {
    this.socket.serverClose(code);
  }
}

/** The socket object `RealtimeStream` drives through its injected factory. */
export class FakeA2ISocket extends EventEmitter {
  readyState: number = WS_STATE.CONNECTING;

  constructor(private readonly session: FakeA2ISession) {
    super();
    setImmediate(() => {
      if (this.readyState !== WS_STATE.CONNECTING) return;
      this.readyState = WS_STATE.OPEN;
      this.emit("open");
    });
  }

  send(data: unknown): void {
    this.session.receive(data);
  }

  /** Server → client delivery. */
  deliver(raw: string): void {
    if (this.readyState !== WS_STATE.OPEN) return;
    this.emit("message", raw);
  }

  close(code?: number): void {
    if (this.readyState === WS_STATE.CLOSED || this.readyState === WS_STATE.CLOSING) return;
    this.readyState = WS_STATE.CLOSING;
    setImmediate(() => {
      this.readyState = WS_STATE.CLOSED;
      this.session.closed = true;
      this.emit("close", code ?? 1000, Buffer.from(""));
    });
  }

  terminate(): void {
    this.readyState = WS_STATE.CLOSED;
    this.session.closed = true;
    setImmediate(() => this.emit("close", 1006, Buffer.from("")));
  }

  /** Server-initiated close (after `Termination`, or on an error code). */
  serverClose(code: number): void {
    if (this.readyState === WS_STATE.CLOSED) return;
    this.readyState = WS_STATE.CLOSED;
    this.session.closed = true;
    this.emit("close", code, Buffer.from(""));
  }
}

/** Hands out one `FakeA2ISession` per connection, in order. */
export class FakeA2IFleet {
  readonly sessions: FakeA2ISession[] = [];
  /** Automatically send `Begin` on connect. Default true. */
  autoBegin = true;

  /** The `WebSocketFactory` to inject into `RealtimeSessionManager`. */
  get factory(): (url: string) => FakeA2ISocket {
    return (url: string) => {
      const session = new FakeA2ISession(url);
      this.sessions.push(session);
      if (this.autoBegin) setImmediate(() => session.begin(`fake-${this.sessions.length}`));
      return session.socket;
    };
  }

  /** The most recently opened session. */
  get latest(): FakeA2ISession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("no A2I session has been opened yet");
    return session;
  }

  /** True when every session opened so far was properly terminated. */
  get allTerminated(): boolean {
    return this.sessions.every((s) => s.terminateReceived);
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
