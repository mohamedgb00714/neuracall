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
import {
  buildAppConfig,
  defaultSettings,
  mergeTtsEnv,
  type NeuraCallSettings,
} from "./settings.js";

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
  /** Overrides the settings' capture source. Mostly for tests. */
  audioSource?: ScrcpyAudioSource;
  /** App data root for recordings and the call log. Default "<cwd>/data". */
  dataDir?: string;
  /**
   * Operator-editable settings (region, LLM, TTS, audio, autopilot limits).
   * Defaults are used when omitted; `reloadSettings` swaps them at runtime.
   */
  settings?: NeuraCallSettings;
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
  /**
   * Mutated in place by `reloadSettings` rather than replaced: the session
   * manager captured this object at construction and reads it when it opens a
   * socket, so a new region or speech model has to land *inside* it to reach
   * the next call.
   */
  private readonly appConfig: AppConfig;
  private settings: NeuraCallSettings;
  private readonly manager: RealtimeSessionManager;
  private readonly devices: DeviceManager;
  private readonly runner: CommandRunner;
  private readonly capture: DeviceAudioCapture;
  private readonly callPollIntervalMs: number;
  private callTimer: NodeJS.Timeout | null = null;
  private callPolling = false;
  private readonly callStates = new Map<string, CallState>();
  private readonly opts: RuntimeOptions;
  private autopilotInstance: Autopilot | null = null;

  constructor(config: AppConfig, opts: RuntimeOptions = {}) {
    super();
    this.appConfig = config;
    this.settings = opts.settings ?? defaultSettings();
    this.opts = opts;
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

  /** The resolved AssemblyAI/LLM/TTS config currently in force. */
  get config(): AppConfig {
    return this.appConfig;
  }

  /** The operator settings currently in force. */
  get currentSettings(): NeuraCallSettings {
    return this.settings;
  }

  /**
   * scrcpy `--audio-source` for call capture. The settings type keeps it a
   * plain string so the renderer needs no scrcpy types; `parseSettingsPatch`
   * is what guarantees it is one of scrcpy's values.
   */
  private get captureSource(): ScrcpyAudioSource {
    return this.opts.audioSource ?? (this.settings.audio.captureSource as ScrcpyAudioSource);
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
      const { assemblyai, llm, audio, autopilot } = this.settings;
      this.autopilotInstance = new Autopilot({
        config: this.appConfig,
        devices: this.devices,
        sessions: this.manager,
        runner: this.runner,
        dataDir: this.opts.dataDir ?? resolve(process.cwd(), "data"),
        // Off unless explicitly asked for: every finished call becomes a paid
        // upload to the pre-recorded API.
        postCallAnalytics: process.env["NEURACALL_POST_CALL"] === "1",
        ...(process.env["NEURACALL_SUMMARY_MODEL"]
          ? { summaryModel: process.env["NEURACALL_SUMMARY_MODEL"] }
          : {}),
        audioSource: this.captureSource,
        realtimeMode: assemblyai.mode,
        keyterms: assemblyai.keyterms,
        maxCallMs: autopilot.maxCallMs,
        stallMs: autopilot.stallMs,
        // Settings sit above the environment, but only where they say
        // something: the merged env keeps hints that have no UI (PIPER_MODEL,
        // TTS_COMMAND) working.
        ttsEnv: mergeTtsEnv(process.env, this.settings),
        ...(audio.injectSink ? { injectSink: audio.injectSink } : {}),
        ...(autopilot.healthPort !== null ? { healthPort: autopilot.healthPort } : {}),
        ...(autopilot.defaultCountryCode
          ? { defaultCountryCode: autopilot.defaultCountryCode }
          : {}),
        ...(llm.baseUrl ? { llmBaseUrl: llm.baseUrl } : {}),
        ...(llm.greeting ? { greeting: llm.greeting } : {}),
        ...(llm.systemPrompt ? { systemPrompt: llm.systemPrompt } : {}),
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

  /**
   * Whether new settings can be applied right now.
   *
   * Applying them tears the Autopilot down and rebuilds it — new LLM client,
   * new TTS provider, new watchdog limits — which would drop whoever is on the
   * line, so a call in flight is a hard refusal rather than a best effort.
   */
  assertReloadable(): void {
    const active = this.autopilotInstance?.activeCalls.length ?? 0;
    if (active > 0) {
      throw new Error(
        `Cannot apply settings while ${active} call${active === 1 ? " is" : "s are"} in progress — ` +
          `rebuilding the agent would drop the caller. End the call and try again.`,
      );
    }
  }

  /**
   * Adopt new settings without restarting the app: the AssemblyAI region and
   * model reach the next session through the shared config object, and the
   * Autopilot is rebuilt so a changed LLM key or TTS provider takes effect. An
   * Autopilot that was answering calls is left answering them.
   */
  async reloadSettings(settings: NeuraCallSettings): Promise<void> {
    this.assertReloadable();
    this.settings = settings;
    this.applyConfig(settings);

    const previous = this.autopilotInstance;
    if (!previous) return; // never built; the next `get autopilot` uses the new settings
    const wasEnabled = previous.enabled;
    this.autopilotInstance = null;
    await previous.shutdown();
    if (wasEnabled) this.enableAutopilot();
  }

  /** Fold settings into the shared AppConfig object, in place. */
  private applyConfig(settings: NeuraCallSettings): void {
    const merged = buildAppConfig(this.appConfig.assemblyai.apiKey, settings);
    Object.assign(this.appConfig.assemblyai, merged.assemblyai);
    // Assigned field by field rather than merged: a cleared key is absent from
    // `merged`, and Object.assign would leave the old one in place.
    this.appConfig.llm.apiKey = merged.llm.apiKey;
    this.appConfig.llm.model = merged.llm.model;
    this.appConfig.tts.apiKey = merged.tts.apiKey;
    this.appConfig.tts.model = merged.tts.model;
    // The Autopilot reads config.voiceAgent once, when reloadSettings rebuilds
    // it after this returns. A section left out here is frozen at launch: the
    // switch, the voice and the region's agents.* hosts would only ever change
    // by restarting the app. Field by field for the same reason as llm/tts —
    // agentId, greeting and systemPrompt are absent from `merged` when cleared,
    // and Object.assign would keep the old value. sampleRate is readonly and
    // pinned; model is not settings-driven (see buildAppConfig).
    this.appConfig.voiceAgent.enabled = merged.voiceAgent.enabled;
    this.appConfig.voiceAgent.voice = merged.voiceAgent.voice;
    this.appConfig.voiceAgent.agentId = merged.voiceAgent.agentId;
    this.appConfig.voiceAgent.greeting = merged.voiceAgent.greeting;
    this.appConfig.voiceAgent.systemPrompt = merged.voiceAgent.systemPrompt;
    this.appConfig.voiceAgent.restBaseUrl = merged.voiceAgent.restBaseUrl;
    this.appConfig.voiceAgent.wsUrl = merged.voiceAgent.wsUrl;
    this.appConfig.voiceAgent.tokenUrl = merged.voiceAgent.tokenUrl;
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
    const keyterms = this.settings.assemblyai.keyterms;
    const stream = await this.manager.open(
      { deviceId, channelId },
      {
        params: {
          sampleRate: 16000,
          speechModel: this.appConfig.assemblyai.speechModel,
          mode: this.settings.assemblyai.mode,
          ...(keyterms.length > 0 ? { keyterms_prompt: keyterms } : {}),
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
          this.capture.attach(deviceId, deviceId, channelId, opts.source ?? this.captureSource);
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
