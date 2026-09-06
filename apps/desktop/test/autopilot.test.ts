import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RealtimeSessionManager } from "@neuracall/aai-client";
import { CrmStore, sqliteAvailable } from "@neuracall/crm";
import {
  DeviceManager,
  realRunner,
  defaultSpawner,
  type CallChannelDetector,
  type CallController,
  type CallState,
  type ChannelKind,
  type Device,
  type DevicePhase,
} from "@neuracall/device-manager";
import {
  Orchestrator,
  type AudioCapture,
  type CallAgent,
  type CallRecordStore,
  type CaptureHandle,
  type CapturePcmSink,
  type DevicePool,
  type SttSessionManager,
} from "@neuracall/orchestrator";
import { Autopilot, ttsEnvWithLlmBase } from "../electron/service/autopilot.js";
import { buildAppConfig, defaultSettings } from "../electron/service/settings.js";

const DEVICE = "192.168.1.44:5555";
const CALL_ID = "call-under-test";
// buildAppConfig only carries this key into the config object; nothing here
// reaches the network, so the shape is all that matters.
const AAI_KEY = "aai_2b7d1f0c9e8a4d3fb6c50a19e7f42d83";

// ---------------------------------------------------------------- fakes

class FakePool implements DevicePool {
  private device: Device = {
    id: DEVICE,
    kind: "wifi",
    adbState: "device",
    phase: "online",
    updatedAt: 0,
  };

  get snapshot(): Device[] {
    return [this.device];
  }

  get(id: string): Device | undefined {
    return id === this.device.id ? this.device : undefined;
  }

  setPhase(id: string, phase: DevicePhase): void {
    if (id !== this.device.id) return;
    this.device = { ...this.device, phase };
  }

  reportIncomingCall(id: string, channel: ChannelKind): Device | undefined {
    if (id !== this.device.id) return undefined;
    this.device = { ...this.device, phase: "incoming", channel };
    return this.device;
  }
}

class FakeController implements CallController {
  telephony: CallState = "offhook";

  async answer(): Promise<void> {}
  async hangUp(): Promise<void> {
    this.telephony = "idle";
  }
  async safeHangUp(): Promise<void> {
    await this.hangUp();
  }
  async dial(): Promise<void> {}
  async openDialer(): Promise<void> {}
  async pressDigits(): Promise<void> {}
  async toggleMute(): Promise<void> {}
  async callState(): Promise<CallState> {
    return this.telephony;
  }
}

class FakeStream extends EventEmitter {
  sendAudio(_chunk: Uint8Array): boolean {
    return true;
  }
  updateConfiguration(_update: { agent_context?: string; keyterms_prompt?: string[] }): void {}
}

/**
 * A session manager whose close() can be parked mid-teardown — the realtime
 * Terminate that is still in flight when the operator quits the app.
 */
class FakeSessions implements SttSessionManager {
  readonly stream = new FakeStream();
  private parkClose = false;
  private closeGate: Promise<void> | null = null;
  private closeRelease: (() => void) | null = null;

  /** The next close() parks here until closeReleased(). */
  parkNextClose(): void {
    this.parkClose = true;
  }

  /** Whether a close is currently parked (teardown mid-flight). */
  get closeParked(): boolean {
    return this.closeGate !== null;
  }

  closeReleased(): void {
    this.closeRelease?.();
    this.closeRelease = null;
    this.closeGate = null;
  }

  isOpen(): boolean {
    return false;
  }

  async open(): Promise<FakeStream> {
    return this.stream;
  }

  async close(): Promise<void> {
    if (this.parkClose) {
      this.parkClose = false;
      this.closeGate = new Promise<void>((resolve) => (this.closeRelease = resolve));
    }
    if (this.closeGate) await this.closeGate;
  }
}

class FakeCapture implements AudioCapture {
  sink: CapturePcmSink | null = null;

