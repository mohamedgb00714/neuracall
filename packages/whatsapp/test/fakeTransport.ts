/**
 * An in-memory `WhatsAppTransport`, so the whole text path can be exercised
 * with no network, no Meta app and no credentials.
 */

import type { InboundTextMessage, Unsubscribe, WhatsAppTransport } from "../src/types.js";

export class FakeTransport implements WhatsAppTransport {
  readonly sent: Array<{ to: string; text: string }> = [];
  readonly listeners = new Set<(msg: InboundTextMessage) => void>();
  startCount = 0;
  stopCount = 0;
  /** Set to make the next `send` reject, modelling a Meta policy rejection. */
  failNextSend: Error | null = null;

  async send(to: string, text: string): Promise<void> {
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = null;
      throw err;
    }
    this.sent.push({ to, text });
  }

  onMessage(cb: (msg: InboundTextMessage) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  /** Pretend Meta delivered a webhook. */
  deliver(msg: InboundTextMessage): void {
    for (const listener of [...this.listeners]) listener(msg);
  }
}

let counter = 0;

/** An inbound message with sensible defaults. */
export function inbound(overrides: Partial<InboundTextMessage> = {}): InboundTextMessage {
  counter += 1;
  return {
    from: "212600000001",
    text: "hello",
    messageId: `wamid.TEST${counter}`,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}
