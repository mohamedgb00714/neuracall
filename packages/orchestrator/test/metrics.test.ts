import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Metrics } from "../src/metrics.js";
import type { CallRecord } from "../src/types.js";

const DEVICE = "192.168.1.44:5555";

/** A stand-in for the Orchestrator: the same events, none of the machinery. */
class FakeOrchestrator extends EventEmitter {
  startCall(callId: string): void {
    this.emit("state", callId, "incoming", "inbound cellular call detected");
  }

  endCall(callId: string, outcome: CallRecord["outcome"]): void {
    this.emit("state", callId, "ended", "call ended");
    this.emit("call", record(callId, { state: "ended", outcome }));
  }
}

function record(callId: string, over: Partial<CallRecord> = {}): CallRecord {
  return {
    callId,
    deviceId: DEVICE,
    channelId: "cellular",
    direction: "inbound",
    state: "talking",
    outcome: null,
    remoteParty: null,
    startedAt: 1000,
    answeredAt: 1100,
    endedAt: null,
    transcript: [],
    audioPath: null,
    states: [],
    ...over,
  };
}

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("counters start at zero and the snapshot is plain JSON", () => {
  const c = clock();
  const metrics = new Metrics({ now: c.now });
  const snap = metrics.snapshot();

  assert.equal(snap.uptimeMs, 0);
  assert.equal(snap.startedAt, c.now());
  assert.deepEqual(
    Object.values(snap.counters).filter((n) => n !== 0),
    [],
  );
  assert.deepEqual(snap.gauges, { activeCalls: 0, queuedSessions: 0 });
  // Round-trips: whatever the health endpoint serves is what was measured.
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test("uptime comes from the injected clock, never from the wall clock", () => {
  const c = clock();
  const metrics = new Metrics({ now: c.now, startedAt: c.now() - 5000 });
  c.advance(2500);

  const snap = metrics.snapshot();
  assert.equal(snap.uptimeMs, 7500);
});

test("attach counts calls, turns, barge-ins and errors from orchestrator events", () => {
  const orchestrator = new FakeOrchestrator();
  const metrics = new Metrics({ now: clock().now });
  metrics.attach(orchestrator);

  orchestrator.startCall("call-1");
  assert.equal(metrics.snapshot().gauges.activeCalls, 1);

  orchestrator.emit("transcript", "call-1", { speaker: "caller", text: "hello", at: 1 });
  orchestrator.emit("transcript", "call-1", { speaker: "agent", text: "hi there", at: 2 });
  orchestrator.emit("bargeIn", "call-1");
  orchestrator.emit("error", new Error("recording sink died"), "call-1");
  orchestrator.endCall("call-1", "completed");

  const snap = metrics.snapshot();
  assert.equal(snap.counters.callsStarted, 1);
  assert.equal(snap.counters.callsCompleted, 1);
  assert.equal(snap.counters.transcriptTurns, 2);
  assert.equal(snap.counters.agentReplies, 1);
  assert.equal(snap.counters.bargeIns, 1);
  assert.equal(snap.counters.errors, 1);
  assert.equal(snap.gauges.activeCalls, 0, "the gauge must drop when the call ends");
});

test("each outcome lands in its own counter and is counted exactly once", () => {
  const orchestrator = new FakeOrchestrator();
  const metrics = new Metrics({ now: clock().now });
  metrics.attach(orchestrator);

  orchestrator.startCall("a");
  orchestrator.endCall("a", "failed");
  orchestrator.startCall("b");
  orchestrator.endCall("b", "missed");
  orchestrator.startCall("c");
  orchestrator.endCall("c", "rejected");

  // A duplicate final record (a re-persist) must not inflate anything.
  orchestrator.emit("call", record("a", { state: "ended", outcome: "failed" }));

  const snap = metrics.snapshot();
  assert.equal(snap.counters.callsStarted, 3);
  assert.equal(snap.counters.callsFailed, 1);
  assert.equal(snap.counters.callsMissed, 1);
  assert.equal(snap.counters.callsRejected, 1);
  assert.equal(snap.counters.callsCompleted, 0);
  assert.equal(snap.gauges.activeCalls, 0);
});

test("in-progress records do not count as endings", () => {
  const orchestrator = new FakeOrchestrator();
  const metrics = new Metrics({ now: clock().now });
  metrics.attach(orchestrator);

  orchestrator.startCall("call-1");
  orchestrator.emit("call", record("call-1"));
  orchestrator.emit("call", record("call-1", { state: "talking" }));

  const snap = metrics.snapshot();
  assert.equal(snap.counters.callsCompleted, 0);
  assert.equal(snap.gauges.activeCalls, 1);
});

test("detaching stops the counting", () => {
  const orchestrator = new FakeOrchestrator();
  const metrics = new Metrics({ now: clock().now });
  const detach = metrics.attach(orchestrator);

  orchestrator.startCall("call-1");
  detach();
  // Node throws on an "error" with no listener, and detaching removed the only
  // one metrics had installed.
  orchestrator.on("error", () => undefined);
  orchestrator.emit("bargeIn", "call-1");
  orchestrator.emit("error", new Error("ignored"));

  const snap = metrics.snapshot();
  assert.equal(snap.counters.callsStarted, 1);
  assert.equal(snap.counters.bargeIns, 0);
  assert.equal(snap.counters.errors, 0);
  assert.equal(orchestrator.listenerCount("state"), 0);
});

test("counters are monotonic: a negative delta is ignored", () => {
  const metrics = new Metrics({ now: clock().now });
  metrics.increment("errors", 3);
  metrics.increment("errors", -5);
  assert.equal(metrics.snapshot().counters.errors, 3);
});

test("instrumentSessions counts opens and closes around a real manager", async () => {
  const metrics = new Metrics({ now: clock().now });
  const closed: Array<{ deviceId: string; channelId: string }> = [];
  const sessions = metrics.instrumentSessions({
    open: async (key: { deviceId: string; channelId: string }, _opts: { params: unknown }) => ({
      key,
    }),
    close: async (key: { deviceId: string; channelId: string }) => {
      closed.push(key);
    },
  });

  await sessions.open({ deviceId: DEVICE, channelId: "cellular" }, { params: {} });
  await sessions.close({ deviceId: DEVICE, channelId: "cellular" }, "call ended");

  const snap = metrics.snapshot();
  assert.equal(snap.counters.sttSessionsOpened, 1);
  assert.equal(snap.counters.sttSessionsClosed, 1);
  assert.deepEqual(closed, [{ deviceId: DEVICE, channelId: "cellular" }]);
});

test("a close that throws is still counted, and still propagates", async () => {
  const metrics = new Metrics({ now: clock().now });
  const sessions = metrics.instrumentSessions({
    open: async () => ({}),
    close: async () => {
      throw new Error("socket already gone");
    },
  });

  await assert.rejects(() => sessions.close({}, "call ended"), /socket already gone/);
  // Opened vs closed is how an operator spots a leaked session; a failed
  // Terminate must not silently widen that gap.
  assert.equal(metrics.snapshot().counters.sttSessionsClosed, 1);
});

test("a bound gauge is read at snapshot time, and a throwing one is survivable", () => {
  const metrics = new Metrics({ now: clock().now });
  let queued = 0;
  metrics.bindGauge("queuedSessions", () => queued);
  assert.equal(metrics.snapshot().gauges.queuedSessions, 0);

  queued = 4;
  assert.equal(metrics.snapshot().gauges.queuedSessions, 4);

  metrics.setGauge("activeCalls", 2);
  metrics.bindGauge("activeCalls", () => {
    throw new Error("manager exploded");
  });
  assert.equal(metrics.snapshot().gauges.activeCalls, 2, "falls back to the stored value");
});
