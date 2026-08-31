/**
 * The transport port for WhatsApp text.
 *
 * Text is deliberately a separate transport from voice. Voice runs through a
 * physical handset (scrcpy on a real Android device, because there is no API
 * that answers a WhatsApp call); text has a first-class Business API, so
 * pushing it through the phone as well would be self-inflicted pain. What the
 * two share is the *brain* — the same `CallAgent` and the same conversation —
 * not the wire.
 *
 * Keeping the port this narrow means the Cloud API, an on-device bridge, or a
 * fake in a test are interchangeable, and every test in this package runs with
 * no network and no Meta credentials.
 */

/** One inbound text message, normalised out of whatever the transport speaks. */
export interface InboundTextMessage {
  /**
   * Who sent it, as the identifier a reply must be addressed to.
   *
   * Usually an E.164 phone number, but since Meta's username rollout a sender
   * can hide their number and arrive as a Business-Scoped User ID instead —
   * an opaque string that is unique per business/user pair and is *not*
   * dialable. Treat it as an identity, never as a phone number.
   */
  from: string;
  text: string;
  /** Provider message id (`wamid.…`). The dedup key for webhook retries. */
  messageId: string;
  /** ms since epoch. */
  timestamp: number;
  /** Which device's line this belongs to, when the transport knows. */
  deviceId?: string;
}

/** Unsubscribes a listener registered with `onMessage`. */
export type Unsubscribe = () => void;

/** What the text bridge needs from a messaging provider. */
export interface WhatsAppTransport {
  send(to: string, text: string): Promise<void>;
  onMessage(cb: (msg: InboundTextMessage) => void): Unsubscribe;
  /** Optional: open whatever connection the transport needs. */
  start?(): Promise<void>;
  /** Optional: close it again. */
  stop?(): Promise<void>;
}
