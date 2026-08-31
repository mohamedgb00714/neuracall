/**
 * The full mocked-call scenario: a phone rings and the whole NeuraCall stack
 * carries it through to a persisted call record, with only adb, the A2I
 * WebSocket, scrcpy, the LLM and TTS faked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWavHeader } from "@neuracall/audio-pipeline";
import { buildHarness, DEFAULT_ENDPOINT } from "../src/harness.js";
import { FakePhone } from "../src/fakePhone.js";

test("e2e: an inbound cellular call is detected, answered, transcribed and recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-e2e-"));
  try {
    const h = buildHarness({
      replies: ["Certainly, what time would suit you?", "Booked. See you then."],
      greeting: "Thanks for calling NeuraCall.",
      recordingsDir: dir,
    });

    // The device pool discovers the phone through the real DeviceManager.
    await h.refresh();
    assert.equal(h.devices.get(DEFAULT_ENDPOINT)?.phase, "online");
    assert.equal(h.orchestrator.acquireDevice()?.id, DEFAULT_ENDPOINT);

    // The phone starts ringing; the real detector classifies the channel.
    h.phone.ringCellular();
    const detected = await h.devices.detectIncomingCall(
      DEFAULT_ENDPOINT,
      new (await import("@neuracall/device-manager")).AdbCallChannelDetector(h.adb),
    );
    // Field-wise rather than deepEqual: the detector adds informational fields
    // (stage, ownerPackage) over time, and a strict match would fail on a
    // purely additive change that breaks nothing.
    assert.equal(detected.present, true);
    assert.equal(detected.channel, "cellular");

    const call = h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");

    // Answering drives the real controller, which drives the fake handset.
    await h.waitFor(() => h.phone.callState === "offhook", "the phone to be answered");
    assert.equal(h.phone.answeredCount, 1);

    // A realtime session was opened over the real RealtimeStream.
    await h.waitFor(() => h.a2i.sessions.length === 1, "an A2I session");
    const session = h.a2i.latest;
    assert.match(session.url, /\/v3\/ws\?/);
    assert.match(session.url, /speech_model=universal-3-5-pro/);
    assert.match(session.url, /sample_rate=16000/);

    // Far-end audio flows through the real pipeline into the session.
    await h.waitFor(() => h.capture.sink !== null, "capture to start");
    h.capture.speak(500);
    await h.waitFor(() => session.audioBytes > 0, "audio to reach A2I");
    // 48 kHz stereo in, 16 kHz mono out: a quarter of the bytes per sample-pair.
    assert.ok(session.audioBytes >= 3200, "at least one 100 ms chunk arrived");
    assert.equal(session.audioBytes % 2, 0, "whole Int16 samples only");

    // The caller speaks; the agent answers and biases the next turn.
    session.finalTurn("I'd like to book a table for two");
    await h.waitFor(() => h.llm.prompts.length === 1, "the agent's first reply");
    await h.waitFor(
      () => session.configUpdates.length > 0,
      "an UpdateConfiguration carrying agent_context",
    );
    assert.equal(
      session.configUpdates.at(-1)?.["agent_context"],
      "Certainly, what time would suit you?",
    );

    // Second turn, then the far end hangs up.
    session.finalTurn("Seven o'clock");
    await h.waitFor(() => h.llm.prompts.length === 2, "the agent's second reply");
    h.orchestrator.endCall("", "completed"); // no-op: unknown id must be safe
    const active = h.orchestrator.activeCalls[0]!;
    h.orchestrator.endCall(active.callId, "completed", "far end hung up");

    const record = await call;

    // --- the state machine walked the whole path
    assert.deepEqual(h.states, ["incoming", "answered", "talking", "ended"]);
    assert.equal(record.state, "ended");
    assert.equal(record.outcome, "completed");
    assert.equal(record.channelId, "cellular");
    assert.equal(record.direction, "inbound");

    // --- the A2I session was terminated, not just dropped
    assert.equal(session.terminateReceived, true, "Terminate must always be sent");
    assert.equal(h.a2i.allTerminated, true);
    assert.equal(session.closed, true);
    assert.equal(h.sessions.activeCount, 0, "no session left open");

    // --- the phone was hung up and the device returned to the pool
    assert.equal(h.phone.hungUpCount >= 1, true);
    assert.equal(h.phone.callState, "idle");
    assert.equal(h.devices.get(DEFAULT_ENDPOINT)?.phase, "online");

    // --- both sides of the conversation were transcribed, in order
    assert.deepEqual(
      record.transcript.map((t) => `${t.speaker}: ${t.text}`),
      [
        "agent: Thanks for calling NeuraCall.",
        "caller: I'd like to book a table for two",
        "agent: Certainly, what time would suit you?",
        "caller: Seven o'clock",
        "agent: Booked. See you then.",
      ],
    );

    // --- the agent kept context across turns
    assert.match(h.llm.prompts[1]!, /Seven o'clock/);

    // --- the recording is a playable WAV of what was transcribed
    assert.ok(record.audioPath);
    const header = parseWavHeader(readFileSync(record.audioPath!));
    assert.equal(header.sampleRate, 16000);
    assert.equal(header.channels, 1);
    assert.equal(header.dataBytes, session.audioBytes);

    // --- the record was persisted
    const stored = await h.store.get(record.callId);
    assert.equal(stored?.state, "ended");
    assert.deepEqual(
      stored!.states.map((s) => s.state),
      ["idle", "incoming", "answered", "talking", "ended"],
    );

    assert.deepEqual(h.errors, [], "the happy path must report no errors");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: an inbound WhatsApp call is detected on the right channel and handled", async () => {
  const h = buildHarness({ replies: ["Hello, how can I help?"] });
  await h.refresh();

  // Telephony stays idle for a WhatsApp call — only the UI gives it away.
  h.phone.ringWhatsApp();
  await h.orchestrator.poll();

  await h.waitFor(() => h.orchestrator.activeCalls.length === 1, "the WhatsApp call to start");
  const active = h.orchestrator.activeCalls[0]!;
  assert.equal(active.channelId, "whatsapp");
  assert.equal(h.devices.get(DEFAULT_ENDPOINT)?.channel, "whatsapp");

  await h.waitFor(() => h.a2i.sessions.length === 1, "an A2I session");
  const session = h.a2i.latest;
  session.finalTurn("is this the restaurant?");
  await h.waitFor(() => h.llm.prompts.length === 1, "the agent to reply");

  h.orchestrator.endCall(active.callId);
  await h.waitFor(() => h.orchestrator.activeCalls.length === 0, "the call to finish");

  const record = (await h.store.get(active.callId))!;
  assert.equal(record.channelId, "whatsapp");
  assert.equal(record.outcome, "completed");
  assert.equal(session.terminateReceived, true);
  assert.equal(h.devices.get(DEFAULT_ENDPOINT)?.phase, "online");
});

test("e2e: two phones run concurrent calls without crossing transcripts", async () => {
  const a = new FakePhone({ endpoint: "10.0.0.1:5555" });
  const b = new FakePhone({ endpoint: "10.0.0.2:5555" });
  const h = buildHarness({ phones: [a, b], replies: ["Reply to A", "Reply to B"] });
  await h.refresh();

  const callA = h.orchestrator.handleIncomingCall(a.endpoint, "cellular");
  await h.waitFor(() => h.a2i.sessions.length === 1, "A's session");
  const callB = h.orchestrator.handleIncomingCall(b.endpoint, "whatsapp");
  await h.waitFor(() => h.a2i.sessions.length === 2, "B's session");

  const sessionA = h.a2i.sessions[0]!;
  const sessionB = h.a2i.sessions[1]!;
  assert.equal(h.sessions.activeCount, 2);

  sessionA.finalTurn("this is caller A");
  await h.waitFor(() => h.llm.prompts.length === 1, "A's reply");
  sessionB.finalTurn("this is caller B");
  await h.waitFor(() => h.llm.prompts.length === 2, "B's reply");

  const idA = h.orchestrator.activeCalls.find((c) => c.deviceId === a.endpoint)!.callId;
  const idB = h.orchestrator.activeCalls.find((c) => c.deviceId === b.endpoint)!.callId;
  h.orchestrator.endCall(idA);
  h.orchestrator.endCall(idB);

  const [recordA, recordB] = await Promise.all([callA, callB]);

  // Each call kept its own transcript — no cross-talk between sessions.
  assert.deepEqual(
    recordA.transcript.map((t) => t.text),
    ["this is caller A", "Reply to A"],
  );
  assert.deepEqual(
    recordB.transcript.map((t) => t.text),
    ["this is caller B", "Reply to B"],
  );
  assert.equal(recordA.channelId, "cellular");
  assert.equal(recordB.channelId, "whatsapp");

  // Both sessions were terminated and both devices released.
  assert.equal(h.a2i.allTerminated, true);
  assert.equal(h.sessions.activeCount, 0);
  assert.equal(h.devices.get(a.endpoint)?.phase, "online");
  assert.equal(h.devices.get(b.endpoint)?.phase, "online");
});

test("e2e: a realtime session that drops mid-call still tears the call down cleanly", async () => {
  const h = buildHarness({ replies: ["hello"] });
  await h.refresh();

  const call = h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");
  await h.waitFor(() => h.a2i.sessions.length === 1, "an A2I session");

  // The server drops the socket with "too many sessions".
  h.a2i.latest.failWith(3009);

  const record = await call;
  assert.equal(record.state, "ended");
  assert.equal(record.outcome, "failed");
  // The phone is not left off-hook and the device is back in the pool.
  assert.equal(h.phone.callState, "idle");
  assert.equal(h.devices.get(DEFAULT_ENDPOINT)?.phase, "online");
  assert.equal(h.sessions.activeCount, 0);
  assert.equal(h.capture.stopped, 1);
});

test("e2e: a phone with no usable audio source does not strand the device", async () => {
  const h = buildHarness();
  await h.refresh();
  h.capture.failNext = new Error("no usable audio source for this device");

  const record = await h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");

  assert.equal(record.state, "ended");
  assert.equal(record.outcome, "failed");
  assert.match(record.error ?? "", /no usable audio source/);
  // The session opened before capture was attempted, so it must still be closed.
  assert.equal(h.a2i.allTerminated, true);
  assert.equal(h.sessions.activeCount, 0);
  assert.equal(h.phone.callState, "idle");
  assert.equal(h.devices.get(DEFAULT_ENDPOINT)?.phase, "online");
});

test("e2e: partial turns do not make the agent speak", async () => {
  const h = buildHarness({ replies: ["the only reply"] });
  await h.refresh();

  const call = h.orchestrator.handleIncomingCall(DEFAULT_ENDPOINT, "cellular");
  await h.waitFor(() => h.a2i.sessions.length === 1, "an A2I session");
  const session = h.a2i.latest;

  session.partialTurn("I'd like");
  session.partialTurn("I'd like to ask");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.llm.prompts.length, 0, "the agent must wait for a final turn");

  session.finalTurn("I'd like to ask about opening hours");
  await h.waitFor(() => h.llm.prompts.length === 1, "the agent to reply");

  h.orchestrator.endCall(h.orchestrator.activeCalls[0]!.callId);
  const record = await call;
  assert.equal(
    record.transcript.filter((t) => t.speaker === "caller").length,
    1,
    "only the finalized turn is transcribed",
  );
});
