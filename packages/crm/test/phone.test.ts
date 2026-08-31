import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, samePhoneKey } from "../src/phone.js";

const US = { defaultCountryCode: "1" };

test("the three ways a NANP number is written collide onto one key", () => {
  const keys = ["+1 (555) 010-9999", "555-010-9999", "5550109999", "1 555 010 9999"].map(
    (raw) => normalizePhone(raw, US)?.key,
  );
  assert.deepEqual(keys, ["+15550109999", "+15550109999", "+15550109999", "+15550109999"]);
});

test("an international number keeps its own country code, whatever the default", () => {
  assert.equal(normalizePhone("+33 6 12 34 56 78", US)?.key, "+33612345678");
  assert.equal(normalizePhone("0033612345678", US)?.key, "+33612345678");
});

test("a leading zero is a trunk prefix, not part of the number", () => {
  const fr = { defaultCountryCode: "33" };
  assert.equal(normalizePhone("06 12 34 56 78", fr)?.key, "+33612345678");
  assert.equal(normalizePhone("+33612345678", fr)?.key, "+33612345678");
});

test("a WhatsApp JID is already international", () => {
  assert.equal(normalizePhone("15550109999@s.whatsapp.net")?.key, "+15550109999");
});

test("without a country code the key does not pretend to be E.164", () => {
  const phone = normalizePhone("555-010-9999");
  assert.equal(phone?.key, "5550109999");
  // ...but the suffix still matches its international form, which is the
  // whole point of the fallback.
  assert.equal(phone?.suffix, normalizePhone("+1 555 010 9999")?.suffix);
});

test("the suffix is the trailing significant digits", () => {
  assert.equal(normalizePhone("+1 555 010 9999", US)?.suffix, "0109999");
  assert.equal(normalizePhone("+1 555 010 9999", { ...US, significantDigits: 4 })?.suffix, "9999");
  // Shorter than the window: the whole number is the suffix.
  assert.equal(normalizePhone("911")?.suffix, "911");
});

test("a number with no digits at all is not a number", () => {
  assert.equal(normalizePhone("unknown"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("   "), null);
});

test("samePhoneKey compares normalized forms", () => {
  assert.ok(samePhoneKey("+1 (555) 010-9999", "5550109999", US));
  assert.ok(!samePhoneKey("+1 (555) 010-9999", "+1 555 010 9998", US));
  assert.ok(!samePhoneKey("unknown", "unknown", US));
});
