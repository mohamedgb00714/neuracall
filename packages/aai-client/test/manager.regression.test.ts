import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RealtimeSessionManager } from "../src/manager.js";
import type { SessionKey } from "../src/manager.js";
import type { WsLike } from "../src/realtime.js";
import { MockA2I, TEST_PARAMS, WS_STATE, testConfig } from "./mockA2I.js";
import type { HeartbeatMessage, LLMGatewayResponseMessage } from "../src/types.js";

/** A socket that never opens, never errors, never closes: connect() hangs on it. */
class NeverOpeningSocket extends EventEmitter {
  readyState: number = WS_STATE.CONNECTING;
  send(): void {}
  close(): void {
    this.readyState = WS_STATE.CLOSING;
  }
  terminate(): void {
    this.readyState = WS_STATE.CLOSED;
  }
}

/** A socket that answers the handshake with `error`, rejecting connect(). */
class RefusingSocket extends EventEmitter {
  readyState: number = WS_STATE.CONNECTING;

  constructor() {
    super();
    // Deferred so RealtimeStream has attached its onError listener first.
    setImmediate(() => {
      if (this.readyState === WS_STATE.CONNECTING) {
        this.emit("error", new Error("handshake refused"));
      }
    });
  }

  send(): void {}
  close(): void {
    this.readyState = WS_STATE.CLOSED;
  }
  terminate(): void {
    this.readyState = WS_STATE.CLOSED;
  }
}

test("open() releases the concurrency slot when connect() rejects, so a later key is not stuck queued", async () => {
  let calls = 0;
  const manager = new RealtimeSessionManager(testConfig(), {
    maxConcurrent: 1,
    wsFactory: () => {
      calls += 1;
      return calls === 1 ? new RefusingSocket() : new MockA2I().socket;
    },
  });

  const keyA: SessionKey = { deviceId: "SERIAL", channelId: "cellular" };
  const keyB: SessionKey = { deviceId: "SERIAL", channelId: "whatsapp" };

  // The only slot is acquired, then the handshake fails: the slot must be
  // returned, otherwise every later call queues forever behind a ghost session.
  await assert.rejects(manager.open(keyA, { params: TEST_PARAMS }), /handshake refused/);
  assert.equal(manager.activeCount, 0, "a rejected connect must not leave a phantom session");

  const streamB = await manager.open(keyB, { params: TEST_PARAMS });
  assert.equal(manager.get(keyB), streamB, "the freed slot lets a different key open");
  assert.equal(manager.queuedCount, 0);

  await manager.close(keyB);
  assert.equal(manager.activeCount, 0);
});

test("open() releases the slot when the post-acquire duplicate check throws", async () => {
  const neverA = new NeverOpeningSocket();
  const mockB = new MockA2I().socket;
  const sockets: WsLike[] = [neverA, mockB];
  const manager = new RealtimeSessionManager(testConfig(), {
    maxConcurrent: 2,
    wsFactory: () => {
      const socket = sockets.shift();
      assert.ok(socket, "wsFactory ran out of sockets");
      return socket;
    },
  });

  const keyA: SessionKey = { deviceId: "dupe", channelId: "a" };
  const keyB: SessionKey = { deviceId: "dupe", channelId: "b" };
  const keyX: SessionKey = { deviceId: "dupe", channelId: "x" };
  const keyY: SessionKey = { deviceId: "dupe", channelId: "y" };
  const keyZ: SessionKey = { deviceId: "dupe", channelId: "z" };

  // Slot 1: keyA's session is registered but its connect never settles.
  const openingA = manager.open(keyA, { params: TEST_PARAMS });
  openingA.catch(() => {});
  // Slot 2: keyB opens normally.
  await manager.open(keyB, { params: TEST_PARAMS });
  assert.equal(manager.activeCount, 2);

  // Both slots are taken, so an open for a FRESH key queues instead of
  // tripping the early dup check (keyX is not in the sessions map yet).
  const openingX1 = manager.open(keyX, { params: TEST_PARAMS });
  const openingX2 = manager.open(keyX, { params: TEST_PARAMS });
  assert.equal(manager.queuedCount, 2);

  // Push the socket keyX will eventually connect with, then free slot 2:
  // keyX1 drains, registers its session and starts a connect that never
  // settles — the freed slot is now held by keyX.
  sockets.push(new NeverOpeningSocket());
  await manager.close(keyB);
  // The granted waiter adds its session in a later microtask; a couple of
  // turns settle it before we assert.
  for (let i = 0; i < 4 && !manager.isOpen(keyX); i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  // Note: queuedCount undercounts in this window (releaseSlot and drainQueue
  // each decrement), so the regression is asserted on behavior — the slot was
  // granted and keyX1 holds it — not the counter.
  assert.ok(manager.isOpen(keyX), "keyX1 holds the freed slot");

  // Free slot 1: keyX2 acquires it, finds keyX already in the map, and the
  // post-acquire dup check throws — the slot it just took must go back.
  await manager.close(keyA);
  await assert.rejects(openingX2, /Session already open for dupe\/x/);

  assert.equal(manager.activeCount, 0, "the dup-check throw must not leak the session");

  // Two fresh keys open immediately afterwards: the returned slot really went
  // back to the pool.
  sockets.push(new MockA2I().socket, new MockA2I().socket);
  const streamY = await manager.open(keyY, { params: TEST_PARAMS });
  assert.equal(manager.get(keyY), streamY);
  const streamZ = await manager.open(keyZ, { params: TEST_PARAMS });
  assert.equal(manager.get(keyZ), streamZ);
  await manager.close(keyY);
  await manager.close(keyZ);
});

test("manager re-emits llmGatewayResponse and heartbeat with (key, msg)", async () => {
  const server = new MockA2I();
  const manager = new RealtimeSessionManager(testConfig(), {
    wsFactory: () => server.socket,
  });
  const key: SessionKey = { deviceId: "SERIAL", channelId: "cellular" };
  const llm: Array<[SessionKey, LLMGatewayResponseMessage]> = [];
  const beats: Array<[SessionKey, HeartbeatMessage]> = [];
  manager.on("llmGatewayResponse", (k: SessionKey, m: LLMGatewayResponseMessage) =>
    llm.push([k, m]),
  );
  manager.on("heartbeat", (k: SessionKey, m: HeartbeatMessage) => beats.push([k, m]));

  await manager.open(key, { params: TEST_PARAMS });

  const gateway: LLMGatewayResponseMessage = {
    type: "LLMGatewayResponse",
    turn_order: 2,
    transcript: "Book the table for four.",
    data: { tool_calls: ["create_booking"] },
  };
  const heartbeat: HeartbeatMessage = {
    type: "Heartbeat",
    total_audio_received_ms: 4321,
    total_duration_ms: 9000,
    realtime_factor: 0.52,
    max_speech_probability: 0.9,
  };
  server.sendToClient(gateway);
  server.sendToClient(heartbeat);

  // The manager prefixes each forwarded stream event with the session key so
  // callers can route by (deviceId, channelId) without holding the stream.
  assert.equal(llm.length, 1);
  assert.deepEqual(llm[0], [key, gateway]);
  assert.equal(beats.length, 1);
  assert.deepEqual(beats[0], [key, heartbeat]);

  await manager.closeAll("test over");
});