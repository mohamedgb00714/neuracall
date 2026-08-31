/**
 * Pure parsing of the Cloud API webhook envelope.
 *
 * No I/O, no state, no clock it does not own — so the whole inbound surface is
 * testable from a JSON fixture. The envelope is deep and every level is
 * optional in practice:
 *
 *   { object, entry: [ { id, changes: [ { field, value: {
 *       metadata: { phone_number_id }, contacts: [], messages: [], statuses: []
 *   } } ] } ] }
 *
 * Two shapes account for most real traffic and neither may throw:
 *
 *  - **status-only callbacks.** Delivery and read receipts for our *own*
 *    outbound messages arrive on the same subscription with `statuses` and no
 *    `messages` at all. They outnumber inbound messages several to one.
 *  - **non-text messages.** Images, audio, stickers and locations arrive on
 *    the same channel. The agent is a text brain, so they are skipped rather
 *    than half-parsed into an empty prompt.
 *
 * Senders are not always phone numbers any more: since Meta's username
 * rollout a message can carry no `from` and no `wa_id`, only a
 * Business-Scoped User ID. Dropping those (`if (!m.from) continue`) silently
 * loses real customers, so any of the identifiers is accepted.
 */

import type { InboundTextMessage } from "./types.js";

export interface ParseWebhookOptions {
  /**
   * Accept only messages addressed to this phone number id.
   *
   * A valid signature proves the payload came from Meta, not that it concerns
   * this deployment — one Meta app can be subscribed to several numbers, and
   * another business's conversation must never reach this agent.
   */
  phoneNumberId?: string;
  /** Stamped onto every parsed message, so the router knows the line. */
  deviceId?: string;
  /** Clock, injectable for tests. Used when a timestamp is missing or junk. */
  now?: () => number;
}

/** The `object` value Meta sends for WhatsApp Business deliveries. */
export const WHATSAPP_WEBHOOK_OBJECT = "whatsapp_business_account";

/** Extract every text message from a webhook body. Never throws. */
export function parseWebhook(body: unknown, opts: ParseWebhookOptions = {}): InboundTextMessage[] {
  const now = opts.now ?? Date.now;
  const root = asRecord(body);
  if (!root) return [];

  const messages: InboundTextMessage[] = [];
  for (const entryValue of asArray(root["entry"])) {
    const entry = asRecord(entryValue);
    if (!entry) continue;

    for (const changeValue of asArray(entry["changes"])) {
      const change = asRecord(changeValue);
      if (!change) continue;
      // "messages" is the only field carrying conversation traffic; account
      // and template updates ride the same subscription.
      if (change["field"] !== undefined && change["field"] !== "messages") continue;

      const value = asRecord(change["value"]);
      if (!value) continue;
      if (!belongsToUs(value, opts.phoneNumberId)) continue;

      for (const messageValue of asArray(value["messages"])) {
        const parsed = parseMessage(messageValue, opts.deviceId, now);
        if (parsed) messages.push(parsed);
      }
    }
  }
  return messages;
}

function belongsToUs(value: Record<string, unknown>, phoneNumberId?: string): boolean {
  if (phoneNumberId === undefined) return true;
  const metadata = asRecord(value["metadata"]);
  return asString(metadata?.["phone_number_id"]) === phoneNumberId;
}

function parseMessage(
  raw: unknown,
  deviceId: string | undefined,
  now: () => number,
): InboundTextMessage | null {
  const message = asRecord(raw);
  if (!message) return null;

  const messageId = asString(message["id"]);
  if (!messageId) return null;

  const from = senderOf(message);
  if (!from) return null;

  const text = textOf(message);
  if (!text) return null;

  return {
    from,
    text,
    messageId,
    timestamp: timestampOf(message["timestamp"], now),
    ...(deviceId !== undefined ? { deviceId } : {}),
  };
}

/**
 * The sender's identity: a phone number when they have one, otherwise the
 * Business-Scoped User ID. Meta has spelled that field several ways through
 * the rollout, so all of them are tried.
 */
function senderOf(message: Record<string, unknown>): string | undefined {
  return (
    asString(message["from"]) ??
    asString(message["user_id"]) ??
    asString(message["external_user_id"])
  );
}

/** The readable content, or undefined for a type the agent cannot answer. */
function textOf(message: Record<string, unknown>): string | undefined {
  switch (message["type"]) {
    case "text":
      return asString(asRecord(message["text"])?.["body"]);
    case "button":
      // Quick reply on a template: the payload is machine-readable, the text
      // is what the customer believes they said.
      return asString(asRecord(message["button"])?.["text"]);
    case "interactive": {
      const interactive = asRecord(message["interactive"]);
      return (
        asString(asRecord(interactive?.["button_reply"])?.["title"]) ??
        asString(asRecord(interactive?.["list_reply"])?.["title"])
      );
    }
    default:
      return undefined;
  }
}

/** Meta sends unix *seconds*, as a string. */
function timestampOf(raw: unknown, now: () => number): number {
  const seconds = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : now();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
