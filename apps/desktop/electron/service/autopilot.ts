import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "@neuracall/config";
import type { RealtimeSessionManager } from "@neuracall/aai-client";
import {
  AdbCallChannelDetector,
  AndroidCallController,
  DeviceManager,
  type CommandRunner,
} from "@neuracall/device-manager";
import type { ScrcpyAudioSource } from "@neuracall/scrcpy-bridge";
import type { AudioInjector } from "@neuracall/audio-pipeline";
import {
  LlmCallAgent,
  OpenAiCompatibleLlmClient,
  selectTtsClient,
  type LlmClient,
} from "@neuracall/agent";
import { CrmStore, sqliteAvailable } from "@neuracall/crm";
import {
  CommandAudioInjector,
  JsonlCallRecordStore,
  Metrics,
  NullAudioInjector,
  Orchestrator,
  ScrcpyAudioCapture,
  Watchdog,
  createHealthServer,
  detectAudioPlayer,
  type AgentReply,
  type AgentTurnContext,
  type CallAgent,
  type CallRecord,
  type CallRecordStore,
  type HealthServer,
  type MetricsSnapshot,
} from "@neuracall/orchestrator";

/** Value `.env.example` ships for every unset key; treat it as unconfigured. */
const PLACEHOLDER = "replace-me";

export interface AutopilotOptions {
  config: AppConfig;
  /** The shared ADB device pool. */
  devices: DeviceManager;
  /** The shared realtime session manager (one concurrency budget for the app). */
  sessions: RealtimeSessionManager;
  /** ADB command runner, for per-device call control. */
  runner: CommandRunner;
  /** App data root; recordings and the call log live under it. */
  dataDir: string;
  /** scrcpy source for far-end capture. Default "mic" (see docs/AUDIO-ABI.md). */
  audioSource?: ScrcpyAudioSource;
  /**
   * PulseAudio/PipeWire sink that agent audio is played into — normally a
   * Bluetooth HFP sink the phone treats as its headset. Injection stays OFF
   * until this is set: without it the agent's voice would come out of the
   * host's speakers mid-call, which the caller cannot hear and the operator
   * did not ask for.
   */
  injectSink?: string;
  /** How often to sweep the pool for a ringing phone, in ms. */
  pollIntervalMs?: number;
  greeting?: string;
  systemPrompt?: string;
  /**
   * Bind the operator health/metrics endpoint on this port. Omit to leave it
   * off — it is bound to loopback, but an endpoint nobody asked for is still
   * an endpoint.
   */
  healthPort?: number;
  /** Hard ceiling on one call before the watchdog ends it. */
  maxCallMs?: number;
  /** Silence after which an answered call is assumed dead. */
  stallMs?: number;
  /**
   * Country calling code for caller IDs that arrive without one, so a national
   * number still links to the contact holding its E.164 form.
   */
  defaultCountryCode?: string;
}

export interface AutopilotStatus {
  enabled: boolean;
  /** Why the agent cannot speak, or null when it can. */
  degraded: string[];
  llmConfigured: boolean;
  ttsConfigured: boolean;
  injection: "off" | "sink" | "unavailable";
  activeCalls: number;
  handled: number;
}

/**
 * A CallAgent that listens and transcribes but never speaks.
 *
 * The default when no LLM is configured. Answering a real caller with a canned
 * line nobody wrote is worse than silence, and this way the rest of the
 * loop — detection, answering, transcription, recording, the call record —
 * still runs and is observable.
 */
class TranscribeOnlyAgent implements CallAgent {
  async onFinalTurn(_ctx: AgentTurnContext): Promise<AgentReply | null> {
    return null;
  }
}

/**
 * Autonomous call handling for the desktop app.
 *
 * Wraps the Orchestrator and everything it needs, and — importantly — stays
 * OFF until an operator turns it on. Enabling it means the app will answer
 * real inbound calls on real phones without further confirmation, so it is
 * opt-in per session rather than something that starts with the window.
 *
 * Events: "call" (CallRecord) · "state" (callId, state, reason) ·
 *         "transcript" (callId, entry) · "error" (message, callId?)
 */
