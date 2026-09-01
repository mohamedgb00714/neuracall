/**
 * A stand-in for `VoiceAgentSession`, so the Voice Agent pipeline can be driven
 * end to end without a socket.
 *
 * The Voice Agent is a closed loop — it decides when to speak — so this fake has
 * to be scripted the same way: a test says "the caller said X" and the fake
 * produces the reply audio and transcript the real service would, in the same
 * order and on the same events. That order is the part worth testing, because
 * the bridge depends on it: audio arrives before the reply text, and the
 * orchestrator asks for the text only after it has persisted the caller's turn.
 */

import { EventEmitter } from "node:events";

/** 24 kHz mono Int16: what the real service returns. */
const AGENT_RATE = 24000;

export interface FakeVoiceAgentOptions {
  /** Replies handed out in order, one per caller turn. */
  replies?: string[];
  /** Spoken on connect, as the real service does. */
  greeting?: string;
  /** Milliseconds of audio synthesised per reply. Default 200. */
  speechMs?: number;
}

/**
 * One fake session. Extends EventEmitter so the bridge's listeners attach
 * exactly as they would to the real class.
 */
export class FakeVoiceAgentSession extends EventEmitter {
  /** Audio the bridge sent us, i.e. the caller's voice after resampling. */
  readonly received: Uint8Array[] = [];
  connected = false;
  closed = false;
  destroyed = false;
  /** Replies still to be handed out. */
  private readonly replies: string[];
  private readonly greeting: string | undefined;
  private readonly speechMs: number;
  private replyId = 0;

  constructor(opts: FakeVoiceAgentOptions = {}) {
    super();
    this.replies = [...(opts.replies ?? [])];
    if (opts.greeting !== undefined) this.greeting = opts.greeting;
    this.speechMs = opts.speechMs ?? 200;
  }

  /** Total bytes of caller audio received, for asserting the pipe is live. */
  get receivedBytes(): number {
    return this.received.reduce((n, c) => n + c.length, 0);
  }

  async connect(): Promise<{ sessionId: string; resumed: boolean }> {
    this.connected = true;
    // The real service speaks its greeting unprompted once the session is
    // ready, before any audio has been sent.
    if (this.greeting !== undefined) {
      // Deferred a tick so listeners attached right after connect() still see
      // it, which is what the real socket does.
      setImmediate(() => this.say(this.greeting as string));
    }
    return { sessionId: "sess-fake", resumed: false };
  }

  sendAudio(pcm: Uint8Array): boolean {
    if (this.closed) return false;
    this.received.push(pcm);
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code: 1000, reason: "" });
  }

  destroy(): void {
    this.destroyed = true;
    if (!this.closed) {
      this.closed = true;
      this.emit("close", { code: 1006, reason: "destroyed" });
    }
  }

  // --- scripting -----------------------------------------------------------

  /** The caller said something and the service finalized the turn. */
  callerSaid(text: string): void {
    this.emit("speechStarted", {});
    this.emit("userTranscript", { text, final: false, itemId: null });
    this.emit("speechStopped", {});
    this.emit("userTranscript", { text, final: true, itemId: null });
    const reply = this.replies.shift();
    if (reply !== undefined) this.say(reply);
  }

  /** The caller talked over the agent, without finishing a turn. */
  callerInterrupted(): void {
    this.emit("speechStarted", {});
  }

  /** Emit a full reply: audio first, then the text, then done — as the API does. */
  say(text: string): void {
    const id = `r${(this.replyId += 1)}`;
    this.emit("replyStarted", { replyId: id, itemId: null });
    const samples = Math.round((AGENT_RATE * this.speechMs) / 1000);
    this.emit("replyAudio", new Uint8Array(samples * 2));
    this.emit("agentTranscript", {
      text,
      final: true,
      replyId: id,
      itemId: null,
      startMs: 0,
      endMs: this.speechMs,
      interrupted: false,
    });
    this.emit("replyDone", { replyId: id, status: "completed" });
  }
}

/** Hands out fake sessions and remembers them, like FakeA2IFleet. */
export class FakeVoiceAgentFleet {
  readonly sessions: FakeVoiceAgentSession[] = [];

  constructor(private readonly opts: FakeVoiceAgentOptions = {}) {}

  /** Pass as `VoiceAgentBridgeOptions.createSession`. */
  readonly create = (): FakeVoiceAgentSession => {
    const session = new FakeVoiceAgentSession(this.opts);
    this.sessions.push(session);
    return session;
  };

  get latest(): FakeVoiceAgentSession {
    const last = this.sessions[this.sessions.length - 1];
    if (!last) throw new Error("no Voice Agent session has been opened");
    return last;
  }
}
