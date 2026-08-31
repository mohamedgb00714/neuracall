import { contextBridge, ipcRenderer } from "electron";

interface TurnMsg {
  key: { deviceId: string; channelId: string };
  turn: {
    turnOrder: number;
    final: boolean;
    transcript: string;
    speakerLabel?: string;
    languageCode?: string;
  };
}

interface SessionEndMsg {
  key: { deviceId: string; channelId: string };
  reason: string;
}

interface DeviceMsg {
  id: string;
  kind: string;
  adbState: string;
  phase: string;
  label?: string;
  updatedAt: number;
}

interface ToolStatusMsg {
  tool: "adb" | "scrcpy";
  installed: boolean;
  binary: string;
  platform: string;
  path: string | null;
  version: string | null;
  installGuide: string | null;
}

interface OkResult {
  ok: boolean;
  error?: string;
}

interface CaptureMsg {
  deviceId: string;
  channelId: string;
  endpoint: string;
  source: string;
  attachedAt: number;
  state?: "started" | "exited";
  exitCode?: number | null;
  signal?: string | null;
}

type CallState = "idle" | "ringing" | "offhook" | "unknown";

interface AutopilotStatusMsg {
  enabled: boolean;
  /** Human-readable reasons the agent is not fully operational. */
  degraded: string[];
  llmConfigured: boolean;
  ttsConfigured: boolean;
  injection: "off" | "sink" | "unavailable";
  activeCalls: number;
  handled: number;
}

interface TranscriptEntryMsg {
  speaker: "caller" | "agent";
  text: string;
  at: number;
  turnOrder?: number;
}

interface CallRecordMsg {
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
  transcript: TranscriptEntryMsg[];
  audioPath: string | null;
  error?: string;
}

interface ContactPhoneMsg {
  e164: string;
  suffix: string;
  raw: string;
}

/** Mirrors `Contact` in @neuracall/crm, which is where the shape is defined. */
interface ContactMsg {
  id: string;
  displayName: string;
  org: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  phones: ContactPhoneMsg[];
  tags: string[];
}

/** A contact carrying the call roll-up the list column shows. */
interface ContactSummaryMsg extends ContactMsg {
  callCount: number;
  /** ms since epoch of the most recent linked call; null when there are none. */
  lastCallAt: number | null;
}

/** A call record with the contact it was linked to, if any. */
interface CrmCallMsg extends CallRecordMsg {
  contactId: string | null;
}

interface CreateContactMsg {
  displayName: string;
  org?: string;
  notes?: string;
  phones?: string[];
  tags?: string[];
}

interface CreateContactResult {
  ok: boolean;
  contact?: ContactMsg;
  error?: string;
}

/**
 * Settings as the renderer sees them: every apiKey blanked, with `hasApiKey`
 * reporting whether one is stored. Mirrors `RedactedSettings` in
 * electron/service/settings.ts, which is where the shape is defined.
 */
interface RedactedSettingsMsg {
  assemblyai: {
    region: "us" | "eu" | "edge";
    speechModel: string;
    mode: "min_latency" | "balanced" | "max_accuracy";
    keyterms: string[];
  };
  llm: {
    apiKey: string;
    hasApiKey: boolean;
    model: string;
    baseUrl: string;
    systemPrompt: string;
    greeting: string;
  };
  tts: {
    provider: "auto" | "openai" | "elevenlabs" | "command" | "silent";
    apiKey: string;
    hasApiKey: boolean;
    model: string;
    voice: string;
    baseUrl: string;
  };
  audio: { captureSource: string; injectSink: string };
  autopilot: {
    maxCallMs: number;
    stallMs: number;
    defaultCountryCode: string;
    healthPort: number | null;
  };
}

interface ProbeResultMsg {
  ok: boolean;
  /** Human-readable; scrubbed of every configured key in the main process. */
  detail: string;
}

interface ProbeReportMsg {
  assemblyai: ProbeResultMsg;
  llm: ProbeResultMsg;
  tts: ProbeResultMsg;
}

interface SaveSettingsResult {
  ok: boolean;
  settings?: RedactedSettingsMsg;
  error?: string;
}

