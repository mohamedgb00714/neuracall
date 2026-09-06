import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeStream } from "../src/realtime.js";
import { MockA2I, testConfig, TEST_PARAMS } from "./mockA2I.js";

function openStream(server: MockA2I): RealtimeStream {
  return new RealtimeStream(testConfig(), TEST_PARAMS, {
    wsFactory: () => server.socket,
  });
}

test("updateConfiguration sends UpdateConfiguration with agent_context and keyterms_prompt", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  await stream.connect();

  // Bias the next user turn with the agent's last reply + domain terms.
  stream.updateConfiguration({
    agent_context: "Your account number is 4829-1107. How else can I help?",
    keyterms_prompt: ["ACME", "SKU-4829", "Priya"],
  });

  const wire = server.sent
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m) as Record<string, unknown>);

  const msg = wire.find((m) => m.type === "UpdateConfiguration");
  assert.ok(msg, "expected an UpdateConfiguration control message on the wire");
  assert.equal(msg.agent_context, "Your account number is 4829-1107. How else can I help?");
  assert.deepEqual(msg.keyterms_prompt, ["ACME", "SKU-4829", "Priya"]);
});

test("updateConfiguration can push just an agent_context mid-session", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  await stream.connect();

  stream.updateConfiguration({ agent_context: "Repeat the tracking number: 778-334." });

  const wire = server.sent
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m) as Record<string, unknown>);
  const msg = wire.find((m) => m.type === "UpdateConfiguration");
  assert.ok(msg);
  assert.equal(msg.agent_context, "Repeat the tracking number: 778-334.");
  assert.equal(msg.keyterms_prompt, undefined);
});

test("updateConfiguration is rejected when the stream is not open", () => {
  const server = new MockA2I();
  const stream = openStream(server);
  assert.throws(() => stream.updateConfiguration({ agent_context: "hi" }), /not open/);
});

test("updateConfiguration serializes mode, threshold, language_codes and session_heartbeat in one frame", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  await stream.connect();

  // These fields were previously hidden from the type; each one must reach the
  // wire verbatim under its documented UpdateConfiguration field name.
  stream.updateConfiguration({
    mode: "max_accuracy",
    end_of_turn_confidence_threshold: 0.6,
    language_codes: ["en", "fr"],
    session_heartbeat: true,
  });

  const wire = server.sent
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m) as Record<string, unknown>);
  const updates = wire.filter((m) => m["type"] === "UpdateConfiguration");

  assert.equal(updates.length, 1, "everything ships in a single UpdateConfiguration text frame");
  assert.deepEqual(updates[0]!, {
    type: "UpdateConfiguration",
    mode: "max_accuracy",
    end_of_turn_confidence_threshold: 0.6,
    language_codes: ["en", "fr"],
    session_heartbeat: true,
  });
});
