import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Metrics } from "../src/metrics.js";
import { Watchdog, type SessionRegistry, type WatchdogTeardown } from "../src/watchdog.js";
import type { CallOutcome, CallRecord } from "../src/types.js";

const DEVICE = "192.168.1.44:5555";
const MINUTE = 60_000;
const START = 1_700_000_000_000;

/** A clock the test moves by hand: no real time passes anywhere in this file. */
class TestClock {
  private t = START;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * The orchestrator surface the watchdog observes, with an `endCall` that
 * behaves like the real one: the call leaves `activeCalls`.
 */
class FakeOrchestrator extends EventEmitter {
  readonly calls = new Map<string, CallRecord>();
  readonly ended: Array<{ callId: string; outcome: CallOutcome; reason: string }> = [];

  constructor(private readonly clock: TestClock) {
    super();
  }

  get activeCalls(): CallRecord[] {
    return [...this.calls.values()].map((r) => ({ ...r }));
  }

  endCall(callId: string, outcome: CallOutcome, reason: string): void {
    this.ended.push({ callId, outcome, reason });
    this.calls.delete(callId);
  }

  begin(callId: string, over: Partial<CallRecord> = {}): CallRecord {
    const at = this.clock.now();
    const rec: CallRecord = {
      callId,
      deviceId: DEVICE,
      channelId: "cellular",
      direction: "inbound",
      state: "talking",
      outcome: null,
      remoteParty: null,
      startedAt: at,
      answeredAt: at,
      endedAt: null,
      transcript: [],
      audioPath: null,
      states: [],
      ...over,
    };
    this.calls.set(callId, rec);
    return rec;
  }

  /** The caller said something: the watchdog sees this as a sign of life. */
  speak(callId: string, text: string): void {
    const rec = this.calls.get(callId);
    rec?.transcript.push({ speaker: "caller", text, at: this.clock.now() });
    this.emit("transcript", callId, { speaker: "caller", text, at: this.clock.now() });
  }
}

/** A session manager whose `close` is the only thing that sends Terminate. */
class FakeSessions implements SessionRegistry {
  private readonly open = new Set<string>();
  readonly terminated: Array<{ key: { deviceId: string; channelId: string }; reason?: string }> =
    [];
  closeError: Error | null = null;

  add(deviceId: string, channelId: string): void {
    this.open.add(`${deviceId}::${channelId}`);
  }

  get keys(): Array<{ deviceId: string; channelId: string }> {
    return [...this.open].map((k) => {
      const [deviceId, channelId] = k.split("::");
      return { deviceId: deviceId ?? "", channelId: channelId ?? "" };
    });
  }

