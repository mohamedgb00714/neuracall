/**
 * The conversational brain: a finalized caller turn goes in, a spoken reply
 * comes out.
 *
 * The hard part is not calling a model, it is **barge-in**. When the caller
 * talks over the agent, three things must stop, in this order of importance:
 *
 *  1. the audio already playing (the orchestrator handles that — it cancels
 *     `localOut`, which drops the injector queue and invalidates the
 *     generation token),
 *  2. the LLM request still generating the superseded reply, and
 *  3. the TTS request still synthesising it.
 *
 * Miss (2) and (3) and the agent finishes composing an answer to a question
 * the caller has already moved on from, then says it — the single most
 * jarring failure mode a voice agent has. So every turn runs under an
 * `AbortController` held per conversation; a new turn aborts the previous
 * one before it does anything else, and a turn that discovers it has been
 * superseded returns `null` (say nothing) rather than a stale reply.
 *
 * Because the abort is checked again *after* each await, a reply that was
 * cancelled while the model was mid-sentence is discarded even though the
 * HTTP response technically arrived.
 */

import type { AgentReply, AgentTurnContext, CallAgent, CallRecord } from "@neuracall/orchestrator";
import { ConversationStore, type ChatMessage, type Conversation } from "./conversation.js";
import type { LlmClient, LlmMessage } from "./llm.js";
import { SilentTts, type TtsClient } from "./tts.js";

/** Why a turn produced no reply. */
export type SkipReason = "interrupted" | "empty-reply" | "error";

export interface LlmCallAgentOptions {
  llm: LlmClient;
  /** Speech synthesis. Defaults to `SilentTts` (the agent is inaudible). */
  tts?: TtsClient;
  /** The agent's persona and instructions. */
  systemPrompt?: string;
  /** Opening line spoken as soon as a call is answered. */
  greeting?: string;
  /** Messages of history to keep per conversation. Default 40. */
  maxMessages?: number;
  /** Cap on reply length. Default 300 tokens — a spoken turn should be short. */
  maxTokens?: number;
  /** Terms to bias STT toward on every turn (brand names, SKUs). */
  keyterms?: string[];
  /** Drop a conversation idle this long, in ms. Default 30 min. */
  idleTtlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Observability: a turn produced no reply. */
  onSkip?: (ctx: AgentTurnContext, reason: SkipReason, err?: Error) => void;
  /** Observability: a reply was generated. */
  onReply?: (ctx: AgentTurnContext, reply: AgentReply) => void;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful voice assistant answering a live phone call.",
  "You are speaking out loud, so keep replies to one or two short sentences.",
  "Never use markdown, lists, emoji, or any formatting — everything you write is spoken aloud.",
  "Spell out numbers and abbreviations the way a person would say them.",
  "If you do not know something, say so plainly and offer to take a message.",
].join(" ");

/** Turn state for one conversation, so a new turn can cancel the last. */
interface InFlight {
  controller: AbortController;
  turnOrder: number;
}

export class LlmCallAgent implements CallAgent {
  readonly conversations: ConversationStore;
  private readonly opts: LlmCallAgentOptions;
  private readonly tts: TtsClient;
  private readonly systemPrompt: string;
  private readonly inFlight = new Map<string, InFlight>();
  /** How many replies have been abandoned mid-generation. */
  private interrupted = 0;

