import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeStream } from "../src/realtime.js";
import type {
  SpeechStartedEvent,
  TurnEvent,
  SpeakerRevisionEvent,
  TerminationMessage,
} from "../src/types.js";
import { MockA2I, testConfig, TEST_PARAMS } from "./mockA2I.js";

function openStream(server: MockA2I): RealtimeStream {
  return new RealtimeStream(testConfig(), TEST_PARAMS, {
    wsFactory: () => server.socket,
  });
}

test("routes SpeechStarted to the speechStarted event", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const started: SpeechStartedEvent[] = [];
  stream.on("speechStarted", (e: SpeechStartedEvent) => started.push(e));
  await stream.connect();

  server.sendToClient({ type: "SpeechStarted", timestamp: 250, confidence: 0.7 });
  assert.equal(started.length, 1);
  assert.equal(started[0]!.timestamp, 250);
  assert.equal(started[0]!.confidence, 0.7);
});

test("routes a partial Turn with final=false and a final Turn with final=true", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const turns: TurnEvent[] = [];
  stream.on("turn", (t: TurnEvent) => turns.push(t));
  await stream.connect();

  server.sendToClient({
    type: "Turn",
    turn_order: 0,
    end_of_turn: false,
    turn_is_formatted: false,
    transcript: "the quick",
    end_of_turn_confidence: 0.1,
    words: [
      { text: "the", start: 0, end: 200, confidence: 0.9, word_is_final: false },
    ],
    utterance: "",
  });

  server.sendToClient({
    type: "Turn",
    turn_order: 0,
    end_of_turn: true,
    turn_is_formatted: true,
    transcript: "the quick brown fox",
    end_of_turn_confidence: 0.98,
    words: [
      { text: "the", start: 0, end: 200, confidence: 0.99, word_is_final: true },
    ],
    utterance: "the quick brown fox",
    speaker_label: "A",
  });

  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.final, false);
  assert.equal(turns[0]!.formatted, false);
  assert.equal(turns[1]!.final, true);
  assert.equal(turns[1]!.formatted, true);
  assert.equal(turns[1]!.utterance, "the quick brown fox");
  assert.equal(turns[1]!.speakerLabel, "A");
});

test("routes a SpeakerRevision with turnOrders derived from revisions", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const revisions: SpeakerRevisionEvent[] = [];
  stream.on("speakerRevision", (r: SpeakerRevisionEvent) => revisions.push(r));
  await stream.connect();

  server.sendToClient({
    type: "SpeakerRevision",
    revisions: [
      {
        turn_order: 2,
        speaker_label: "B",
        words: [{ text: "hello", start: 0, end: 100, speaker: "B" }],
      },
    ],
  });

  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0]!.turnOrders, [2]);
  assert.equal(revisions[0]!.revisions[0]!.speaker_label, "B");
});

test("honors Termination as the terminal message", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const terminated: TerminationMessage[] = [];
  stream.on("termination", (m: TerminationMessage) => terminated.push(m));
  await stream.connect();

  server.sendToClient({
    type: "Termination",
    audio_duration_seconds: 12.3,
    session_duration_seconds: 15.0,
  });

  assert.equal(terminated.length, 1);
  assert.equal(terminated[0]!.session_duration_seconds, 15.0);
});

test("maps a 3007 close to a typed error and corrects the chunk size without crashing", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const errors: Error[] = [];
  const warnings: unknown[] = [];
  stream.on("error", (e: Error) => errors.push(e));
  stream.on("warn", (w: unknown) => warnings.push(w));
  await stream.connect();

  const before = stream.chunkSizeBytes;
  assert.ok(before > 0);

  // Server closes with 3007 (bad audio chunk size) — must not throw/reject.
  assert.doesNotThrow(() => server.socket.emulateServerClose(3007));

  assert.equal(errors.length, 1, "should emit a typed error");
  assert.match(errors[0]!.message, /chunk size corrected/i);
  assert.equal(warnings.length, 1, "should emit a warn before the error");

  // The recommended chunk size was halved toward the 50ms floor.
  assert.ok(stream.chunkSizeBytes < before, "chunk size should shrink after 3007");
  assert.equal(stream.state, "closed");
});

test("close codes 1008/3005/3006/3008/3009 map to typed errors without crashing", async () => {
  const codes = [1008, 3005, 3006, 3008, 3009];
  for (const code of codes) {
    const s = new MockA2I();
    const st = openStream(s);
    const errs: Error[] = [];
    st.on("error", (e: Error) => errs.push(e));
    await st.connect();
    assert.doesNotThrow(() => s.socket.emulateServerClose(code));
    assert.equal(errs.length, 1, `close code ${code} should emit a typed error`);
    assert.equal(st.state, "closed");
  }
});

test("exposes the negotiated session id from Begin", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  await stream.connect();
  server.sendToClient({
    type: "Begin",
    id: "sess-abc-123",
    expires_at: 1760000000,
    configuration: { model: "universal-3-5-pro" },
  });
  assert.equal(stream.sessionId, "sess-abc-123");
});

test("warns when the server serves a different model than was requested", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  const warnings: string[] = [];
  stream.on("warn", (message: string) => warnings.push(message));
  await stream.connect();

  // A bad speech_model does not fail the connection — the socket opens and
  // transcribes with whatever the server chose, and the Pro-only features the
  // agent loop needs silently stop applying. This echo is the only signal.
  server.sendToClient({
    type: "Begin",
    id: "sess-1",
    expires_at: 1760000000,
    configuration: { model: "universal-2" },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /serving "universal-2" but "universal-3-5-pro" was requested/);
});

test("stays quiet when the served model matches, or is not echoed at all", async () => {
  for (const configuration of [{ model: "universal-3-5-pro" }, undefined]) {
    const server = new MockA2I();
    const stream = openStream(server);
    const warnings: string[] = [];
    stream.on("warn", (message: string) => warnings.push(message));
    await stream.connect();

    server.sendToClient({
      type: "Begin",
      id: "sess-1",
      expires_at: 1760000000,
      ...(configuration ? { configuration } : {}),
    });

    assert.deepEqual(warnings, []);
  }
});
