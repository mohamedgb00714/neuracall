import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWebhook } from "../src/webhook.js";

const PHONE_NUMBER_ID = "1555550000";

function envelope(value: unknown, field = "messages"): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field, value }] }],
  };
}

function messagesValue(messages: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15555550000", phone_number_id: PHONE_NUMBER_ID },
    ...extra,
    messages,
  };
}

test("a text message is extracted with its identifiers", () => {
  const parsed = parseWebhook(
    envelope(
      messagesValue(
        [
          {
            from: "212600000001",
            id: "wamid.ABC",
            timestamp: "1700000000",
            type: "text",
            text: { body: "are you open on Sunday?" },
          },
        ],
        { contacts: [{ profile: { name: "Amina" }, wa_id: "212600000001" }] },
      ),
    ),
    { phoneNumberId: PHONE_NUMBER_ID, deviceId: "SERIAL" },
  );

  assert.deepEqual(parsed, [
    {
      from: "212600000001",
      text: "are you open on Sunday?",
      messageId: "wamid.ABC",
      // Meta sends unix seconds as a string.
      timestamp: 1_700_000_000_000,
      deviceId: "SERIAL",
    },
  ]);
});

test("a status-only callback yields nothing and does not throw", () => {
  const parsed = parseWebhook(
    envelope({
      messaging_product: "whatsapp",
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      statuses: [
        {
          id: "wamid.OUT",
          status: "delivered",
          timestamp: "1700000005",
          recipient_id: "212600000001",
        },
      ],
    }),
    { phoneNumberId: PHONE_NUMBER_ID },
  );

  assert.deepEqual(parsed, []);
});

test("malformed and empty bodies yield nothing", () => {
  for (const body of [null, undefined, 42, "not json", [], {}, { entry: "nope" }]) {
    assert.deepEqual(parseWebhook(body), [], `body: ${JSON.stringify(body)}`);
  }
  assert.deepEqual(parseWebhook(envelope(null)), []);
  assert.deepEqual(parseWebhook(envelope(messagesValue([null, 7, {}]))), []);
});

test("a message for another business number is dropped", () => {
  const body = envelope(
    messagesValue([
      {
        from: "212600000001",
        id: "wamid.X",
        timestamp: "1700000000",
        type: "text",
        text: { body: "hi" },
      },
    ]),
  );

  assert.equal(parseWebhook(body, { phoneNumberId: "9999999" }).length, 0);
  assert.equal(parseWebhook(body, { phoneNumberId: PHONE_NUMBER_ID }).length, 1);
  // No ownership filter configured: accept whatever arrived.
  assert.equal(parseWebhook(body).length, 1);
});

test("non-message fields on the same subscription are ignored", () => {
  const body = envelope(
    { event: "APPROVED", message_template_id: 1 },
    "message_template_status_update",
  );
  assert.deepEqual(parseWebhook(body), []);
});

test("a sender with no phone number is kept via the business-scoped id", () => {
  // Since Meta's username rollout a customer can hide their number; dropping
  // these loses real conversations.
  const parsed = parseWebhook(
    envelope(
      messagesValue([
        {
          user_id: "BSUID123",
          id: "wamid.BS",
          timestamp: "1700000000",
          type: "text",
          text: { body: "hello" },
        },
        {
          external_user_id: "BSUID456",
          id: "wamid.BS2",
          timestamp: "1700000000",
          type: "text",
          text: { body: "hello again" },
        },
      ]),
    ),
  );

  assert.deepEqual(
    parsed.map((m) => m.from),
    ["BSUID123", "BSUID456"],
  );
});

test("button and interactive replies are read as text", () => {
  const parsed = parseWebhook(
    envelope(
      messagesValue([
        {
          from: "1",
          id: "wamid.1",
          timestamp: "1700000000",
          type: "button",
          button: { payload: "BOOK", text: "Book a table" },
        },
        {
          from: "2",
          id: "wamid.2",
          timestamp: "1700000000",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes please" } },
        },
        {
          from: "3",
          id: "wamid.3",
          timestamp: "1700000000",
          type: "interactive",
          interactive: { type: "list_reply", list_reply: { id: "l1", title: "Large" } },
        },
      ]),
    ),
  );

  assert.deepEqual(
    parsed.map((m) => m.text),
    ["Book a table", "Yes please", "Large"],
  );
});

test("media messages the agent cannot read are skipped", () => {
  const parsed = parseWebhook(
    envelope(
      messagesValue([
        { from: "1", id: "wamid.IMG", timestamp: "1700000000", type: "image", image: { id: "m1" } },
        { from: "1", id: "wamid.AUD", timestamp: "1700000000", type: "audio", audio: { id: "m2" } },
        {
          from: "1",
          id: "wamid.TXT",
          timestamp: "1700000000",
          type: "text",
          text: { body: "and this" },
        },
      ]),
    ),
  );

  assert.deepEqual(
    parsed.map((m) => m.messageId),
    ["wamid.TXT"],
  );
});

test("a junk timestamp falls back to the injected clock", () => {
  const parsed = parseWebhook(
    envelope(
      messagesValue([
        { from: "1", id: "wamid.T", timestamp: "later", type: "text", text: { body: "hi" } },
      ]),
    ),
    { now: () => 4242 },
  );

  assert.equal(parsed[0]?.timestamp, 4242);
});
