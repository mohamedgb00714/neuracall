import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS_REST_PATH,
  AGENTS_TOKEN_PATH,
  AGENTS_WS_PATH,
  DEFAULT_VOICE_AGENT_VOICE,
  REGIONS,
  VOICE_AGENT_SAMPLE_RATE,
  getConfig,
  voiceAgentEndpointsForRegion,
} from "../src/index.js";

/** A value that passes the placeholder check but is obviously not a real key. */
const FAKE_KEY = "unit-test-not-a-real-key-0123456789";

/** getConfig() requires the AssemblyAI key, so every case carries it. */
function config(env: NodeJS.ProcessEnv = {}) {
  return getConfig({ ASSEMBLYAI_API_KEY: FAKE_KEY, ...env }).voiceAgent;
}

// ------------------------------------------------------------------- defaults

test("voiceAgent is off, voiced alba and pinned to 24 kHz when nothing is set", () => {
  const va = config();
  assert.equal(va.enabled, false);
  assert.equal(va.voice, "alba");
  assert.equal(va.voice, DEFAULT_VOICE_AGENT_VOICE);
  assert.equal(va.sampleRate, 24000);
});

test("optional voiceAgent fields are absent rather than undefined when unset", () => {
  const va = config();
  // Distinguishes "key missing" from "key present holding undefined" — the
  // latter would serialise into a session.update as an explicit null.
  assert.equal(Object.hasOwn(va, "agentId"), false);
  assert.equal(Object.hasOwn(va, "greeting"), false);
  assert.equal(Object.hasOwn(va, "systemPrompt"), false);
  assert.equal(Object.hasOwn(va, "model"), false);
});

test("the .env.example placeholder counts as unset for every voiceAgent field", () => {
  const va = config({
    VOICE_AGENT_ID: "replace-me",
    VOICE_AGENT_VOICE: "replace-me",
    VOICE_AGENT_GREETING: "replace-me",
    VOICE_AGENT_SYSTEM_PROMPT: "replace-me",
    VOICE_AGENT_LLM_MODEL: "replace-me",
  });
  assert.equal(va.voice, DEFAULT_VOICE_AGENT_VOICE);
  assert.equal(Object.hasOwn(va, "agentId"), false);
  assert.equal(Object.hasOwn(va, "model"), false);
});

// --------------------------------------------------------------- env override

test("every voiceAgent field is readable from the environment", () => {
  const va = config({
    VOICE_AGENT_ENABLED: "true",
    VOICE_AGENT_ID: "6f1c2b7e-0000-4a1b-9c3d-1234567890ab",
    VOICE_AGENT_VOICE: "vera",
    VOICE_AGENT_GREETING: "Thanks for calling NeuraBiz.",
    VOICE_AGENT_SYSTEM_PROMPT: "You are a receptionist. One sentence per reply.",
    VOICE_AGENT_LLM_MODEL: "qwen3.5-4b-32k-fast",
  });
  assert.equal(va.enabled, true);
  assert.equal(va.agentId, "6f1c2b7e-0000-4a1b-9c3d-1234567890ab");
  assert.equal(va.voice, "vera");
  assert.equal(va.greeting, "Thanks for calling NeuraBiz.");
  assert.equal(va.systemPrompt, "You are a receptionist. One sentence per reply.");
  assert.equal(va.model, "qwen3.5-4b-32k-fast");
});

test("VOICE_AGENT_ENABLED accepts the usual truthy and falsy spellings", () => {
  for (const on of ["1", "true", "TRUE", "yes", "on", " True "]) {
    assert.equal(config({ VOICE_AGENT_ENABLED: on }).enabled, true, on);
  }
  for (const off of ["0", "false", "FALSE", "no", "off"]) {
    assert.equal(config({ VOICE_AGENT_ENABLED: off }).enabled, false, off);
  }
});

test("a misspelled VOICE_AGENT_ENABLED throws instead of silently meaning off", () => {
  assert.throws(
    () => config({ VOICE_AGENT_ENABLED: "flase" }),
    /Invalid VOICE_AGENT_ENABLED="flase"/,
  );
  assert.throws(() => config({ VOICE_AGENT_ENABLED: "enabled" }), /1, true, yes, on/);
});

test("string voiceAgent values are trimmed like the rest of the config", () => {
  const va = config({ VOICE_AGENT_VOICE: "  george  ", VOICE_AGENT_ID: "  agent-1  " });
  assert.equal(va.voice, "george");
  assert.equal(va.agentId, "agent-1");
});

// ---------------------------------------------------------------- sample rate

test("the sample rate is 24000 regardless of what the environment says", () => {
  // No env var reads it on purpose: 16000 is accepted by the API and then fails
  // at session start as a misleading "internal_error", so it must be unreachable.
  assert.equal(config({ VOICE_AGENT_SAMPLE_RATE: "16000" }).sampleRate, 24000);
  assert.equal(config({ ASSEMBLYAI_REGION: "eu" }).sampleRate, 24000);
  assert.equal(VOICE_AGENT_SAMPLE_RATE, 24000);
});

