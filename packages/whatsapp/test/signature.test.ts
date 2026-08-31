import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { escapeUnicode, verifyWebhookChallenge, verifyWebhookSignature } from "../src/signature.js";

const SECRET = "app-secret-value";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

test("a correct signature is accepted", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
});

test("a tampered body is rejected", () => {
  const body = JSON.stringify({ amount: 10 });
  const signature = sign(body);
  const tampered = JSON.stringify({ amount: 10000 });

  assert.equal(verifyWebhookSignature(tampered, signature, SECRET), false);
});

test("a tampered signature is rejected", () => {
  const body = JSON.stringify({ hello: "world" });
  const signature = sign(body);
  // Flip one hex digit; still 64 characters, so only the compare can catch it.
  const flipped = signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");

  assert.equal(verifyWebhookSignature(body, flipped, SECRET), false);
});

test("a wrong-length signature is rejected without throwing", () => {
  const body = JSON.stringify({ hello: "world" });

  // Truncated: Buffer.from(hex, "hex") would silently shorten this rather than
  // throw, and timingSafeEqual would then throw on the length mismatch.
  assert.equal(verifyWebhookSignature(body, "sha256=deadbeef", SECRET), false);
  // Over-long (a sha512-sized digest).
  assert.equal(verifyWebhookSignature(body, `sha256=${"a".repeat(128)}`, SECRET), false);
  // Not hex at all.
  assert.equal(verifyWebhookSignature(body, `sha256=${"z".repeat(64)}`, SECRET), false);
});

test("verification fails closed on a missing header or secret", () => {
  const body = "{}";
  assert.equal(verifyWebhookSignature(body, undefined, SECRET), false);
  assert.equal(verifyWebhookSignature(body, null, SECRET), false);
  assert.equal(verifyWebhookSignature(body, "", SECRET), false);
  assert.equal(verifyWebhookSignature(body, sign(body, "other"), SECRET), false);
  assert.equal(verifyWebhookSignature(body, sign(body), ""), false);
});

test("the sha256= prefix is required", () => {
  const body = "{}";
  const hex = sign(body).slice("sha256=".length);
  assert.equal(verifyWebhookSignature(body, hex, SECRET), false);
  assert.equal(verifyWebhookSignature(body, `sha1=${hex}`, SECRET), false);
});

test("a signature over the escaped-unicode payload is accepted", () => {
  // Meta signs an escaped rendering of the body. An ASCII-only fixture cannot
  // tell the two apart, so this uses a body a real customer would send.
  const body = JSON.stringify({ text: "مرحبا, ça va?" });
  assert.notEqual(escapeUnicode(body), body);

  const escapedSignature = `sha256=${createHmac("sha256", SECRET)
    .update(Buffer.from(escapeUnicode(body), "utf8"))
    .digest("hex")}`;

  assert.equal(verifyWebhookSignature(body, escapedSignature, SECRET), true);
  // The raw-bytes form still works too.
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
});

test("escapeUnicode leaves ASCII alone and lowercases its hex", () => {
  assert.equal(escapeUnicode('{"a":"b"}'), '{"a":"b"}');
  assert.equal(escapeUnicode("é"), "\\u00e9");
});

test("raw bytes verify the same as a string body", () => {
  const body = JSON.stringify({ hello: "world" });
  const bytes = new TextEncoder().encode(body);
  assert.equal(verifyWebhookSignature(bytes, sign(body), SECRET), true);
});

test("the handshake echoes the challenge only for the right token", () => {
  const query = {
    "hub.mode": "subscribe",
    "hub.verify_token": "shared-token",
    "hub.challenge": "1158201444",
  };

  assert.equal(verifyWebhookChallenge(query, "shared-token"), "1158201444");
  assert.equal(verifyWebhookChallenge(query, "wrong-token"), null);
  // A different length must not throw on the timing-safe compare.
  assert.equal(verifyWebhookChallenge(query, "short"), null);
  assert.equal(
    verifyWebhookChallenge({ ...query, "hub.mode": "unsubscribe" }, "shared-token"),
    null,
  );
  assert.equal(verifyWebhookChallenge({}, "shared-token"), null);
});
