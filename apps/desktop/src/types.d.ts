/// <reference types="vite/client" />

import type { TurnEvent } from "@neuracall/aai-client";

export type DevicePhase = "unknown" | "online" | "incoming" | "in-call" | "busy" | "offline";
export type CallState = "idle" | "ringing" | "offhook" | "unknown";

export interface NeuraCallDevice {
  id: string;
  kind: "usb" | "wifi";
  adbState: "device" | "offline" | "unauthorized" | "connecting";
  phase: DevicePhase;
  label?: string;
  updatedAt: number;
}

export type ToolName = "adb" | "scrcpy";

export interface ToolStatus {
  tool: ToolName;
  installed: boolean;
  binary: string;
  platform: string;
  path: string | null;
  version: string | null;
  installGuide: string | null;
}

/** @deprecated use ToolStatus */
export type ScrcpyStatus = ToolStatus;

export interface OkResult {
  ok: boolean;
  error?: string;
}

export interface CaptureInfo {
  deviceId: string;
  channelId: string;
  endpoint: string;
  source: string;
  attachedAt: number;
  state?: "started" | "exited";
  exitCode?: number | null;
  signal?: string | null;
}

export interface TurnMessage {
  key: { deviceId: string; channelId: string };
  turn: TurnEvent;
}

export interface SessionEndMessage {
  key: { deviceId: string; channelId: string };
  reason: string;
}

export interface AutopilotStatus {
  enabled: boolean;
  /** Human-readable reasons the agent is not fully operational. */
  degraded: string[];
  llmConfigured: boolean;
  ttsConfigured: boolean;
  injection: "off" | "sink" | "unavailable";
  activeCalls: number;
  handled: number;
}

export interface TranscriptEntry {
  speaker: "caller" | "agent";
  text: string;
  at: number;
  turnOrder?: number;
}

export interface CallRecord {
  callId: string;
  deviceId: string;
  channelId: string;
  direction: string;
  state: string;
  outcome: string | null;
  remoteParty: string | null;
  startedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  transcript: TranscriptEntry[];
  audioPath: string | null;
  error?: string;
}

/** One phone number belonging to a contact (see packages/crm/src/types.ts). */
export interface ContactPhone {
  /** The normalized match key ("+15550109999"). */
  e164: string;
  /** The trailing digits used by the suffix fallback. */
  suffix: string;
  /** What the number looked like when it was added. */
  raw: string;
}

export interface Contact {
  id: string;
  displayName: string;
  org: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  phones: ContactPhone[];
  tags: string[];
}

/** A contact carrying the call roll-up the list column shows. */
export interface ContactSummary extends Contact {
  callCount: number;
  /** ms since epoch of the most recent linked call; null when there are none. */
  lastCallAt: number | null;
}

/** A call record with the contact it was linked to — null while unidentified. */
export interface CrmCall extends CallRecord {
  contactId: string | null;
}

export interface CreateContactInput {
  displayName: string;
  org?: string;
  notes?: string;
  /** Raw numbers; the main process normalizes them and drops unparseable ones. */
  phones?: string[];
  tags?: string[];
}

export interface CreateContactResult {
  ok: boolean;
  contact?: Contact;
  error?: string;
}

export type AssemblyAIRegion = "us" | "eu" | "edge";
export type TranscriptionMode = "min_latency" | "balanced" | "max_accuracy";
export type TtsProvider = "auto" | "openai" | "elevenlabs" | "command" | "silent";

/** The persisted settings document (owned by electron/service/settings.ts). */
export interface NeuraCallSettings {
  assemblyai: {
    region: AssemblyAIRegion;
    speechModel: string;
    mode: TranscriptionMode;
    /** Bias terms sent with the stream, max 100. */
    keyterms: string[];
  };
  llm: {
    apiKey: string;
    model: string;
    baseUrl: string;
    systemPrompt: string;
    greeting: string;
  };
  tts: {
    provider: TtsProvider;
    apiKey: string;
    model: string;
    voice: string;
    baseUrl: string;
  };
  audio: {
    /** scrcpy --audio-source. */
    captureSource: string;
    /** "" turns injection off. */
    injectSink: string;
  };
  autopilot: {
    maxCallMs: number;
    stallMs: number;
    defaultCountryCode: string;
    healthPort: number | null;
  };
}

/**
 * What the renderer is allowed to read. Every `apiKey` comes back as "" and the
 * sibling `hasApiKey` says whether one is stored — a secret never crosses the
 * bridge in this direction.
 */