// ------------------------------------------------- voiceAgentEndpointsForRegion

test("voiceAgentEndpointsForRegion picks the US agents host", () => {
  const ep = voiceAgentEndpointsForRegion("us");
  assert.equal(ep.restBaseUrl, "https://agents.us.assemblyai.com/v1");
  assert.equal(ep.wsUrl, "wss://agents.us.assemblyai.com/v1/ws");
  assert.equal(ep.tokenUrl, "https://agents.us.assemblyai.com/v1/token");
});

test("voiceAgentEndpointsForRegion picks the EU agents host for every endpoint", () => {
  const ep = voiceAgentEndpointsForRegion("eu");
  assert.equal(ep.restBaseUrl, "https://agents.eu.assemblyai.com/v1");
  assert.equal(ep.wsUrl, "wss://agents.eu.assemblyai.com/v1/ws");
  assert.equal(ep.tokenUrl, "https://agents.eu.assemblyai.com/v1/token");
});

test("voiceAgentEndpointsForRegion edge uses the auto-routed agents host", () => {
  const ep = voiceAgentEndpointsForRegion("edge");
  assert.equal(ep.restBaseUrl, "https://agents.assemblyai.com/v1");
  assert.equal(ep.wsUrl, "wss://agents.assemblyai.com/v1/ws");
  assert.equal(ep.tokenUrl, "https://agents.assemblyai.com/v1/token");
});

test("all three agent URLs share one host and carry the right scheme and path", () => {
  for (const region of REGIONS) {
    const ep = voiceAgentEndpointsForRegion(region);
    const rest = new URL(ep.restBaseUrl);
    const ws = new URL(ep.wsUrl);
    const token = new URL(ep.tokenUrl);

    assert.equal(rest.protocol, "https:");
    // wss:, never ws: — the socket carries the API key or a minted token.
    assert.equal(ws.protocol, "wss:");
    assert.equal(token.protocol, "https:");

    assert.equal(ws.host, rest.host);
    assert.equal(token.host, rest.host);
    assert.match(rest.host, /^agents(\.(us|eu))?\.assemblyai\.com$/);

    assert.equal(rest.pathname, AGENTS_REST_PATH);
    assert.equal(ws.pathname, AGENTS_WS_PATH);
    assert.equal(token.pathname, AGENTS_TOKEN_PATH);
    // The agents token path is /v1/token; the streaming one is /v3/token.
    assert.equal(token.pathname, "/v1/token");
    // No trailing slash — callers append "/agents" to restBaseUrl.
    assert.equal(ep.restBaseUrl.endsWith("/"), false);
  }
});

test("agent endpoints are distinct per region so residency is not silently lost", () => {
  const hosts = REGIONS.map((r) => new URL(voiceAgentEndpointsForRegion(r).restBaseUrl).host);
  assert.equal(new Set(hosts).size, REGIONS.length);
});

test("the agents hosts never collide with the transcription hosts", () => {
  const cfg = getConfig({ ASSEMBLYAI_API_KEY: FAKE_KEY, ASSEMBLYAI_REGION: "eu" });
  assert.notEqual(cfg.voiceAgent.restBaseUrl, cfg.assemblyai.restBaseUrl);
  assert.notEqual(cfg.voiceAgent.tokenUrl, cfg.assemblyai.tokenUrl);
  assert.doesNotMatch(cfg.voiceAgent.wsUrl, /streaming\./);
});

// ------------------------------------------------- region wiring via getConfig

test("getConfig derives the agent endpoints from ASSEMBLYAI_REGION", () => {
  const eu = config({ ASSEMBLYAI_REGION: "eu" });
  assert.equal(eu.wsUrl, "wss://agents.eu.assemblyai.com/v1/ws");
  assert.equal(eu.restBaseUrl, "https://agents.eu.assemblyai.com/v1");

  const us = config({ ASSEMBLYAI_REGION: "us" });
  assert.equal(us.wsUrl, "wss://agents.us.assemblyai.com/v1/ws");

  // Unset region falls through to edge, exactly as the transcription hosts do.
  assert.equal(config().wsUrl, "wss://agents.assemblyai.com/v1/ws");
});

test("getConfig gives voiceAgent the same region as assemblyai", () => {
  for (const region of REGIONS) {
    const cfg = getConfig({ ASSEMBLYAI_API_KEY: FAKE_KEY, ASSEMBLYAI_REGION: region });
    assert.deepEqual(
      {
        restBaseUrl: cfg.voiceAgent.restBaseUrl,
        wsUrl: cfg.voiceAgent.wsUrl,
        tokenUrl: cfg.voiceAgent.tokenUrl,
      },
      voiceAgentEndpointsForRegion(region),
    );
  }
});

test("an invalid region rejects before any agent endpoint is built", () => {
  assert.throws(() => config({ ASSEMBLYAI_REGION: "mars" }), /Invalid ASSEMBLYAI_REGION="mars"/);
});
