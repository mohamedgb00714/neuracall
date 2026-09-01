import type { AssemblyAIEndpoints, Region, VoiceAgentEndpoints } from "./types.js";

/** All accepted ASSEMBLYAI_REGION values (case-insensitive). */
export const REGIONS: readonly Region[] = ["us", "eu", "edge"];

/** Region used when ASSEMBLYAI_REGION is unset or blank. */
export const DEFAULT_REGION: Region = "edge";

/**
 * The single source of truth for AssemblyAI hostnames per region.
 *
 * REST: only US and EU clusters exist; "edge" uses the US REST host.
 * Realtime: each region has its own streaming host; "edge" is the
 * geographically-routed default that AssemblyAI documents as the primary
 * Universal-Streaming URL.
 * Token minting: always served by the realtime host under /v3/token.
 */
const REST_HOST: Record<Region, string> = {
  us: "https://api.assemblyai.com",
  eu: "https://api.eu.assemblyai.com",
  edge: "https://api.assemblyai.com",
};

const REALTIME_HOST: Record<Region, string> = {
  us: "streaming.us.assemblyai.com",
  eu: "streaming.eu.assemblyai.com",
  edge: "streaming.assemblyai.com",
};

/** Path of the temporary-token endpoint, relative to the realtime host. */
export const TOKEN_PATH = "/v3/token";

/**
 * Voice Agent hostnames per region. A separate host family from the
 * transcription API — agents.* serves /v1/{agents,ws,token} and nothing else.
 *
 * All three were probed directly. Each serves the whole surface: /v1/agents
 * answers `{"code":"missing_authorization"}` (401), /v1/ws answers 426 Upgrade
 * Required, /v1/token answers 422 naming the missing authorization header, and
 * an unknown path under /v1 answers a clean `{"code":"not_found"}` — so the
 * paths below are real routes on every host, not a catch-all.
 *
 * agents.us presents CN=*.usw2.assemblyai.com and agents.eu CN=*.euw1, on
 * different addresses, so "us" and "eu" are genuinely different clusters and
 * ASSEMBLYAI_REGION does buy real residency on the agent path.
 *
 * "edge" is the caveat, and it is the DEFAULT region. agents.assemblyai.com is
 * geo-routed: probed from Europe it returns the *same* addresses and the same
 * *.euw1 certificate as agents.eu, i.e. it is the EU cluster there. Meanwhile
 * REST_HOST maps "edge" to the US api.assemblyai.com and the LLM gateway
 * follows REST. So under the default region, transcription and the gateway sit
 * in the US while a Voice Agent session may sit in the EU. That asymmetry is
 * intentional — agents.assemblyai.com is the only agents host AssemblyAI
 * documents, and pinning "edge" to agents.us would silently override the
 * routing they do — but an operator who needs one jurisdiction for the whole
 * call must set ASSEMBLYAI_REGION explicitly to "us" or "eu", not leave it at
 * "edge". The wildcard cert covers *.assemblyai.com, so TLS never objects and
 * nothing about a cross-region setup fails loudly.
 *
 * NOT verified: whether a stored agent created against one region is visible
 * from another. Assume the agent store is per-region — create the agent and
 * open its sessions through the SAME configured region, or a valid
 * VOICE_AGENT_ID will 404 for reasons that have nothing to do with the uuid.
 */
const AGENTS_HOST: Record<Region, string> = {
  us: "agents.us.assemblyai.com",
  eu: "agents.eu.assemblyai.com",
  edge: "agents.assemblyai.com",
};

/** Path of the Voice Agent session WebSocket, relative to the agents host. */
export const AGENTS_WS_PATH = "/v1/ws";

/** Path prefix of the Voice Agent REST surface (agent CRUD hangs off this). */
export const AGENTS_REST_PATH = "/v1";

/**
 * Path of the Voice Agent browser-token endpoint. Deliberately not TOKEN_PATH:
 * the streaming API mints tokens at /v3/token, the agents API at /v1/token, and
 * crossing them yields a 404 that looks like an auth failure.
 */
export const AGENTS_TOKEN_PATH = "/v1/token";

/**
 * Parse the raw ASSEMBLYAI_REGION value. Empty/undefined falls back to
 * "edge"; anything else that is not a known region throws so a typo in .env
 * is caught at startup rather than silently routing to the wrong cluster.
 */
export function parseRegion(raw: string | undefined): Region {
  const value = (raw ?? "").toLowerCase().trim();
  if (value === "") return DEFAULT_REGION;
  if (value === "us" || value === "eu" || value === "edge") return value;
  throw new Error(`Invalid ASSEMBLYAI_REGION="${raw}". Expected one of: ${REGIONS.join(", ")}.`);
}

/** Derive the REST base URL, realtime host and token URL for a region. */
export function endpointsForRegion(region: Region): AssemblyAIEndpoints {
  const realtimeHost = REALTIME_HOST[region];
  return {
    restBaseUrl: REST_HOST[region],
    realtimeHost,
    tokenUrl: `https://${realtimeHost}${TOKEN_PATH}`,
  };
}

/**
 * Derive the Voice Agent REST base, session WebSocket URL and token URL for a
 * region. These carry their scheme (unlike realtimeHost) because there is only
 * one correct scheme per URL and no call site should be assembling either.
 */
export function voiceAgentEndpointsForRegion(region: Region): VoiceAgentEndpoints {
  const host = AGENTS_HOST[region];
  return {
    restBaseUrl: `https://${host}${AGENTS_REST_PATH}`,
    wsUrl: `wss://${host}${AGENTS_WS_PATH}`,
    tokenUrl: `https://${host}${AGENTS_TOKEN_PATH}`,
  };
}
