import type { AppConfig } from "@neuracall/config";

const TOKEN_MAX_SECONDS = 600;

/**
 * Mint a short-lived, single-use realtime token so the API key never leaves
 * the server. Used for browser/mobile clients; verifies against live docs
 * (https://www.assemblyai.com/docs/streaming/api-spec/generate-streaming-token).
 *
 * @param expiresInSeconds How long the token can be redeemed for (1-600).
 * @returns The opaque token string.
 */
export async function mintRealtimeToken(config: AppConfig, expiresInSeconds = 60): Promise<string> {
  const seconds = clampInt(expiresInSeconds, 1, TOKEN_MAX_SECONDS, 60);
  const host = realtimeTokenHost(config.assemblyai.realtimeHost);

  const url = `https://${host}/v3/token?expires_in_seconds=${seconds}`;
  const res = await fetch(url, {
    headers: { authorization: config.assemblyai.apiKey },
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Failed to mint realtime token (HTTP ${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error("AssemblyAI token response did not include a token.");
  }
  return data.token;
}

/** Map a realtime host to its token-minting host (same hostname). */
function realtimeTokenHost(host: string): string {
  return host;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(unreadable body)";
  }
}

export { TOKEN_MAX_SECONDS };