export type RedactedSettings = Omit<NeuraCallSettings, "llm" | "tts"> & {
  llm: NeuraCallSettings["llm"] & { hasApiKey: boolean };
  tts: NeuraCallSettings["tts"] & { hasApiKey: boolean };
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * A save patch. Writing is deliberately asymmetric with reading: an `apiKey` of
 * "" means LEAVE THE STORED KEY UNCHANGED, so the redacted view can be edited
 * and sent straight back without wiping a secret it was never shown. A
 * non-empty string replaces the key; an explicit null clears it.
 */
export type SettingsPatch = DeepPartial<Omit<NeuraCallSettings, "llm" | "tts">> & {
  llm?: DeepPartial<Omit<NeuraCallSettings["llm"], "apiKey">> & { apiKey?: string | null };
  tts?: DeepPartial<Omit<NeuraCallSettings["tts"], "apiKey">> & { apiKey?: string | null };
};

/** Outcome of one provider reachability check. `detail` never holds a key. */
export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface SettingsProbe {
  assemblyai: ProbeResult;
  llm: ProbeResult;
  tts: ProbeResult;
}

export interface SettingsSaveResult {
  ok: boolean;
  settings?: RedactedSettings;
  error?: string;
}

/** The IPC bridge exposed by the preload script (see electron/preload.mts). */
export interface NeuraCallBridge {
  getConfigInfo(): Promise<{
    region: string;
    speechModel: string;
    ready: boolean;
    error: string | null;
  }>;
  startSession(deviceId: string, channelId: string, source?: string): Promise<OkResult>;
  stopSession(deviceId: string, channelId: string): Promise<OkResult>;
  feedAudio(deviceId: string, channelId: string, chunk: Uint8Array): Promise<{ ok: boolean }>;
  listDevices(): Promise<NeuraCallDevice[]>;
  reconnectDevices(): Promise<OkResult>;
  checkTools(): Promise<Record<ToolName, ToolStatus>>;
  checkScrcpy(): Promise<ToolStatus>;
  checkAdb(): Promise<ToolStatus>;
  dialNumber(deviceId: string, number: string): Promise<OkResult>;
  openDialer(deviceId: string, number?: string): Promise<OkResult>;
  answerCall(deviceId: string): Promise<OkResult>;
  hangUpCall(deviceId: string): Promise<OkResult>;
  getCallState(deviceId: string): Promise<{ ok: boolean; state: CallState; error?: string }>;
  captureStatus(): Promise<CaptureInfo[]>;
  onDevicesChange(cb: (device: NeuraCallDevice) => void): () => void;
  onCallStateChange(cb: (msg: { id: string; state: CallState }) => void): () => void;
  onCapture(cb: (msg: CaptureInfo) => void): () => void;
  onCaptureLog(cb: (msg: { id: string; line: string; isError: boolean }) => void): () => void;
  onTurn(cb: (msg: TurnMessage) => void): () => void;
  onSessionEnd(cb: (msg: SessionEndMessage) => void): () => void;
  onError(cb: (msg: { key: unknown; error: string }) => void): () => void;

  enableAutopilot(): Promise<{ ok: boolean; status?: AutopilotStatus; error?: string }>;
  disableAutopilot(): Promise<{ ok: boolean; status?: AutopilotStatus; error?: string }>;
  autopilotStatus(): Promise<AutopilotStatus | null>;
  autopilotCalls(): Promise<CallRecord[]>;
  endAutopilotCall(callId: string): Promise<OkResult>;
  onAutopilotCall(cb: (record: CallRecord) => void): () => void;
  onAutopilotState(
    cb: (msg: { callId: string; state: string; reason?: string }) => void,
  ): () => void;
  onAutopilotTranscript(
    cb: (msg: { callId: string; entry: TranscriptEntry }) => void,
  ): () => void;
  onAutopilotError(cb: (msg: { message: string; callId?: string }) => void): () => void;

  /** False on a runtime without node:sqlite, where there is no contact database. */
  crmAvailable(): Promise<boolean>;
  crmContacts(): Promise<ContactSummary[]>;
  crmCalls(contactId: string): Promise<CrmCall[]>;
  crmRecentCalls(): Promise<CrmCall[]>;
  crmCreateContact(input: CreateContactInput): Promise<CreateContactResult>;

  getSettings(): Promise<RedactedSettings>;
  saveSettings(patch: SettingsPatch): Promise<SettingsSaveResult>;
  resetSettings(): Promise<RedactedSettings>;
  probeSettings(): Promise<SettingsProbe>;
  onSettingsChanged(cb: (settings: RedactedSettings) => void): () => void;
}

declare global {
  interface Window {
    neuracall: NeuraCallBridge;
  }
}
