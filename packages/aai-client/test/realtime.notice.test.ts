import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeStream } from "../src/realtime.js";
import { RealtimeSessionManager, type SessionKey } from "../src/manager.js";
import { MockA2I, testConfig, TEST_PARAMS } from "./mockA2I.js";

function openStream(server: MockA2I): RealtimeStream {
  return new RealtimeStream(testConfig(), TEST_PARAMS, {
    wsFactory: () => server.socket,
  });
}

// A consumer that never subscribes to "error" must not be crashed by
// recoverable protocol noise: non-JSON frames arrive as a `notice` event
// carrying the diagnostic, and the emitter never throws.

test("a consumer with NO error listener gets recoverable non-JSON frames as notice, without throwing", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const notices: Error[] = [];
  stream.on("notice", (e: Error) => notices.push(e));
  await stream.connect();

  assert.equal(stream.listenerCount("error"), 0, "no error listener, as in the crash case");
  assert.doesNotThrow(() => server.socket.emit("message", "definitely-not-json"));

  assert.equal(notices.length, 1, "the diagnostic must be delivered on notice");
  assert.match(notices[0]!.message, /non-JSON/i);
  assert.equal(stream.state, "open", "the stream survives recoverable noise");
});

test("a consumer with NO error listener gets unknown server types as notice, without throwing", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const notices: Error[] = [];
  stream.on("notice", (e: Error) => notices.push(e));
  await stream.connect();

  assert.equal(stream.listenerCount("error"), 0);
  assert.doesNotThrow(() => server.sendToClient({ type: "BloopFrobnicate" }));

  assert.equal(notices.length, 1);
  assert.match(notices[0]!.message, /Unknown server message type: BloopFrobnicate/);
});

test("a consumer with NO error listener gets a 3007 recovery as notice, without throwing", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const notices: Error[] = [];
  stream.on("notice", (e: Error) => notices.push(e));
  await stream.connect();

  assert.equal(stream.listenerCount("error"), 0);
  assert.doesNotThrow(() => server.socket.emulateServerClose(3007));

  assert.equal(notices.length, 1);
  assert.match(notices[0]!.message, /chunk size corrected/i);
  assert.ok(stream.chunkSizeBytes > 0);
  assert.equal(stream.state, "closed");
});

// Irrecoverable failures still emit "error" for consumers that listen.

test("an irrecoverable server Error frame still emits error to listeners", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const errors: Error[] = [];
  stream.on("error", (e: Error) => errors.push(e));
  await stream.connect();

  server.sendToClient({ type: "Error", error_code: 4001, error: "invalid_mode: moonlight" });

  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /Realtime server error 4001/);
  assert.equal((errors[0] as { errorCode?: number }).errorCode, 4001);
});

test("irrecoverable close codes (1008/3008/3005/3006/3009) still emit error to listeners", async () => {
  const codes = [1008, 3008, 3005, 3006, 3009];
  for (const code of codes) {
    const server = new MockA2I();
    const stream = openStream(server);
    const errors: Error[] = [];
    stream.on("error", (e: Error) => errors.push(e));
    await stream.connect();

    server.socket.emulateServerClose(code);

    assert.equal(errors.length, 1, `close code ${code} must emit a typed error`);
    assert.equal(stream.state, "closed");
  }
});

// The manager forwards notices with the session key, mirroring warn.

test("the manager forwards stream notices with the session key", async () => {
  const server = new MockA2I();
  const manager = new RealtimeSessionManager(testConfig(), {
    wsFactory: () => server.socket,
  });
  const key: SessionKey = { deviceId: "SERIAL", channelId: "cellular" };
  const stream = await manager.open(key, { params: TEST_PARAMS });

  const seen: Array<{ key: SessionKey; message: string }> = [];
  manager.on("notice", (k: SessionKey, e: Error) => seen.push({ key: k, message: e.message }));

  assert.doesNotThrow(() => server.socket.emit("message", "definitely-not-json"));

  assert.deepEqual(seen, [
    { key, message: "Received non-JSON message from server." },
  ]);

  await manager.closeAll("test over");
});