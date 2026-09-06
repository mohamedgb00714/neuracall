import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  VoiceAgentSession,
  VoiceAgentError,
  VOICE_AGENT_SAMPLE_RATE,
  VOICE_AGENT_RESUME_GRACE_MS,
  assertVoiceAgentSampleRate,
  normalizeInlineConfig,
} from "../src/voiceAgent.js";
import type {
  VoiceAgentAgentTranscriptEvent,
  VoiceAgentToolCallEvent,
  VoiceAgentUserTranscriptEvent,
} from "../src/voiceAgent.js";
import { WS_STATE } from "./mockA2I.js";

/**
 * An in-memory stand-in for wss://agents.assemblyai.com/v1/ws. Every frame is
 * JSON in both directions, so `sent` holds parsed objects: the tests care about
 * frame *order* (session.update must be first) as much as content.
 */
class MockAgentSocket extends EventEmitter {
  readyState: number = WS_STATE.CONNECTING;
  /** Client → server frames, in order. */
  readonly sent: Array<Record<string, unknown>> = [];
  clientClosed = false;

  private readonly opts: {
    autoReady: boolean;
    asyncClose: boolean;
    sessionId: string;
    onFirstFrame?: (socket: MockAgentSocket, frame: Record<string, unknown>) => void;
  };

  constructor(
    opts: {
      autoReady?: boolean;
      /**
       * Report "close" on a later tick, the way the real `ws` does: close() and
       * terminate() return long before the event fires. Left off by default so
       * most tests stay synchronous, but any test about teardown ordering needs
       * it — a socket that closes synchronously hides a listener detached in
       * between.
       */
      asyncClose?: boolean;
      sessionId?: string;
      onFirstFrame?: (socket: MockAgentSocket, frame: Record<string, unknown>) => void;
    } = {},
  ) {
    super();
    this.opts = {
      autoReady: opts.autoReady ?? true,
      asyncClose: opts.asyncClose ?? false,
      sessionId: opts.sessionId ?? "sess-agent-1",
      ...(opts.onFirstFrame ? { onFirstFrame: opts.onFirstFrame } : {}),
    };
    setImmediate(() => {
      if (this.readyState === WS_STATE.CONNECTING) {
        this.readyState = WS_STATE.OPEN;
        this.emit("open");
      }
    });
  }

  send(data: unknown): void {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    this.sent.push(frame);
    const type = frame["type"];
    if (type === "session.update" || type === "session.resume") {
      if (this.opts.onFirstFrame) {
        this.opts.onFirstFrame(this, frame);
        return;
      }
      if (this.opts.autoReady) {
        this.fromServer({ type: "session.ready", session_id: this.opts.sessionId, config: {} });
      }
      return;
    }
    if (type === "session.end") {
      this.fromServer({ type: "session.ended", audio_duration: 3.5, session_duration: 4.25 });
      this.emulateServerClose(1000);
    }
  }

  /** Server → client. */
  fromServer(obj: unknown): void {
    this.emit("message", JSON.stringify(obj));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WS_STATE.CLOSED || this.readyState === WS_STATE.CLOSING) return;
    this.readyState = WS_STATE.CLOSING;
    this.clientClosed = true;
    this.readyState = WS_STATE.CLOSED;
    this.announceClose(code ?? 1000, reason ?? "");
  }

  terminate(): void {
    this.clientClosed = true;
    this.readyState = WS_STATE.CLOSED;
    this.announceClose(1006, "");
  }

  emulateServerClose(code = 1000, reason = ""): void {
    if (this.readyState === WS_STATE.CLOSED) return;
    this.readyState = WS_STATE.CLOSED;
    this.announceClose(code, reason);
  }

  private announceClose(code: number, reason: string): void {
    if (this.opts.asyncClose) setImmediate(() => this.emit("close", code, Buffer.from(reason)));
    else this.emit("close", code, Buffer.from(reason));
  }

  /** Frames of one type, in order. */
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f["type"] === type);
  }
}

const INLINE = {
  system_prompt: "You are a call assistant.",
  greeting: "Hello.",
  // A bare id, not `{ voice_id }` — that is the stored-agent shape and
  // session.update rejects it as invalid_format.
  voice: "jane",
};

function newSession(
  socket: MockAgentSocket,
  overrides: Partial<ConstructorParameters<typeof VoiceAgentSession>[0]> = {},
): VoiceAgentSession {
  return new VoiceAgentSession(
    { apiKey: "test-not-a-real-key", session: { ...INLINE }, ...overrides },
    { wsFactory: () => socket },
  );
}

