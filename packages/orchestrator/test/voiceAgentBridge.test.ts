/**
 * The bridge's job is to make the Voice Agent look like the two interfaces the
 * orchestrator already depends on, without giving up low latency or barge-in.
 * These tests are mostly about those two properties, because a bridge that
 * merely compiles would fail both silently: the caller would hear the agent
 * late, or would not be able to interrupt it.
 */

import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import type { AudioInjector } from "@neuracall/audio-pipeline";
import type { VoiceAgentOptions } from "@neuracall/aai-client";
import { VoiceAgentBridge } from "../src/voiceAgentBridge.js";

/** Stands in for a VoiceAgentSession: same events, no socket. */
class FakeSession extends EventEmitter {
  readonly sent: Uint8Array[] = [];
  connected = false;
  closed = false;
  destroyed = false;

  async connect(): Promise<unknown> {
    this.connected = true;
    return { sessionId: "sess_test", resumed: false };
  }
  sendAudio(pcm: Uint8Array): boolean {
    this.sent.push(pcm);
    return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.emit("close", { code: 1000, reason: "" });
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class RecordingInjector implements AudioInjector {
  readonly sampleRate: number;
  readonly channels = 1 as const;
  readonly writes: Uint8Array[] = [];
  cancels = 0;
  ended = 0;

  constructor(sampleRate = 16000) {
    this.sampleRate = sampleRate;
  }
  write(pcm: Uint8Array): void {
    this.writes.push(pcm);
  }
  cancel(): void {
    this.cancels += 1;
  }
  end(): void {
    this.ended += 1;
  }
}

const KEY = { deviceId: "DEV1", channelId: "whatsapp" };
const PARAMS = { params: { sampleRate: 16000, speechModel: "x" } } as never;

function makeBridge(injector?: AudioInjector) {
  let session!: FakeSession;
  const bridge = new VoiceAgentBridge({
    apiKey: "k",
    agentId: "agent-1",
    ...(injector ? { injectorFor: () => injector } : {}),
    createSession: () => {
      session = new FakeSession();
      return session as never;
    },
    replyTimeoutMs: 200,
  });
  return { bridge, session: () => session };
}

/** Int16 LE buffer of `n` samples, so byte counts are unambiguous. */
function pcm(n: number, value = 1000): Uint8Array {
  const buf = new Uint8Array(n * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < n; i += 1) view.setInt16(i * 2, value, true);
  return buf;
}

test("call audio is resampled 16k -> 24k before it reaches the service", async () => {
  const { bridge, session } = makeBridge();
  const stream = await bridge.open(KEY, PARAMS);

  // 480 samples at 16 kHz is 30 ms; at 24 kHz that is 720 samples.
  stream.sendAudio(pcm(480));
  const sent = session().sent;
  assert.equal(sent.length, 1);
  const outSamples = (sent[0]?.length ?? 0) / 2;
  assert.ok(
    Math.abs(outSamples - 720) <= 1,
    `expected ~720 samples at 24 kHz, got ${outSamples} — a wrong rate fails as "internal_error"`,
  );
});

test("the agent's audio reaches the injector before the reply is complete", async () => {
  // This is the latency property. If the bridge buffered the reply and handed
  // it back through AgentReply.audio, nothing would be written until
  // reply.done — the caller would hear a ten-second answer ten seconds late.
  const injector = new RecordingInjector(24000);
  const { bridge, session } = makeBridge(injector);
  await bridge.open(KEY, PARAMS);

  session().emit("replyStarted", { replyId: "r1", itemId: null });
  session().emit("replyAudio", pcm(240));

  assert.equal(injector.writes.length, 1, "audio must be written as it arrives, not buffered");
});

test("agent audio is resampled to the injector's rate", async () => {
  const injector = new RecordingInjector(16000);
  const { bridge, session } = makeBridge(injector);
  await bridge.open(KEY, PARAMS);

  // 720 samples at 24 kHz is 30 ms; the 16 kHz injector wants ~480.
  session().emit("replyStarted", { replyId: "r1", itemId: null });
  session().emit("replyAudio", pcm(720));

  const written = (injector.writes[0]?.length ?? 0) / 2;
  assert.ok(Math.abs(written - 480) <= 2, `expected ~480 samples at 16 kHz, got ${written}`);
});

test("onFinalTurn returns the reply text and never its audio", async () => {
  const injector = new RecordingInjector(24000);
  const { bridge, session } = makeBridge(injector);
  await bridge.open(KEY, PARAMS);

  // The caller speaks first: a reply that arrives before any caller turn is the
  // greeting, not an answer, and the bridge tells them apart on exactly this.
  session().emit("userTranscript", { text: "hello", final: true });
  session().emit("replyStarted", { replyId: "r1", itemId: null });
  session().emit("replyAudio", pcm(240));
  session().emit("agentTranscript", { text: "Certainly.", final: true, replyId: "r1" });
  session().emit("replyDone", { replyId: "r1", status: "completed" });

  const reply = await bridge.agent.onFinalTurn({
    callId: "c1",
    deviceId: KEY.deviceId,
    channelId: KEY.channelId as never,
    transcript: "hello",
    turnOrder: 0,
    history: [],
  });

  assert.equal(reply?.text, "Certainly.");
  assert.equal(
    reply?.audio,
    undefined,
    "returning audio would make the orchestrator buffer the whole reply first",
  );
});

test("a reply that finishes before it is asked for is not lost", async () => {
  // The orchestrator persists the caller's turn before calling onFinalTurn, so
  // the reply routinely completes first. A bridge that only registered a
  // waiter on demand would deadlock here.
  const { bridge, session } = makeBridge();
  await bridge.open(KEY, PARAMS);

  session().emit("userTranscript", { text: "hi", final: true });
  session().emit("replyStarted", { replyId: "r1", itemId: null });
  session().emit("agentTranscript", { text: "Queued.", final: true, replyId: "r1" });
  session().emit("replyDone", { replyId: "r1", status: "completed" });

  const reply = await bridge.agent.onFinalTurn({
    callId: "c1",
    deviceId: KEY.deviceId,
    channelId: KEY.channelId as never,
    transcript: "hi",
    turnOrder: 0,
    history: [],
  });
  assert.equal(reply?.text, "Queued.");
});

test("the caller speaking flushes the agent's queued audio (barge-in)", async () => {
  const injector = new RecordingInjector();
  const { bridge, session } = makeBridge(injector);
  await bridge.open(KEY, PARAMS);

  session().emit("speechStarted", {});
  assert.equal(injector.cancels, 1, "the agent must stop talking when the caller starts");
});

test("turnOrder increases once per finalized caller turn", async () => {
  const { bridge, session } = makeBridge();
  const stream = await bridge.open(KEY, PARAMS);
  const orders: number[] = [];
  stream.on("turn", (t) => {
    if (t.final) orders.push(t.turnOrder);
  });

  session().emit("userTranscript", { text: "one", final: false });
  session().emit("userTranscript", { text: "one", final: true });
  session().emit("userTranscript", { text: "two", final: true });

  assert.deepEqual(orders, [0, 1], "the orchestrator dedupes transcript entries on this number");
});

test("a call that ends while a reply is awaited resolves instead of hanging", async () => {
  const { bridge, session } = makeBridge();
  await bridge.open(KEY, PARAMS);

  const pending = bridge.agent.onFinalTurn({
    callId: "c1",
    deviceId: KEY.deviceId,
    channelId: KEY.channelId as never,
    transcript: "hi",
    turnOrder: 0,
    history: [],
  });
  session().emit("close", { code: 1000, reason: "" });

  assert.equal(await pending, null, "a hung promise would stall the orchestrator's turn loop");
});

test("close() ends the session and releases the transport", async () => {
  const injector = new RecordingInjector();
  const { bridge, session } = makeBridge(injector);
  await bridge.open(KEY, PARAMS);
  await bridge.close(KEY, "call ended");

  assert.equal(session().closed, true);
  assert.equal(injector.ended, 1);
});

test("audio is refused once the call has closed", async () => {
  const { bridge, session } = makeBridge();
  const stream = await bridge.open(KEY, PARAMS);
  const before = session().sent.length;
  session().emit("close", { code: 1000, reason: "" });

  assert.equal(stream.sendAudio(pcm(160)), false);
  assert.equal(session().sent.length, before, "nothing may be sent after close");
});

test("a bridge with neither an agentId nor an inline config is refused", () => {
  assert.throws(
    () => new VoiceAgentBridge({ apiKey: "k" }),
    /agentId .*or an inline session config/,
  );
});

test("a bridge with no API key is refused", () => {
  assert.throws(() => new VoiceAgentBridge({ apiKey: "", agentId: "a" }), /apiKey is required/);
});

test("a missing injector degrades the call instead of failing it", async () => {
  // No transport configured: the call must still transcribe and reply.
  const { bridge, session } = makeBridge();
  await bridge.open(KEY, PARAMS);

  session().emit("userTranscript", { text: "hi", final: true });
  session().emit("replyStarted", { replyId: "r1", itemId: null });
  session().emit("replyAudio", pcm(240));
  session().emit("agentTranscript", { text: "Still here.", final: true, replyId: "r1" });
  session().emit("replyDone", { replyId: "r1", status: "completed" });

  const reply = await bridge.agent.onFinalTurn({
    callId: "c1",
    deviceId: KEY.deviceId,
    channelId: KEY.channelId as never,
    transcript: "hi",
    turnOrder: 0,
    history: [],
  });
  assert.equal(reply?.text, "Still here.");
});

test("agent_context biasing is a no-op rather than an error", async () => {
  const { bridge } = makeBridge();
  const stream = await bridge.open(KEY, PARAMS);
  assert.doesNotThrow(() => stream.updateConfiguration({ agent_context: "anything" }));
});

test("a session that fails to connect releases its transport", async () => {
  // open() registers the call only after connect() resolves, so a failure
  // leaves an object nothing can reach — its socket and its injector would sit
  // there until the process exited.
  const injector = new RecordingInjector();
  let made!: FakeSession;
  const bridge = new VoiceAgentBridge({
    apiKey: "k",
    agentId: "agent-1",
    injectorFor: () => injector,
    createSession: () => {
      made = new FakeSession();
      made.connect = async () => {
        throw new Error("connect refused");
      };
      return made as never;
    },
  });

  await assert.rejects(bridge.open(KEY, PARAMS), /connect refused/);
  assert.equal(made.destroyed, true, "the socket must be released");
  assert.equal(injector.ended, 1, "the transport must be released");
});

test("a greeting waiter does not swallow the first turn's answer", async () => {
  // The bug this guards was invisible locally and obvious in an e2e run: while
  // onAnswered waited for a greeting the agent never had, the answer to turn
  // one settled that wait instead. Every later reply was then off by one and
  // the last turn sat out the full reply timeout.
  const { bridge, session } = makeBridge();
  await bridge.open(KEY, PARAMS);

  const ctx = {
    callId: "c1",
    deviceId: KEY.deviceId,
    channelId: KEY.channelId as never,
    history: [],
  };
  const greeting = bridge.agent.onAnswered!(ctx);

  // No greeting is coming; the caller just starts talking.
  session().emit("userTranscript", { text: "hello", final: true });
  session().emit("replyStarted", { replyId: "r1", itemId: null });
  session().emit("agentTranscript", { text: "The answer.", final: true, replyId: "r1" });
  session().emit("replyDone", { replyId: "r1", status: "completed" });

  assert.equal(await greeting, null, "there was no greeting to report");
  const answer = await bridge.agent.onFinalTurn({ ...ctx, transcript: "hello", turnOrder: 0 });
  assert.equal(answer?.text, "The answer.", "the turn's answer must not be lost to the greeting");
});

test("a greeting spoken before the caller talks is reported as the greeting", async () => {
  const { bridge, session } = makeBridge();
  await bridge.open(KEY, PARAMS);

  session().emit("replyStarted", { replyId: "g", itemId: null });
  session().emit("agentTranscript", { text: "Hello, NeuraCall.", final: true, replyId: "g" });
  session().emit("replyDone", { replyId: "g", status: "completed" });

  const greeting = await bridge.agent.onAnswered!({
    callId: "c1",
    deviceId: KEY.deviceId,
    channelId: KEY.channelId as never,
    history: [],
  });
  assert.equal(greeting?.text, "Hello, NeuraCall.");
});

test("an inline agent with no greeting does not delay call setup", async () => {
  // The orchestrator awaits onAnswered before it starts the hang-up watch, so
  // any wait here is dead time at the head of every call. When the config is
  // inline we can see no greeting was asked for and skip it entirely.
  const bridge = new VoiceAgentBridge({
    apiKey: "k",
    session: { system_prompt: "Be brief." },
    createSession: () => new FakeSession() as never,
    greetingTimeoutMs: 5000,
  });
  await bridge.open(KEY, PARAMS);

  const started = Date.now();
  const greeting = await bridge.agent.onAnswered!({
    callId: "c1",
    deviceId: KEY.deviceId,
    channelId: KEY.channelId as never,
    history: [],
  });

  assert.equal(greeting, null);
  assert.ok(Date.now() - started < 100, "it must not wait out the greeting timeout");
});

test("realtime tuning reaches the Voice Agent where it has a slot", async () => {
  // The operator's vad_threshold / turn-silence knobs have a genuine
  // equivalent in the Voice Agent config (turn_detection); language_codes and
  // session_heartbeat do not, and must be left alone rather than fake-mapped —
  // the mergeSttParams contract.
  let received!: VoiceAgentOptions;
  const bridge = new VoiceAgentBridge({
    apiKey: "k",
    session: { system_prompt: "Be brief." },
    createSession: (options: VoiceAgentOptions) => {
      received = options;
      return new FakeSession() as never;
    },
  });

  await bridge.open(KEY, {
    params: {
      sampleRate: 16000,
      speechModel: "universal-3-5-pro",
      vad_threshold: 0.6,
      min_turn_silence: 2000,
      max_turn_silence: 6000,
      language_codes: ["ar"],
      session_heartbeat: true,
    },
  } as never);

  const input = received.session?.input as Record<string, unknown>;
  assert.deepEqual(input["turn_detection"], {
    vad_threshold: 0.6,
    min_silence: 2000,
    max_silence: 6000,
  });
  assert.equal(input["language_codes"], undefined, "no language_codes slot on the Voice Agent");
  assert.equal(
    input["session_heartbeat"],
    undefined,
    "no session_heartbeat slot on the Voice Agent",
  );
  assert.equal(
    received.session?.input?.keyterms ?? input["prompt"],
    undefined,
    "nothing else is invented for fields without a counterpart",
  );
});

test("sessionFor picks a stored agent per device, falling back to the static one", async () => {
  const seen: VoiceAgentOptions[] = [];
  const bridge = new VoiceAgentBridge({
    apiKey: "k",
    agentId: "global-agent",
    sessionFor: (key) =>
      key.deviceId === "DEV1" ? { agentId: "device1-agent" } : undefined,
    createSession: (opts) => {
      seen.push(opts);
      return new FakeSession() as never;
    },
  });
  await bridge.open({ deviceId: "DEV1", channelId: "whatsapp" }, PARAMS);
  await bridge.open({ deviceId: "DEV2", channelId: "whatsapp" }, PARAMS);
  await bridge.open({ deviceId: "DEV3", channelId: "whatsapp" }, PARAMS);

  assert.equal(seen[0]?.agentId, "device1-agent", "DEV1 gets its own stored agent");
  assert.equal(seen[1]?.agentId, "global-agent", "DEV2 falls back to the static agent");
  assert.equal(seen[2]?.agentId, "global-agent", "DEV3 falls back to the static agent");
  assert.equal(seen[0]?.session, undefined, "agent_id and inline config never mix");
});

test("sessionFor can hand a device an inline persona instead of a stored agent", async () => {
  const seen: VoiceAgentOptions[] = [];
  const bridge = new VoiceAgentBridge({
    apiKey: "k",
    session: { voice: "alba" },
    sessionFor: (key) =>
      key.deviceId === "DEV1"
        ? { session: { voice: "estelle", greeting: "Bonjour" } }
        : undefined,
    createSession: (opts) => {
      seen.push(opts);
      return new FakeSession() as never;
    },
  });
  await bridge.open({ deviceId: "DEV1", channelId: "whatsapp" }, PARAMS);
  await bridge.open({ deviceId: "DEV9", channelId: "whatsapp" }, PARAMS);

  assert.equal(seen[0]?.session?.voice, "estelle");
  assert.equal(seen[0]?.session?.greeting, "Bonjour");
  assert.equal(seen[1]?.session?.voice, "alba", "DEV9 keeps the static inline persona");
});
