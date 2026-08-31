import { test } from "node:test";
import assert from "node:assert/strict";
import { VOICES as SERVICE_VOICES } from "@neuracall/aai-client";
import {
  SPOKEN_LANGUAGES,
  UNDERSTOOD_LANGUAGE_COUNT,
  VOICES,
  isKnownVoice,
  spokenLanguageList,
  voiceLabel,
} from "../src/voices.js";

/**
 * `apps/desktop/src/voices.ts` restates the service's voice catalogue because
 * importing it would drag `node:events` and `ws` into the renderer bundle and
 * fail the Rollup build. That restatement is only safe if something checks it.
 *
 * Its `Record<VoiceId, …>` annotation pins the *keys* — a voice added or
 * dropped upstream fails to compile. Nothing pins the *values*, and the values
 * are the dangerous half: the settings page derives its warning callout from
 * them, so a `language` typed wrong here makes the UI claim a language the
 * agent cannot speak. This app answers calls in Algeria and there is no Arabic
 * voice, so that particular sentence is the one an operator acts on.
 *
 * Hence a deep equality against the real catalogue rather than spot checks.
 */

test("the renderer catalogue is the service catalogue, value for value", () => {
  assert.deepEqual(
    VOICES.map((v) => ({ ...v })),
    SERVICE_VOICES.map((v) => ({ ...v })),
    "apps/desktop/src/voices.ts has drifted from packages/aai-client/src/voiceAgentAdmin.ts",
  );
});

test("every voice the service accepts is offered, and nothing else is", () => {
  for (const voice of SERVICE_VOICES) {
    assert.equal(isKnownVoice(voice.id), true, `${voice.id} is missing from the dropdown`);
  }
  assert.equal(isKnownVoice("nonesuch"), false);
  assert.equal(isKnownVoice(""), false);
  // Object.prototype keys must not read as voices: the check guards a value
  // that arrives from a settings file.
  assert.equal(isKnownVoice("toString"), false);
  assert.equal(isKnownVoice("constructor"), false);
});

test("the spoken-language warning states what the catalogue actually contains", () => {
  assert.deepEqual([...SPOKEN_LANGUAGES], [...new Set(SERVICE_VOICES.map((v) => v.language))]);

  // The claim the settings page prints, and the reason the file exists: the
  // agent understands far more languages than it can answer in.
  assert.ok(SPOKEN_LANGUAGES.length < UNDERSTOOD_LANGUAGE_COUNT);
  assert.equal(
    SPOKEN_LANGUAGES.some((l) => /arab/i.test(l)),
    false,
    "an Arabic voice would make the settings callout wrong, not merely stale",
  );

  const sentence = spokenLanguageList();
  for (const language of SPOKEN_LANGUAGES) {
    assert.ok(sentence.includes(language), `${language} is missing from "${sentence}"`);
  }
  // One "and", joining the last pair — the string is dropped into prose.
  assert.equal(sentence.split(" and ").length, 2);
});

test("a label distinguishes two voices that differ only by accent", () => {
  const anna = VOICES.find((v) => v.id === "anna");
  const alba = VOICES.find((v) => v.id === "alba");
  assert.ok(anna && alba, "anna and alba are both English voices in the catalogue");
  assert.notEqual(voiceLabel(anna), voiceLabel(alba));
  assert.equal(voiceLabel(anna), "anna — English (UK)");
  // A language with a single accent prints no parenthetical.
  const giovanni = VOICES.find((v) => v.id === "giovanni");
  assert.ok(giovanni);
  assert.equal(voiceLabel(giovanni), "giovanni — Italian");
});
