import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { AppConfig } from "@neuracall/config";
import {
  RealtimeSessionManager,
  type SessionKey,
  type TurnEvent,
} from "@neuracall/aai-client";
import {
  DeviceManager,
  AndroidCallController,
  realRunner,
  defaultSpawner,
  type CommandRunner,
  type CallState,
  type Device,
  type DevicePhase,
} from "@neuracall/device-manager";
import {
  detectAdb,
  detectScrcpy,
  detectRequiredTools,
  type ScrcpyAudioSource,
  type ToolDetection,
  type ToolName,
} from "@neuracall/scrcpy-bridge";
import { DeviceAudioCapture, type CaptureSession } from "./capture.js";
import { Autopilot, type AutopilotStatus } from "./autopilot.js";

export interface TurnKeyed {
  key: SessionKey;
  turn: TurnEvent;
}

export interface RuntimeOptions {
  /** ADB reconcile interval (ms). Default 5000. */
  pollIntervalMs?: number;
  /** Wireless endpoints to reconnect on demand. */
  knownEndpoints?: string[];
  /** Telephony call-state poll interval per online phone (ms). 0 disables. Default 2000. */
  callPollIntervalMs?: number;
  /** scrcpy audio source used for call capture. Default "mic". */
  audioSource?: ScrcpyAudioSource;
  /** App data root for recordings and the call log. Default "<cwd>/data". */
  dataDir?: string;
  /**
   * Audio sink the agent's voice is played into (normally a Bluetooth HFP sink
   * the phone treats as its headset). Unset means the caller hears nothing.
   */
  injectSink?: string;
  /** Bind the operator health/metrics endpoint on this loopback port. */
  healthPort?: number;
}

export interface CaptureUpdate extends CaptureSession {
  state: "started" | "exited";
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * NeuraCall runtime — the service layer hosted in the desktop app's main
 * process. Owns the AssemblyAI realtime session manager, the ADB device pool,
 * per-device scrcpy audio capture and call control, and exposes safe,
 * key-free operations to the renderer via IPC.
 *
 * Events (re-broadcast to the renderer by main.ts):
 *  - "turn" / "sessionEnd" / "error"      realtime STT
 *  - "device" / "adb-state" / "phase"     device pool
 *  - "call-state" (deviceId, CallState)   telephony poll
 *  - "capture" (CaptureUpdate)            scrcpy capture started/exited
 *  - "capture-log" (deviceId, line, isError)
 */
export class Runtime extends EventEmitter {
  readonly config: AppConfig;
  private readonly manager: RealtimeSessionManager;
  private readonly devices: DeviceManager;
  private readonly runner: CommandRunner;
  private readonly capture: DeviceAudioCapture;
  private readonly audioSource: ScrcpyAudioSource;
  private readonly callPollIntervalMs: number;
  private callTimer: NodeJS.Timeout | null = null;
  private callPolling = false;
  private readonly callStates = new Map<string, CallState>();
  private readonly opts: RuntimeOptions;
  private autopilotInstance: Autopilot | null = null;

