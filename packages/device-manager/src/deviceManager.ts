import { EventEmitter } from "node:events";
import type { CommandRunner } from "./adb.js";
import type { AdbState, Device, DevicePhase } from "./types.js";

export interface DeviceManagerOptions {
  runner: CommandRunner;
  /** Reconcile interval in ms. Default 5000. */
  pollIntervalMs?: number;
  /** A previously-known set of wireless endpoints to reconnect to. */
  knownEndpoints?: string[];
}

/**
 * Tracks the pool of Android devices attached via adb (USB or wireless),
 * reconciles their state on a poll loop, and exposes a small event surface for
 * the rest of NeuraCall. Writes are copied out; callers get snapshots.
 *
 * Events:
 *  - "device" (device: Device)                  on any device map change
 *  - "adb-state" (id, adbState: AdbState)       transport-level state change
 *  - "phase" (id, phase: DevicePhase)           high-level phase change
 */
export class DeviceManager extends EventEmitter {
  private readonly runner: CommandRunner;
  private readonly pollIntervalMs: number;
  private readonly knownEndpoints: Set<string>;
  private devices = new Map<string, Device>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: DeviceManagerOptions) {
    super();
    this.runner = opts.runner;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.knownEndpoints = new Set(opts.knownEndpoints ?? []);
  }

  /** Start the reconciliation loop. */
  start(): void {
    if (this.timer) return;
    void this.refresh(); // immediate first pass
    this.timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the reconciliation loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force a single reconciliation pass against adb. */
  async refresh(): Promise<void> {
    let lines: string[];
    try {
      lines = (await this.runner.run(["devices"])).split("\n");
    } catch {
      this.markAllOffline();
      return; // adb unavailable — keep last known state, mark everything offline
    }

    const seen = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("List of")) continue;
      const [id, state] = trimmed.split(/\s+/);
      if (!id || !state) continue;
      seen.add(id);

      const existing = this.devices.get(id);
      const adbState = normalizeAdbState(state);
      const phase = existing?.phase ?? "online";
      if (existing && existing.adbState === adbState) {
        continue; // no change
      }
      const device: Device = {
        id,
        kind: id.includes(":") ? "wifi" : "usb",
        adbState,
        phase: adbState === "device" ? (phase === "unknown" ? "online" : phase) : "offline",
        updatedAt: Date.now(),
      };
      this.devices.set(id, device);
      this.emit("device", device);
      this.emit("adb-state", id, adbState);
    }

    // Mark devices that vanished from `adb devices` as offline.
    for (const id of [...this.devices.keys()]) {
      if (!seen.has(id)) {
        const dev = this.devices.get(id)!;
        this.devices.set(id, { ...dev, adbState: "offline", phase: "offline", updatedAt: Date.now() });
      }
    }
  }

  /** Reconnect any known wireless endpoints (they drop on phone reboot). */
  async reconnectKnown(): Promise<void> {
    for (const endpoint of this.knownEndpoints) {
      try {
        await this.runner.run(["connect", endpoint]);
      } catch {
        // endpoint simply may be unreachable right now — ignore
      }
    }
    await this.refresh();
  }

  get snapshot(): Device[] {
    return [...this.devices.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): Device | undefined {
    return this.devices.get(id);
  }

  /** Mark a device busy/in-call/online from elsewhere (e.g. the orchestrator). */
  setPhase(id: string, phase: DevicePhase): void {
    const dev = this.devices.get(id);
    if (!dev) return;
    const updated = { ...dev, phase, updatedAt: Date.now() };
    this.devices.set(id, updated);
    this.emit("device", updated);
    this.emit("phase", id, phase);
  }

  private markAllOffline(): void {
    const now = Date.now();
    for (const [id, dev] of this.devices) {
      this.devices.set(id, { ...dev, adbState: "offline", phase: "offline", updatedAt: now });
    }
  }
}

function normalizeAdbState(state: string): AdbState {
  switch (state) {
    case "device":
      return "device";
    case "offline":
      return "offline";
    case "unauthorized":
      return "unauthorized";
    default:
      return "unauthorized";
  }
}
