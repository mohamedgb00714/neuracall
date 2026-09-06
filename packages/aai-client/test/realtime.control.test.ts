import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeStream } from "../src/realtime.js";
import { MockA2I, testConfig, TEST_PARAMS } from "./mockA2I.js";

function openStream(server: MockA2I): RealtimeStream {
  return new RealtimeStream(testConfig(), TEST_PARAMS, {
    wsFactory: () => server.socket,
  });
}

/** Every JSON text frame the client sent, parsed. */
function wireFrames(server: MockA2I): Array<Record<string, unknown>> {
  return server.sent
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m) as Record<string, unknown>);
}

test("forceEndpoint serializes { type: 'ForceEndpoint' } on the wire", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  await stream.connect();

  stream.forceEndpoint();

  assert.deepEqual(wireFrames(server).find((m) => m.type === "ForceEndpoint"), {
    type: "ForceEndpoint",
  });
});

test("keepAlive serializes { type: 'KeepAlive' } on the wire", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  await stream.connect();

  stream.keepAlive();

  assert.deepEqual(wireFrames(server).find((m) => m.type === "KeepAlive"), {
    type: "KeepAlive",
  });
});

test("forceEndpoint and keepAlive are rejected when the stream is not open", () => {
  const server = new MockA2I();
  const stream = openStream(server);

  assert.throws(() => stream.forceEndpoint(), /not open/);
  assert.throws(() => stream.keepAlive(), /not open/);
});