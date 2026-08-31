import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REGION,
  DEFAULT_SPEECH_MODEL,
  REGIONS,
  TOKEN_PATH,
  endpointsForRegion,
  getConfig,
  parseRegion,
} from "../src/index.js";

/** A value that passes the placeholder check but is obviously not a real key. */
const FAKE_KEY = "unit-test-not-a-real-key-0123456789";

// ---------------------------------------------------------------- parseRegion

test("parseRegion accepts us / eu / edge case-insensitively and trims", () => {
  assert.equal(parseRegion("us"), "us");
  assert.equal(parseRegion("eu"), "eu");
  assert.equal(parseRegion("edge"), "edge");
  assert.equal(parseRegion(" EU "), "eu");
  assert.equal(parseRegion("Us"), "us");
});

test("parseRegion defaults to edge when unset or blank", () => {
  assert.equal(parseRegion(undefined), "edge");
  assert.equal(parseRegion(""), "edge");
  assert.equal(parseRegion("   "), "edge");
  assert.equal(DEFAULT_REGION, "edge");
});

test("parseRegion rejects unknown regions with a helpful message", () => {
  assert.throws(() => parseRegion("asia"), /Invalid ASSEMBLYAI_REGION="asia"/);
  assert.throws(() => parseRegion("us-east-1"), /us, eu, edge/);
  assert.throws(() => parseRegion("europe"), /Invalid ASSEMBLYAI_REGION/);
});

// --------------------------------------------------------- endpointsForRegion

test("endpointsForRegion picks the US cluster", () => {
  const ep = endpointsForRegion("us");
  assert.equal(ep.restBaseUrl, "https://api.assemblyai.com");
  assert.equal(ep.realtimeHost, "streaming.us.assemblyai.com");
  assert.equal(ep.tokenUrl, "https://streaming.us.assemblyai.com/v3/token");
});

test("endpointsForRegion picks the EU cluster for every endpoint", () => {
  const ep = endpointsForRegion("eu");
  assert.equal(ep.restBaseUrl, "https://api.eu.assemblyai.com");
  assert.equal(ep.realtimeHost, "streaming.eu.assemblyai.com");
  assert.equal(ep.tokenUrl, "https://streaming.eu.assemblyai.com/v3/token");
});

test("endpointsForRegion edge uses US REST and the auto-routed streaming host", () => {
  const ep = endpointsForRegion("edge");
  assert.equal(ep.restBaseUrl, "https://api.assemblyai.com");
  assert.equal(ep.realtimeHost, "streaming.assemblyai.com");
  assert.equal(ep.tokenUrl, "https://streaming.assemblyai.com/v3/token");
});

