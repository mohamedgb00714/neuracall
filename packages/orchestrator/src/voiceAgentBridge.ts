/**
 * Running a call through AssemblyAI's Voice Agent instead of three vendors.
 *
 * The composed pipeline asks the orchestrator to do the turn-taking: STT hands
 * up a finalized turn, the orchestrator asks an LLM for a reply, a TTS renders
 * it, and `LocalOutStream` plays it. The Voice Agent does all of that inside
 * one socket and decides for itself when to speak. That is a different shape,
 * and the temptation is to rewrite the orchestrator around it.
 *
 * It is not necessary. The orchestrator already depends on two interfaces
 * rather than on AssemblyAI — `SttSessionManager` for the ears and `CallAgent`
 * for the brain — so the Voice Agent can be dropped in behind both without the
 * orchestrator changing at all. This file is that adapter: it *is* an
 * `SttSessionManager`, and it exposes a `CallAgent` in `.agent`. The state
 * machine, the hang-up watch, recording, persistence and post-call analysis all
 * keep working untouched.
 *
 * Two decisions are worth explaining, because the obvious implementation of
 * each is wrong.
 *
 * **The agent's audio is streamed to the injector here, not returned to the
 * orchestrator.** `AgentReply` can carry PCM, and returning it would be tidier.
 * But the orchestrator awaits `onFinalTurn` before it plays anything, so
 * returning the audio would mean buffering the entire reply first — the caller
 * would hear nothing until the last byte of a ten-second answer had been
 * synthesised. Instead `reply.audio` frames go straight to the injector as they
 * arrive, and `onFinalTurn` returns text only. Waiting for the text costs
 * nothing, because it lands after the audio has already started playing.
 *
 * **Barge-in is handled here too.** Since the reply never passes through
 * `LocalOutStream`, that stream's `isSpeaking` is always false and the
 * orchestrator's own barge-in check can never fire. The server tells us when
 * the caller starts talking (`speechStarted`), which is a better signal anyway
 * — it is the same voice-activity detector that decided the turn — so that is
 * what flushes the injector.
 *
 * Sample rates are the third trap and are handled in `sendAudio`/`onReplyAudio`:
 * the Voice Agent accepts 24 kHz and nothing else (see docs/VOICE-AGENT.md),
 * while the call runs at 16 kHz, so both directions are resampled with a
 * phase-carrying resampler rather than per chunk.
 */

import { EventEmitter } from "node:events";
import {
  VOICE_AGENT_SAMPLE_RATE,
  VoiceAgentSession,
  type VoiceAgentInlineConfig,
  type VoiceAgentOptions,
} from "@neuracall/aai-client";
import { Pcm16Resampler, type AudioInjector } from "@neuracall/audio-pipeline";
import type { ChannelKind } from "@neuracall/device-manager";
import type { RealtimeParams, TurnEvent } from "@neuracall/aai-client";
import type { SttSessionManager, SttStream } from "./orchestrator.js";
import type { AgentReply, AgentTurnContext, CallAgent, CallRecord } from "./types.js";

/** How long to wait for the agent's reply text before giving up on it. */
const DEFAULT_REPLY_TIMEOUT_MS = 20_000;

/**
 * How long to wait for the greeting. Much shorter than a reply, because the
 * orchestrator awaits it during call setup and an agent with no greeting
 * configured never produces one — see `firstReply`.
 */
const DEFAULT_GREETING_TIMEOUT_MS = 2_000;

export interface VoiceAgentBridgeOptions {
  /** AssemblyAI key. Never logged, never sent anywhere but the socket. */
  apiKey: string;
  /**
   * A stored agent's uuid. Mutually exclusive with `session`, and required if
   * you need a BYO LLM — the service rejects an `llm` block on session.update.
   */
  agentId?: string;
  /** Inline session configuration, for an agent that needs no stored record. */
  session?: VoiceAgentInlineConfig;
  /** Override the endpoint. Comes from `AppConfig.voiceAgent.wsUrl`. */
  wsUrl?: string;
  /**
   * The rate the orchestrator feeds us and expects back, in Hz. Default 16000.
   * This is the call's rate, not the Voice Agent's — see the file comment.
   */
  callSampleRate?: number;
  /**
   * Where the agent's voice goes. Hand this the same injector the orchestrator
   * was given: both flushing paths then act on one transport.
   *
   * Omit it and the call still runs — transcribed, recorded, both sides in the
   * transcript — but the caller hears nothing, exactly as with no TTS
   * configured. That is deliberately not an error.
   */
  injectorFor?: (deviceId: string, channelId: ChannelKind) => AudioInjector | undefined;
  /** How long `onFinalTurn` waits for reply text. Default 20000 ms. */
  replyTimeoutMs?: number;
  /**
   * How long `onAnswered` waits for a greeting. Default 2000 ms, deliberately
   * short: the orchestrator blocks call setup on it and an agent without a
   * greeting never sends one.
   */
  greetingTimeoutMs?: number;
  /** Injectable so tests neither open sockets nor wait. */
  createSession?: (opts: VoiceAgentOptions) => VoiceAgentSession;
  now?: () => number;
}

