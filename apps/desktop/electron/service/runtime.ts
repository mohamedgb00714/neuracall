import { EventEmitter } from "node:events";
import type { AppConfig } from "@neuracall/config";
import {
  RealtimeSessionManager,
  type SessionKey,
  type TurnEvent,
} from "@neuracall/aai-client";
import {
  DeviceManager,
  realRunner,
  defaultSpawner,
  type Device,
  type DevicePhase,
} from "@neuracall/device-manager";

export interface TurnKeyed {
  key: SessionKey;
  turn: TurnEvent;
}

/**
 * NeuraCall runtime — the service layer hosted in the desktop app's main
 * process. Owns the AssemblyAI realtime session manager and the ADB device
 * pool, and exposes safe, key-free operations to the renderer via IPC.
 */
export class Runtime extends EventEmitter {
  readonly config: AppConfig;
  private readonly manager: RealtimeSessionManager;
  private readonly devices: DeviceManager;

  constructor(
    config: AppConfig,
    opts: { pollIntervalMs?: number; knownEndpoints?: string[] } = {},
  ) {
    super();
    this.config = config;
    this.manager = new RealtimeSessionManager(config, {
      maxConcurrent: 10,
    });

    // ADB device pool. The runner shells out to the real `adb` binary; this is
    // where USB/wireless phones enter the pool.
    this.devices = new DeviceManager({
      runner: realRunner(defaultSpawner),
      pollIntervalMs: opts.pollIntervalMs ?? 5000,
      knownEndpoints: opts.knownEndpoints,
    });

    // Re-broadcast manager events out of the runtime for the main process.
    this.manager.on("turn", (key, turn) => this.emit("turn", key, turn));
    this.manager.on("sessionEnd", (key, reason) =>
      this.emit("sessionEnd", key, reason),
    );
    this.manager.on("error", (key, err) => this.emit("error", key, err));
    this.devices.on("device", (device) => this.emit("device", device));
    this.devices.on("adb-state", (id, state) =>
      this.emit("adb-state", id, state),
    );
    this.devices.on("phase", (id, phase) => this.emit("phase", id, phase));
  }

  /** Begin polling for ADB devices. */
  start(): void {
    this.devices.start();
  }

  /** Present list of adb-attached devices. */
  get devicesList(): Device[] {
    return this.devices.snapshot;
  }

  /** Reconnect previously-known wireless endpoints. */
  reconnectKnown(): Promise<void> {
    return this.devices.reconnectKnown();
  }

  /** Mark a device phase from the orchestrator (e.g. in-call). */
  setDevicePhase(id: string, phase: DevicePhase): void {
    this.devices.setPhase(id, phase);
  }

  /** Open a realtime STT session for one device/channel. */
  async startSession(deviceId: string, channelId: string) {
    return this.manager.open(
      { deviceId, channelId },
      {
        params: {
          sampleRate: 16000,
          speechModel: this.config.assemblyai.speechModel,
          mode: "balanced",
        },
      },
    );
  }

  /** Close (Terminate) a realtime session. */
  async stopSession(deviceId: string, channelId: string): Promise<void> {
    await this.manager.close({ deviceId, channelId }, "stopped by user");
  }

  /** Feed a PCM16 chunk (16 kHz mono) into the open session. */
  feedAudio(deviceId: string, channelId: string, chunk: Buffer): boolean {
    const stream = this.manager.get({ deviceId, channelId });
    if (!stream) return false;
    return stream.sendAudio(chunk);
  }

  /** Shut down cleanly, terminating every open session and stopping polling. */
  async shutdown(): Promise<void> {
    this.devices.stop();
    await this.manager.closeAll("shutdown");
  }

  get activeSessions(): SessionKey[] {
    return this.manager.keys;
  }
}
