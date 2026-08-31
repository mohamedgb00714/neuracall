import type { AppConfig } from "./types.js";

/** Prefix on every banner line so it is easy to grep in Electron/console logs. */
const PREFIX = "[neuracall]";

/** Number of leading characters of the API key that may appear in logs. */
const VISIBLE_KEY_CHARS = 4;

/**
 * Redact an API key for logging: the first 4 characters followed by "****".
 * Keys too short for that to hide anything (8 characters or fewer) are fully
 * masked. The output never contains the whole key.
 */
export function maskApiKey(key: string): string {
  if (key.length <= VISIBLE_KEY_CHARS * 2) return "****";
  return `${key.slice(0, VISIBLE_KEY_CHARS)}****`;
}

/**
 * Render a human-readable summary of the resolved configuration: region, the
 * three AssemblyAI endpoints derived from it, the speech model, and whether
 * the optional LLM / TTS providers are configured. The API key is masked and
 * optional-provider keys are never printed at all.
 */
export function describeConfig(config: AppConfig): string {
  const { assemblyai, llm, tts } = config;

  const regionNote =
    assemblyai.region === "edge"
      ? "edge (auto-routed; set ASSEMBLYAI_REGION=us|eu to pin data residency)"
      : assemblyai.region;

  const lines = [
    `${PREFIX} AssemblyAI region: ${regionNote}`,
    `${PREFIX}   REST base URL:   ${assemblyai.restBaseUrl}`,
    `${PREFIX}   realtime host:   ${assemblyai.realtimeHost}`,
    `${PREFIX}   token URL:       ${assemblyai.tokenUrl}`,
    `${PREFIX}   speech model:    ${assemblyai.speechModel}`,
    `${PREFIX}   API key:         ${maskApiKey(assemblyai.apiKey)}`,
    `${PREFIX} optional providers: llm=${describeProvider(llm)} tts=${describeProvider(tts)}`,
  ];
  return lines.join("\n");
}

/**
 * Log the startup banner. Accepts an injectable sink so callers can route it
 * to a file/structured logger and tests can capture it.
 */
export function logStartupBanner(
  config: AppConfig,
  log: (message: string) => void = console.log,
): void {
  log(describeConfig(config));
}

function describeProvider(provider: { apiKey?: string; model: string }): string {
  if (!provider.apiKey) return "not configured";
  const model = provider.model === "replace-me" ? "model unset" : `model=${provider.model}`;
  return `configured (${model})`;
}