test("token URL is always the realtime host plus the v3 token path", () => {
  for (const region of REGIONS) {
    const ep = endpointsForRegion(region);
    const parsed = new URL(ep.tokenUrl);
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.host, ep.realtimeHost);
    assert.equal(parsed.pathname, TOKEN_PATH);
    // realtimeHost is a bare hostname (aai-client prepends wss:// itself)
    assert.doesNotMatch(ep.realtimeHost, /^[a-z]+:\/\//);
    assert.doesNotMatch(ep.realtimeHost, /\//);
  }
});

// ------------------------------------------------------------------ getConfig

test("getConfig reads both vars and derives all three endpoints from region", () => {
  const cfg = getConfig({ ASSEMBLYAI_API_KEY: FAKE_KEY, ASSEMBLYAI_REGION: "eu" });
  assert.equal(cfg.assemblyai.apiKey, FAKE_KEY);
  assert.equal(cfg.assemblyai.region, "eu");
  assert.equal(cfg.assemblyai.restBaseUrl, "https://api.eu.assemblyai.com");
  assert.equal(cfg.assemblyai.realtimeHost, "streaming.eu.assemblyai.com");
  assert.equal(cfg.assemblyai.tokenUrl, "https://streaming.eu.assemblyai.com/v3/token");
});

test("getConfig region=us", () => {
  const cfg = getConfig({ ASSEMBLYAI_API_KEY: FAKE_KEY, ASSEMBLYAI_REGION: "us" });
  assert.equal(cfg.assemblyai.region, "us");
  assert.equal(cfg.assemblyai.restBaseUrl, "https://api.assemblyai.com");
  assert.equal(cfg.assemblyai.realtimeHost, "streaming.us.assemblyai.com");
  assert.equal(cfg.assemblyai.tokenUrl, "https://streaming.us.assemblyai.com/v3/token");
});

test("getConfig defaults to edge + flagship model when region/model unset", () => {
  const cfg = getConfig({ ASSEMBLYAI_API_KEY: FAKE_KEY });
  assert.equal(cfg.assemblyai.region, "edge");
  assert.equal(cfg.assemblyai.realtimeHost, "streaming.assemblyai.com");
  assert.equal(cfg.assemblyai.speechModel, DEFAULT_SPEECH_MODEL);
  assert.equal(cfg.assemblyai.speechModel, "universal-3-5-pro");
});

test("getConfig honours ASSEMBLYAI_SPEECH_MODEL and trims the key", () => {
  const cfg = getConfig({
    ASSEMBLYAI_API_KEY: `  ${FAKE_KEY}  `,
    ASSEMBLYAI_SPEECH_MODEL: "universal-3-5-pro",
  });
  assert.equal(cfg.assemblyai.apiKey, FAKE_KEY);
  assert.equal(cfg.assemblyai.speechModel, "universal-3-5-pro");
});

test("getConfig throws on invalid region", () => {
  assert.throws(
    () => getConfig({ ASSEMBLYAI_API_KEY: FAKE_KEY, ASSEMBLYAI_REGION: "mars" }),
    /Invalid ASSEMBLYAI_REGION="mars"/,
  );
});

test("getConfig throws when the key is missing", () => {
  assert.throws(() => getConfig({}), /Missing required environment variable ASSEMBLYAI_API_KEY/);
  assert.throws(() => getConfig({ ASSEMBLYAI_API_KEY: "" }), /ASSEMBLYAI_API_KEY/);
  assert.throws(() => getConfig({ ASSEMBLYAI_API_KEY: "   " }), /ASSEMBLYAI_API_KEY/);
});

test("getConfig throws on the .env.example placeholder", () => {
  assert.throws(() => getConfig({ ASSEMBLYAI_API_KEY: "replace-me" }), /ASSEMBLYAI_API_KEY/);
  assert.throws(
    () => getConfig({ ASSEMBLYAI_API_KEY: "sk-replace-me-later" }),
    /ASSEMBLYAI_API_KEY/,
  );
});

test("getConfig rejects a key with a Bearer prefix or embedded whitespace", () => {
  assert.throws(
    () => getConfig({ ASSEMBLYAI_API_KEY: `Bearer ${FAKE_KEY}` }),
    /without a "Bearer " prefix/,
  );
  assert.throws(
    () => getConfig({ ASSEMBLYAI_API_KEY: "abcd efgh" }),
    /must not contain whitespace/,
  );
});

test("getConfig treats optional provider placeholders as not configured", () => {
  const cfg = getConfig({
    ASSEMBLYAI_API_KEY: FAKE_KEY,
    LLM_API_KEY: "replace-me",
    LLM_MODEL: "replace-me",
    TTS_API_KEY: "tts-unit-test-key",
    TTS_MODEL: "tts-1",
  });
  assert.equal(cfg.llm.apiKey, undefined);
  assert.equal(cfg.llm.model, "replace-me");
  assert.equal(cfg.tts.apiKey, "tts-unit-test-key");
  assert.equal(cfg.tts.model, "tts-1");
});

test("getConfig reads process.env by default", () => {
  const prev = {
    key: process.env.ASSEMBLYAI_API_KEY,
    region: process.env.ASSEMBLYAI_REGION,
  };
  try {
    process.env.ASSEMBLYAI_API_KEY = FAKE_KEY;
    process.env.ASSEMBLYAI_REGION = "eu";
    const cfg = getConfig();
    assert.equal(cfg.assemblyai.region, "eu");
    assert.equal(cfg.assemblyai.apiKey, FAKE_KEY);

    delete process.env.ASSEMBLYAI_API_KEY;
    assert.throws(() => getConfig(), /ASSEMBLYAI_API_KEY/);
  } finally {
    restoreEnv("ASSEMBLYAI_API_KEY", prev.key);
    restoreEnv("ASSEMBLYAI_REGION", prev.region);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