test("session.update is the very first frame on the wire", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);

  const ready = await session.connect();

  assert.equal(session.state, "ready");
  assert.equal(ready.sessionId, "sess-agent-1");
  assert.equal(ready.resumed, false);

  const first = socket.sent[0];
  assert.ok(first, "expected at least one client frame");
  assert.equal(first["type"], "session.update", "session.update must be the first frame");

  const sent = first["session"] as Record<string, unknown>;
  assert.equal(sent["system_prompt"], INLINE.system_prompt);
  // The 24 kHz formats are stated explicitly even though the caller omitted
  // them — omission is the usual way to end up at the wrong rate.
  assert.deepEqual(sent["input"], {
    format: { encoding: "audio/pcm", sample_rate: VOICE_AGENT_SAMPLE_RATE },
  });
  // The voice rides under `output`, not at the top level: the wire refuses a
  // top-level `voice` on session.update with a bare `invalid_format`.
  assert.deepEqual(sent["output"], {
    format: { encoding: "audio/pcm", sample_rate: VOICE_AGENT_SAMPLE_RATE },
    voice: INLINE.voice,
  });
  assert.ok(!("voice" in sent), "a top-level voice is rejected as invalid_format");
});

test("a stored agent is sent as agent_id, never mixed with inline config", async () => {
  const socket = new MockAgentSocket();
  const session = new VoiceAgentSession(
    { apiKey: "k", agentId: "11111111-2222-3333-4444-555555555555" },
    { wsFactory: () => socket },
  );
  await session.connect();

  assert.deepEqual(socket.sent[0], {
    type: "session.update",
    session: { agent_id: "11111111-2222-3333-4444-555555555555" },
  });

  assert.throws(
    () => new VoiceAgentSession({ apiKey: "k", agentId: "a", session: { ...INLINE } }),
    /mutually exclusive/i,
  );
});

test("audio before session.ready throws and names the state it needs", async () => {
  const socket = new MockAgentSocket({ autoReady: false });
  const session = newSession(socket, { readyTimeoutMs: 50 });

  // Never connected at all.
  assert.throws(() => session.sendAudio(new Uint8Array(480)), /before session\.ready/i);

  const connecting = session.connect();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state, "configuring");
  // Socket open, configuration sent, but the server has not said ready: still
  // illegal, and deliberately not queued (stale mic audio mistimes turn one).
  assert.throws(() => session.sendAudio(new Uint8Array(480)), /before session\.ready/i);
  assert.equal(socket.ofType("input.audio").length, 0, "nothing may be sent before ready");

  // connect() only rejects when the (unref'd) readyTimeout fires. Awaiting it
  // bare would drain the event loop and node:test would cancel this as
  // "event loop has already resolved"; awaitUnrefTimer keeps the loop alive
  // until the rejection, instead of relying on timer ordering.
  const rejection = await awaitUnrefTimer(
    connecting.then(
      () => null,
      (err: Error) => err,
    ),
    "connect()",
  );
  assert.ok(rejection, "connect() must reject with the ready timeout, not resolve");
  assert.match(rejection.message, /Timed out .* waiting for session\.ready/);
});

test("audio after the session ended returns false instead of throwing", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  await session.connect();

  assert.equal(session.sendAudio(new Uint8Array(480)), true);
  await session.close();

  // A chunk still in flight when the far end hangs up is a race, not misuse.
  assert.equal(session.sendAudio(new Uint8Array(480)), false);
});

test("sendAudio base64-encodes PCM into input.audio and rejects half samples", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  await session.connect();

  const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
  const pcm = new Uint8Array(samples.buffer);
  assert.equal(session.sendAudio(pcm), true);

  const frames = socket.ofType("input.audio");
  assert.equal(frames.length, 1);
  const roundTrip = Buffer.from(String(frames[0]!["audio"]), "base64");
  assert.deepEqual(new Uint8Array(roundTrip), pcm);

  // A view into a larger buffer must encode only the view: a pipeline hands
  // out subarrays of one capture buffer, and encoding the backing store would
  // ship the whole buffer every chunk.
  const view = pcm.subarray(2, 6);
  assert.equal(session.sendAudio(view), true);
  assert.deepEqual(
    new Uint8Array(Buffer.from(String(socket.ofType("input.audio")[1]!["audio"]), "base64")),
    view,
  );

  // An odd byte count would misalign every sample after it.
  assert.throws(() => session.sendAudio(new Uint8Array(481)), /PCM16 samples/);
  // Empty chunks are a no-op, not a frame.
  assert.equal(session.sendAudio(new Uint8Array(0)), true);
  assert.equal(socket.ofType("input.audio").length, 2);
});