  constructor(opts: LlmCallAgentOptions) {
    this.opts = opts;
    this.tts = opts.tts ?? new SilentTts();
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.conversations = new ConversationStore({
      ...(opts.maxMessages !== undefined ? { maxMessages: opts.maxMessages } : {}),
      ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }

  /** Replies abandoned because the caller interrupted. */
  get interruptedCount(): number {
    return this.interrupted;
  }

  /** Whether a reply is currently being generated for this conversation. */
  isGenerating(deviceId: string, channelId: string): boolean {
    return this.inFlight.has(ConversationStore.key(deviceId, channelId));
  }

  /** The agent's opening line, spoken as soon as the call is answered. */
  async onAnswered(
    ctx: Omit<AgentTurnContext, "transcript" | "turnOrder">,
  ): Promise<AgentReply | null> {
    if (!this.opts.greeting) return null;
    const conversation = this.conversations.for(ctx.deviceId, ctx.channelId);
    conversation.appendAgent(this.opts.greeting);
    return this.buildReply(this.opts.greeting, undefined);
  }

  /**
   * Handle a finalized caller turn. Returns null when the agent should stay
   * quiet — the turn was interrupted, the model returned nothing, or it failed.
   */
  async onFinalTurn(ctx: AgentTurnContext): Promise<AgentReply | null> {
    const key = ConversationStore.key(ctx.deviceId, ctx.channelId);

    // Barge-in: whatever was being generated is now answering the wrong
    // question. Kill it before starting the new turn.
    const previous = this.inFlight.get(key);
    if (previous) {
      previous.controller.abort(new Error("superseded by a new caller turn"));
      this.interrupted += 1;
    }

    const controller = new AbortController();
    const current: InFlight = { controller, turnOrder: ctx.turnOrder };
    this.inFlight.set(key, current);

    const conversation = this.conversations.for(ctx.deviceId, ctx.channelId);
    conversation.appendUser(ctx.transcript);

    try {
      const text = await this.opts.llm.complete({
        messages: this.promptFor(conversation),
        signal: controller.signal,
        ...(this.opts.maxTokens !== undefined ? { maxTokens: this.opts.maxTokens } : {}),
      });

      // The model may have finished after the caller cut in; the answer is
      // still stale, so throw it away rather than speak it.
      if (controller.signal.aborted) return this.skip(ctx, "interrupted");
      if (text.trim() === "") return this.skip(ctx, "empty-reply");

      const reply = await this.buildReply(text, controller.signal);
      if (controller.signal.aborted) return this.skip(ctx, "interrupted");

      conversation.appendAgent(text);
      this.opts.onReply?.(ctx, reply);
      return reply;
    } catch (err) {
      if (controller.signal.aborted) return this.skip(ctx, "interrupted");
      const error = err instanceof Error ? err : new Error(String(err));
      return this.skip(ctx, "error", error);
    } finally {
      // Only clear the slot if it is still ours; a newer turn owns it otherwise.
      if (this.inFlight.get(key) === current) this.inFlight.delete(key);
    }
  }

  /** Called by the orchestrator once the call is over. */
  async onCallEnded(record: CallRecord): Promise<void> {
    const key = ConversationStore.key(record.deviceId, record.channelId);
    const pending = this.inFlight.get(key);
    if (pending) {
      pending.controller.abort(new Error("call ended"));
      this.inFlight.delete(key);
    }
    // The context outlives the call so a caller who rings straight back is
    // remembered; the store evicts it once it has been idle long enough.
    this.conversations.evictIdle();
  }

  /**
   * Record a text message on the same line so voice and text share context.
   * Used by the WhatsApp text bridge.
   */
  noteTextMessage(
    deviceId: string,
    channelId: string,
    role: "user" | "assistant",
    content: string,
  ): void {
    this.conversations.for(deviceId, channelId).appendText(role, content);
  }

  /** Turn the conversation into the model's prompt. */
  private promptFor(conversation: Conversation): LlmMessage[] {
    return [
      { role: "system", content: this.systemPrompt },
      ...conversation.window.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
    ];
  }

  /** Synthesise the reply and attach the STT biasing terms. */
  private async buildReply(text: string, signal: AbortSignal | undefined): Promise<AgentReply> {
    const speech = await this.tts.synthesize({
      text,
      ...(signal ? { signal } : {}),
    });
    return {
      text,
      audio: speech.pcm,
      sampleRate: speech.sampleRate,
      channels: speech.channels,
      ...(this.opts.keyterms ? { keyterms: this.opts.keyterms } : {}),
    };
  }

  private skip(ctx: AgentTurnContext, reason: SkipReason, err?: Error): null {
    this.opts.onSkip?.(ctx, reason, err);
    return null;
  }
}
