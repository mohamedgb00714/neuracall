/**
 * The WhatsApp Business Cloud API transport.
 *
 * Outbound is a plain HTTPS POST, so it is a `fetch` away. Inbound is not a
 * connection this process opens at all: Meta POSTs to a public HTTPS endpoint
 * the host application owns. That asymmetry shapes the class — there is
 * nothing to `start()`, and instead `handleWebhook` is the seam the host's
 * route calls with the raw body and the signature header.
 *
 * Two things about that route are the caller's responsibility and cannot be
 * enforced from here:
 *
 *  - It must hand over the **exact bytes** Meta sent. Once a JSON body parser
 *    has consumed and discarded them, no re-serialisation reproduces them and
 *    every signature check fails.
 *  - It must answer 200 quickly and do the work afterwards. Meta retries a
 *    failed delivery for seven days, so a slow agent turn inside the request
 *    handler turns one message into a queue of duplicates — which is exactly
 *    what `TextMessageRouter`'s dedup exists to survive.
 *
 * The access token never appears in an error, a log line or a rejection: it is
 * a bearer credential for the business's entire WhatsApp presence.
 */

import { SIGNATURE_HEADER, verifyWebhookChallenge, verifyWebhookSignature } from "./signature.js";
import type { InboundTextMessage, Unsubscribe, WhatsAppTransport } from "./types.js";
import { parseWebhook } from "./webhook.js";

export interface CloudApiTransportOptions {
  /** Permanent or system-user access token. Never logged. */
  accessToken: string;
  /** The business phone number id messages are sent from. */
  phoneNumberId: string;
  /** App secret for webhook signatures. Without it inbound fails closed. */
  appSecret?: string;
  /** Shared token for the `hub.challenge` handshake. */
  verifyToken?: string;
  /**
   * Graph API version, e.g. "v23.0". Meta supports a version for about two
   * years, so this is configuration rather than a constant to be forgotten
   * in a source file.
   */
  apiVersion?: string;
  /** Graph API root. Overridden in tests. */
  baseUrl?: string;
  /** The device whose line this number represents, for conversation keying. */
  deviceId?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Observability: a listener threw, or a delivery was rejected. */
  onError?: (err: Error) => void;
}

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v23.0";

/** Why a webhook delivery was not turned into messages. */
export type WebhookRejection = "bad-signature" | "no-app-secret" | "malformed-body";

/** The outcome of one webhook delivery. */
export interface WebhookResult {
  accepted: boolean;
  reason?: WebhookRejection;
  messages: InboundTextMessage[];
}

export class CloudApiTransport implements WhatsAppTransport {
  private readonly opts: CloudApiTransportOptions;
  private readonly fetchFn: typeof fetch;
  private readonly listeners = new Set<(msg: InboundTextMessage) => void>();

  constructor(opts: CloudApiTransportOptions) {
    if (!opts.accessToken) throw new Error("CloudApiTransport: accessToken is required");
    if (!opts.phoneNumberId) throw new Error("CloudApiTransport: phoneNumberId is required");
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  /** Send a free-form text message. */
  async send(to: string, text: string): Promise<void> {
    if (!to) throw new Error("CloudApiTransport.send: a recipient is required");
    if (text.trim() === "") return;

    const base = (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const version = this.opts.apiVersion ?? DEFAULT_API_VERSION;
    const url = `${base}/${version}/${this.opts.phoneNumberId}/messages`;

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        // Link previews turn a spoken-style reply into a card; the agent is
        // holding a conversation, not publishing.
        text: { preview_url: false, body: text },
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Outside the 24-hour customer-service window Meta rejects free-form
      // replies and only an approved template may be sent. That is policy,
      // not a transport fault, so the message is surfaced rather than retried.
      throw new Error(
        `WhatsApp send failed: ${response.status} ${response.statusText}` +
          `${body ? ` - ${body.slice(0, 500)}` : ""}`,
      );
    }
  }

  onMessage(cb: (msg: InboundTextMessage) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Verify, parse and dispatch one webhook delivery. `rawBody` must be the
   * untouched request bytes.
   */
  handleWebhook(
    rawBody: string | Uint8Array,
    signatureHeader: string | null | undefined,
  ): WebhookResult {
    const appSecret = this.opts.appSecret;
    if (!appSecret) {
      return this.reject("no-app-secret", "WhatsApp webhook rejected: no app secret configured");
    }
    if (!verifyWebhookSignature(rawBody, signatureHeader, appSecret)) {
      return this.reject("bad-signature", "WhatsApp webhook rejected: signature mismatch");
    }

    let body: unknown;
    try {
      const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
      body = JSON.parse(text);
    } catch {
      return this.reject("malformed-body", "WhatsApp webhook rejected: body was not JSON");
    }

    const messages = parseWebhook(body, {
      phoneNumberId: this.opts.phoneNumberId,
      ...(this.opts.deviceId !== undefined ? { deviceId: this.opts.deviceId } : {}),
      ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
    });
    for (const message of messages) this.emit(message);
    return { accepted: true, messages };
  }

  /**
   * Answer Meta's subscription handshake. Returns the challenge to echo with a
   * 200, or null when the request must get a 403.
   */
  verifyChallenge(query: Record<string, string | undefined>): string | null {
    const token = this.opts.verifyToken;
    if (!token) return null;
    return verifyWebhookChallenge(query, token);
  }

  /** The header a host route must pass to `handleWebhook`. */
  static readonly signatureHeader = SIGNATURE_HEADER;

  private emit(message: InboundTextMessage): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (err) {
        // One broken listener must not stop the others from seeing the message.
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private reject(reason: WebhookRejection, message: string): WebhookResult {
    this.opts.onError?.(new Error(message));
    return { accepted: false, reason, messages: [] };
  }
}
