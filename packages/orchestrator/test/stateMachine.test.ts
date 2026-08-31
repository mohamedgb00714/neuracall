import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_STATES, CallStateMachine } from "../src/stateMachine.js";

test("a call walks the full happy path", () => {
  let clock = 1000;
  const m = new CallStateMachine({ now: () => (clock += 10) });

  assert.equal(m.state, "idle");
  m.to("incoming", "cellular ring");
  m.to("answered");
  m.to("talking");
  m.to("ended", "far end hung up");

  assert.deepEqual(m.visited, [...CALL_STATES]);
  assert.equal(m.isEnded, true);
  assert.equal(m.history.length, 4);
  assert.equal(m.history[0]!.reason, "cellular ring");
  assert.ok(m.enteredAt("answered")! < m.enteredAt("ended")!);
  assert.equal(m.enteredAt("idle"), undefined, "never transitioned *into* idle");
});

test("every state can bail straight to ended", () => {
  for (const from of ["idle", "incoming", "answered", "talking"] as const) {
    const m = new CallStateMachine({ initial: from });
    assert.equal(m.can("ended"), true, `${from} must be able to end`);
    m.to("ended", "failure");
    assert.equal(m.state, "ended");
  }
});

test("illegal transitions throw rather than corrupt the call", () => {
  const m = new CallStateMachine();
  // Cannot answer a call that was never ringing.
  assert.throws(() => m.to("answered"), /Illegal call transition idle -> answered/);
  // Cannot skip answering.
  m.to("incoming");
  assert.throws(() => m.to("talking"), /Illegal call transition incoming -> talking/);
  // Cannot go backwards.
  m.to("answered");
  assert.throws(() => m.to("incoming"), /Illegal call transition answered -> incoming/);
  assert.equal(m.state, "answered", "a rejected transition leaves the state alone");
});

test("ended is terminal", () => {
  const m = new CallStateMachine();
  m.to("ended");
  for (const state of CALL_STATES) {
    assert.equal(m.can(state), false, `nothing may follow ended, got ${state}`);
  }
  assert.throws(() => m.to("incoming"), /Legal from ended: \(none\)/);
});

test("end() is idempotent so double teardown is harmless", () => {
  const m = new CallStateMachine();
  m.to("incoming");
  assert.equal(m.end("hangup"), true);
  assert.equal(m.end("hangup again"), false);
  assert.equal(m.history.filter((t) => t.to === "ended").length, 1);
});

test("transitions are announced per-state and in aggregate", () => {
  const m = new CallStateMachine();
  const seen: string[] = [];
  m.on("transition", (t: { to: string }) => seen.push(`transition:${t.to}`));
  m.on("answered", () => seen.push("answered"));

  m.to("incoming");
  m.to("answered");

  assert.deepEqual(seen, ["transition:incoming", "transition:answered", "answered"]);
});
