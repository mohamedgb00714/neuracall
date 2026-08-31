/// <reference types="vite/client" />

import type { TurnEvent, SessionKey } from "@neuracall/aai-client";

export interface NeuraCallDevice {
  id: string;
  kind: string;
  adbState: string;
  phase: string;
  label?: string;
  updatedAt: number;
}

/** The IPC bridge exposed by the preload script (see electron/preload.mts). */
export interface NeuraCallBridge {
  getConfigInfo(): Promise<{
    region: string;
    speechModel: string;
    ready: boolean;
  }>;
  startSession(deviceId: string, channelId: string): Promise<{ ok: boolean }>;
  stopSession(deviceId: string, channelId: string): Promise<{ ok: boolean }>;
  feedAudio(
    deviceId: string,
    channelId: string,
    chunk: Uint8Array,
  ): Promise<{ ok: boolean }>;
  listDevices(): Promise<NeuraCallDevice[]>;
  reconnectDevices(): Promise<{ ok: boolean }>;
  onDevicesChange(cb: (device: NeuraCallDevice) => void): () => void;
  onTurn(cb: (msg: TurnMessage) => void): () => void;
  onSessionEnd(cb: (msg: SessionEndMessage) => void): () => void;
  onError(cb: (msg: { key: unknown; error: string }) => void): () => void;
}

export interface TurnMessage {
  key: SessionKey;
  turn: TurnEvent;
}

export interface SessionEndMessage {
  key: SessionKey;
  reason: string;
}

declare global {
  interface Window {
    neuracall: NeuraCallBridge;
  }
}

export {};
