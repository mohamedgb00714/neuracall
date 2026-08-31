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
  }> => ipcRenderer.invoke("config:getInfo"),

  startSession: (deviceId: string, channelId: string) =>
    ipcRenderer.invoke("session:start", { deviceId, channelId }),

  stopSession: (deviceId: string, channelId: string) =>
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

  reconnectDevices: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("devices:reconnect"),

  onDevicesChange: (cb: (msg: DeviceMsg) => void) => {
    const listener = (_e: unknown, msg: DeviceMsg) => cb(msg);
    ipcRenderer.on("devices:update", listener);
    return () => ipcRenderer.removeListener("devices:update", listener);
  },

  onTurn: (cb: (msg: TurnMsg) => void) => {
    const listener = (_e: unknown, msg: TurnMsg) => cb(msg);
    ipcRenderer.on("session:turn", listener);
    return () => ipcRenderer.removeListener("session:turn", listener);
  },

  onSessionEnd: (cb: (msg: SessionEndMsg) => void) => {
    const listener = (_e: unknown, msg: SessionEndMsg) => cb(msg);
    ipcRenderer.on("session:end", listener);
    return () => ipcRenderer.removeListener("session:end", listener);
  },

  onError: (cb: (msg: { key: unknown; error: string }) => void) => {
    const listener = (_e: unknown, msg: { key: unknown; error: string }) =>
      cb(msg);
    ipcRenderer.on("session:error", listener);
    return () => ipcRenderer.removeListener("session:error", listener);
  },
};

contextBridge.exposeInMainWorld("neuracall", api);

export type NeuraCallBridge = typeof api;
