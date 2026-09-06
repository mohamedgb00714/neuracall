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

  const languageCodes = listEnv(env, "ASSEMBLYAI_LANGUAGE_CODES");
  const vadThreshold = numberEnv(env, "ASSEMBLYAI_VAD_THRESHOLD", 0, 1);
  const minTurnSilence = numberEnv(env, "ASSEMBLYAI_MIN_TURN_SILENCE", 50, 10000, {
    integer: true,
  });
  const maxTurnSilence = numberEnv(env, "ASSEMBLYAI_MAX_TURN_SILENCE", 50, 10000, {
    integer: true,
  });
  const sessionHeartbeat = booleanEnv(env, "ASSEMBLYAI_SESSION_HEARTBEAT", false);

  return {
    assemblyai: {
      apiKey,
      region,
      speechModel: optionalEnv(env, "ASSEMBLYAI_SPEECH_MODEL") ?? DEFAULT_SPEECH_MODEL,
      ...(languageCodes !== undefined ? { languageCodes } : {}),
      ...(vadThreshold !== undefined ? { vadThreshold } : {}),
      ...(minTurnSilence !== undefined ? { minTurnSilence } : {}),
      ...(maxTurnSilence !== undefined ? { maxTurnSilence } : {}),
      // Heartbeat is a domain flag: "off" and "not set" both mean "do not ask
      // for Heartbeats", so only the on-state is worth carrying.
      ...(sessionHeartbeat ? { sessionHeartbeat: true } : {}),
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

/**
 * A comma-separated list from the environment. Blank entries are dropped, and a
 * list that ends up empty reads as unset — same lenience as a blank variable,
 * so an absent or half-erased ASSEMBLYAI_LANGUAGE_CODES never becomes an error.
 */
function listEnv(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return undefined;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length > 0 ? entries : undefined;
}

/**
 * A bounded number from the environment. An unrecognised spelling throws rather
 * than falling back, for the same reason booleanEnv does: a typo'd
 * `ASSEMBLYAI_VAD_THRESHOLD=o.5` must not silently mean "service default".
 */
function numberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
  opts: { integer?: boolean } = {},
): number | undefined {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= min &&
    parsed <= max &&
    (!opts.integer || Number.isInteger(parsed));
  if (!valid) {
    throw new Error(
      `Invalid ${name}="${raw}". Expected a ${opts.integer ? "whole " : ""}number ` +
        `between ${min} and ${max}.`,
    );
  }
  return parsed;
}
