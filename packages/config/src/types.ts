export type Region = "us" | "eu" | "edge";

export interface AppConfig {
  assemblyai: {
    apiKey: string;
    region: Region;
    speechModel: string;
    restBaseUrl: string;
    realtimeHost: string;
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