  async start(args: { deviceId: string; sink: CapturePcmSink }): Promise<CaptureHandle> {
    this.sink = args.sink;
    args.sink.format?.({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
    return { stop: () => {} };
  }
}

const agent: CallAgent = {
  onFinalTurn: async () => null,
};

const detector: CallChannelDetector = {
  detect: async () => ({ present: false, channel: null }),
};

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --------------------------------------------------------------- tests

test("the TTS env borrows the same base URL the LLM talks to", () => {
  const hints = { TTS_PROVIDER: "auto" as const };
  assert.deepEqual(ttsEnvWithLlmBase(hints, undefined), hints, "no override, untouched");
  assert.equal(
    ttsEnvWithLlmBase(hints, "https://gateway.openrouter.ai")["LLM_BASE_URL"],
    "https://gateway.openrouter.ai",
    "a custom LLM base must voice the reply through the same gateway",
  );
  assert.equal(
    ttsEnvWithLlmBase(hints, "https://gateway.openrouter.ai")["TTS_PROVIDER"],
    "auto",
    "the settings hints survive the merge",
  );
});

test("shutdown drains an in-flight call before closing the CRM", async (t) => {
  // Regression: closing the CRM while a call's teardown was still persisting
  // threw the final save away — the record existed mid-call and never got its
  // "ended" transition. Shutdown must hold the store open until the teardown
  // has landed, then close it.
  if (!sqliteAvailable()) {
    t.skip("node:sqlite unavailable — the CRM is null and the race cannot manifest");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "neuracall-quit-"));
  try {
    const pool = new FakePool();
    const controller = new FakeController();
    const sessions = new FakeSessions();
    const capture = new FakeCapture();
    let orchestrator!: Orchestrator;

    // The real Autopilot, but with a test-built orchestrator that keeps the
    // real store/crm wiring while every transport is a fake.
    const autopilot = new Autopilot({
      config: buildAppConfig(AAI_KEY, defaultSettings()),
      devices: new DeviceManager({ runner: realRunner(defaultSpawner), pollIntervalMs: 0 }),
      sessions: new RealtimeSessionManager(buildAppConfig(AAI_KEY, defaultSettings()), {
        maxConcurrent: 1,
      }),
      runner: realRunner(defaultSpawner),
      dataDir: dir,
      buildOrchestrator: (store) => {
        orchestrator = new Orchestrator({
          devices: pool,
          controllerFor: () => controller,
          detector,
          sessions,
          capture,
          agent,
          store,
          makeCallId: () => CALL_ID,
          hangupPollMs: 0,
        });
        return orchestrator;
      },
    });

    // A call that gets as far as an open session and sits, mid-flight.
    const call = orchestrator.handleIncomingCall(DEVICE, "cellular");
    await waitFor(() => capture.sink !== null, "the call to be in flight");
    assert.equal(orchestrator.activeCalls.length, 1);

    // Quit: the call's teardown starts but the session close parks, so the
    // final record is still unwritten — exactly the shape of the quit race.
    sessions.parkNextClose();
    const shutdown = autopilot.shutdown();
    let shutdownSettled = false;
    void shutdown
      .then(() => {
        shutdownSettled = true;
      })
      .catch(() => {});

    await waitFor(() => sessions.closeParked, "the teardown to park mid-flight");
    assert.equal(
      shutdownSettled,
      false,
      "shutdown must not finish (close the CRM) while the teardown is still in flight",
    );

    sessions.closeReleased();
    await shutdown;
    assert.equal(shutdownSettled, true);

    // The final record was written before the CRM closed: reopen the file and
    // the call has ended rather than lingering in "answered".
    await call;
    const reopened = new CrmStore({ path: join(dir, "neuracall.db") });
    try {
      const stored = await reopened.get(CALL_ID);
      assert.ok(stored, "the call record must survive the quit");
      assert.equal(stored.state, "ended", "shutdown persisted the in-flight call's final record");
      assert.equal(stored.outcome, "failed");
      assert.notEqual(stored.endedAt, null, "the teardown stamped endedAt");
    } finally {
      reopened.close();
    }

    // Idempotent: a second shutdown neither hangs on a drained store nor
    // closes the already-closed CRM a second time.
    await autopilot.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});