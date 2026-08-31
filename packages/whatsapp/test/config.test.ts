import { test } from "node:test";
import assert from "node:assert/strict";
import { describeWhatsAppConfig, getWhatsAppConfig } from "../src/config.js";

test("an environment with no WhatsApp variables disables text", () => {
  assert.equal(getWhatsAppConfig({}), null);
  // A stray version alone is not evidence that text was meant to be on.
  assert.equal(getWhatsAppConfig({ WHATSAPP_API_VERSION: "v23.0" }), null);
  // .env.example placeholders count as unset.
  assert.equal(
    getWhatsAppConfig({
      WHATSAPP_ACCESS_TOKEN: "replace-me",
      WHATSAPP_PHONE_NUMBER_ID: "replace-me",
    }),
    null,
  );
});

test("a complete environment is read and trimmed", () => {
  const config = getWhatsAppConfig({
    WHATSAPP_ACCESS_TOKEN: "  EAAtoken  ",
    WHATSAPP_PHONE_NUMBER_ID: "1555550000",
    WHATSAPP_APP_SECRET: "secret",
    WHATSAPP_VERIFY_TOKEN: "shared",
    WHATSAPP_API_VERSION: "v23.0",
  });

  assert.deepEqual(config, {
    accessToken: "EAAtoken",
    phoneNumberId: "1555550000",
    appSecret: "secret",
    verifyToken: "shared",
    apiVersion: "v23.0",
  });
});

test("a half-configured environment fails fast", () => {
  assert.throws(
    () => getWhatsAppConfig({ WHATSAPP_ACCESS_TOKEN: "EAAtoken" }),
    /WHATSAPP_PHONE_NUMBER_ID/,
  );
  assert.throws(
    () => getWhatsAppConfig({ WHATSAPP_PHONE_NUMBER_ID: "1555550000" }),
    /WHATSAPP_ACCESS_TOKEN/,
  );
  // An app secret on its own is the classic "webhook configured, sending not".
  assert.throws(
    () => getWhatsAppConfig({ WHATSAPP_APP_SECRET: "secret" }),
    /WHATSAPP_ACCESS_TOKEN/,
  );
});

test("the loggable summary never contains the token", () => {
  const summary = describeWhatsAppConfig({
    accessToken: "EAA-super-secret-token",
    phoneNumberId: "1555550000",
  });

  assert.ok(!summary.includes("EAA-super-secret-token"));
  assert.match(summary, /\*\*\*\*oken/);
  assert.match(summary, /inbound disabled/);
});
