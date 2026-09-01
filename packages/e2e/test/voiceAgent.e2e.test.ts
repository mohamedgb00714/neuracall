/**
 * The Voice Agent pipeline, driven through the real orchestrator.
 *
 * The bridge is unit-tested against a fake session, but that proves only that
 * the bridge behaves. What matters here is the seam: the orchestrator was
 * written for STT-then-LLM-then-TTS, and the Voice Agent inverts who decides
 * when to speak. If the adapter is wrong the call still "works" in ways that
 * are hard to see — a transcript missing the agent's half, audio that never
 * reaches the transport, a turn loop that stalls waiting for a reply that has
 * already been and gone.
 *
 * Everything here is the real thing except the handset, scrcpy and the socket.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHarness, DEFAULT_ENDPOINT } from "../src/harness.js";

test("e2e: a call runs end to end on the Voice Agent, with no LLM and no TTS", async () => {
  const h = buildHarness({
    voiceAgent: {
      greeting: "Thanks for calling NeuraCall.",
      replies: ["Certainly, what time would suit you?", "Booked. See you then."],
    },
  });

  await h.refresh();
  h.phone.ringCellular();
  const call = h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");

  await h.waitFor(() => h.phone.callState === "offhook", "the phone to be answered");
  await h.waitFor(() => h.voiceAgent !== null && h.voiceAgent.sessions.length === 1, "a session");
  const session = h.voiceAgent!.latest;
  assert.equal(session.connected, true);

  // The greeting is spoken by the service without being asked, and has to reach
  // the transcript even though nothing in the orchestrator requested it.
  await h.waitFor(() => h.injected.bytes > 0, "the greeting to reach the transport");

  // Far-end audio flows through the real capture pipeline and out the bridge,
  // resampled on the way: the service accepts 24 kHz and nothing else.
  await h.waitFor(() => h.capture.sink !== null, "capture to start");
  h.capture.speak(500);
  await h.waitFor(() => session.receivedBytes > 0, "caller audio to reach the service");

  // Two caller turns, two replies.
  session.callerSaid("I'd like to book a table for two");
  await h.waitFor(
    () => h.injected.writes.length >= 2,
    "the agent's first answer to reach the transport",
  );
  session.callerSaid("Eight o'clock");

  h.phone.remoteHangUp();
  h.orchestrator.endCall(h.store.all[0]?.callId ?? "", "completed", "far end hung up");
  const record = await h.finish(call);

  // The transcript must carry BOTH halves. The agent's lines never pass through
  // the orchestrator's TTS path on this pipeline, so if the adapter returned
  // nothing they would be silently missing while the call looked fine.
  const caller = record.transcript.filter((t) => t.speaker === "caller").map((t) => t.text);
  const agent = record.transcript.filter((t) => t.speaker === "agent").map((t) => t.text);

  assert.deepEqual(caller, ["I'd like to book a table for two", "Eight o'clock"]);
  assert.deepEqual(agent, [
    "Thanks for calling NeuraCall.",
    "Certainly, what time would suit you?",
    "Booked. See you then.",
  ]);
  assert.equal(record.state, "ended");

  // No LLM and no TTS were configured or used — the whole point of this path.
  assert.equal(h.llm.prompts.length, 0, "the composed LLM must not be involved");
  assert.ok(h.injected.bytes > 0, "the caller would have heard the agent");
  assert.deepEqual(h.errors, []);
});

test("e2e: turn order increases per caller turn, so transcript entries do not collide", async () => {
  // The Voice Agent has no turn_order of its own — it is a Universal-Streaming
  // field — and the orchestrator stores one on every entry. A constant would
  // make every caller turn look like a repeat of the first.
  const h = buildHarness({ voiceAgent: { replies: ["One.", "Two.", "Three."] } });

  await h.refresh();
  h.phone.ringCellular();
  const call = h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");
  await h.waitFor(() => h.voiceAgent !== null && h.voiceAgent.sessions.length === 1, "a session");
  const session = h.voiceAgent!.latest;

  for (const line of ["first", "second", "third"]) {
    session.callerSaid(line);
    await h.waitFor(
      () => h.store.all[0]?.transcript.some((t) => t.text === line) === true,
      `"${line}" to be recorded`,
    );
  }

  h.orchestrator.endCall(h.store.all[0]?.callId ?? "", "completed", "done");
  const record = await h.finish(call);

  const orders = record.transcript.filter((t) => t.speaker === "caller").map((t) => t.turnOrder);
  assert.deepEqual(orders, [0, 1, 2], "each caller turn needs its own turn order");
});

test("e2e: the caller talking over the agent flushes the queued speech", async () => {
  // Barge-in cannot come from the orchestrator here: the reply never passes
  // through LocalOutStream, so its isSpeaking is always false. The bridge has
  // to act on the service's own speechStarted instead.
  const h = buildHarness({ voiceAgent: { replies: ["A long answer the caller cuts off."] } });

  await h.refresh();
  h.phone.ringCellular();
  const call = h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");
  await h.waitFor(() => h.voiceAgent !== null && h.voiceAgent.sessions.length === 1, "a session");
  const session = h.voiceAgent!.latest;

  session.callerSaid("tell me everything");
  await h.waitFor(() => h.injected.bytes > 0, "the agent to start speaking");
  const before = h.injected.cancels;

  session.callerInterrupted();
  assert.equal(h.injected.cancels, before + 1, "queued agent audio must be dropped");

  h.orchestrator.endCall(h.store.all[0]?.callId ?? "", "completed", "done");
  await h.finish(call);
});

test("e2e: ending the call closes the session and releases the transport", async () => {
  // A session left open bills by wall-clock until the service times it out, so
  // teardown is a money question, not only a tidiness one.
  const h = buildHarness({ voiceAgent: { replies: [] } });

  await h.refresh();
  h.phone.ringCellular();
  const call = h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");
  await h.waitFor(() => h.voiceAgent !== null && h.voiceAgent.sessions.length === 1, "a session");
  const session = h.voiceAgent!.latest;

  h.orchestrator.endCall(h.store.all[0]?.callId ?? "", "completed", "done");
  await h.finish(call);

  await h.waitFor(() => session.closed, "the Voice Agent session to be closed");
  assert.equal(h.injected.ended, 1, "the transport must be released");
});
