import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeSessionManager } from "../src/manager.js";
import type { SessionKey } from "../src/manager.js";
import { RealtimeStream } from "../src/realtime.js";
import type { TurnEvent } from "../src/types.js";
import { MockA2I, TEST_PARAMS, testConfig } from "./mockA2I.js";

const TRANSCRIPTS = [
  "the quick brown fox",
  "jumps over the lazy dog",
  "pack my box with five dozen",
  "five boxing wizards jump quickly",
];

function feedTurnPcm(stream: RealtimeStream): void {
  // A single 50ms PCM16 chunk (1600 bytes) is enough to trigger the mock Turn.
  stream.sendAudio(new Uint8Array(1600));
}

test("stress: 4 concurrent sessions route final Turns to their own (deviceId, channelId)", async () => {
  const servers: MockA2I[] = [];
  const manager = new RealtimeSessionManager(testConfig(), {
    maxConcurrent: 4,
    wsFactory: () => {
      const server = new MockA2I({ transcript: TRANSCRIPTS[servers.length] });
      servers.push(server);
      return server.socket;
    },
  });

  const received: Array<{ key: SessionKey; turn: TurnEvent }> = [];
  manager.on("turn", (key: SessionKey, turn: TurnEvent) => {
    received.push({ key, turn });
  });

  // Open four concurrent sessions keyed by (deviceId, channelId).
  const keys: SessionKey[] = [
    { deviceId: "dev-A", channelId: "cellular" },
    { deviceId: "dev-A", channelId: "whatsapp" },
    { deviceId: "dev-B", channelId: "cellular" },
    { deviceId: "dev-B", channelId: "whatsapp" },
  ];

  for (const key of keys) {
    await manager.open(key, { params: TEST_PARAMS });
  }
  assert.equal(manager.activeCount, 4, "all 4 sessions should be open concurrently");

  // Feeds each stream and triggers its own distinct final Turn.
  for (const key of keys) {
    const stream = manager.get(key);
    assert.ok(stream, `stream for ${key.deviceId}/${key.channelId} should exist`);
    feedTurnPcm(stream);
  }

  // Every session produced exactly one final Turn routed to its own handler.
  assert.equal(received.length, TRANSCRIPTS.length);

  // No cross-talk: channel-i must only ever see transcript-i.
  keys.forEach((key, i) => {
    const mine = received.filter(
      (r) => r.key.deviceId === key.deviceId && r.key.channelId === key.channelId,
    );
    assert.equal(
      mine.length,
      1,
      `session ${key.deviceId}/${key.channelId} should get exactly one Turn`,
    );
    assert.equal(mine[0]!.turn.transcript, TRANSCRIPTS[i]);
    assert.equal(mine[0]!.turn.final, true);

    const others = received.filter(
      (r) => !(r.key.deviceId === key.deviceId && r.key.channelId === key.channelId),
    );
    assert.ok(
      others.every((r) => r.turn.transcript !== TRANSCRIPTS[i]),
      `transcript ${i} must not leak to another session`,
    );
  });

  await manager.closeAll();
  assert.equal(manager.activeCount, 0);
});

test("concurrency bound queues excess opens until a slot frees", async () => {
  const servers: MockA2I[] = [];
  const manager = new RealtimeSessionManager(testConfig(), {
    maxConcurrent: 1,
    wsFactory: () => {
      const server = new MockA2I({ transcript: "queued session" });
      servers.push(server);
      return server.socket;
    },
  });

  const keyA: SessionKey = { deviceId: "dev-A", channelId: "one" };
  const keyB: SessionKey = { deviceId: "dev-A", channelId: "two" };

  // First open takes the only slot.
  await manager.open(keyA, { params: TEST_PARAMS });
  assert.equal(manager.queuedCount, 0);

  // The second open must queue, not throw, and not open yet.
  const openingB = manager.open(keyB, { params: TEST_PARAMS });
  assert.equal(manager.queuedCount, 1);
  assert.equal(manager.get(keyB), undefined, "B should not be open while queued");

  // Freeing A's slot drains the queue and lets B proceed.
  await manager.close(keyA);
  const streamB = await openingB;
  assert.ok(streamB, "queued open should resolve once a slot frees");
  assert.equal(manager.get(keyB), streamB);
  assert.equal(manager.queuedCount, 0);

  await manager.close(keyB);
  assert.equal(manager.activeCount, 0);
});

