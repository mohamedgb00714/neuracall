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
};

contextBridge.exposeInMainWorld("neuracall", api);

export type NeuraCallBridge = typeof api;
