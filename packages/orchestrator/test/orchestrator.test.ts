import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWavHeader } from "@neuracall/audio-pipeline";
import type {
  CallChannelDetector,
  CallController,
  CallState as TelephonyState,
  ChannelKind,
  Device,
  DevicePhase,
} from "@neuracall/device-manager";
import { MemoryCallRecordStore } from "../src/callStore.js";
import { Orchestrator, type DevicePool, type SttSessionManager } from "../src/orchestrator.js";
import type {
  AgentReply,
  AgentTurnContext,
  AudioCapture,
  CallAgent,
  CallRecord,
  CapturePcmSink,
  CaptureHandle,
} from "../src/types.js";

const DEVICE = "192.168.1.44:5555";
const CALL_ID = "call-under-test";

// --------------------------------------------------------------- fakes

class FakeDevicePool implements DevicePool {
  private device: Device = {
    id: DEVICE,
    kind: "wifi",
    adbState: "device",
    phase: "online",
    updatedAt: 0,
  };
  readonly phases: DevicePhase[] = [];

  get snapshot(): Device[] {
    return [this.device];
  }

  get(id: string): Device | undefined {
    return id === this.device.id ? this.device : undefined;
  }

  setPhase(id: string, phase: DevicePhase): void {
    if (id !== this.device.id) return;
    this.device = { ...this.device, phase };
    this.phases.push(phase);
  }

  reportIncomingCall(id: string, channel: ChannelKind): Device | undefined {
    if (id !== this.device.id) return undefined;
    this.device = { ...this.device, phase: "incoming", channel };
    this.phases.push("incoming");
    return this.device;
  }
}

class FakeCallController implements CallController {
  answered = 0;
  hungUp = 0;
  telephony: TelephonyState = "ringing";
  /** Set to make answering fail, as a phone that ignores the keyevent would. */
  answerError: Error | null = null;

  async answer(): Promise<void> {
    if (this.answerError) throw this.answerError;
    this.answered += 1;
    this.telephony = "offhook";
  }
  async hangUp(): Promise<void> {
    this.hungUp += 1;
    this.telephony = "idle";
  }
  async safeHangUp(): Promise<void> {
    await this.hangUp();
  }
  async dial(): Promise<void> {}
  async openDialer(): Promise<void> {}
  async pressDigits(): Promise<void> {}
  async toggleMute(): Promise<void> {}
  async callState(): Promise<TelephonyState> {
    return this.telephony;
  }
}

class FakeDetector implements CallChannelDetector {
  constructor(private result: { present: boolean; channel: ChannelKind | null }) {}
  async detect(): Promise<{ present: boolean; channel: ChannelKind | null }> {
    return this.result;
  }
  set(result: { present: boolean; channel: ChannelKind | null }): void {
    this.result = result;
  }
}

/** A realtime session that records what it was sent and can emit turns. */
class FakeSttStream extends EventEmitter {
  readonly audio: Buffer[] = [];
  readonly configUpdates: Array<{ agent_context?: string; keyterms_prompt?: string[] }> = [];

  sendAudio(chunk: Uint8Array): boolean {
    this.audio.push(Buffer.from(chunk));
    return true;
  }

  updateConfiguration(update: { agent_context?: string; keyterms_prompt?: string[] }): void {
    this.configUpdates.push(update);
  }

  get audioBytes(): number {
    return this.audio.reduce((n, c) => n + c.length, 0);
  }

  /** Simulate the server finalising a caller turn. */
  emitFinalTurn(transcript: string, turnOrder = 0): void {
    this.emit("turn", {
      turnOrder,
      final: true,
      formatted: true,
      transcript,
      endOfTurnConfidence: 0.98,
      words: [],
      utterance: transcript,
    });
  }

  emitPartialTurn(transcript: string, turnOrder = 0): void {
    this.emit("turn", {
      turnOrder,
      final: false,
      formatted: false,
      transcript,
      endOfTurnConfidence: 0.1,
      words: [],
      utterance: null,
    });
  }
}

class FakeSttManager implements SttSessionManager {
  readonly opened: Array<{ deviceId: string; channelId: string }> = [];
  readonly closed: Array<{ key: { deviceId: string; channelId: string }; reason?: string }> = [];
  stream = new FakeSttStream();
  openError: Error | null = null;

  async open(key: { deviceId: string; channelId: string }): Promise<FakeSttStream> {
    if (this.openError) throw this.openError;
    this.opened.push(key);
    return this.stream;
  }

  async close(key: { deviceId: string; channelId: string }, reason?: string): Promise<void> {
    this.closed.push({ key, ...(reason !== undefined ? { reason } : {}) });
  }
}

