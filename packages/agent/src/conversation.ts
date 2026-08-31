/**
 * Per-(device, channel) conversation context.
 *
 * The context window is keyed by device *and* channel rather than by call, so
 * a caller who hangs up and rings straight back is not met by an agent with
 * total amnesia, and so a WhatsApp text thread and a voice call on the same
 * line share one history — which is the point of `appendText`: the agent that
 * answered the phone should know what was said over text five minutes earlier.
 *
 * Contexts are trimmed, not unbounded. A long call would otherwise grow the
 * prompt until it is slow and expensive on every single turn, and the opening
 * of a twenty-minute call rarely matters to the current sentence. The system
 * prompt is stored separately and never trimmed away.
 */

/** A single message in the conversation. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** ms since epoch. */
  at: number;
  /** Which surface it arrived on. Voice and text share one history. */
  via: "voice" | "text";
}

export interface ConversationOptions {
  /**
   * How many messages to keep. Older ones are dropped from the window (they
   * remain in `all` for the transcript). Default 40.
   */
  maxMessages?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** One caller's running context on a (device, channel) pair. */
export class Conversation {
  readonly deviceId: string;
  readonly channelId: string;
  private readonly maxMessages: number;
  private readonly now: () => number;
  private readonly messages: ChatMessage[] = [];

  constructor(deviceId: string, channelId: string, opts: ConversationOptions = {}) {
    this.deviceId = deviceId;
    this.channelId = channelId;
    this.maxMessages = Math.max(1, opts.maxMessages ?? 40);
    this.now = opts.now ?? Date.now;
  }

  /** The full history, oldest first — what the transcript is built from. */
  get all(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** The trimmed window actually sent to the model. */
  get window(): ChatMessage[] {
    return this.messages.slice(-this.maxMessages).map((m) => ({ ...m }));
  }

  get length(): number {
    return this.messages.length;
  }

  /** When the last message was added, or 0 for an untouched conversation. */
  get lastActivityAt(): number {
    return this.messages.at(-1)?.at ?? 0;
  }

  /** Record something the caller said out loud. */
  appendUser(content: string): ChatMessage {
    return this.append("user", content, "voice");
  }

  /** Record something the agent said out loud. */
  appendAgent(content: string): ChatMessage {
    return this.append("assistant", content, "voice");
  }

  /**
   * Record a text message on the same line, so voice and text share context.
   * Used by the WhatsApp text bridge.
   */
  appendText(role: "user" | "assistant", content: string): ChatMessage {
    return this.append(role, content, "text");
  }

  private append(role: "user" | "assistant", content: string, via: "voice" | "text"): ChatMessage {
    const message: ChatMessage = { role, content, at: this.now(), via };
    this.messages.push(message);
    return { ...message };
  }

  /** Forget everything (call ended, or an operator reset). */
  clear(): void {
    this.messages.length = 0;
  }
}

export interface ConversationStoreOptions extends ConversationOptions {
  /**
   * Drop a conversation that has been idle this long, in ms. Default 30 min.
   * Without this the store would hold every caller the system has ever spoken
   * to for as long as the process lives.
   */
  idleTtlMs?: number;
}

/** Holds one `Conversation` per (device, channel). */
export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly opts: ConversationStoreOptions;
  private readonly now: () => number;
  private readonly idleTtlMs: number;

  constructor(opts: ConversationStoreOptions = {}) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60 * 1000;
  }

  static key(deviceId: string, channelId: string): string {
    return `${deviceId}::${channelId}`;
  }

  /** Live conversation keys. */
  get keys(): string[] {
    return [...this.conversations.keys()];
  }

  get size(): number {
    return this.conversations.size;
  }

  /** Get the conversation for a (device, channel), creating it if needed. */
  for(deviceId: string, channelId: string): Conversation {
    const key = ConversationStore.key(deviceId, channelId);
    const existing = this.conversations.get(key);
    if (existing) return existing;

    const created = new Conversation(deviceId, channelId, this.opts);
    this.conversations.set(key, created);
    return created;
  }

  /** Look one up without creating it. */
  peek(deviceId: string, channelId: string): Conversation | undefined {
    return this.conversations.get(ConversationStore.key(deviceId, channelId));
  }

  /** Forget one conversation entirely. */
  drop(deviceId: string, channelId: string): boolean {
    return this.conversations.delete(ConversationStore.key(deviceId, channelId));
  }

  /** Evict conversations idle beyond the TTL. Returns how many were dropped. */
  evictIdle(): number {
    const cutoff = this.now() - this.idleTtlMs;
    let dropped = 0;
    for (const [key, conversation] of [...this.conversations]) {
      if (conversation.lastActivityAt < cutoff) {
        this.conversations.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }
}