  async close(key: { deviceId: string; channelId: string }, reason?: string): Promise<void> {
    if (this.closeError) throw this.closeError;
    this.open.delete(`${key.deviceId}::${key.channelId}`);
    this.terminated.push({ key, ...(reason !== undefined ? { reason } : {}) });
  }
}

interface Harness {
  clock: TestClock;
  orchestrator: FakeOrchestrator;
  sessions: FakeSessions;
  metrics: Metrics;
  watchdog: Watchdog;
  teardowns: WatchdogTeardown[];
  errors: Error[];
}

function harness(
  opts: { maxCallMs?: number; stallMs?: number; strayGraceMs?: number } = {},
): Harness {
  const clock = new TestClock();
  const orchestrator = new FakeOrchestrator(clock);
  const sessions = new FakeSessions();
  const metrics = new Metrics({ now: clock.now });
  const teardowns: WatchdogTeardown[] = [];
  const errors: Error[] = [];

  const watchdog = new Watchdog({
    orchestrator,
    sessions,
    metrics,
    now: clock.now,
    maxCallMs: opts.maxCallMs ?? 10 * MINUTE,
    stallMs: opts.stallMs ?? 2 * MINUTE,
    ...(opts.strayGraceMs !== undefined ? { strayGraceMs: opts.strayGraceMs } : {}),
    onTeardown: (t) => teardowns.push(t),
    onError: (err) => errors.push(err),
  });

  return { clock, orchestrator, sessions, metrics, watchdog, teardowns, errors };
}

test("a call that overruns is torn down and the device freed", async () => {
  const h = harness({ maxCallMs: 10 * MINUTE, stallMs: 60 * MINUTE });
  h.orchestrator.begin("wedged");
  h.sessions.add(DEVICE, "cellular");

  h.clock.advance(9 * MINUTE);
  assert.deepEqual(await h.watchdog.tick(), [], "a long but legal call is left alone");

  h.clock.advance(2 * MINUTE);
  const torn = await h.watchdog.tick();

  assert.equal(torn.length, 1);
  assert.equal(torn[0]!.kind, "overrun");
  assert.equal(torn[0]!.callId, "wedged");
  assert.equal(torn[0]!.deviceId, DEVICE);
  assert.match(torn[0]!.reason, /exceeded 600000 ms/);
  assert.deepEqual(h.orchestrator.ended, [
    { callId: "wedged", outcome: "failed", reason: torn[0]!.reason },
  ]);
  assert.equal(h.metrics.snapshot().counters.watchdogTeardowns, 1);
  assert.deepEqual(h.teardowns, torn);
});

test("a call whose audio died silently is torn down after stallMs", async () => {
  const h = harness({ stallMs: 2 * MINUTE });
  h.orchestrator.begin("stalled");

  h.clock.advance(30_000);
  h.orchestrator.speak("stalled", "are you still there?");

  h.clock.advance(MINUTE);
  assert.deepEqual(await h.watchdog.tick(), [], "a minute of thinking is not a stall");

  // Capture dies here: nothing else is ever transcribed.
  h.clock.advance(2 * MINUTE);
  const torn = await h.watchdog.tick();

  assert.equal(torn.length, 1);
  assert.equal(torn[0]!.kind, "stall");
  assert.equal(torn[0]!.ageMs, 3 * MINUTE);
  assert.match(torn[0]!.reason, /no transcript activity/);
  assert.equal(h.orchestrator.ended[0]?.outcome, "failed");
});

test("a healthy talkative call is never touched", async () => {
  const h = harness({ stallMs: 2 * MINUTE, maxCallMs: 30 * MINUTE });
  h.orchestrator.begin("healthy");
  h.sessions.add(DEVICE, "cellular");

  for (let i = 0; i < 10; i++) {
    h.clock.advance(MINUTE);
    h.orchestrator.speak("healthy", `turn ${i}`);
    assert.deepEqual(await h.watchdog.tick(), [], `swept away a live call on turn ${i}`);
  }

  assert.deepEqual(h.orchestrator.ended, []);
  assert.deepEqual(h.sessions.terminated, [], "the call's own session must survive");
  assert.equal(h.metrics.snapshot().counters.watchdogTeardowns, 0);
});

test("a still-ringing call is exempt from the stall check but not from maxCallMs", async () => {
  const h = harness({ stallMs: MINUTE, maxCallMs: 5 * MINUTE });
  h.orchestrator.begin("ringing", { state: "incoming", answeredAt: null });

  h.clock.advance(3 * MINUTE);
  assert.deepEqual(await h.watchdog.tick(), [], "an unanswered call has nothing to transcribe");

  h.clock.advance(3 * MINUTE);
  const torn = await h.watchdog.tick();
  assert.equal(torn[0]?.kind, "overrun");
});

test("a stray session with no call behind it is Terminated", async () => {
  const h = harness();
  // A crash between opening the session and registering the call, or a
  // teardown that never finished: the meter is running with nobody on the line.
  h.sessions.add("192.168.1.99:5555", "whatsapp");
  h.orchestrator.begin("live");
  h.sessions.add(DEVICE, "cellular");

  h.clock.advance(1000);
  const torn = await h.watchdog.tick();

  assert.equal(torn.length, 1);
  assert.equal(torn[0]!.kind, "stray-session");
  assert.equal(torn[0]!.deviceId, "192.168.1.99:5555");
  assert.equal(torn[0]!.channelId, "whatsapp");

  // close() is the manager call that sends Terminate; a session merely dropped
  // keeps billing wall-clock to the 3-hour cap.
  assert.deepEqual(h.sessions.terminated, [
    {
      key: { deviceId: "192.168.1.99:5555", channelId: "whatsapp" },
      reason: "realtime session with no active call",
    },
  ]);
  assert.deepEqual(h.sessions.keys, [{ deviceId: DEVICE, channelId: "cellular" }]);
  assert.equal(h.metrics.snapshot().counters.watchdogTeardowns, 1);
  assert.deepEqual(h.orchestrator.ended, [], "the live call was not collateral damage");
});

test("the session of a call the watchdog just ended is swept on the next pass", async () => {
  const h = harness({ maxCallMs: MINUTE });
  h.orchestrator.begin("wedged");
  h.sessions.add(DEVICE, "cellular");

  h.clock.advance(2 * MINUTE);
  // The call is torn down first; its session is still open in the same sweep,
  // but the call was still active when the sweep started, so it is spared.
  const first = await h.watchdog.tick();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind, "overrun");
  assert.deepEqual(h.sessions.terminated, []);

  // On the next pass nothing owns it any more.
  const second = await h.watchdog.tick();
  assert.equal(second.length, 1);
  assert.equal(second[0]!.kind, "stray-session");
  assert.equal(h.sessions.terminated.length, 1);
});

