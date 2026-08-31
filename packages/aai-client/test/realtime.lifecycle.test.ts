import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RealtimeStream } from "../src/realtime.js";
import type { TurnEvent } from "../src/types.js";
import { MockA2I, WS_STATE, testConfig, TEST_PARAMS } from "./mockA2I.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, "../../test/fixtures/speech-16k-mono.wav"));

/** Mono 16-bit PCM WAVs have a fixed 44-byte RIFF header. */
function wavPcmBody(wav: Buffer): Buffer {
  return wav.subarray(44);
}

function openStream(server: MockA2I): RealtimeStream {
  // A fresh MockA2I per factory call, like a fresh server session per connect.
  return new RealtimeStream(testConfig(), TEST_PARAMS, {
    wsFactory: () => server.socket,
  });
}

test("recorded-audio fixture feeds PCM and yields a final Turn", async () => {
  const server = new MockA2I({ transcript: "the quick brown fox" });
  const stream = openStream(server);

  const turns: TurnEvent[] = [];
  stream.on("turn", (t: TurnEvent) => turns.push(t));

  await stream.connect();

  // Feed the whole fixture in ~50 ms chunks (1600 bytes at 16 kHz mono16).
  const pcm = wavPcmBody(FIXTURE);
  const CHUNK = 1600;
  let fed = 0;
  for (let off = 0; off < pcm.length; off += CHUNK) {
    const ok = stream.sendAudio(pcm.subarray(off, off + CHUNK));
    assert.equal(ok, true, "sendAudio should return true while open");
    fed += Math.min(CHUNK, pcm.length - off);
  }

  // The mock emits Turn synchronously on first audio; client surfaces it.
  const final = turns.find((t) => t.final);
  assert.ok(final, "expected at least one final Turn");
  assert.equal(final.transcript, "the quick brown fox");
  assert.equal(final.turnOrder, 0);
  assert.equal(server.audioReceived, fed, "server should receive all fed audio bytes");
  assert.equal(server.audioReceived, pcm.length);

  // Cleanly end the billable session.
  await stream.close({ terminate: true });
  assert.equal(stream.state, "closed");
});

test("close({terminate:true}) sends Terminate before the socket closes", async () => {
  const server = new MockA2I();
  const stream = openStream(server);

  await stream.connect();
  assert.equal(stream.state, "open");
  assert.equal(server.socket.readyState, WS_STATE.OPEN);

  await stream.close({ terminate: true });

  // The mock must have observed the wire-level Terminate control message.
  assert.equal(server.terminateReceived, true, "server should see Terminate");
  const sentText = server.sent
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m) as { type?: string });
  assert.ok(
    sentText.some((m) => m.type === "Terminate"),
    "client should send a JSON Terminate message",
  );
  assert.equal(stream.state, "closed");
  assert.equal(server.clientClosed, true, "client socket should be closed");
});

test("close({terminate:false}) force-closes without sending Terminate", async () => {
  const server = new MockA2I();
  const stream = openStream(server);
  await stream.connect();

  await stream.close({ terminate: false });
  assert.equal(server.terminateReceived, false, "no Terminate expected on force close");
  assert.equal(stream.state, "closed");
});
