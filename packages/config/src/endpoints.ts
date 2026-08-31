import type { AssemblyAIEndpoints, Region } from "./types.js";

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
 * Parse the raw ASSEMBLYAI_REGION value. Empty/undefined falls back to
 * "edge"; anything else that is not a known region throws so a typo in .env
 * is caught at startup rather than silently routing to the wrong cluster.
 */
export function parseRegion(raw: string | undefined): Region {
  const value = (raw ?? "").toLowerCase().trim();
  if (value === "") return DEFAULT_REGION;
  if (value === "us" || value === "eu" || value === "edge") return value;
  throw new Error(
    `Invalid ASSEMBLYAI_REGION="${raw}". Expected one of: ${REGIONS.join(", ")}.`,
  );
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
