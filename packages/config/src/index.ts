import { loadEnv } from "./env.js";
import { endpointsForRegion, parseRegion, voiceAgentEndpointsForRegion } from "./endpoints.js";
import type { AppConfig, VoiceAgentSampleRate } from "./types.js";

/**
 * Validate and expose application configuration.
 *
 * Reads from environment (dotenv-loaded by callers via loadEnv()) and fails
 * fast at startup if required values are missing or malformed, so a
 * misconfigured install surfaces immediately instead of half-working.
 *
 * Region handling: ASSEMBLYAI_REGION selects every AssemblyAI endpoint at
 * once — REST base URL, realtime WebSocket host and the token-minting URL —
 * via endpointsForRegion(), so no consumer hard-codes a hostname. The same
 * region drives the Voice Agent hosts through voiceAgentEndpointsForRegion().
 */
export * from "./env.js";
export * from "./types.js";
export * from "./endpoints.js";
export * from "./banner.js";
export type { Region } from "./types.js";

/** Default realtime speech model when ASSEMBLYAI_SPEECH_MODEL is unset. */
export const DEFAULT_SPEECH_MODEL = "universal-3-5-pro";

/** Default Voice Agent voice when VOICE_AGENT_VOICE is unset. */
export const DEFAULT_VOICE_AGENT_VOICE = "alba";

/**
 * The Voice Agent input/output rate, in Hz. Exported as a value so call sites
 * resample against the config rather than a literal of their own, and typed as
 * VoiceAgentSampleRate so it cannot drift — see that type for the failure mode
 * a wrong rate produces.
 */
export const VOICE_AGENT_SAMPLE_RATE: VoiceAgentSampleRate = 24000;

/** Placeholder value used throughout .env.example; treated as "not set". */
const PLACEHOLDER = "replace-me";

/** Spellings accepted for boolean flags, matching common .env conventions. */
const TRUE_VALUES = ["1", "true", "yes", "on"];
const FALSE_VALUES = ["0", "false", "no", "off"];

/**
 * Load the full validated NeuraCall config. Call once at process startup.
 *
 * @param env Environment to read from. Defaults to process.env; tests pass an
 *            explicit object so they never mutate the real environment.
 */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const region = parseRegion(env.ASSEMBLYAI_REGION);
  const apiKey = requireApiKey(env, "ASSEMBLYAI_API_KEY");

  // Read into locals so each optional key is spread in only when actually set,
  // rather than assigned undefined — see optionalEnv().
  const agentId = optionalEnv(env, "VOICE_AGENT_ID");
  const greeting = optionalEnv(env, "VOICE_AGENT_GREETING");
  const systemPrompt = optionalEnv(env, "VOICE_AGENT_SYSTEM_PROMPT");
  const agentModel = optionalEnv(env, "VOICE_AGENT_LLM_MODEL");

  return {
    assemblyai: {
      apiKey,
      region,
      speechModel: optionalEnv(env, "ASSEMBLYAI_SPEECH_MODEL") ?? DEFAULT_SPEECH_MODEL,
      ...endpointsForRegion(region),
    },
    voiceAgent: {
      enabled: booleanEnv(env, "VOICE_AGENT_ENABLED", false),
      voice: optionalEnv(env, "VOICE_AGENT_VOICE") ?? DEFAULT_VOICE_AGENT_VOICE,
      sampleRate: VOICE_AGENT_SAMPLE_RATE,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(greeting !== undefined ? { greeting } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(agentModel !== undefined ? { model: agentModel } : {}),
      ...voiceAgentEndpointsForRegion(region),
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
    throw new Error(`${name} must be the raw AssemblyAI key without a "Bearer " prefix.`);
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

/**
 * Parse a boolean flag. An unrecognised spelling throws instead of falling back,
 * because the alternative is VOICE_AGENT_ENABLED=flase silently meaning "off"
 * and a feature that appears never to have been implemented.
 */
function booleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  throw new Error(
    `Invalid ${name}="${raw}". Expected one of: ` +
      `${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}.`,
  );
}
