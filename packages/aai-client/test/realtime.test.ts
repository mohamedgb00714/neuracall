import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWebSocketUrl, normalizeTurn } from "../src/realtime.js";
import { getConfig } from "@neuracall/config";
import { RealtimeCloseCode } from "../src/types.js";

test("buildWebSocketUrl requires singular speech_model and sample_rate", () => {
  const url = buildWebSocketUrl("streaming.assemblyai.com", {
    sampleRate: 16000,
    speechModel: "universal-3-5-pro",
    mode: "balanced",
  });

  const parsed = new URL(url);
  assert.equal(parsed.protocol, "wss:");
  assert.equal(parsed.host, "streaming.assemblyai.com");
  assert.equal(parsed.pathname, "/v3/ws");
  assert.equal(parsed.searchParams.get("sample_rate"), "16000");
  // Realtime uses the SINGULAR speech_model string (not plural array).
  assert.equal(parsed.searchParams.get("speech_model"), "universal-3-5-pro");
  assert.equal(parsed.searchParams.has("speech_models"), false);
  assert.equal(parsed.searchParams.get("mode"), "balanced");
});

test("buildWebSocketUrl omits optional params when not set", () => {
  const url = buildWebSocketUrl("streaming.eu.assemblyai.com", {
    sampleRate: 8000,
    speechModel: "universal-3-5-pro",
    encoding: "pcm_mulaw",
  });
  const parsed = new URL(url);
  assert.equal(parsed.host, "streaming.eu.assemblyai.com");
  assert.equal(parsed.searchParams.get("encoding"), "pcm_mulaw");
  assert.equal(parsed.searchParams.has("mode"), false);
  assert.equal(parsed.searchParams.has("speaker_labels"), false);
});

test("buildWebSocketUrl serializes keyterms_prompt and agent_context", () => {
  const url = buildWebSocketUrl("streaming.assemblyai.com", {
    sampleRate: 16000,
    speechModel: "universal-3-5-pro",
    keyterms_prompt: ["AssemblyAI", "Neuracall"],
    agent_context: "Your reservation is confirmed.",
    speaker_labels: true,
    max_speakers: 2,
  });
  const parsed = new URL(url);
  assert.equal(
    parsed.searchParams.get("keyterms_prompt"),
    JSON.stringify(["AssemblyAI", "Neuracall"]),
  );
  assert.equal(
    parsed.searchParams.get("agent_context"),
    "Your reservation is confirmed.",
  );
  assert.equal(parsed.searchParams.get("speaker_labels"), "true");
  assert.equal(parsed.searchParams.get("max_speakers"), "2");
});

test("normalizeTurn maps v3 fields and flags final turns", () => {
  const ev = normalizeTurn({
    type: "Turn",
    turn_order: 3,
    end_of_turn: true,
    turn_is_formatted: true,
    transcript: "Hello there.",
    end_of_turn_confidence: 1.0,
    words: [
      {
        text: "Hello",
        start: 0,
        end: 300,
        confidence: 0.99,
        word_is_final: true,
        speaker: "A",
      },
    ],
    utterance: "Hello there.",
    speaker_label: "A",
    language_code: "en",
    language_confidence: 0.98,
  });

  assert.equal(ev.turnOrder, 3);
  assert.equal(ev.final, true);
  assert.equal(ev.formatted, true);
  assert.equal(ev.transcript, "Hello there.");
  assert.equal(ev.speakerLabel, "A");
  assert.equal(ev.languageCode, "en");
  assert.equal(ev.words[0]?.speaker, "A");
});

test("normalizeTurn flags partial turns", () => {
  const ev = normalizeTurn({
    type: "Turn",
    turn_order: 4,
    end_of_turn: false,
    turn_is_formatted: false,
    transcript: "Hello the",
    end_of_turn_confidence: 0.0,
    words: [],
    utterance: null,
  });
  assert.equal(ev.final, false);
  assert.equal(ev.utterance, null);
});

test("config fails fast on missing AssemblyAI key", () => {
  delete process.env.ASSEMBLYAI_API_KEY;
  assert.throws(() => getConfig(), /ASSEMBLYAI_API_KEY/);
});

test("config picks EU base URL from ASSEMBLYAI_REGION=eu", () => {
  // NOTE: real key not required here — getConfig requires the key, so we set
  // a placeholder that passes the requireEnv check beyond "replace-me".
  const KEY = "unit-test-not-a-real-key";
  const prevKey = process.env.ASSEMBLYAI_API_KEY;
  const prevRegion = process.env.ASSEMBLYAI_REGION;
  try {
    process.env.ASSEMBLYAI_API_KEY = KEY;
    process.env.ASSEMBLYAI_REGION = "eu";
    const cfg = getConfig();
    assert.equal(cfg.assemblyai.restBaseUrl, "https://api.eu.assemblyai.com");
    assert.equal(cfg.assemblyai.realtimeHost, "streaming.eu.assemblyai.com");
  } finally {
    process.env.ASSEMBLYAI_API_KEY = prevKey;
    process.env.ASSEMBLYAI_REGION = prevRegion;
  }
});

test("config defaults to edge routing and flagship model", () => {
  const prevKey = process.env.ASSEMBLYAI_API_KEY;
  const prevRegion = process.env.ASSEMBLYAI_REGION;
  try {
    process.env.ASSEMBLYAI_API_KEY = "unit-test-not-a-real-key";
    delete process.env.ASSEMBLYAI_REGION;
    const cfg = getConfig();
    assert.equal(cfg.assemblyai.region, "edge");
    assert.equal(cfg.assemblyai.realtimeHost, "streaming.assemblyai.com");
    assert.equal(cfg.assemblyai.speechModel, "universal-3-5-pro");
  } finally {
    process.env.ASSEMBLYAI_API_KEY = prevKey;
    process.env.ASSEMBLYAI_REGION = prevRegion;
  }
});

test("realtime close codes match documented values", () => {
  assert.equal(RealtimeCloseCode.Unauthorized, 1008);
  assert.equal(RealtimeCloseCode.SessionCancelled, 3005);
  assert.equal(RealtimeCloseCode.InvalidMessage, 3006);
  assert.equal(RealtimeCloseCode.BadAudioChunk, 3007);
  assert.equal(RealtimeCloseCode.SessionExpired, 3008);
  assert.equal(RealtimeCloseCode.TooManySessions, 3009);
});
