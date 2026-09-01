/**
 * Composes the real NeuraCall stack with fakes only at its outer edges.
 *
 * Real, running for real in these tests:
 *   DeviceManager · AndroidCallController · AdbCallChannelDetector ·
 *   RealtimeSessionManager · RealtimeStream · CallAudioSession ·
 *   AudioPipeline · EnergyVad · CallRecorder · Orchestrator ·
 *   CallStateMachine · LlmCallAgent · ConversationStore
 *
 * Faked, because they are hardware, network or money:
 *   adb (FakePhone/FakeAdb) · the A2I WebSocket (FakeA2IFleet) ·
 *   scrcpy capture (ReplayCapture) · the LLM · TTS
 *
 * That split is the point of the suite: a bug anywhere in the call loop, in
 * any package, surfaces here, while the whole thing runs offline in CI with no
 * device, no API key and no spend.
 */

import { getConfig } from "@neuracall/config";
import type { AppConfig } from "@neuracall/config";
import { RealtimeSessionManager } from "@neuracall/aai-client";
import {
  AdbCallChannelDetector,
  AndroidCallController,
  DeviceManager,
} from "@neuracall/device-manager";
import { LlmCallAgent, SilentTts } from "@neuracall/agent";
import type { LlmClient, LlmRequest } from "@neuracall/agent";
import {
  MemoryCallRecordStore,
  Orchestrator,
  VoiceAgentBridge,
  type AudioCapture,
  type CapturePcmSink,
  type CaptureHandle,
  type CallRecord,
} from "@neuracall/orchestrator";
import type { AudioInjector } from "@neuracall/audio-pipeline";
import { FakeA2IFleet } from "./fakeA2I.js";
import { FakeVoiceAgentFleet } from "./fakeVoiceAgent.js";
import { FakeAdb, FakePhone } from "./fakePhone.js";

/** A config with no real key — the WebSocket factory is injected anyway. */
export function e2eConfig(): AppConfig {
  return getConfig({
    ASSEMBLYAI_API_KEY: "e2e-not-a-real-key",
    ASSEMBLYAI_REGION: "us",
    ASSEMBLYAI_SPEECH_MODEL: "universal-3-5-pro",
  });
}

/**
 * Capture that replays a fixed PCM buffer on demand, standing in for scrcpy.
 * It announces 48 kHz stereo — what scrcpy really emits — so the pipeline does
 * genuine resampling and downmixing rather than a pass-through.
 */
export class ReplayCapture implements AudioCapture {
  sink: CapturePcmSink | null = null;
  started = 0;
  stopped = 0;
  /** Fails the next `start()`, simulating a phone with no usable source. */
  failNext: Error | null = null;

  async start(args: { deviceId: string; sink: CapturePcmSink }): Promise<CaptureHandle> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.started += 1;
    this.sink = args.sink;
    args.sink.format?.({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
    return {
      stop: () => {
        this.stopped += 1;
      },
    };
  }

  /** Push `ms` of far-end speech into the pipeline. */
  speak(ms: number, freq = 440): void {
    if (!this.sink) throw new Error("capture has not been started");
    this.sink.push(tone(ms, freq));
  }
}

/** `ms` of 48 kHz stereo Int16 tone, loud enough to open the VAD. */
export function tone(ms: number, freq = 440): Buffer {
  const rate = 48000;
  const frames = Math.round((ms / 1000) * rate);
  const buf = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * f) / rate) * 0.5 * 32767);
    buf.writeInt16LE(s, f * 4);
    buf.writeInt16LE(s, f * 4 + 2);
  }
  return buf;
}

/** An LLM that answers from a script, so replies are deterministic. */
export class ScriptedLlm implements LlmClient {
  readonly prompts: string[] = [];

  constructor(private readonly replies: string[]) {}

  async complete(request: LlmRequest): Promise<string> {
    this.prompts.push(request.messages.at(-1)?.content ?? "");
    return this.replies.shift() ?? "Thanks for calling.";
  }
}

/**
 * Stands in for the Bluetooth sink. On the Voice Agent path the agent's speech
 * never passes through `LocalOutStream` — the bridge writes it straight here —
 * so this is the only place a test can see that the caller would have heard
 * anything at all.
 */
export class CollectingInjector implements AudioInjector {
  readonly sampleRate = 16000;
  readonly channels = 1 as const;
  readonly writes: Uint8Array[] = [];
  cancels = 0;
  ended = 0;

  get bytes(): number {
    return this.writes.reduce((n, c) => n + c.length, 0);
  }
  write(pcm: Uint8Array): void {
    this.writes.push(pcm);
  }
  cancel(): void {
    this.cancels += 1;
  }
  end(): void {
    this.ended += 1;
  }
}