/** One completed reply: what the agent said, and whether it was cut off. */
interface CompletedReply {
  text: string;
  interrupted: boolean;
}

function keyOf(key: { deviceId: string; channelId: string }): string {
  return `${key.deviceId}/${key.channelId}`;
}

/**
 * One call's socket, plus the resamplers and the reply queue that belong to it.
 *
 * `SttStream` is implemented on this object rather than on a separate class so
 * that the orchestrator's `wireStream` and this bridge's own listeners are
 * looking at exactly the same emitter.
 */
class VoiceAgentCall extends EventEmitter implements SttStream {
  readonly session: VoiceAgentSession;

  /** 16 kHz call audio -> 24 kHz for the service. */
  private readonly toAgent: Pcm16Resampler;
  /** 24 kHz agent speech -> whatever the injector wants. */
  private readonly toInjector: Pcm16Resampler;
  private readonly injector: AudioInjector | undefined;
  private readonly replyTimeoutMs: number;

  /** Replies that finished before anyone asked for them. */
  private readonly ready: CompletedReply[] = [];
  /** Callers of `takeReply()` waiting for one that has not arrived yet. */
  private readonly waiting: Array<(reply: CompletedReply | null) => void> = [];
  /** Text of the reply currently being generated, assembled from deltas. */
  private replyText = "";
  /** Counts finalized caller turns; see the `userTranscript` handler. */
  private turnOrder = -1;
  /**
   * The greeting gets a channel of its own rather than sharing the reply queue.
   *
   * Sharing it is subtly wrong and the symptom is remote from the cause: while
   * `onAnswered` is still waiting, the first *turn's* reply arrives and settles
   * that waiter instead, so the greeting slot swallows the answer to turn one,
   * every later reply is off by one, and the final turn waits out the full
   * reply timeout with nothing coming. A reply that completes before any caller
   * turn has been finalized is the greeting; one that completes after is an
   * answer. Nothing else can tell them apart.
   */
  private greeting: CompletedReply | null = null;
  private greetingWaiter: ((reply: CompletedReply | null) => void) | null = null;
  /** True once the caller has finished a turn, so no greeting can still come. */
  private sawCallerTurn = false;
  private closed = false;

  constructor(
    session: VoiceAgentSession,
    opts: {
      callSampleRate: number;
      injector: AudioInjector | undefined;
      replyTimeoutMs: number;
    },
  ) {
    super();
    this.session = session;
    this.injector = opts.injector;
    this.replyTimeoutMs = opts.replyTimeoutMs;
    this.toAgent = new Pcm16Resampler(opts.callSampleRate, VOICE_AGENT_SAMPLE_RATE);
    this.toInjector = new Pcm16Resampler(
      VOICE_AGENT_SAMPLE_RATE,
      opts.injector?.sampleRate ?? opts.callSampleRate,
    );
    this.wire();
  }