test("reply.audio decodes from `data` into standalone PCM bytes", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  const chunks: Uint8Array[] = [];
  session.on("replyAudio", (pcm: Uint8Array) => chunks.push(pcm));
  await session.connect();

  const samples = Int16Array.from([0, 256, -256, 32767, -32768]);
  const expected = new Uint8Array(samples.buffer);
  socket.fromServer({ type: "reply.audio", data: Buffer.from(expected).toString("base64") });

  assert.equal(chunks.length, 1);
  const got = chunks[0]!;
  assert.deepEqual(got, expected);
  // Buffer.from(base64) of a small chunk is carved from Node's shared pool, so
  // the obvious consumer move — reinterpreting .buffer as samples — would read
  // the pool unless the bytes were copied out. Guard that copy.
  assert.equal(got.byteOffset, 0, "decoded PCM must not be a view into a pooled buffer");
  assert.deepEqual(Array.from(new Int16Array(got.buffer)), Array.from(samples));
});

test("a reply.audio without a string `data` surfaces an error, not a crash", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  const errors: Error[] = [];
  session.on("error", (e: Error) => errors.push(e));
  await session.connect();

  socket.fromServer({ type: "reply.audio", audio: "wrong-field-name" });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /base64 `data` field/);
});

test("a sample rate other than 24000 is rejected up front, naming internal_error", () => {
  // Direct guard.
  assert.throws(
    () => assertVoiceAgentSampleRate(16000, "input.format.sample_rate"),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      assert.match(err.message, /24000/);
      assert.match(err.message, /internal_error/);
      assert.match(err.message, /16000/);
      return true;
    },
  );

  // Inline config, the path an operator actually takes.
  assert.throws(
    () =>
      new VoiceAgentSession({
        apiKey: "k",
        session: {
          ...INLINE,
          input: { format: { encoding: "audio/pcm", sample_rate: 16000 } },
        },
      }),
    /24000[\s\S]*internal_error/,
  );

  // Output side too.
  assert.throws(
    () =>
      normalizeInlineConfig({
        ...INLINE,
        output: { format: { encoding: "audio/pcm", sample_rate: 8000 } },
      }),
    /output\.format\.sample_rate=8000/,
  );

  // The agent_id case, where the rate lives on the server and only the
  // caller's declared value can be checked.
  assert.throws(
    () => new VoiceAgentSession({ apiKey: "k", agentId: "a", inputSampleRate: 16000 }),
    /inputSampleRate=16000[\s\S]*internal_error/,
  );

  assert.doesNotThrow(
    () => new VoiceAgentSession({ apiKey: "k", agentId: "a", inputSampleRate: 24000 }),
  );
});

test("the inline voice is moved under output, where the wire wants it", () => {
  // Verified against the live service: a top-level `voice` on session.update is
  // rejected with `invalid_format`, whatever its shape, while `output.voice` as
  // a bare string is accepted. The stored-agent API is the opposite, which is
  // exactly why this is easy to get wrong.
  const wire = normalizeInlineConfig({ system_prompt: "hi", voice: "alba" });

  assert.equal(
    (wire["output"] as { voice?: string }).voice,
    "alba",
    "the voice must end up under output",
  );
  assert.ok(
    !("voice" in wire),
    "a top-level voice is the exact shape the server refuses with invalid_format",
  );
});

test("the stored-agent voice shape is refused with an explanation", () => {
  assert.throws(
    // The shape POST /v1/agents takes, which is wrong here and whose server-side
    // rejection names nothing useful.
    () => normalizeInlineConfig({ voice: { voice_id: "alba" } as never }),
    /voice id string[\s\S]*invalid_format/,
  );
});

test("an internal_error before ready is decorated with the real cause", async () => {
  const socket = new MockAgentSocket({
    onFirstFrame: (s) => {
      // Exactly what the live API does when the rate is wrong.
      s.fromServer({
        type: "session.error",
        code: "internal_error",
        message: "Internal service error",
      });
      s.emulateServerClose(1011);
    },
  });
  const session = newSession(socket);

  await assert.rejects(session.connect(), (err: unknown) => {
    assert.ok(err instanceof VoiceAgentError);
    assert.equal(err.code, "internal_error");
    assert.match(err.message, /24000 Hz/);
    assert.match(err.message, /internal error/i);
    return true;
  });
  assert.equal(session.state, "error");
});