/** Capture that hands the test a handle for pushing synthetic far-end audio. */
class FakeCapture implements AudioCapture {
  sink: CapturePcmSink | null = null;
  stopped = 0;
  startError: Error | null = null;

  async start(args: { deviceId: string; sink: CapturePcmSink }): Promise<CaptureHandle> {
    if (this.startError) throw this.startError;
    this.sink = args.sink;
    args.sink.format?.({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
    return {
      stop: () => {
        this.stopped += 1;
      },
    };
  }

  /** Push `ms` of far-end speech. */
  speak(ms: number): void {
    if (!this.sink) throw new Error("capture not started");
    this.sink.push(tone(ms));
  }
}

class ScriptedAgent implements CallAgent {
  readonly turns: AgentTurnContext[] = [];
  readonly ended: CallRecord[] = [];
  greeting: AgentReply | null = null;

  constructor(private readonly replies: Array<AgentReply | null>) {}

  async onAnswered(): Promise<AgentReply | null> {
    return this.greeting;
  }

  async onFinalTurn(ctx: AgentTurnContext): Promise<AgentReply | null> {
    this.turns.push(ctx);
    return this.replies.shift() ?? null;
  }

  async onCallEnded(record: CallRecord): Promise<void> {
    this.ended.push(record);
  }
}

// ------------------------------------------------------------- helpers

/** 48 kHz stereo Int16 speech-like tone, loud enough to open the VAD. */
function tone(ms: number, freq = 440): Buffer {
  const rate = 48000;
  const frames = Math.round((ms / 1000) * rate);
  const buf = Buffer.alloc(frames * 2 * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.sin((2 * Math.PI * freq * f) / rate) * 0.5;
    const s = Math.round(v * 32767);
    buf.writeInt16LE(s, f * 4);
    buf.writeInt16LE(s, f * 4 + 2);
  }
  return buf;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  orchestrator: Orchestrator;
  devices: FakeDevicePool;
  controller: FakeCallController;
  detector: FakeDetector;
  stt: FakeSttManager;
  capture: FakeCapture;
  agent: ScriptedAgent;
  store: MemoryCallRecordStore;
  states: string[];
  errors: Error[];
}

function harness(
  opts: { replies?: Array<AgentReply | null>; recordingsDir?: string } = {},
): Harness {
  const devices = new FakeDevicePool();
  const controller = new FakeCallController();
  const detector = new FakeDetector({ present: true, channel: "cellular" });
  const stt = new FakeSttManager();
  const capture = new FakeCapture();
  const agent = new ScriptedAgent(opts.replies ?? []);
  const store = new MemoryCallRecordStore();
  const states: string[] = [];
  const errors: Error[] = [];

  const orchestrator = new Orchestrator({
    devices,
    controllerFor: () => controller,
    detector,
    sessions: stt,
    capture,
    agent,
    store,
    makeCallId: () => CALL_ID,
    hangupPollMs: 0, // the tests drive the ending explicitly
    ...(opts.recordingsDir !== undefined ? { recordingsDir: opts.recordingsDir } : {}),
  });
  orchestrator.on("state", (_id: string, state: string) => states.push(state));
  orchestrator.on("error", (err: Error) => errors.push(err));

  return { orchestrator, devices, controller, detector, stt, capture, agent, store, states, errors };
}

// --------------------------------------------------------------- tests

test("a full mocked call runs through every state and closes the A2I session", async () => {
  const h = harness({
    replies: [
      { text: "Sure, one moment." },
      { text: "Goodbye.", hangUp: true },
    ],
  });

  const call = h.orchestrator.handleIncomingCall(DEVICE, "cellular");

  await waitFor(() => h.capture.sink !== null, "capture to start");
  h.capture.speak(400); // far-end audio starts flowing
  await waitFor(() => h.stt.stream.audioBytes > 0, "audio to reach STT");

  h.stt.stream.emitFinalTurn("I'd like to book a table", 0);
  await waitFor(() => h.agent.turns.length === 1, "the agent's first turn");

  h.stt.stream.emitFinalTurn("Tomorrow at seven", 1);
  const record = await call;

  // The Done criterion: every state, in order.
  assert.deepEqual(h.states, ["incoming", "answered", "talking", "ended"]);
  assert.equal(record.state, "ended");
  assert.equal(record.outcome, "completed");

  // The A2I session was opened once and closed exactly once. The manager's
  // close() is what sends Terminate — a session dropped without it stays
  // billable for hours.
  assert.deepEqual(h.stt.opened, [{ deviceId: DEVICE, channelId: "cellular" }]);
  assert.equal(h.stt.closed.length, 1);
  assert.deepEqual(h.stt.closed[0]!.key, { deviceId: DEVICE, channelId: "cellular" });

  // The phone was answered, hung up, and the device handed back to the pool.
  assert.equal(h.controller.answered, 1);
  assert.equal(h.controller.hungUp, 1);
  assert.equal(h.capture.stopped, 1);
  assert.deepEqual(h.devices.phases, ["incoming", "in-call", "online"]);

  // Both sides of the conversation were transcribed, in order.
  assert.deepEqual(
    record.transcript.map((t) => `${t.speaker}: ${t.text}`),
    [
      "caller: I'd like to book a table",
      "agent: Sure, one moment.",
      "caller: Tomorrow at seven",
      "agent: Goodbye.",
    ],
  );

  assert.ok(record.startedAt > 0);
  assert.ok(record.answeredAt !== null && record.answeredAt >= record.startedAt);
  assert.ok(record.endedAt !== null && record.endedAt >= record.answeredAt);
  assert.equal(h.errors.length, 0, `unexpected errors: ${h.errors.map((e) => e.message).join("; ")}`);
});

test("the call record is persisted as the call progresses, not only at the end", async () => {
  const h = harness({ replies: [{ text: "Bye.", hangUp: true }] });
  const call = h.orchestrator.handleIncomingCall(DEVICE, "whatsapp");

  await waitFor(() => h.capture.sink !== null, "capture to start");
  await waitFor(() => h.store.all.length > 0, "an in-progress record");

  // A record exists mid-call, so a crash still leaves evidence of the call.
  const midCall = await h.store.get(CALL_ID);
  assert.ok(midCall, "expected a record while the call was still running");
  assert.notEqual(midCall.state, "ended");
  assert.equal(midCall.channelId, "whatsapp");

  h.capture.speak(300);
  h.stt.stream.emitFinalTurn("hello");
  const record = await call;

  const stored = await h.store.get(CALL_ID);
  assert.equal(stored!.state, "ended");
  assert.equal(stored!.outcome, "completed");
  assert.deepEqual(stored!.transcript, record.transcript);
  // Full state history is kept for after-the-fact debugging.
  assert.deepEqual(
    stored!.states.map((s) => s.state),
    ["idle", "incoming", "answered", "talking", "ended"],
  );
  assert.equal(h.agent.ended.length, 1, "the agent was told the call ended");
});

test("the agent's reply biases the next caller turn via agent_context", async () => {
  const h = harness({
    replies: [
      { text: "What is your account number?", keyterms: ["Zendesk", "SKU-42"] },
      { text: "Thanks.", hangUp: true },
    ],
  });
  const call = h.orchestrator.handleIncomingCall(DEVICE, "cellular");

  await waitFor(() => h.capture.sink !== null, "capture to start");
  h.stt.stream.emitFinalTurn("I need help");
  await waitFor(() => h.stt.stream.configUpdates.length > 0, "an UpdateConfiguration");

  assert.deepEqual(h.stt.stream.configUpdates[0], {
    agent_context: "What is your account number?",
    keyterms_prompt: ["Zendesk", "SKU-42"],
  });

  h.stt.stream.emitFinalTurn("It's 4815");
  await call;
});

test("a caller talking over the agent triggers barge-in", async () => {
  const h = harness({
    replies: [
      { text: "Let me read you our full terms...", audio: Buffer.alloc(32000) },
      { text: "Of course.", hangUp: true },
    ],
  });
  const bargeIns: string[] = [];
  h.orchestrator.on("bargeIn", (id: string) => bargeIns.push(id));

  const call = h.orchestrator.handleIncomingCall(DEVICE, "cellular");
  await waitFor(() => h.capture.sink !== null, "capture to start");

  h.stt.stream.emitFinalTurn("tell me about it");
  await waitFor(() => h.agent.turns.length === 1, "the long reply to start");

  // The caller cuts in while the agent is still speaking.
  h.stt.stream.emitFinalTurn("actually, skip it");
  await call;

  assert.deepEqual(bargeIns, [CALL_ID]);
});

test("partial turns never reach the agent", async () => {
  const h = harness({ replies: [{ text: "Bye.", hangUp: true }] });
  const call = h.orchestrator.handleIncomingCall(DEVICE, "cellular");
  await waitFor(() => h.capture.sink !== null, "capture to start");

  h.stt.stream.emitPartialTurn("I'd like to");
  h.stt.stream.emitPartialTurn("I'd like to book");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.agent.turns.length, 0, "the agent must not answer half a sentence");

  h.stt.stream.emitFinalTurn("I'd like to book a table");
  await call;
  assert.equal(h.agent.turns.length, 1);
});

test("a phone that refuses to answer still terminates cleanly", async () => {
  const h = harness();
  h.controller.answerError = new Error("keyevent timed out");

  const record = await h.orchestrator.handleIncomingCall(DEVICE, "cellular");

  assert.deepEqual(h.states, ["incoming", "ended"]);
  assert.equal(record.outcome, "missed");
  assert.match(record.error ?? "", /keyevent timed out/);
  // Never answered, so no session was opened — and nothing to close.
  assert.equal(h.stt.opened.length, 0);
  // The device is still handed back rather than stranded as "incoming".
  assert.equal(h.devices.phases.at(-1), "online");
});

test("an STT session that dies mid-call is still closed and the device released", async () => {
  const h = harness();
  const call = h.orchestrator.handleIncomingCall(DEVICE, "cellular");
  await waitFor(() => h.capture.sink !== null, "capture to start");

  // The realtime socket drops.
  h.stt.stream.emit("close");
  const record = await call;

  assert.equal(record.state, "ended");
  assert.equal(record.outcome, "failed");
  assert.equal(h.stt.closed.length, 1, "Terminate must still be sent");
  assert.equal(h.capture.stopped, 1);
  assert.equal(h.devices.phases.at(-1), "online");
});

test("the far end hanging up ends the call", async () => {
  const h = harness();
  // Re-create with hangup polling enabled.
  const orchestrator = new Orchestrator({
    devices: h.devices,
    controllerFor: () => h.controller,
    detector: h.detector,
    sessions: h.stt,
    capture: h.capture,
    agent: h.agent,
    store: h.store,
    makeCallId: () => CALL_ID,
    hangupPollMs: 10,
  });

  const call = orchestrator.handleIncomingCall(DEVICE, "cellular");
  await waitFor(() => h.capture.sink !== null, "capture to start");

  h.controller.telephony = "idle"; // the caller puts the phone down
  const record = await call;

  assert.equal(record.state, "ended");
  assert.equal(record.outcome, "completed");
  assert.equal(h.stt.closed.length, 1);
});

test("call audio is recorded to a playable WAV alongside the live transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-orch-"));
  try {
    const h = harness({ replies: [{ text: "Bye.", hangUp: true }], recordingsDir: dir });
    const call = h.orchestrator.handleIncomingCall(DEVICE, "cellular");

    await waitFor(() => h.capture.sink !== null, "capture to start");
    h.capture.speak(500);
    await waitFor(() => h.stt.stream.audioBytes > 0, "audio to reach STT");

    h.stt.stream.emitFinalTurn("hello there");
    const record = await call;

    assert.ok(record.audioPath, "expected a recording path on the record");
    const wav = readFileSync(record.audioPath!);
    const header = parseWavHeader(wav);
    assert.equal(header.sampleRate, 16000);
    assert.equal(header.channels, 1);
    assert.equal(header.bitsPerSample, 16);
    // The recording holds the same audio that was transcribed live.
    assert.equal(header.dataBytes, h.stt.stream.audioBytes);
    assert.ok(header.frames > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch() answers a ringing device and refuses to double-book it", async () => {
  const h = harness({ replies: [{ text: "Bye.", hangUp: true }] });

  await h.orchestrator.poll();
  await waitFor(() => h.capture.sink !== null, "the polled call to start");
  assert.equal(h.controller.answered, 1);

  // A second poll while the call is live must not start another one.
  await h.orchestrator.poll();
  assert.equal(h.controller.answered, 1);
  assert.equal(h.stt.opened.length, 1);

  h.stt.stream.emitFinalTurn("hi");
  await waitFor(() => h.orchestrator.activeCalls.length === 0, "the call to finish");
});

test("a device already on a call is rejected", async () => {
  const h = harness({ replies: [{ text: "Bye.", hangUp: true }] });
  const call = h.orchestrator.handleIncomingCall(DEVICE, "cellular");
  await waitFor(() => h.capture.sink !== null, "capture to start");

  await assert.rejects(
    () => h.orchestrator.handleIncomingCall(DEVICE, "whatsapp"),
    /already on a call/,
  );

  h.stt.stream.emitFinalTurn("hi");
  await call;
});

test("acquireDevice only offers an idle, connected phone", () => {
  const h = harness();
  assert.equal(h.orchestrator.acquireDevice()?.id, DEVICE);

  h.devices.setPhase(DEVICE, "in-call");
  assert.equal(h.orchestrator.acquireDevice(), null);
});