export class Autopilot extends EventEmitter {
  private readonly opts: AutopilotOptions;
  private readonly orchestrator: Orchestrator;
  private readonly agent: CallAgent;
  private readonly llmConfigured: boolean;
  private readonly ttsConfigured: boolean;
  /** One-line description of the chosen TTS provider; never holds a key. */
  private readonly ttsDescription: string;
  private readonly injection: AutopilotStatus["injection"];
  private readonly metrics: Metrics;
  private readonly watchdog: Watchdog;
  /**
   * Contacts + call history, or null on a runtime without SQLite. The UI
   * queries it over IPC and must handle null by hiding the contacts view.
   */
  readonly crm: CrmStore | null;
  /** Where call records go — the CRM when it exists, JSONL otherwise. */
  private readonly store: CallRecordStore;
  private health: HealthServer | null = null;
  private running = false;
  private handled = 0;

  constructor(opts: AutopilotOptions) {
    super();
    this.opts = opts;

    const llm = buildLlmClient(opts.config);
    this.llmConfigured = llm !== null;

    // Falls back to SilentTts when nothing is configured, which keeps the loop
    // honest: silence of the right *duration* means turn pacing and the
    // barge-in window behave as they will with real speech.
    const tts = selectTtsClient(opts.config, { sampleRate: 16000 });
    this.ttsConfigured = tts.provider !== "silent";
    this.ttsDescription = tts.description;

    this.agent = llm
      ? new LlmCallAgent({
          llm,
          tts: tts.client,
          ...(opts.greeting !== undefined ? { greeting: opts.greeting } : {}),
          ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
        })
      : new TranscribeOnlyAgent();

    const player = detectAudioPlayer();
    this.injection = opts.injectSink ? (player ? "sink" : "unavailable") : "off";

    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });

    // SQLite needs Node 22+, and Electron pins its own Node (31 ships Node 20).
    // Where it is missing, calls still have to be recorded — so the append-only
    // JSONL store takes over and only the contact/history queries are lost.
    this.crm = sqliteAvailable()
      ? new CrmStore({
          path: join(opts.dataDir, "neuracall.db"),
          ...(opts.defaultCountryCode !== undefined
            ? { defaultCountryCode: opts.defaultCountryCode }
            : {}),
        })
      : null;
    this.store = this.crm ?? new JsonlCallRecordStore(join(opts.dataDir, "calls.jsonl"));

    this.orchestrator = new Orchestrator({
      devices: opts.devices,
      controllerFor: (deviceId) => new AndroidCallController(opts.runner, deviceId),
      detector: new AdbCallChannelDetector(opts.runner),
      sessions: opts.sessions,
      capture: new ScrcpyAudioCapture({
        ...(opts.audioSource !== undefined ? { audioSource: opts.audioSource } : {}),
        onSourceSelected: ({ deviceId, source }) =>
          this.emit("error", `capture using --audio-source=${source}`, deviceId),
      }),
      agent: this.agent,
      // The CRM is the call store, not a separate system: every call is
      // written straight into it and auto-linked to a contact by number, so
      // history is queryable per caller instead of being a flat log.
      store: this.store,
      recordingsDir: opts.dataDir,
      speechModel: opts.config.assemblyai.speechModel,
      injectorFor: () => this.buildInjector(),
      watchIntervalMs: opts.pollIntervalMs ?? 1500,
    });

    this.orchestrator.on("call", (record: CallRecord) => this.emit("call", record));
    this.orchestrator.on("state", (callId: string, state: string, reason?: string) => {
      if (state === "ended") this.handled += 1;
      this.emit("state", callId, state, reason);
    });
    this.orchestrator.on("transcript", (callId: string, entry: unknown) =>
      this.emit("transcript", callId, entry),
    );
    this.orchestrator.on("error", (err: Error, callId?: string) =>
      this.emit("error", err.message, callId),
    );

    this.metrics = new Metrics();
    this.metrics.attach(this.orchestrator);

    // The stray-session sweep is the reason this exists: an A2I session with
    // no call behind it bills wall-clock to a 3-hour cap, and a crash between
    // opening a session and registering its call is exactly how one is
    // orphaned.
    this.watchdog = new Watchdog({
      orchestrator: this.orchestrator,
      sessions: opts.sessions,
      metrics: this.metrics,
      ...(opts.maxCallMs !== undefined ? { maxCallMs: opts.maxCallMs } : {}),
      ...(opts.stallMs !== undefined ? { stallMs: opts.stallMs } : {}),
      onTeardown: (t) => this.emit("error", `watchdog: ${t.reason}`, t.callId),
      onError: (err) => this.emit("error", `watchdog sweep failed: ${err.message}`),
    });
  }

  /** Counters and gauges for the dashboard and the health endpoint. */
  snapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  get enabled(): boolean {
    return this.running;
  }

  /**
   * Start answering inbound calls automatically. Outward-facing: from here the
   * app picks up real calls on the connected phones.
   */
  enable(): AutopilotStatus {
    if (!this.running) {
      this.running = true;
      this.orchestrator.start();
      this.watchdog.start();
      void this.startHealth();
    }
    return this.status();
  }

  /**
   * Stop answering new calls. Calls already in flight run to completion, and
   * the watchdog keeps sweeping until they are done — stopping it here would
   * leave a wedged call with nothing to end it.
   */
  disable(): AutopilotStatus {
    if (this.running) {
      this.running = false;
      this.orchestrator.stop();
    }
    return this.status();
  }

  status(): AutopilotStatus {
    const degraded: string[] = [];
    if (!this.llmConfigured) {
      degraded.push("LLM_API_KEY / LLM_MODEL not set — calls are transcribed but the agent will not reply.");
    }
    if (!this.ttsConfigured) {
      degraded.push(
        `No TTS provider configured (${this.ttsDescription}) — replies appear in the transcript but are not spoken.`,
      );
    }
    if (this.injection === "off") {
      degraded.push("No injection sink configured — the caller cannot hear the agent (see docs/AUDIO-ABI.md).");
    } else if (this.injection === "unavailable") {
      degraded.push("No audio player found on PATH — install pipewire-utils, pulseaudio-utils or alsa-utils.");
    }

    return {
      enabled: this.running,
      degraded,
      llmConfigured: this.llmConfigured,
      ttsConfigured: this.ttsConfigured,
      injection: this.injection,
      activeCalls: this.orchestrator.activeCalls.length,
      handled: this.handled,
    };
  }

  /** Live calls, for the dashboard. */
  get activeCalls(): CallRecord[] {
    return this.orchestrator.activeCalls;
  }

  /** End a call from the UI. */
  endCall(callId: string): void {
    this.orchestrator.endCall(callId, "completed", "ended from the dashboard");
  }

  /** Stop the watch loop and hang up anything still running. */
  async shutdown(): Promise<void> {
    this.disable();
    this.watchdog.stop();
    for (const call of this.orchestrator.activeCalls) {
      this.orchestrator.endCall(call.callId, "failed", "application shutting down");
    }
    await this.health?.close().catch(() => undefined);
    this.health = null;
    this.crm?.close();
  }

  /** Bind the operator endpoint, if one was asked for. Never fatal. */
  private async startHealth(): Promise<void> {
    if (this.health || this.opts.healthPort === undefined) return;
    try {
      const server = createHealthServer({
        metrics: this.metrics,
        port: this.opts.healthPort,
        readiness: () => this.running,
      });
      await server.listen();
      this.health = server;
      this.emit("error", `health endpoint listening on ${server.url}`);
    } catch (err) {
      // A port already in use must not stop the app answering calls.
      this.emit("error", `health endpoint failed to bind: ${String(err)}`);
    }
  }

  private buildInjector(): AudioInjector {
    const sink = this.opts.injectSink;
    if (!sink) return new NullAudioInjector();
    try {
      return new CommandAudioInjector({
        sink,
        sampleRate: 16000,
        channels: 1,
        onError: (message) => this.emit("error", message),
      });
    } catch (err) {
      // No player on PATH. The call must still run — it is transcribed and
      // recorded, the far end just hears nothing.
      this.emit("error", err instanceof Error ? err.message : String(err));
      return new NullAudioInjector();
    }
  }
}

/** Build the LLM client, or null when the config still holds placeholders. */
function buildLlmClient(config: AppConfig): LlmClient | null {
  const apiKey = config.llm.apiKey;
  const model = config.llm.model;
  if (!apiKey || !model || model === PLACEHOLDER) return null;
  return new OpenAiCompatibleLlmClient({ apiKey, model });
}
