import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { CloudApiTransport } from "../src/cloudApi.js";
import type { CloudApiTransportOptions } from "../src/cloudApi.js";
import type { InboundTextMessage } from "../src/types.js";

const TOKEN = "EAA-super-secret-token";
const PHONE_NUMBER_ID = "1555550000";
const APP_SECRET = "app-secret-value";

interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
}

function recordingFetch(response: () => Response): {
  fetchFn: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return response();
  };
  return { fetchFn, calls };
}

function transport(
  fetchFn: typeof fetch,
  extra: Partial<CloudApiTransportOptions> = {},
): CloudApiTransport {
  return new CloudApiTransport({
    accessToken: TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    appSecret: APP_SECRET,
    fetchFn,
    ...extra,
  });
}

function webhookBody(text: string, messageId = "wamid.ABC"): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  from: "212600000001",
                  id: messageId,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

test("send posts a text message to the graph messages endpoint", async () => {
  const { fetchFn, calls } = recordingFetch(() => new Response("{}", { status: 200 }));
  await transport(fetchFn, { apiVersion: "v23.0" }).send("212600000001", "We open at nine.");

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(call.body), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "212600000001",
    type: "text",
    text: { preview_url: false, body: "We open at nine." },
  });
});

test("send surfaces a rejection without leaking the token", async () => {
  const { fetchFn } = recordingFetch(
    () =>
      new Response(
        JSON.stringify({ error: { message: "Message failed to send outside the window" } }),
        {
          status: 400,
          statusText: "Bad Request",
        },
      ),
  );

  await assert.rejects(
    () => transport(fetchFn).send("212600000001", "hello"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /400/);
      assert.ok(!err.message.includes(TOKEN), "the access token must never reach an error message");
      return true;
    },
  );
});

test("send skips an empty body rather than calling the API", async () => {
  const { fetchFn, calls } = recordingFetch(() => new Response("{}", { status: 200 }));
  await transport(fetchFn).send("212600000001", "   ");
  assert.equal(calls.length, 0);
});

test("a correctly signed webhook is parsed and dispatched", () => {
  const { fetchFn } = recordingFetch(() => new Response("{}", { status: 200 }));
  const api = transport(fetchFn, { deviceId: "SERIAL" });
  const received: InboundTextMessage[] = [];
  api.onMessage((msg) => received.push(msg));

  const body = webhookBody("are you open?");
  const result = api.handleWebhook(body, sign(body));

  assert.equal(result.accepted, true);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(received, result.messages);
  assert.equal(received[0]?.deviceId, "SERIAL");
});

test("a forged or unsigned webhook is rejected and dispatches nothing", () => {
  const { fetchFn } = recordingFetch(() => new Response("{}", { status: 200 }));
  const errors: string[] = [];
  const api = transport(fetchFn, { onError: (err: Error) => errors.push(err.message) });
  const received: InboundTextMessage[] = [];
  api.onMessage((msg) => received.push(msg));

  const body = webhookBody("hello");

  assert.equal(api.handleWebhook(body, sign(body, "attacker")).reason, "bad-signature");
  assert.equal(api.handleWebhook(body, undefined).reason, "bad-signature");
  assert.equal(api.handleWebhook(body, "sha256=deadbeef").reason, "bad-signature");
  assert.equal(received.length, 0);
  assert.equal(errors.length, 3);
});

test("inbound fails closed when no app secret is configured", () => {
  const { fetchFn } = recordingFetch(() => new Response("{}", { status: 200 }));
  const api = new CloudApiTransport({
    accessToken: TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    fetchFn,
  });
  const body = webhookBody("hello");

  const result = api.handleWebhook(body, sign(body));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "no-app-secret");
});

test("a signed but non-JSON body is rejected without throwing", () => {
  const { fetchFn } = recordingFetch(() => new Response("{}", { status: 200 }));
  const api = transport(fetchFn);
  const body = "<html>gateway error</html>";

  assert.equal(api.handleWebhook(body, sign(body)).reason, "malformed-body");
});

test("a status-only delivery is accepted with no messages", () => {
  const { fetchFn } = recordingFetch(() => new Response("{}", { status: 200 }));
  const api = transport(fetchFn);
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              statuses: [{ id: "wamid.OUT", status: "read", timestamp: "1700000005" }],
            },
          },
        ],
      },
    ],
  });

  const result = api.handleWebhook(body, sign(body));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.messages, []);
});

test("one throwing listener does not stop the others", () => {
  const { fetchFn } = recordingFetch(() => new Response("{}", { status: 200 }));
  const errors: Error[] = [];
  const api = transport(fetchFn, { onError: (err: Error) => errors.push(err) });
  api.onMessage(() => {
    throw new Error("listener exploded");
  });
  const received: InboundTextMessage[] = [];
  const off = api.onMessage((msg) => received.push(msg));

  const body = webhookBody("hi");
  assert.equal(api.handleWebhook(body, sign(body)).accepted, true);
  assert.equal(received.length, 1);
  assert.equal(errors.length, 1);

  off();
  assert.equal(
    api.handleWebhook(
      webhookBody("hi again", "wamid.DEF"),
      sign(webhookBody("hi again", "wamid.DEF")),
    ).accepted,
    true,
  );
  assert.equal(received.length, 1);
});

test("the challenge handshake answers only for the configured token", () => {
  const { fetchFn } = recordingFetch(() => new Response("{}", { status: 200 }));
  const api = transport(fetchFn, { verifyToken: "shared-token" });
  const query = {
    "hub.mode": "subscribe",
    "hub.verify_token": "shared-token",
    "hub.challenge": "1158201444",
  };

  assert.equal(api.verifyChallenge(query), "1158201444");
  assert.equal(api.verifyChallenge({ ...query, "hub.verify_token": "guess" }), null);
  // Not configured: nothing to verify against, so refuse.
  assert.equal(transport(fetchFn).verifyChallenge(query), null);
});

test("construction refuses incomplete credentials", () => {
  assert.throws(() => new CloudApiTransport({ accessToken: "", phoneNumberId: PHONE_NUMBER_ID }));
  assert.throws(() => new CloudApiTransport({ accessToken: TOKEN, phoneNumberId: "" }));
});
