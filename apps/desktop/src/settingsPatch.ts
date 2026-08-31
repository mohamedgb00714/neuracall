/**
 * The Settings form's state, and the mapping from it to the patch that crosses
 * IPC to the main process.
 *
 * This lives outside `SettingsPage.tsx` so it can be tested without rendering
 * anything — and that is not tidiness. Every section of `SettingsPatch` is
 * optional, so dropping a whole section from this mapping compiles cleanly and
 * leaves the rest of the suite green: the page goes on collecting input for
 * settings that are then silently discarded on the way out. There is no
 * symptom to notice — no error, no warning, just a control that does nothing.
 * A test can only watch for that if the mapping is reachable without React.
 */

// `./types.js`, with the extension, rather than the extensionless form its
// renderer neighbours use: this module is also compiled by the test project,
// which is nodenext and rejects an extensionless relative import. The import is
// type-only and therefore erased, so the bundler never resolves it either way.
import type {
  AssemblyAIRegion,
  SettingsPatch,
  TranscriptionMode,
  TtsProvider,
} from "./types.js";

/** How many keyterms the service will accept in one session. */
export const MAX_KEYTERMS = 100;

/** Form state. Numbers are held as strings so a half-typed value is not NaN. */
export interface Form {
  region: AssemblyAIRegion;
  speechModel: string;
  mode: TranscriptionMode;
  keyterms: string;
  voiceAgentEnabled: boolean;
  voiceAgentId: string;
  voiceAgentVoice: string;
  voiceAgentGreeting: string;
  voiceAgentSystemPrompt: string;
  llmApiKey: string;
  llmClearKey: boolean;
  llmModel: string;
  llmBaseUrl: string;
  llmSystemPrompt: string;
  llmGreeting: string;
  ttsProvider: TtsProvider;
  ttsApiKey: string;
  ttsClearKey: boolean;
  ttsModel: string;
  ttsVoice: string;
  ttsBaseUrl: string;
  captureSource: string;
  injectSink: string;
  maxCallMs: string;
  stallMs: string;
  defaultCountryCode: string;
  healthPort: string;
}

/** The numeric fields, already parsed and validated by the caller. */
export interface ParsedNumbers {
  maxCallMs: number;
  stallMs: number;
  healthPort: number | null;
}

/** Form state to the patch the main process will validate and store. */
export function toPatch(form: Form, terms: string[], numbers: ParsedNumbers): SettingsPatch {
  return {
    assemblyai: {
      region: form.region,
      speechModel: form.speechModel.trim(),
      mode: form.mode,
      keyterms: terms.slice(0, MAX_KEYTERMS),
    },
    voiceAgent: {
      enabled: form.voiceAgentEnabled,
      // Trimmed: a pasted uuid drags whitespace, and "" is what "configure the
      // agent inline" is spelled as — not a near-miss id the API 404s on.
      agentId: form.voiceAgentId.trim(),
      voice: form.voiceAgentVoice.trim(),
      // Prompts keep their whitespace: line breaks are how a prompt is written.
      greeting: form.voiceAgentGreeting,
      systemPrompt: form.voiceAgentSystemPrompt,
    },
    llm: {
      // Trimmed, so a stray pasted newline cannot become part of the key — and
      // whitespace-only input falls back to "" (leave the stored key).
      apiKey: form.llmClearKey ? null : form.llmApiKey.trim(),
      model: form.llmModel.trim(),
      baseUrl: form.llmBaseUrl.trim(),
      systemPrompt: form.llmSystemPrompt,
      greeting: form.llmGreeting,
    },
    tts: {
      provider: form.ttsProvider,
      apiKey: form.ttsClearKey ? null : form.ttsApiKey.trim(),
      model: form.ttsModel.trim(),
      voice: form.ttsVoice.trim(),
      baseUrl: form.ttsBaseUrl.trim(),
    },
    audio: {
      captureSource: form.captureSource.trim(),
      injectSink: form.injectSink.trim(),
    },
    autopilot: {
      maxCallMs: numbers.maxCallMs,
      stallMs: numbers.stallMs,
      defaultCountryCode: form.defaultCountryCode.trim(),
      healthPort: numbers.healthPort,
    },
  };
}