  constructor(config: AppConfig, opts: RuntimeOptions = {}) {
    super();
    this.config = config;
    this.opts = opts;
    this.audioSource = opts.audioSource ?? "mic";
    this.callPollIntervalMs = opts.callPollIntervalMs ?? 2000;
    this.manager = new RealtimeSessionManager(config, {
      maxConcurrent: 10,
    });

    // ADB device pool. The runner shells out to the real `adb` binary; this is
    // where USB/wireless phones enter the pool. The same runner drives calls.
    this.runner = realRunner(defaultSpawner);
    this.devices = new DeviceManager({
      runner: this.runner,
      pollIntervalMs: opts.pollIntervalMs ?? 5000,
      knownEndpoints: opts.knownEndpoints,
    });

    // Phone audio → realtime STT. One scrcpy process per device; scrcpy's
    // 48 kHz stereo is converted to 16 kHz mono before it reaches the session.
    this.capture = new DeviceAudioCapture({
      feed: (deviceId, channelId, chunk) => this.feedAudio(deviceId, channelId, chunk),
      targetSampleRate: 16000,
    });
    this.capture.on("start", (s: CaptureSession) =>
      this.emit("capture", { ...s, state: "started" } satisfies CaptureUpdate),
    );
    this.capture.on("exit", (s: CaptureSession, r: { code: number | null; signal: string | null }) =>
      this.emit("capture", {
        ...s,
        state: "exited",
        exitCode: r.code,
        signal: r.signal,
      } satisfies CaptureUpdate),
    );
    this.capture.on("log", (endpoint: string, line: string) =>
      this.emit("capture-log", endpoint, line, false),
    );
    this.capture.on("error", (endpoint: string, line: string) =>
      this.emit("capture-log", endpoint, line, true),
    );

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

  /** Begin polling for ADB devices and their call state. */
  start(): void {
    this.devices.start();
    if (this.callPollIntervalMs > 0 && !this.callTimer) {
      this.callTimer = setInterval(
        () => void this.pollCallStates(),
        this.callPollIntervalMs,
      );
      this.callTimer.unref?.();
    }
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

  // ---------------------------------------------------------- autopilot

  /**
   * Autonomous call handling, built on first use.
   *
   * Constructed lazily and left disabled: turning it on makes the app answer
   * real inbound calls without further confirmation, so it is an explicit
   * operator action rather than a side effect of the window opening.
   */
  get autopilot(): Autopilot {
    if (!this.autopilotInstance) {
      const opts = this.opts;
      this.autopilotInstance = new Autopilot({
        config: this.config,
        devices: this.devices,
        sessions: this.manager,
        runner: this.runner,
        dataDir: opts.dataDir ?? resolve(process.cwd(), "data"),
        ...(opts.audioSource !== undefined ? { audioSource: opts.audioSource } : {}),
        ...(opts.injectSink !== undefined ? { injectSink: opts.injectSink } : {}),
        ...(opts.healthPort !== undefined ? { healthPort: opts.healthPort } : {}),
      });
      this.autopilotInstance.on("call", (record) => this.emit("autopilot-call", record));
      this.autopilotInstance.on("state", (callId, state, reason) =>
        this.emit("autopilot-state", callId, state, reason),
      );
      this.autopilotInstance.on("transcript", (callId, entry) =>
        this.emit("autopilot-transcript", callId, entry),
      );
      this.autopilotInstance.on("error", (message, callId) =>
        this.emit("autopilot-error", message, callId),
      );
    }
    return this.autopilotInstance;
  }

  /** Turn autonomous answering on. Outward-facing: real calls get picked up. */
  enableAutopilot(): AutopilotStatus {
    return this.autopilot.enable();
  }

  disableAutopilot(): AutopilotStatus {
    return this.autopilot.disable();
  }

  autopilotStatus(): AutopilotStatus {
    return this.autopilot.status();
  }

  // ---------------------------------------------------------------- STT

  /**
   * Open a realtime STT session for one device/channel and, when scrcpy is
   * installed, start streaming the phone's audio into it.
   */
  async startSession(
    deviceId: string,
    channelId: string,
    opts: { capture?: boolean; source?: ScrcpyAudioSource } = {},
  ) {
    const stream = await this.manager.open(
      { deviceId, channelId },
      {
        params: {
          sampleRate: 16000,
          speechModel: this.config.assemblyai.speechModel,
          mode: "balanced",
        },
      },
    );

    if (opts.capture !== false && !this.capture.has(deviceId)) {
      const scrcpy = detectScrcpy();
      if (!scrcpy.installed) {
        this.emit(
          "capture-log",
          deviceId,
          "scrcpy is not installed — session opened without phone audio",
          true,
        );
      } else {
        try {
          this.capture.attach(deviceId, deviceId, channelId, opts.source ?? this.audioSource);
        } catch (err) {
          this.emit("capture-log", deviceId, `capture failed to start: ${String(err)}`, true);
        }
      }
    }
    return stream;
  }

  /** Close (Terminate) a realtime session and stop its audio capture. */
  async stopSession(deviceId: string, channelId: string): Promise<void> {
    const cap = this.capture.get(deviceId);
    if (cap && cap.channelId === channelId) this.capture.detach(deviceId);
    await this.manager.close({ deviceId, channelId }, "stopped by user");
  }

  /** Feed a PCM16 chunk (16 kHz mono) into the open session. */
  feedAudio(deviceId: string, channelId: string, chunk: Buffer): boolean {
    const stream = this.manager.get({ deviceId, channelId });
    if (!stream) return false;
    return stream.sendAudio(chunk);
  }

  get activeSessions(): SessionKey[] {
    return this.manager.keys;
  }

  /** Active scrcpy captures. */
  captureStatus(): CaptureSession[] {
    return this.capture.getStatus();
  }

  // -------------------------------------------------------------- calls

  private controller(deviceId: string): AndroidCallController {
    return new AndroidCallController(this.runner, deviceId);
  }

  /** Place an outgoing call from a phone. Outward-facing: the number rings. */
  async dial(deviceId: string, number: string): Promise<void> {
    await this.controller(deviceId).dial(number);
    this.devices.setPhase(deviceId, "in-call");
  }

  /** Open the phone's dialer, optionally prefilled. Nothing is placed. */
  async openDialer(deviceId: string, number?: string): Promise<void> {
    await this.controller(deviceId).openDialer(number);
  }

  /** Answer a ringing call. */
  async answerCall(deviceId: string): Promise<void> {
    await this.controller(deviceId).answer();
    this.devices.setPhase(deviceId, "in-call");
  }

  /** Hang up / reject the current call (best-effort). */
  async hangUp(deviceId: string): Promise<void> {
    await this.controller(deviceId).safeHangUp();
    this.devices.setPhase(deviceId, "online");
  }

  /** Read the phone's telephony call state right now. */
  callState(deviceId: string): Promise<CallState> {
    return this.controller(deviceId).callState();
  }

  /** Last polled call state per device. */
  get callStateSnapshot(): Record<string, CallState> {
    return Object.fromEntries(this.callStates);
  }

  /**
   * Poll every online phone's telephony state and reflect it in the device
   * phase (ringing → incoming, offhook → in-call, idle → online). Skips a tick
   * if the previous one is still running.
   */
  private async pollCallStates(): Promise<void> {
    if (this.callPolling) return;
    this.callPolling = true;
    try {
      for (const dev of this.devices.snapshot) {
        if (dev.adbState !== "device") {
          this.callStates.delete(dev.id);
          continue;
        }
        let state: CallState;
        try {
          state = await this.controller(dev.id).callState();
        } catch {
          state = "unknown";
        }
        if (this.callStates.get(dev.id) === state) continue;
        this.callStates.set(dev.id, state);
        this.emit("call-state", dev.id, state);

        const phase: DevicePhase =
          state === "ringing"
            ? "incoming"
            : state === "offhook"
              ? "in-call"
              : state === "idle"
                ? "online"
                : dev.phase;
        if (phase !== dev.phase) this.devices.setPhase(dev.id, phase);
      }
    } finally {
      this.callPolling = false;
    }
  }

  // -------------------------------------------------------------- tools

  /** Report whether `scrcpy` (phone audio capture) is installed + install guide. */
  scrcpyStatus(): ToolDetection {
    return detectScrcpy();
  }

  /** Report whether `adb` (device discovery + call control) is installed + install guide. */
  adbStatus(): ToolDetection {
    return detectAdb();
  }

  /** Every required external tool, evaluated fresh so the UI can re-check. */
  toolStatus(): Record<ToolName, ToolDetection> {
    return detectRequiredTools();
  }

  // ----------------------------------------------------------- lifecycle

  /** Shut down cleanly: stop captures and polling, terminate every session. */
  async shutdown(): Promise<void> {
    if (this.callTimer) {
      clearInterval(this.callTimer);
      this.callTimer = null;
    }
    // Stop answering new calls and hang up anything in flight before the
    // sessions below are terminated, so no call is left mid-teardown.
    await this.autopilotInstance?.shutdown();
    this.capture.stopAll();
    this.devices.stop();
    await this.manager.closeAll("shutdown");
  }
}