test("a BYO-LLM block is refused with the endpoint that does accept it", () => {
  assert.throws(
    () =>
      new VoiceAgentSession({
        apiKey: "k",
        // Callers coming from JSON config bypass the `llm?: never` type.
        session: { ...INLINE, llm: [{ model: "qwen3.5-4b-32k-fast" }] } as never,
      }),
    /POST \/v1\/agents/,
  );
});

test("teardown is idempotent: one session.end, one close event", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  const closes: unknown[] = [];
  const ended: unknown[] = [];
  session.on("close", (e: unknown) => closes.push(e));
  session.on("ended", (e: unknown) => ended.push(e));
  await session.connect();

  await session.close();
  await session.close();
  await session.close();
  session.destroy();

  assert.equal(socket.ofType("session.end").length, 1, "session.end must be sent once");
  assert.equal(closes.length, 1, "close must be emitted exactly once");
  assert.deepEqual(ended, [{ audioDurationSeconds: 3.5, sessionDurationSeconds: 4.25 }]);
  assert.equal(session.state, "closed");
});

test("a server-initiated close and a client close do not double-fire teardown", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  const closes: unknown[] = [];
  session.on("close", (e: unknown) => closes.push(e));
  await session.connect();

  socket.emulateServerClose(1000, "bye");
  await session.close();

  assert.equal(closes.length, 1);
  assert.equal(session.state, "closed");
});

/**
 * Fail loudly instead of hanging. The bugs these teardown tests cover are
 * promises that never settle, and node:test would sit on one until the whole
 * run is killed rather than naming it.
 */