  private wire(): void {
    this.session.on("userTranscript", (e: { text: string; final: boolean }) => {
      // The Voice Agent has no `turn_order` — that is a Universal-Streaming
      // field. The orchestrator stores it on every transcript entry and uses it
      // to dedupe, so it needs to increase once per finalized caller turn;
      // counting them here is the only source of that number.
      if (e.final) {
        this.turnOrder += 1;
        // The caller has spoken, so a greeting is no longer possible. Release
        // anyone waiting for one now rather than making call setup sit out the
        // rest of its timeout.
        this.sawCallerTurn = true;
        this.releaseGreeting(null);
      }
      // Partials are forwarded too: the orchestrator ignores them, but a UI
      // subscribing to the same emitter wants them.
      this.emit("turn", {
        turnOrder: this.turnOrder,
        final: e.final,
        formatted: true,
        transcript: e.text,
        endOfTurnConfidence: e.final ? 1 : 0,
        words: [],
        utterance: e.final ? e.text : null,
      } satisfies TurnEvent);
    });

    // The caller started talking. Drop whatever the agent still has queued —
    // see the file comment on why this cannot be left to the orchestrator.
    this.session.on("speechStarted", () => {
      this.injector?.cancel?.();
      this.emit("bargeIn");
    });

    this.session.on("replyStarted", () => {
      this.replyText = "";
    });

    this.session.on("replyAudio", (pcm: Uint8Array) => {
      if (this.closed || !this.injector) return;
      try {
        const out = this.toInjector.process(pcm);
        if (out.length > 0) this.injector.write(out);
      } catch (err) {
        // A transport that fails mid-call must not end the call; the caller
        // loses the agent's voice, which the orchestrator already tolerates.
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.session.on("agentTranscript", (e: { text: string; final: boolean }) => {
      if (e.final) this.replyText = e.text;
    });

    this.session.on("replyDone", (e: { status?: string }) => {
      this.settleReply({
        text: this.replyText.trim(),
        interrupted: e.status === "interrupted",
      });
      this.replyText = "";
    });

    this.session.on("error", (err: Error) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });

    this.session.on("close", () => {
      this.closed = true;
      // Anyone still waiting for a reply will never get one.
      this.releaseGreeting(null);
      for (const resolve of this.waiting.splice(0)) resolve(null);
      this.emit("close");
    });
  }

  /** Hand a finished reply to a waiter, or park it until one arrives. */
  private settleReply(reply: CompletedReply): void {
    // Before the caller has said anything, the only thing the agent can be
    // saying is its greeting.
    if (!this.sawCallerTurn) {
      if (this.greetingWaiter) this.releaseGreeting(reply);
      else this.greeting = reply;
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter(reply);
    else this.ready.push(reply);
  }

  /** Settle a pending greeting wait, if there is one. */
  private releaseGreeting(reply: CompletedReply | null): void {
    const waiter = this.greetingWaiter;
    this.greetingWaiter = null;
    waiter?.(reply);
  }

  /**
   * The greeting, if the agent has one. Waits only briefly: the orchestrator
   * blocks call setup on this, and an agent configured without a greeting never
   * sends one.
   */
  takeGreeting(timeoutMs: number): Promise<CompletedReply | null> {
    const ready = this.greeting;
    if (ready) {
      this.greeting = null;
      return Promise.resolve(ready);
    }
    if (this.closed || this.sawCallerTurn) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.greetingWaiter = null;
        resolve(null);
      }, timeoutMs);
      this.greetingWaiter = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
    });
  }

  /**
   * The next reply the agent completes, or null if the call ends or it takes
   * too long. Resolves immediately when one is already queued, which is the
   * common case: the audio and the text both arrive while the orchestrator is
   * still persisting the caller's turn.
   */
  takeReply(timeoutMs = this.replyTimeoutMs): Promise<CompletedReply | null> {
    const queued = this.ready.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(settle);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const settle = (reply: CompletedReply | null): void => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.waiting.push(settle);
    });
  }

  // --- SttStream ---------------------------------------------------------

  sendAudio(chunk: Uint8Array): boolean {
    if (this.closed) return false;
    const upsampled = this.toAgent.process(chunk);
    if (upsampled.length === 0) return true;
    return this.session.sendAudio(upsampled);
  }

  /**
   * A no-op, deliberately.
   *
   * `agent_context` biasing exists to tell a *separate* STT what the agent just
   * said. The Voice Agent generated that reply itself and already has it in
   * context, so there is nothing to tell it. Keyterms are fixed when the agent
   * is created rather than per turn.
   */
  updateConfiguration(): void {}

  /**
   * Give up the injector without going near the socket. For the case where the
   * socket never opened, so there is no session to end politely.
   */
  releaseTransport(): void {
    this.closed = true;
    this.releaseGreeting(null);
    for (const resolve of this.waiting.splice(0)) resolve(null);
    this.injector?.end?.();
  }

  async close(): Promise<void> {
    this.releaseTransport();
    await this.session.close({ end: true }).catch(() => {
      this.session.destroy();
    });
  }
}

/**
 * Adapts the Voice Agent to the two seams the orchestrator already has.
 *
 * Pass an instance as `sessions`, and its `.agent` as `agent`:
 *
 * ```ts
 * const bridge = new VoiceAgentBridge({ apiKey, agentId, injectorFor });
 * new Orchestrator({ ...rest, sessions: bridge, agent: bridge.agent });
 * ```
 */
export class VoiceAgentBridge implements SttSessionManager {
  private readonly opts: VoiceAgentBridgeOptions;
  private readonly calls = new Map<string, VoiceAgentCall>();
  /** Which call a given callId belongs to, so `CallAgent` can find its socket. */
  private readonly byCallId = new Map<string, VoiceAgentCall>();

  constructor(opts: VoiceAgentBridgeOptions) {
    if (!opts.apiKey) throw new Error("VoiceAgentBridge: apiKey is required");
    if (!opts.agentId && !opts.session) {
      throw new Error(
        "VoiceAgentBridge needs either an agentId (a stored agent) or an inline session config.",
      );
    }
    this.opts = opts;
  }