export interface HarnessOptions {
  /** Phones in the pool. Default one wireless phone. */
  phones?: FakePhone[];
  /** Agent replies, in order. */
  replies?: string[];
  /** Agent greeting spoken on answer. */
  greeting?: string;
  /** Record call audio into this directory. */
  recordingsDir?: string;
  /** Poll interval for far-end hangup detection, ms. 0 disables. Default 0. */
  hangupPollMs?: number;
  /** Cap on concurrent realtime sessions. */
  maxConcurrent?: number;
  /**
   * Run the call through the AssemblyAI Voice Agent instead of the composed
   * STT + LLM + TTS pipeline. The replies come from the fake service rather
   * than from `replies`, because on this path the service produces both the
   * text and the speech.
   */
  voiceAgent?: { replies?: string[]; greeting?: string };
}

export const DEFAULT_ENDPOINT = "192.168.1.44:5555";

/** Everything a test needs to drive and inspect one running stack. */
export interface Harness {
  adb: FakeAdb;
  phone: FakePhone;
  devices: DeviceManager;
  sessions: RealtimeSessionManager;
  a2i: FakeA2IFleet;
  capture: ReplayCapture;
  llm: ScriptedLlm;
  agent: LlmCallAgent;
  /** Set only when `voiceAgent` was requested. */
  voiceAgent: FakeVoiceAgentFleet | null;
  /** Everything the agent's voice was written into, on the Voice Agent path. */
  injected: CollectingInjector;
  store: MemoryCallRecordStore;
  orchestrator: Orchestrator;
  /** Every state the orchestrator announced, in order. */
  states: string[];
  /** Non-fatal errors the orchestrator reported. */
  errors: Error[];
  /** Reconcile the device pool against the fake adb. */
  refresh(): Promise<void>;
  /** Wait until `predicate` holds, or fail. */
  waitFor(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** Wait for a call to finish and return its record. */
  finish(call: Promise<CallRecord>): Promise<CallRecord>;
}

/** Build a fully wired stack. */
export function buildHarness(opts: HarnessOptions = {}): Harness {
  const phones = opts.phones ?? [new FakePhone({ endpoint: DEFAULT_ENDPOINT })];
  const adb = new FakeAdb(phones);
  const devices = new DeviceManager({ runner: adb, pollIntervalMs: 60_000 });
  const detector = new AdbCallChannelDetector(adb);

  const a2i = new FakeA2IFleet();
  const sessions = new RealtimeSessionManager(e2eConfig(), {
    wsFactory: a2i.factory as never,
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
  });

  const capture = new ReplayCapture();
  const llm = new ScriptedLlm(opts.replies ?? []);
  const agent = new LlmCallAgent({
    llm,
    tts: new SilentTts(),
    ...(opts.greeting !== undefined ? { greeting: opts.greeting } : {}),
  });
  const store = new MemoryCallRecordStore();

  const injected = new CollectingInjector();
  const voiceAgentFleet = opts.voiceAgent
    ? new FakeVoiceAgentFleet({
        ...(opts.voiceAgent.replies ? { replies: opts.voiceAgent.replies } : {}),
        ...(opts.voiceAgent.greeting !== undefined ? { greeting: opts.voiceAgent.greeting } : {}),
      })
    : null;
  const bridge = voiceAgentFleet
    ? new VoiceAgentBridge({
        apiKey: "test-not-a-real-key",
        agentId: "11111111-2222-3333-4444-555555555555",
        injectorFor: () => injected,
        createSession: voiceAgentFleet.create as never,
      })
    : null;

  const states: string[] = [];
  const errors: Error[] = [];
  const orchestrator = new Orchestrator({
    devices,
    controllerFor: (deviceId) => new AndroidCallController(adb, deviceId),
    detector,
    // One socket doing STT, the model and the voice, or the composed trio.
    sessions: bridge ?? sessions,
    capture,
    agent: bridge ? bridge.agent : agent,
    store,
    hangupPollMs: opts.hangupPollMs ?? 0,
    ...(opts.recordingsDir !== undefined ? { recordingsDir: opts.recordingsDir } : {}),
  });
  orchestrator.on("state", (_id: string, state: string) => states.push(state));
  orchestrator.on("error", (err: Error) => errors.push(err));

  const waitFor = async (
    predicate: () => boolean,
    what: string,
    timeoutMs = 3000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`e2e: timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  return {
    adb,
    phone: phones[0]!,
    devices,
    sessions,
    a2i,
    capture,
    llm,
    agent,
    voiceAgent: voiceAgentFleet,
    injected,
    store,
    orchestrator,
    states,
    errors,
    refresh: () => devices.refresh(),
    waitFor,
    finish: (call) => call,
  };
}