test("releasing one slot grants exactly one waiter, not the whole queue", async () => {
  // Regression (3009 concurrency over-limit): drainQueue used to be a
  // `while (sessions.size < maxConcurrent)` loop. A granted waiter adds its
  // session asynchronously (a later microtask), so sessions.size had not grown
  // yet when the loop ran — freeing ONE slot popped EVERY waiter and opened
  // them all, blowing past maxConcurrent. Each release maps to exactly one freed
  // slot, so it must pop at most one waiter.
  const servers: MockA2I[] = [];
  const manager = new RealtimeSessionManager(testConfig(), {
    maxConcurrent: 2,
    wsFactory: () => {
      const server = new MockA2I({ transcript: "granted" });
      servers.push(server);
      return server.socket;
    },
  });

  // Fill both slots.
  const keys: SessionKey[] = [
    { deviceId: "dev-A", channelId: "one" },
    { deviceId: "dev-A", channelId: "two" },
    { deviceId: "dev-A", channelId: "three" },
    { deviceId: "dev-A", channelId: "four" },
  ];
  await manager.open(keys[0]!, { params: TEST_PARAMS });
  await manager.open(keys[1]!, { params: TEST_PARAMS });
  assert.equal(manager.activeCount, 2);

  // Queue two waiters behind the full pool.
  const openingC = manager.open(keys[2]!, { params: TEST_PARAMS });
  const openingD = manager.open(keys[3]!, { params: TEST_PARAMS });
  assert.equal(manager.queuedCount, 2);
  assert.equal(manager.activeCount, 2, "no session may open while the pool is full");

  // Free ONE slot (A). Exactly one queued waiter may proceed to open; the pool
  // must never exceed maxConcurrent=2. A while-loop drain would let BOTH C and
  // D open here, pushing activeCount to 3.
  await manager.close(keys[0]!);
  assert.equal(manager.activeCount, 2, "freeing one slot must not exceed maxConcurrent");

  // Free another slot (B): the last waiter (now the only one) opens. Still 2.
  await manager.close(keys[1]!);
  assert.equal(manager.activeCount, 2, "pool stays bounded as waiters drain one at a time");

  // Both waiters eventually resolved.
  assert.ok(await openingC, "first waiter opened");
  assert.ok(await openingD, "second waiter opened");

  await manager.closeAll("test over");
  assert.equal(manager.activeCount, 0);
});

test("a session error with no subscriber does not crash the host process", async () => {
  // Node throws ERR_UNHANDLED_ERROR when an "error" event has no listener, so
  // an ordinary recoverable A2I failure must not be emitted unguarded — that
  // would take down whatever is hosting the manager (in production, the
  // Electron main process) purely because nobody subscribed.
  const server = new MockA2I();
  const manager = new RealtimeSessionManager(testConfig(), {
    wsFactory: () => server.socket,
  });
  const key: SessionKey = { deviceId: "SERIAL", channelId: "cellular" };
  const stream = await manager.open(key, { params: TEST_PARAMS });

  assert.equal(manager.listenerCount("error"), 0, "no subscriber, as in the failing case");
  assert.doesNotThrow(() => stream.emit("error", new Error("socket blew up")));

  await manager.closeAll("test over");
});

test("a subscribed error still reaches the listener with its session key", async () => {
  const server = new MockA2I();
  const manager = new RealtimeSessionManager(testConfig(), {
    wsFactory: () => server.socket,
  });
  const seen: Array<{ key: SessionKey; message: string }> = [];
  manager.on("error", (key: SessionKey, err: Error) => seen.push({ key, message: err.message }));

  const key: SessionKey = { deviceId: "SERIAL", channelId: "whatsapp" };
  const stream = await manager.open(key, { params: TEST_PARAMS });
  stream.emit("error", new Error("socket blew up"));

  assert.deepEqual(seen, [{ key, message: "socket blew up" }]);
  await manager.closeAll("test over");
});