  /** Hand this to `OrchestratorOptions.agent`. */
  get agent(): CallAgent {
    return {
      onAnswered: (ctx) => this.firstReply(ctx),
      onFinalTurn: (ctx) => this.nextReply(ctx),
      onCallEnded: async (record: CallRecord) => {
        this.byCallId.delete(record.callId);
      },
    };
  }

  // --- SttSessionManager -------------------------------------------------

  async open(
    key: { deviceId: string; channelId: string },
    _opts: { params: RealtimeParams },
  ): Promise<SttStream> {
    await this.close(key, "reopening");

    let injector: AudioInjector | undefined;
    try {
      injector = this.opts.injectorFor?.(key.deviceId, key.channelId as ChannelKind);
    } catch {
      // No transport is a degraded call, not a failed one — same rule the
      // orchestrator applies to its own injector.
      injector = undefined;
    }

    const session = this.createSession();
    const call = new VoiceAgentCall(session, {
      callSampleRate: this.opts.callSampleRate ?? 16000,
      injector,
      replyTimeoutMs: this.opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
    });

    // Connect before returning: the orchestrator starts pumping audio as soon
    // as it has the stream, and audio sent before session.ready is dropped.
    try {
      await session.connect();
    } catch (err) {
      // Nothing has been registered yet, so close() cannot reach this call and
      // its socket would sit there until the process exited. Release it here,
      // then let the failure reach the orchestrator, which treats a session it
      // cannot open as a call it cannot service.
      session.destroy();
      call.releaseTransport();
      throw err;
    }
    this.calls.set(keyOf(key), call);
    return call;
  }

  async close(key: { deviceId: string; channelId: string }, _reason?: string): Promise<void> {
    const call = this.calls.get(keyOf(key));
    if (!call) return;
    this.calls.delete(keyOf(key));
    for (const [callId, c] of this.byCallId) {
      if (c === call) this.byCallId.delete(callId);
    }
    await call.close();
  }

  private createSession(): VoiceAgentSession {
    const options: VoiceAgentOptions = {
      apiKey: this.opts.apiKey,
      ...(this.opts.agentId ? { agentId: this.opts.agentId } : {}),
      ...(this.opts.session ? { session: this.opts.session } : {}),
      ...(this.opts.wsUrl ? { url: this.opts.wsUrl } : {}),
    };
    return this.opts.createSession?.(options) ?? new VoiceAgentSession(options);
  }

  /** The call whose socket serves this turn, remembered by callId. */
  private callFor(ctx: {
    callId: string;
    deviceId: string;
    channelId: string;
  }): VoiceAgentCall | undefined {
    const known = this.byCallId.get(ctx.callId);
    if (known) return known;
    const call = this.calls.get(keyOf(ctx));
    if (call) this.byCallId.set(ctx.callId, call);
    return call;
  }

  /**
   * The greeting. The Voice Agent speaks it on its own as soon as the session
   * is ready, so there is nothing to send — only its text to collect for the
   * transcript.
   *
   * It waits on a much shorter deadline than a turn does, because an agent
   * configured *without* a greeting produces nothing here and the orchestrator
   * `await`s this call during call setup — the hang-up watch does not even
   * start until it returns. On the full reply timeout that is a 20-second stall
   * at the head of every call, which an e2e run caught as three tests that
   * passed and took exactly 20 seconds each. A greeting either arrives right
   * after `session.ready` or does not exist.
   */
  private async firstReply(
    ctx: Omit<AgentTurnContext, "transcript" | "turnOrder">,
  ): Promise<AgentReply | null> {
    const call = this.callFor(ctx);
    if (!call) return null;
    // With an inline config we can see there is no greeting, so there is no
    // reason to hold up call setup waiting for one. A stored agent keeps its
    // configuration server-side and cannot be asked, so that case still waits.
    if (this.opts.session && this.opts.session.greeting === undefined) return null;
    const reply = await call.takeGreeting(
      this.opts.greetingTimeoutMs ?? DEFAULT_GREETING_TIMEOUT_MS,
    );
    if (!reply || reply.text === "") return null;
    return { text: reply.text };
  }

  private async nextReply(ctx: AgentTurnContext): Promise<AgentReply | null> {
    return this.replyFrom(ctx);
  }

  /**
   * Text only, never audio — the audio has already been played. Returning it
   * here would make the orchestrator buffer the whole reply before the caller
   * heard any of it. See the file comment.
   */
  private async replyFrom(
    ctx: { callId: string; deviceId: string; channelId: string },
    timeoutMs?: number,
  ): Promise<AgentReply | null> {
    const call = this.callFor(ctx);
    if (!call) return null;
    const reply = await call.takeReply(timeoutMs);
    if (!reply || reply.text === "") return null;
    return { text: reply.text };
  }
}
