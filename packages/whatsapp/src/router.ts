/**
 * The bridge between a text transport and the agent that answers the phone.
 *
 * The whole point is that there is only *one* brain. A customer who asks a
 * question over WhatsApp text and then rings the same number should not have
 * to repeat themselves, so the router drives the same `CallAgent` and the same
 * `ConversationStore` entry that a voice call on that line uses — keyed by
 * (deviceId, channelId), which is why `channelId` stays "whatsapp" rather than
 * becoming a separate text channel. A distinct channel id would key a distinct
 * conversation, which is exactly the amnesia this exists to prevent; the text
 * turns are told apart by `ChatMessage.via` and by the `whatsapp-text:` call
 * id instead.
 *
 * Two failure modes are designed for rather than hoped away:
 *
 *  - **Meta retries.** A webhook that is not answered 200 fast enough is
 *    redelivered, for up to seven days. Answering the same message twice is a
 *    visible bug — the customer sees the agent say the same thing again — so
 *    every message id is remembered, and the id is remembered *before* the
 *    agent is asked, not after, because the retry usually arrives while the
 *    first turn is still generating. The set is bounded; an unbounded one is
 *    a slow leak on a long-lived process.
 *  - **Concurrent messages.** Turns for one conversation are serialised. The
 *    agent treats a new turn as barge-in and aborts the previous one, which is
 *    right for speech (the caller talked over the reply) and wrong for text
 *    (both messages deserve an answer), so the router never starts a second
 *    turn on a conversation while the first is in flight.
 */

import type { AgentReply, AgentTurnContext } from "@neuracall/orchestrator";
import type { InboundTextMessage, Unsubscribe, WhatsAppTransport } from "./types.js";

/** Prefix marking a turn that arrived as text rather than as speech. */
export const TEXT_CHANNEL_ID = "whatsapp-text";

/** The conversation channel text shares with WhatsApp voice calls. */
const VOICE_CHANNEL: AgentTurnContext["channelId"] = "whatsapp";

/** Default cap on remembered message ids. Roughly a day of busy traffic. */
const DEFAULT_MAX_SEEN = 1000;

/**
 * What the router needs from the agent brain. `LlmCallAgent` satisfies it;
 * anything that can answer a turn does.
 */
export interface TextAgent {
  onFinalTurn(ctx: AgentTurnContext): Promise<AgentReply | null>;
  /** Record a message on the shared conversation without answering it. */
  noteTextMessage?(
    deviceId: string,
    channelId: string,
    role: "user" | "assistant",
    content: string,
  ): void;
}

export interface TextMessageRouterOptions {
  agent: TextAgent;
  transport: WhatsAppTransport;
  /** Device whose line this number belongs to, when the message omits one. */
  deviceId: string;
  /**
   * Conversation channel. Defaults to "whatsapp" so text and voice on the same
   * number share one history.
   */
  channelId?: AgentTurnContext["channelId"];
  /**
   * Override the conversation's device id per message.
   *
   * A device is one line, so by default every contact texting it shares that
   * line's conversation — which is what makes voice and text continuous, and
   * is wrong the moment two different customers text the same number at once.
   * Returning `` `${deviceId}:${msg.from}` `` gives each contact its own
   * thread, at the cost of no longer sharing history with a voice call.
   */
  conversationDeviceId?: (msg: InboundTextMessage) => string;
  /** How many message ids to remember for dedup. Default 1000. */
  maxSeenMessages?: number;
  /**
   * Whether the router writes both sides of the exchange into the shared
   * conversation itself.
   *
   * Off by default, because `LlmCallAgent.onFinalTurn` already appends the
   * incoming text and its own reply — recording again would put every message
   * in the prompt twice, doubling cost and confusing the model. Turn it on for
   * a reply-only agent that keeps no history, and the messages are then tagged
   * `via: "text"`.
   */
  recordTurns?: boolean;
  /** Observability: a reply was sent. */
  onReply?: (msg: InboundTextMessage, reply: string) => void;
  /** Observability: a redelivery was dropped. */
  onDuplicate?: (msg: InboundTextMessage) => void;
  /** Observability: the agent or the transport failed. */
  onError?: (msg: InboundTextMessage, err: Error) => void;
}

