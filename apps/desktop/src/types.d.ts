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
}

declare global {
  interface Window {
    neuracall: NeuraCallBridge;
  }
}