function subscribe<T>(channel: string) {
  return (cb: (msg: T) => void) => {
    const listener = (_e: unknown, msg: T) => cb(msg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * Secure bridge exposed to the renderer. The renderer never holds the
 * AssemblyAI API key — it only receives event streams and issues call control
 * via IPC. contextIsolation is on and nodeIntegration is off.
 */
const api = {
  getConfigInfo: (): Promise<{
    region: string;
    speechModel: string;
    ready: boolean;
    error: string | null;
  }> => ipcRenderer.invoke("config:getInfo"),

  startSession: (deviceId: string, channelId: string, source?: string): Promise<OkResult> =>
    ipcRenderer.invoke("session:start", { deviceId, channelId, source }),

  stopSession: (deviceId: string, channelId: string): Promise<OkResult> =>
    ipcRenderer.invoke("session:stop", { deviceId, channelId }),

  feedAudio: (deviceId: string, channelId: string, chunk: Uint8Array) => {
    const buffer = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    );
    return ipcRenderer.invoke("session:feedAudio", {
      deviceId,
      channelId,
      chunk: buffer,
    });
  },

  listDevices: (): Promise<DeviceMsg[]> => ipcRenderer.invoke("devices:list"),

  reconnectDevices: (): Promise<OkResult> =>
    ipcRenderer.invoke("devices:reconnect"),

  // ---- external tools
  checkTools: (): Promise<{ adb: ToolStatusMsg; scrcpy: ToolStatusMsg }> =>
    ipcRenderer.invoke("tools:check"),
  checkScrcpy: (): Promise<ToolStatusMsg> => ipcRenderer.invoke("scrcpy:check"),
  checkAdb: (): Promise<ToolStatusMsg> => ipcRenderer.invoke("adb:check"),

  // ---- call control
  dialNumber: (deviceId: string, number: string): Promise<OkResult> =>
    ipcRenderer.invoke("call:dial", { deviceId, number }),
  openDialer: (deviceId: string, number?: string): Promise<OkResult> =>
    ipcRenderer.invoke("call:openDialer", { deviceId, number }),
  answerCall: (deviceId: string): Promise<OkResult> =>
    ipcRenderer.invoke("call:answer", { deviceId }),
  hangUpCall: (deviceId: string): Promise<OkResult> =>
    ipcRenderer.invoke("call:hangup", { deviceId }),
  getCallState: (deviceId: string): Promise<{ ok: boolean; state: CallState; error?: string }> =>
    ipcRenderer.invoke("call:state", { deviceId }),

  captureStatus: (): Promise<CaptureMsg[]> => ipcRenderer.invoke("capture:status"),

  // ---- CRM
  // Every query runs in the main process; the renderer never gets a database
  // handle. `crmAvailable` is false on a runtime without node:sqlite, where
  // calls go to JSONL and there are no contacts to show.
  crmAvailable: (): Promise<boolean> => ipcRenderer.invoke("crm:available"),
  crmContacts: (): Promise<ContactSummaryMsg[]> => ipcRenderer.invoke("crm:contacts"),
  crmCalls: (contactId: string): Promise<CrmCallMsg[]> =>
    ipcRenderer.invoke("crm:calls", { contactId }),
  crmRecentCalls: (): Promise<CrmCallMsg[]> => ipcRenderer.invoke("crm:recent"),
  crmCreateContact: (input: CreateContactMsg): Promise<CreateContactResult> =>
    ipcRenderer.invoke("crm:createContact", input),

  // ---- settings
  // Asymmetric on purpose: a key can be sent in but never comes back out. In
  // a patch an apiKey of "" leaves the stored key alone (so round-tripping the
  // redacted view is safe), a non-empty string replaces it, and null clears it.
  getSettings: (): Promise<RedactedSettingsMsg> => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch: unknown): Promise<SaveSettingsResult> =>
    ipcRenderer.invoke("settings:save", patch),
  resetSettings: (): Promise<RedactedSettingsMsg> => ipcRenderer.invoke("settings:reset"),
  probeSettings: (): Promise<ProbeReportMsg> => ipcRenderer.invoke("settings:probe"),

  // ---- autopilot
  enableAutopilot: (): Promise<{ ok: boolean; status?: AutopilotStatusMsg; error?: string }> =>
    ipcRenderer.invoke("autopilot:enable"),
  disableAutopilot: (): Promise<{ ok: boolean; status?: AutopilotStatusMsg; error?: string }> =>
    ipcRenderer.invoke("autopilot:disable"),
  autopilotStatus: (): Promise<AutopilotStatusMsg | null> =>
    ipcRenderer.invoke("autopilot:status"),
  autopilotCalls: (): Promise<CallRecordMsg[]> => ipcRenderer.invoke("autopilot:activeCalls"),
  endAutopilotCall: (callId: string): Promise<OkResult> =>
    ipcRenderer.invoke("autopilot:endCall", { callId }),

  // ---- event streams
  onDevicesChange: subscribe<DeviceMsg>("devices:update"),
  onCallStateChange: subscribe<{ id: string; state: CallState }>("call:state-change"),
  onCapture: subscribe<CaptureMsg>("capture:update"),
  onCaptureLog: subscribe<{ id: string; line: string; isError: boolean }>("capture:log"),
  onTurn: subscribe<TurnMsg>("session:turn"),
  onSessionEnd: subscribe<SessionEndMsg>("session:end"),
  onError: subscribe<{ key: unknown; error: string }>("session:error"),
  onAutopilotCall: subscribe<CallRecordMsg>("autopilot:call"),
  onAutopilotState: subscribe<{ callId: string; state: string; reason?: string }>("autopilot:state"),
  onAutopilotTranscript: subscribe<{ callId: string; entry: TranscriptEntryMsg }>(
    "autopilot:transcript",
  ),
  onAutopilotError: subscribe<{ message: string; callId?: string }>("autopilot:error"),
  onSettingsChanged: subscribe<RedactedSettingsMsg>("settings:changed"),
};

contextBridge.exposeInMainWorld("neuracall", api);

export type NeuraCallBridge = typeof api;
