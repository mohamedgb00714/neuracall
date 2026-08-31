import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { CallAudioSession } from "@neuracall/audio-pipeline";
import type { PcmSink } from "../src/bridge.js";
import {
  CaptureSourceSelector,
  LOCAL_OUT_SOURCES,
  REMOTE_IN_SOURCES,
  captureSourcesFor,
  isDuplexSource,
  isPrivilegedSource,
} from "../src/callAudio.js";

test("a session's remoteIn can be handed to ScrcpyBridge as its sink", () => {
  const session = new CallAudioSession({
    deviceId: "SERIAL",
    callId: "call-1",
    channelId: "cellular",
    sink: new Writable({ objectMode: true, write: (_c, _e, cb) => cb() }),
  });

  // The assignment is the assertion: it only compiles while RemoteInStream
  // still satisfies the PcmSink shape the bridge writes into. The two packages
  // never import each other's types (scrcpy-bridge depends on audio-pipeline,
  // so the dependency cannot go both ways) — this is what keeps them in step.
  const sink: PcmSink = session.remoteIn;

  sink.format?.({ formatTag: 1, channels: 2, sampleRate: 48000, bitsPerSample: 16, blockAlign: 4 });
  assert.equal(session.remoteIn.captureFormat.sampleRate, 48000);
  sink.push(Buffer.alloc(64));
  sink.end();
  assert.equal(session.remoteIn.closed, true);
});

test("the far-end preference list starts with the cleanest source", () => {
  assert.equal(REMOTE_IN_SOURCES[0], "voice-call-downlink");
  // `mic` is the last resort: it only hears the far end acoustically.
  assert.equal(REMOTE_IN_SOURCES.at(-1), "mic");
  assert.equal(LOCAL_OUT_SOURCES[0], "voice-call-uplink");
  assert.deepEqual(captureSourcesFor("remoteIn"), REMOTE_IN_SOURCES);
  assert.deepEqual(captureSourcesFor("localOut"), LOCAL_OUT_SOURCES);
});

test("privileged and duplex sources are flagged", () => {
  assert.equal(isPrivilegedSource("voice-call-downlink"), true);
  assert.equal(isPrivilegedSource("output"), true);
  assert.equal(isPrivilegedSource("mic"), false);

  // These carry the agent's own voice back into STT.
  assert.equal(isDuplexSource("voice-call"), true);
  assert.equal(isDuplexSource("mic"), true);
  assert.equal(isDuplexSource("voice-call-downlink"), false);
});

test("the selector falls back through the list as sources fail", () => {
  const selector = new CaptureSourceSelector("remoteIn");
  assert.equal(selector.next(), "voice-call-downlink");
  assert.equal(selector.pinned, false);

  assert.equal(selector.fail("permission denied"), "voice-call");
  assert.equal(selector.fail("no such source"), "output");
  assert.equal(selector.next(), "output");
  assert.deepEqual(selector.remaining, ["mic"]);

  assert.equal(selector.fail("silent"), "mic");
  assert.equal(selector.fail("nothing works"), null, "exhausted the list");
  assert.equal(selector.attempts.get("voice-call-downlink"), "permission denied");
  assert.equal(selector.attempts.size, 4);
});

test("an explicit override pins one source so a bad phone fails loudly", () => {
  const selector = new CaptureSourceSelector("remoteIn", "voice-call");
  assert.equal(selector.next(), "voice-call");
  assert.equal(selector.pinned, true);
  // No silent degradation to room audio.
  assert.equal(selector.fail("permission denied"), null);
});

test("reset restarts the search after a device reconnects", () => {
  const selector = new CaptureSourceSelector("remoteIn");
  selector.fail("permission denied");
  assert.equal(selector.next(), "voice-call");

  selector.reset();
  assert.equal(selector.next(), "voice-call-downlink");
  assert.equal(selector.attempts.size, 0);
});
