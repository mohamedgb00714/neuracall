/**
 * Webhook authentication: proving a delivery really came from Meta.
 *
 * This is the only thing standing between a public HTTPS endpoint and anyone
 * on the internet who can make the agent answer as this business, so three
 * details are load-bearing:
 *
 *  1. The comparison is timing-safe. A `===` on the hex digest leaks the
 *     expected signature a byte at a time to an attacker who can measure
 *     response time, which is a forgery in a few thousand requests.
 *  2. `timingSafeEqual` *throws* on a length mismatch, and
 *     `Buffer.from(hex, "hex")` silently truncates on malformed input rather
 *     than throwing — so a truncated signature would otherwise become a
 *     shorter buffer and crash the handler. Both are checked first, and a bad
 *     signature always returns false instead of raising.
 *  3. Meta documents (on the Messenger page; the WhatsApp one omits it) that
 *     the digest is taken over an *escaped-unicode* rendering of the payload
 *     with lowercase hex. Verifying only the decoded bytes passes every ASCII
 *     fixture and fails on essentially every real Arabic or accented message
 *     — an empty inbox that looks like a parser bug. Both forms are accepted.
 *
 * Verification fails closed: no header, no secret, or a malformed header is a
 * rejection, never a pass.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Header Meta signs its deliveries with. */
export const SIGNATURE_HEADER = "x-hub-signature-256";

const PREFIX = "sha256=";
/** HMAC-SHA256 hex is exactly 64 characters. */
const HEX_DIGEST = /^[0-9a-f]{64}$/i;

/**
 * Check an `X-Hub-Signature-256` header against the exact bytes received.
 *
 * `rawBody` must be the untouched request body. A re-serialised
 * `JSON.stringify(req.body)` does not reproduce Meta's bytes (key order,
 * spacing, escaping) and will fail for reasons that look random.
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;

  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith(PREFIX)) return false;

  const hex = trimmed.slice(PREFIX.length);
  if (!HEX_DIGEST.test(hex)) return false;
  const supplied = Buffer.from(hex, "hex");

  const raw = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  if (digestMatches(appSecret, raw, supplied)) return true;

  // Only worth a second pass when the body actually contains non-ASCII; for an
  // ASCII payload the escaped form is byte-identical to the raw one.
  const text = raw.toString("utf8");
  const escaped = escapeUnicode(text);
  if (escaped === text) return false;
  return digestMatches(appSecret, Buffer.from(escaped, "utf8"), supplied);
}

/**
 * Meta's `hub.challenge` handshake. Returns the challenge to echo back with a
 * 200, or null when the caller must be answered with a 403.
 */
export function verifyWebhookChallenge(
  query: Record<string, string | undefined>,
  verifyToken: string,
): string | null {
  if (!verifyToken) return null;
  if (query["hub.mode"] !== "subscribe") return null;

  const supplied = query["hub.verify_token"];
  if (supplied === undefined || !constantTimeEquals(supplied, verifyToken)) return null;

  return query["hub.challenge"] ?? null;
}

/**
 * Render every non-ASCII code unit as a lowercase `\uXXXX` escape, matching
 * the payload Meta signs.
 */
export function escapeUnicode(text: string): string {
  let out = "";
  // Per UTF-16 code unit rather than per code point: a surrogate pair becomes
  // the two escapes JSON would emit, which is what Meta hashes.
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code > 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : text.charAt(i);
  }
  return out;
}

function digestMatches(secret: string, body: Buffer, supplied: Buffer): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
