/**
 * AssemblyAI data-residency region.
 *
 *  - "us"   — pin to the US cluster (api.assemblyai.com / streaming.us.assemblyai.com)
 *  - "eu"   — pin to the EU cluster (api.eu.assemblyai.com / streaming.eu.assemblyai.com)
 *  - "edge" — default; US REST plus the edge-routed streaming.assemblyai.com host
 */
export type Region = "us" | "eu" | "edge";

/** Every AssemblyAI endpoint NeuraCall talks to, all derived from one Region. */
export interface AssemblyAIEndpoints {
  /** REST base URL for pre-recorded transcription and other HTTP APIs. */
  restBaseUrl: string;
  /** Hostname of the Universal-Streaming (v3) WebSocket endpoint (no scheme, no path). */
  realtimeHost: string;
  /**
   * Full URL of the temporary-token endpoint used to mint short-lived streaming
   * tokens. Served by the realtime host, not the REST host — see
   * https://www.assemblyai.com/docs/streaming/api-spec/generate-streaming-token
   */
  tokenUrl: string;
}

export interface AppConfig {
  assemblyai: AssemblyAIEndpoints & {
    apiKey: string;
    region: Region;
    speechModel: string;
  };
  llm: {
    apiKey?: string;
    model: string;
  };
  tts: {
    apiKey?: string;
    model: string;
  };
}