test("strayGraceMs delays the sweep until a session has looked stray twice", async () => {
  const h = harness({ strayGraceMs: 30_000 });
  h.sessions.add(DEVICE, "cellular");

  assert.deepEqual(await h.watchdog.tick(), [], "grace period not elapsed");
  assert.deepEqual(h.sessions.terminated, []);

  h.clock.advance(30_000);
  const torn = await h.watchdog.tick();
  assert.equal(torn[0]?.kind, "stray-session");
  assert.equal(torn[0]?.ageMs, 30_000);
  assert.equal(h.sessions.terminated.length, 1);
});

test("a session that reacquires a call before the grace elapses is spared", async () => {
  const h = harness({ strayGraceMs: 30_000 });
  h.sessions.add(DEVICE, "cellular");
  await h.watchdog.tick();

  h.orchestrator.begin("late");
  h.clock.advance(60_000);
  assert.deepEqual(await h.watchdog.tick(), []);
  assert.deepEqual(h.sessions.terminated, []);
});

test("a close that fails is reported, not thrown, and is retried next sweep", async () => {
  const h = harness();
  h.sessions.add(DEVICE, "cellular");
  h.sessions.closeError = new Error("websocket already destroyed");

  await h.watchdog.tick();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!.message, /websocket already destroyed/);

  h.sessions.closeError = null;
  await h.watchdog.tick();
  assert.equal(h.sessions.terminated.length, 1, "the stray must not be abandoned");
});

test("a call is only asked to end once, however slow its teardown is", async () => {
  const h = harness({ maxCallMs: MINUTE });
  h.orchestrator.begin("stuck");
  // A call that ignores endCall, as one stuck inside a teardown step would:
  // it stays in activeCalls and is offered to every later sweep.
  h.orchestrator.endCall = (callId, outcome, reason) => {
    h.orchestrator.ended.push({ callId, outcome, reason });
  };

  h.clock.advance(2 * MINUTE);
  await h.watchdog.tick();
  h.clock.advance(2 * MINUTE);
  await h.watchdog.tick();

  assert.equal(h.orchestrator.ended.length, 1);
  assert.equal(h.metrics.snapshot().counters.watchdogTeardowns, 1);
});

test("start() and stop() drive the sweep through injected timers only", async () => {
  const h = harness({ maxCallMs: MINUTE });
  const scheduled: { fire: (() => void) | null; cleared: number } = { fire: null, cleared: 0 };
  const watchdog = new Watchdog({
    orchestrator: h.orchestrator,
    sessions: h.sessions,
    now: h.clock.now,
    maxCallMs: MINUTE,
    intervalMs: 5000,
    scheduler: {
      setInterval: (fn) => {
        scheduled.fire = fn;
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {
        scheduled.cleared += 1;
      },
    },
  });

  watchdog.start();
  watchdog.start(); // idempotent
  assert.ok(scheduled.fire, "start() must schedule through the injected scheduler");

  h.orchestrator.begin("wedged");
  h.clock.advance(2 * MINUTE);
  scheduled.fire?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.orchestrator.ended.length, 1);

  watchdog.stop();
  assert.equal(scheduled.cleared, 1);
  assert.equal(h.orchestrator.listenerCount("transcript"), 1, "only the harness watchdog remains");
});
