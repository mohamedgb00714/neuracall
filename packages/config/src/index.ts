import { loadEnv } from "./env.js";
import type { AppConfig, Region } from "./types.js";

/**
 * Validate and expose application configuration.
 *
 * Reads from environment (dotenv-loaded by callers via loadEnv()) and fails
 * fast at startup if required values are missing or malformed, so a
 * misconfigured install surfaces immediately instead of half-working.
 */
export * from "./env.js";
export * from "./types.js";
export type { Region } from "./types.js";

/** Load the full validated NeuraCall config. Call once at process startup. */
export function getConfig(): AppConfig {
  const region = regionFromEnv(process.env.ASSEMBLYAI_REGION);
  const apiKey = requireEnv("ASSEMBLYAI_API_KEY");

  return {
    assemblyai: {
      apiKey,
      region,
      speechModel: process.env.ASSEMBLYAI_SPEECH_MODEL ?? "universal-3-5-pro",
      restBaseUrl: region === "eu" ? "https://api.eu.assemblyai.com" : "https://api.assemblyai.com",
      realtimeHost:
        region === "eu"
          ? "streaming.eu.assemblyai.com"
          : region === "us"
            ? "streaming.us.assemblyai.com"
            : "streaming.assemblyai.com", // edge-routed default
    },
    llm: {
      apiKey: optionalEnv("LLM_API_KEY"),
      model: process.env.LLM_MODEL ?? "replace-me",
    },
    tts: {
      apiKey: optionalEnv("TTS_API_KEY"),
      model: process.env.TTS_MODEL ?? "replace-me",
    },
  };
}

function regionFromEnv(raw: string | undefined): Region {
  const value = (raw ?? "edge").toLowerCase().trim();
  if (value === "us" || value === "eu") return value;
  if (value === "edge" || value === "") return "edge";
  throw new Error(
    `Invalid ASSEMBLYAI_REGION="${raw}". Expected "us", "eu", or "edge".`,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "" || value.includes("replace-me")) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and set it, or export it before starting.`,
    );
  }
  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.includes("replace-me")) return undefined;
  return value.trim();
}
