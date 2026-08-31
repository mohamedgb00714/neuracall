import { loadEnv } from "./env.js";
import { endpointsForRegion, parseRegion } from "./endpoints.js";
import type { AppConfig } from "./types.js";

/**
 * Validate and expose application configuration.
 *
 * Reads from environment (dotenv-loaded by callers via loadEnv()) and fails
 * fast at startup if required values are missing or malformed, so a
 * misconfigured install surfaces immediately instead of half-working.
 *
 * Region handling: ASSEMBLYAI_REGION selects every AssemblyAI endpoint at
 * once — REST base URL, realtime WebSocket host and the token-minting URL —
 * via endpointsForRegion(), so no consumer hard-codes a hostname.
 */
export * from "./env.js";
export * from "./types.js";
export * from "./endpoints.js";
export * from "./banner.js";
export type { Region } from "./types.js";

/** Default realtime speech model when ASSEMBLYAI_SPEECH_MODEL is unset. */
export const DEFAULT_SPEECH_MODEL = "universal-3-5-pro";

/** Placeholder value used throughout .env.example; treated as "not set". */
const PLACEHOLDER = "replace-me";

/**
 * Load the full validated NeuraCall config. Call once at process startup.
 *
 * @param env Environment to read from. Defaults to process.env; tests pass an
 *            explicit object so they never mutate the real environment.
 */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const region = parseRegion(env.ASSEMBLYAI_REGION);
  const apiKey = requireApiKey(env, "ASSEMBLYAI_API_KEY");

  return {
    assemblyai: {
      apiKey,
      region,
      speechModel: optionalEnv(env, "ASSEMBLYAI_SPEECH_MODEL") ?? DEFAULT_SPEECH_MODEL,
      ...endpointsForRegion(region),
    },
    llm: {
      apiKey: optionalEnv(env, "LLM_API_KEY"),
      model: env.LLM_MODEL ?? PLACEHOLDER,
    },
    tts: {
      apiKey: optionalEnv(env, "TTS_API_KEY"),
      model: env.TTS_MODEL ?? PLACEHOLDER,
    },
  };
}

/** Load .env (if present) and return the validated config in one call. */
export function loadConfig(envFile?: string): AppConfig {
  loadEnv(envFile);
  return getConfig();
}

function requireApiKey(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (!raw || raw.trim() === "" || raw.includes(PLACEHOLDER)) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and set it, or export it before starting.`,
    );
  }
  const value = raw.trim();
  if (/^bearer\s/i.test(value)) {
    throw new Error(
      `${name} must be the raw AssemblyAI key without a "Bearer " prefix.`,
    );
  }
  if (/\s/.test(value)) {
    throw new Error(`${name} must not contain whitespace.`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (!value || value.trim() === "" || value.includes(PLACEHOLDER)) return undefined;
  return value.trim();
}