function withinTick<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} never settled`)), 250);
      timer.unref?.();
    }),
  ]);
}

/**
 * Await a promise that only an UNREF'D internal timer (e.g. the session.ready
 * timeout) can settle. node:test flags such a test as cancelled — "Promise
 * resolution is still pending but the event loop has already resolved" — once
 * the loop drains with no ref'd work left: an unref'd timer does not keep the
 * loop alive, so the pending await looks permanently stuck. A ref'd keeper runs
 * until the promise settles and is cleared the moment it does.
 */
async function awaitUnrefTimer<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const keeper = setTimeout(() => {
      reject(new Error(`${label} never settled within the keep-alive window`));
    }, 10_000);
    promise.then(
      (value) => {
        clearTimeout(keeper);
        resolve(value);
      },
      (err) => {
        clearTimeout(keeper);
        reject(err);
      },
    );
  });
}

test("close() during the handshake settles connect() and sends no session.end", async () => {
  const socket = new MockAgentSocket({ autoReady: false, asyncClose: true });
  const session = newSession(socket, { readyTimeoutMs: 60_000, endTimeoutMs: 60_000 });

  const connecting = session.connect();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state, "configuring");

  await withinTick(session.close(), "close()");

  // There is no session to end before session.ready and no session.ended can
  // arrive, so the end handshake must be skipped rather than waited out —
  // otherwise hanging up mid-dial blocks for the whole endTimeoutMs.
  assert.equal(socket.ofType("session.end").length, 0, "session.end needs a ready session");
  // Teardown detaches the socket listeners, so the close the real ws reports a
  // tick later can no longer reach handleClose: finalize itself has to settle
  // the handshake or the caller awaits connect() forever.
  await assert.rejects(withinTick(connecting, "connect()"), /before session\.ready/);
  assert.equal(session.state, "closed");
});

test("destroy() during the handshake settles connect(), not just the ready timeout", async () => {
  const socket = new MockAgentSocket({ autoReady: false, asyncClose: true });
  const session = newSession(socket, { readyTimeoutMs: 60_000 });

  const connecting = session.connect();
  await new Promise((r) => setImmediate(r));
  session.destroy();

  await assert.rejects(withinTick(connecting, "connect()"), /before session\.ready/);
});

test("a handshake refused without a close frame still releases the socket", async () => {
  const refused = new MockAgentSocket({
    // An `invalid_value` on session.update — the documented BYO-LLM rejection —
    // is answered without a close frame, unlike the 1011 that follows
    // internal_error. Nothing else will ever tear this socket down.
    onFirstFrame: (s) =>
      s.fromServer({
        type: "session.error",
        code: "invalid_value",
        message: "BYO LLM config is not allowed on session.update",
      }),
  });
  const queued: MockAgentSocket[] = [refused];
  const session = new VoiceAgentSession(
    { apiKey: "k", session: { ...INLINE } },
    { wsFactory: () => queued.shift() ?? new MockAgentSocket() },
  );

  await assert.rejects(session.connect(), /BYO LLM config is not allowed/);
  assert.equal(refused.readyState, WS_STATE.CLOSED, "a refused handshake must not leak the socket");

  // ...and the session is retryable rather than wedged on "already connected".
  const ready = await withinTick(session.connect(), "retry connect()");
  assert.equal(ready.sessionId, "sess-agent-1");
});

test("errors never throw for want of a listener", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  await session.connect();
  assert.equal(session.listenerCount("error"), 0);

  // Node throws ERR_UNHANDLED_ERROR on an unlistened "error"; a recoverable
  // server hiccup must not take the host process down with it.
  assert.doesNotThrow(() =>
    socket.fromServer({ type: "session.error", code: "invalid_value", message: "nope" }),
  );
  assert.doesNotThrow(() => socket.emit("message", "definitely-not-json"));
  assert.doesNotThrow(() => socket.emit("error", new Error("socket blew up")));

  // With a listener the same frame is delivered, typed.
  const errors: Error[] = [];
  session.on("error", (e: Error) => errors.push(e));
  socket.fromServer({
    type: "session.error",
    code: "invalid_value",
    message: "bad param",
    param: "voice.voice_id",
  });
  assert.equal(errors.length, 1);
  const err = errors[0]!;
  assert.ok(err instanceof VoiceAgentError);
  assert.equal(err.code, "invalid_value");
  assert.equal(err.param, "voice.voice_id");
});

test("session.resume re-attaches with the captured session_id as the first frame", async () => {
  const first = new MockAgentSocket({ sessionId: "sess-drop-me" });
  const second = new MockAgentSocket({ sessionId: "sess-drop-me" });
  const sockets = [first, second];
  let clock = 1_000_000;
  const session = new VoiceAgentSession(
    { apiKey: "k", session: { ...INLINE } },
    { wsFactory: () => sockets.shift()!, now: () => clock },
  );

  await session.connect();
  assert.equal(session.sessionId, "sess-drop-me");

  // The socket drops; the server holds the session for 30 s.
  first.emulateServerClose(1006, "network");
  assert.equal(session.state, "closed");
  assert.equal(session.resumable, true);

  clock += 5_000;
  const resumed = await session.resume();

  assert.deepEqual(second.sent[0], { type: "session.resume", session_id: "sess-drop-me" });
  assert.equal(second.ofType("session.update").length, 0, "resume must not re-send config");
  assert.equal(resumed.resumed, true);
  assert.equal(session.state, "ready");

  // Past the grace window the attempt still goes out (the server decides) but
  // it is flagged loudly.
  await session.close();
  const third = new MockAgentSocket({ sessionId: "sess-drop-me" });
  sockets.push(third);
  clock += VOICE_AGENT_RESUME_GRACE_MS + 15_000;
  const warnings: string[] = [];
  session.on("warn", (w: string) => warnings.push(w));
  await session.resume();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /grace window has elapsed/);
});

test("transcripts, replies and speech events are normalized", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  const user: VoiceAgentUserTranscriptEvent[] = [];
  const agent: VoiceAgentAgentTranscriptEvent[] = [];
  const order: string[] = [];
  session.on("userTranscript", (e: VoiceAgentUserTranscriptEvent) => user.push(e));
  session.on("agentTranscript", (e: VoiceAgentAgentTranscriptEvent) => agent.push(e));
  session.on("speechStarted", () => order.push("speechStarted"));
  session.on("speechStopped", () => order.push("speechStopped"));
  session.on("replyStarted", () => order.push("replyStarted"));
  session.on("replyDone", (e: { status: string }) => order.push(`replyDone:${e.status}`));
  await session.connect();

  socket.fromServer({ type: "input.speech.started" });
  socket.fromServer({ type: "transcript.user.delta", delta: "book a", item_id: "item-1" });
  socket.fromServer({ type: "transcript.user", text: "book a table", item_id: "item-1" });
  socket.fromServer({ type: "input.speech.stopped" });
  socket.fromServer({ type: "reply.started", reply_id: "r1", item_id: "item-2" });
  socket.fromServer({
    type: "transcript.agent.delta",
    reply_id: "r1",
    item_id: "item-2",
    delta: "Sure",
    start_ms: 0,
    end_ms: 240,
  });
  socket.fromServer({
    type: "transcript.agent",
    reply_id: "r1",
    item_id: "item-2",
    text: "Sure, for when?",
    interrupted: true,
  });
  socket.fromServer({ type: "reply.done", reply_id: "r1", status: "interrupted" });

  assert.deepEqual(order, [
    "speechStarted",
    "speechStopped",
    "replyStarted",
    "replyDone:interrupted",
  ]);
  assert.deepEqual(user, [
    { text: "book a", final: false, itemId: "item-1" },
    { text: "book a table", final: true, itemId: "item-1" },
  ]);
  assert.equal(agent[0]!.final, false);
  assert.equal(agent[0]!.startMs, 0);
  assert.equal(agent[0]!.endMs, 240);
  assert.equal(agent[1]!.final, true);
  assert.equal(agent[1]!.interrupted, true);
  assert.equal(agent[1]!.replyId, "r1");
});

test("tool.call is parsed and tool.result is sent as a JSON-encoded string", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  const calls: VoiceAgentToolCallEvent[] = [];
  session.on("toolCall", (e: VoiceAgentToolCallEvent) => calls.push(e));
  await session.connect();

  socket.fromServer({
    type: "tool.call",
    call_id: "call-1",
    name: "lookup_booking",
    arguments: JSON.stringify({ name: "Sam", party: 4 }),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.arguments, { name: "Sam", party: 4 });
  assert.equal(calls[0]!.callId, "call-1");

  session.sendToolResult("call-1", { found: true });
  const result = socket.ofType("tool.result")[0];
  // The server rejects an object here: `result` must be a JSON string.
  assert.equal(typeof result!["result"], "string");
  assert.deepEqual(JSON.parse(String(result!["result"])), { found: true });

  // An already-encoded string is passed through untouched.
  session.sendToolResult("call-2", '{"found":false}');
  assert.equal(socket.ofType("tool.result")[1]!["result"], '{"found":false}');
});

test("reply.create forces a reply, with or without instructions", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  await session.connect();

  session.createReply();
  session.createReply("Ask for the callback number.");

  assert.deepEqual(socket.ofType("reply.create"), [
    { type: "reply.create" },
    { type: "reply.create", instructions: "Ask for the callback number." },
  ]);
});

test("an unknown server frame warns instead of erroring the call", async () => {
  const socket = new MockAgentSocket();
  const session = newSession(socket);
  const warnings: string[] = [];
  const errors: Error[] = [];
  session.on("warn", (w: string) => warnings.push(w));
  session.on("error", (e: Error) => errors.push(e));
  await session.connect();

  socket.fromServer({ type: "reply.some.future.event", value: 1 });

  assert.equal(errors.length, 0, "a new event type must not kill a live call");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /reply\.some\.future\.event/);
});

test("credentials never reach the socket URL when a header is used", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> | undefined;
  const socket = new MockAgentSocket();
  const session = new VoiceAgentSession(
    { apiKey: "super-secret-key", session: { ...INLINE } },
    {
      wsFactory: (url, opts) => {
        seenUrl = url;
        seenHeaders = opts?.headers;
        return socket;
      },
    },
  );
  await session.connect();

  assert.equal(seenUrl, "wss://agents.assemblyai.com/v1/ws");
  assert.ok(!seenUrl.includes("super-secret-key"));
  assert.equal(seenHeaders?.["authorization"], "Bearer super-secret-key");

  // The browser path puts a one-time token — never the key — in the query.
  const tokenSocket = new MockAgentSocket();
  let tokenUrl = "";
  const browserSession = new VoiceAgentSession(
    { token: "one-time-token", session: { ...INLINE } },
    {
      wsFactory: (url) => {
        tokenUrl = url;
        return tokenSocket;
      },
    },
  );
  await browserSession.connect();
  assert.equal(tokenUrl, "wss://agents.assemblyai.com/v1/ws?token=one-time-token");
});

test("a socket that errors after teardown does not crash the process", async () => {
  // `ws` reports a connection that never completed by emitting "error" a tick
  // AFTER terminate() returns, i.e. after finalize() has detached everything.
  // An EventEmitter with no "error" listener throws, and this runs on
  // Electron's main process — so this was a whole-app crash on a network blip
  // during dial, reachable from any connect timeout.
  const socket = new MockAgentSocket({ asyncClose: true });
  const session = newSession(socket);

  const connecting = session.connect();
  session.destroy();
  await connecting.catch(() => {});

  assert.doesNotThrow(() => socket.emit("error", new Error("closed before established")));
});
