/**
 * The Voice Agent voice catalogue, plus the two facts an operator has to be
 * told before choosing from it.
 *
 * WHY THIS IS NOT `import { VOICES } from "@neuracall/aai-client"`: that entry
 * point reaches `node:events`, `node:timers/promises` and `ws` through
 * voiceAgent.js, and this is a browser bundle — Rollup fails the renderer build
 * outright ("EventEmitter is not exported by __vite-browser-external"). The
 * only other route is an IPC channel, which is a lot of machinery for a
 * constant. So the table is restated here, in the renderer.
 *
 * Restating it does not lose the guarantee it was written for. VOICE_TABLE is
 * keyed by aai-client's `VoiceId` union, imported as a *type* — erased at
 * build, so it drags in no runtime code — which means a voice added, renamed or
 * dropped upstream fails to compile here instead of quietly disappearing from
 * the dropdown.
 *
 * The language facts below are derived from the table rather than written out,
 * because they are the part that actually matters: this app answers calls in
 * Algeria, and the agent has no Arabic voice. A hand-written list that drifted
 * from the catalogue would be worse than none.
 */

import type { VoiceId, VoiceOption } from "@neuracall/aai-client";

/** Mirrors VOICE_TABLE in packages/aai-client/src/voiceAgentAdmin.ts. */
const VOICE_TABLE: Record<VoiceId, Omit<VoiceOption, "id">> = {
  alba: { language: "English", languageCode: "en-US", accent: "US" },
  eve: { language: "English", languageCode: "en-US", accent: "US" },
  george: { language: "English", languageCode: "en-US", accent: "US" },
  jane: { language: "English", languageCode: "en-US", accent: "US" },
  jean: { language: "English", languageCode: "en-US", accent: "US" },
  mary: { language: "English", languageCode: "en-US", accent: "US" },
  michael: { language: "English", languageCode: "en-US", accent: "US" },
  anna: { language: "English", languageCode: "en-GB", accent: "UK" },
  charles: { language: "English", languageCode: "en-GB", accent: "UK" },
  paul: { language: "English", languageCode: "en-GB", accent: "UK" },
  vera: { language: "English", languageCode: "en-GB", accent: "UK" },
  giovanni: { language: "Italian", languageCode: "it-IT", accent: "" },
  lola: { language: "Spanish", languageCode: "es-ES", accent: "" },
  juergen: { language: "German", languageCode: "de-DE", accent: "" },
  rafael: { language: "Portuguese", languageCode: "pt-BR", accent: "" },
  estelle: { language: "French", languageCode: "fr-FR", accent: "" },
};

/** Every voice the API accepts, grouped by language through ordering alone. */
export const VOICES: readonly VoiceOption[] = (Object.keys(VOICE_TABLE) as VoiceId[]).map((id) => ({
  id,
  ...VOICE_TABLE[id],
}));

/** One dropdown row: "alba — English (US)", "giovanni — Italian". */
export function voiceLabel(voice: VoiceOption): string {
  return voice.accent === ""
    ? `${voice.id} — ${voice.language}`
    : `${voice.id} — ${voice.language} (${voice.accent})`;
}

/** True when a stored setting still names a voice the API would accept. */
export function isKnownVoice(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(VOICE_TABLE, id);
}

/** The languages the agent can SPEAK. Six, against the 18 it understands. */
export const SPOKEN_LANGUAGES: readonly string[] = [...new Set(VOICES.map((v) => v.language))];

/** How many languages the agent can UNDERSTAND. Recognition is the long list. */
export const UNDERSTOOD_LANGUAGE_COUNT = 18;

/** "English, Italian, Spanish, German, Portuguese and French". */
export function spokenLanguageList(): string {
  const all = [...SPOKEN_LANGUAGES];
  const last = all.pop();
  if (last === undefined) return "";
  return all.length === 0 ? last : `${all.join(", ")} and ${last}`;
}
