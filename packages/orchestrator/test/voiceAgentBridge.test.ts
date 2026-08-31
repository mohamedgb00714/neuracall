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
