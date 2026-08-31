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

/**
 * Every Voice Agent endpoint NeuraCall talks to, all derived from one Region.
 *
 * Separate from AssemblyAIEndpoints because the Voice Agent API lives on its
 * own host family (agents.*) with its own /v1 surface — none of it is reachable
 * from the transcription hosts, and its token path is /v1/token rather than the
 * streaming API's /v3/token.
 */
export interface VoiceAgentEndpoints {
  /** REST base for stored-agent CRUD: POST/GET/PATCH/DELETE `${restBaseUrl}/agents`. */
  restBaseUrl: string;
  /** Full wss:// URL of the realtime agent session socket (scheme and path included). */
  wsUrl: string;
  /**
   * Full URL of the short-lived-token endpoint. Browser clients GET this with
   * ?expires_in_seconds=<n> and connect with ?token=<token>; the returned token
   * is single-use. Node clients skip it and send the raw key as a Bearer header.
   */
  tokenUrl: string;
}

/**
 * The only sample rate the Voice Agent API accepts, in Hz, for both input and
 * output audio.
 *
 * Modelled as a literal type rather than `number` because the failure mode is
 * actively misleading: an agent configured for 16000 or 8000 does not fail
 * validation. It is accepted, then session start returns
 * `{"code":"internal_error","message":"Internal service error"}` and the socket
 * closes 1011 — indistinguishable from an AssemblyAI outage. There is no other
 * signal. A config able to express 16000 therefore costs an afternoon of
 * debugging the wrong layer, so the type makes it unrepresentable.
 *
 * NeuraCall captures at 16 kHz, so resampling 16k -> 24k inbound (and 24k -> 16k
 * outbound) is mandatory at the pipeline edge, not negotiable here.
 */
export type VoiceAgentSampleRate = 24000;

export interface AppConfig {
  assemblyai: AssemblyAIEndpoints & {
    apiKey: string;
    region: Region;
    speechModel: string;
  };
  voiceAgent: VoiceAgentEndpoints & {
    /** VOICE_AGENT_ENABLED. Off unless explicitly turned on. */
    enabled: boolean;
    /**
     * VOICE_AGENT_ID — uuid of an agent stored via POST /v1/agents.
     * Mutually exclusive with inline session config: a session.update carrying
     * both agent_id and inline fields is rejected, so a caller that has an
     * agentId must ignore voice/greeting/systemPrompt/model and send only the id.
     */
    agentId?: string;
    /** VOICE_AGENT_VOICE. A voice_id such as "alba"; see .env.example for the set. */
    voice: string;
    /** VOICE_AGENT_GREETING — the agent's opening line. */
    greeting?: string;
    /** VOICE_AGENT_SYSTEM_PROMPT — the agent's persona and instructions. */
    systemPrompt?: string;
    /**
     * VOICE_AGENT_LLM_MODEL — LLM Gateway model for BYO-LLM.
     * Only usable on a STORED agent: a `llm` block on session.update is rejected
     * with invalid_value ("define it on a stored agent via POST /v1/agents").
     * This account is entitled to "qwen3.5-4b-32k-fast" only; every other id
     * (claude-*, gpt-*, gemini-*) returns HTTP 400 from the gateway.
     */
    model?: string;
    /** Pinned to 24000 — see VoiceAgentSampleRate for why it is not configurable. */
    readonly sampleRate: VoiceAgentSampleRate;
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
