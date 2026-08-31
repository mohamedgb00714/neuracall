import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeConfig,
  getConfig,
  logStartupBanner,
  maskApiKey,
  type AppConfig,
} from "../src/index.js";

const KEY = "abcd1234efgh5678ijkl9012mnop3456";
const LLM_KEY = "llm-secret-key-should-never-print";
const TTS_KEY = "tts-secret-key-should-never-print";

function sampleConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  return getConfig({
    ASSEMBLYAI_API_KEY: KEY,
    ASSEMBLYAI_REGION: "eu",
    LLM_API_KEY: LLM_KEY,
    LLM_MODEL: "gpt-unit",
    ...overrides,
  });
}

test("maskApiKey shows only the first 4 characters", () => {
  assert.equal(maskApiKey(KEY), "abcd****");
  assert.equal(maskApiKey("abcdefghi"), "abcd****");
});

test("maskApiKey fully hides keys too short to partially reveal", () => {
  assert.equal(maskApiKey(""), "****");
  assert.equal(maskApiKey("abc"), "****");
  assert.equal(maskApiKey("abcdefgh"), "****");
});

test("describeConfig prints region, all endpoints and the speech model", () => {
  const banner = describeConfig(sampleConfig());
  assert.match(banner, /region: eu/);
  assert.match(banner, /https:\/\/api\.eu\.assemblyai\.com/);
  assert.match(banner, /streaming\.eu\.assemblyai\.com/);
  assert.match(banner, /https:\/\/streaming\.eu\.assemblyai\.com\/v3\/token/);
  assert.match(banner, /universal-3-5-pro/);
});

test("describeConfig masks the AssemblyAI key and never prints provider keys", () => {
  const banner = describeConfig(sampleConfig({ TTS_API_KEY: TTS_KEY, TTS_MODEL: "tts-1" }));
  assert.equal(banner.includes(KEY), false, "full API key leaked into banner");
  assert.match(banner, /abcd\*\*\*\*/);
  assert.equal(banner.includes(LLM_KEY), false, "LLM key leaked into banner");
  assert.equal(banner.includes(TTS_KEY), false, "TTS key leaked into banner");
  // Not even a partial of the optional keys
  assert.equal(banner.includes("llm-secret"), false);
  assert.equal(banner.includes("tts-secret"), false);
});

test("describeConfig reports which optional providers are configured", () => {
  const withLlmOnly = describeConfig(sampleConfig());
  assert.match(withLlmOnly, /llm=configured \(model=gpt-unit\)/);
  assert.match(withLlmOnly, /tts=not configured/);

  const none = describeConfig(sampleConfig({ LLM_API_KEY: "replace-me" }));
  assert.match(none, /llm=not configured/);

  const keyButNoModel = describeConfig(sampleConfig({ LLM_MODEL: "replace-me" }));
  assert.match(keyButNoModel, /llm=configured \(model unset\)/);
});

test("describeConfig flags edge as auto-routed with a hint to pin a region", () => {
  const banner = describeConfig(sampleConfig({ ASSEMBLYAI_REGION: undefined }));
  assert.match(banner, /region: edge \(auto-routed/);
  assert.match(banner, /ASSEMBLYAI_REGION=us\|eu/);
});

test("logStartupBanner writes the description to the provided sink", () => {
  const lines: string[] = [];
  const cfg = sampleConfig();
  logStartupBanner(cfg, (m) => lines.push(m));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], describeConfig(cfg));
  assert.equal(lines[0]?.includes(KEY), false);
  // Every line is prefixed so it can be grepped out of Electron's console.
  for (const line of lines[0]!.split("\n")) {
    assert.match(line, /^\[neuracall\]/);
  }
});

test("logStartupBanner defaults to console.log", () => {
  const original = console.log;
  const captured: unknown[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(...args);
  };
  try {
    logStartupBanner(sampleConfig());
  } finally {
    console.log = original;
  }
  assert.equal(captured.length, 1);
  assert.match(String(captured[0]), /AssemblyAI region: eu/);
  assert.equal(String(captured[0]).includes(KEY), false);
});
