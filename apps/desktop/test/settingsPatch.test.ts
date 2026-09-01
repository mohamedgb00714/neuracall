/**
 * Does what the operator typed actually reach the service?
 *
 * Every section of `SettingsPatch` is optional, so deleting a whole section
 * from the save mapping compiles cleanly and leaves the rest of the suite
 * green — the UI goes on accepting input for settings that are then silently
 * dropped on the way to IPC. That failure has no symptom to notice: no error,
 * no warning, just a toggle that does nothing.
 *
 * `toPatch` is pure and exported precisely so this can be checked without a
 * renderer. These tests are about the *mapping*, not about React.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { toPatch, type Form } from "../src/settingsPatch.js";

const NUMBERS = { maxCallMs: 600_000, stallMs: 30_000, healthPort: null };

function form(overrides: Partial<Form> = {}): Form {
  return {
    region: "edge",
    speechModel: "universal-3-5-pro",
    mode: "balanced",
    keyterms: "",
    voiceAgentEnabled: false,
    voiceAgentId: "",
    voiceAgentVoice: "alba",
    voiceAgentGreeting: "",
    voiceAgentSystemPrompt: "",
    llmApiKey: "",
    llmClearKey: false,
    llmModel: "",
    llmBaseUrl: "",
    llmSystemPrompt: "",
    llmGreeting: "",
    ttsProvider: "auto",
    ttsApiKey: "",
    ttsClearKey: false,
    ttsModel: "",
    ttsVoice: "",
    ttsBaseUrl: "",
    captureSource: "",
    injectSink: "",
    maxCallMs: "600000",
    stallMs: "30000",
    defaultCountryCode: "",
    healthPort: "",
    ...overrides,
  } as Form;
}

test("every section the form collects reaches the patch", () => {
  // The regression this file exists for: a section dropped from the mapping is
  // a compile-clean, test-clean, entirely silent loss of settings.
  const patch = toPatch(form(), [], NUMBERS);
  for (const section of ["assemblyai", "voiceAgent", "llm", "tts", "audio", "autopilot"]) {
    assert.ok(section in patch, `the "${section}" section never reaches the service`);
  }
});

test("the Voice Agent settings the operator typed are the ones sent", () => {
  const patch = toPatch(
    form({
      voiceAgentEnabled: true,
      voiceAgentId: "11111111-2222-3333-4444-555555555555",
      voiceAgentVoice: "estelle",
      voiceAgentGreeting: "Bonjour.",
      voiceAgentSystemPrompt: "Be brief.",
    }),
    [],
    NUMBERS,
  );

  assert.deepEqual(patch.voiceAgent, {
    enabled: true,
    agentId: "11111111-2222-3333-4444-555555555555",
    voice: "estelle",
    greeting: "Bonjour.",
    systemPrompt: "Be brief.",
  });
});

test("a pasted agent id keeps none of its whitespace", () => {
  // Pasted uuids drag spaces and newlines, and the service answers a near-miss
  // id with a 404 at session start rather than at save time.
  const patch = toPatch(form({ voiceAgentId: "  abc-123\n" }), [], NUMBERS);
  assert.equal(patch.voiceAgent?.agentId, "abc-123");
});

test("prompts keep their line breaks", () => {
  // Trimming a prompt the way ids are trimmed would quietly reflow it; line
  // breaks are how a system prompt is written.
  const prompt = "Line one.\n\nLine two.";
  const patch = toPatch(
    form({ voiceAgentSystemPrompt: prompt, voiceAgentGreeting: prompt }),
    [],
    NUMBERS,
  );
  assert.equal(patch.voiceAgent?.systemPrompt, prompt);
  assert.equal(patch.voiceAgent?.greeting, prompt);
});

test("an empty agent id stays empty rather than becoming a bad id", () => {
  // "" is how "configure the agent inline" is spelled; it must survive as "".
  const patch = toPatch(form({ voiceAgentId: "   " }), [], NUMBERS);
  assert.equal(patch.voiceAgent?.agentId, "");
});

test("clearing a key sends null, not an empty string", () => {
  // "" means "leave the stored key alone", so it cannot also mean "delete it".
  const cleared = toPatch(form({ llmClearKey: true, ttsClearKey: true }), [], NUMBERS);
  assert.equal(cleared.llm?.apiKey, null);
  assert.equal(cleared.tts?.apiKey, null);

  const untouched = toPatch(form(), [], NUMBERS);
  assert.equal(untouched.llm?.apiKey, "");
  assert.equal(untouched.tts?.apiKey, "");
});