export class TextMessageRouter {
  private readonly opts: TextMessageRouterOptions;
  private readonly channelId: AgentTurnContext["channelId"];
  private readonly maxSeen: number;
  /** Insertion-ordered, so the oldest id is the first one out. */
  private readonly seen = new Set<string>();
  private readonly turnOrders = new Map<string, number>();
  /** One promise chain per conversation, so its turns never overlap. */
  private readonly queues = new Map<string, Promise<void>>();
  private unsubscribe: Unsubscribe | undefined;

  constructor(opts: TextMessageRouterOptions) {
    this.opts = opts;
    this.channelId = opts.channelId ?? VOICE_CHANNEL;
    this.maxSeen = Math.max(1, opts.maxSeenMessages ?? DEFAULT_MAX_SEEN);
  }

  /** How many message ids are currently remembered for dedup. */
  get seenCount(): number {
    return this.seen.size;
  }

  /** Subscribe to the transport and start answering. */
  async start(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.opts.transport.onMessage((msg) => {
        void this.enqueue(msg);
      });
    }
    await this.opts.transport.start?.();
  }

  /** Stop answering, letting the turns already in flight finish. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.drain();
    await this.opts.transport.stop?.();
  }

  /**
   * Handle one message as if it had arrived on the transport, waiting for the
   * reply to be sent. Used by tests and by hosts that already have the message.
   */
  handle(msg: InboundTextMessage): Promise<void> {
    return this.enqueue(msg);
  }

  /** Wait for every in-flight turn to finish. */
  async drain(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()]);
    }
  }

  /**
   * Send a message the customer did not ask for (an operator note, a callback
   * confirmation) and record it, so the agent knows what was said on its
   * behalf the next time this line is used.
   */
  async sendText(to: string, text: string, deviceId?: string): Promise<void> {
    const body = text.trim();
    if (body === "") return;
    await this.opts.transport.send(to, body);
    this.opts.agent.noteTextMessage?.(
      deviceId ?? this.opts.deviceId,
      this.channelId,
      "assistant",
      body,
    );
  }

  private enqueue(msg: InboundTextMessage): Promise<void> {
    const key = this.conversationKey(msg);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const tail: Promise<void> = previous.then(async () => {
      try {
        await this.answer(msg, key);
      } finally {
        // Only release the slot if a newer message has not already claimed it.
        if (this.queues.get(key) === tail) this.queues.delete(key);
      }
    });
    this.queues.set(key, tail);
    return tail;
  }

  /** Never rejects: a thrown error would break the conversation's chain. */
  private async answer(msg: InboundTextMessage, key: string): Promise<void> {
    const text = msg.text.trim();
    if (text === "") return;

    if (this.seen.has(msg.messageId)) {
      this.opts.onDuplicate?.(msg);
      return;
    }
    this.remember(msg.messageId);

    const deviceId = this.deviceIdFor(msg);
    const turnOrder = (this.turnOrders.get(key) ?? 0) + 1;
    this.turnOrders.set(key, turnOrder);

    if (this.opts.recordTurns) {
      this.opts.agent.noteTextMessage?.(deviceId, this.channelId, "user", text);
    }

    let reply: string;
    try {
      const answer = await this.opts.agent.onFinalTurn({
        callId: `${TEXT_CHANNEL_ID}:${msg.messageId}`,
        deviceId,
        channelId: this.channelId,
        transcript: text,
        turnOrder,
        history: [],
      });
      reply = answer?.text.trim() ?? "";
    } catch (err) {
      this.fail(msg, err);
      return;
    }
    if (reply === "") return;

    try {
      await this.opts.transport.send(msg.from, reply);
    } catch (err) {
      this.fail(msg, err);
      return;
    }

    if (this.opts.recordTurns) {
      this.opts.agent.noteTextMessage?.(deviceId, this.channelId, "assistant", reply);
    }
    this.opts.onReply?.(msg, reply);
  }

  private deviceIdFor(msg: InboundTextMessage): string {
    if (this.opts.conversationDeviceId) return this.opts.conversationDeviceId(msg);
    return msg.deviceId ?? this.opts.deviceId;
  }

  private conversationKey(msg: InboundTextMessage): string {
    return `${this.deviceIdFor(msg)}::${this.channelId}`;
  }

  private remember(messageId: string): void {
    this.seen.add(messageId);
    while (this.seen.size > this.maxSeen) {
      const oldest = this.seen.values().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }

  private fail(msg: InboundTextMessage, err: unknown): void {
    this.opts.onError?.(msg, err instanceof Error ? err : new Error(String(err)));
  }
}
