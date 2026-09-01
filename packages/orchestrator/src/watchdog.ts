/**
 * The thing that runs when nothing else does.
 *
 * Three failure modes cost real money or real hardware, and none of them
 * announce themselves — the call loop is still sitting in an `await` that will
 * never resolve, so nothing throws and nothing logs:
 *
 *  1. **A wedged call** holds a phone forever. The device never returns to the
 *     pool, so every later caller hears a busy tone.
 *  2. **A silently dead audio path** looks exactly like a caller who has
 *     stopped talking. Capture died, the socket is fine, the turn never
 *     finalizes; the call sits answered and mute until someone notices.
 *  3. **A stray realtime session** — one with no call behind it any more —
 *     keeps billing. AssemblyAI charges wall-clock on an open session up to a
 *     3-hour cap, so a session leaked by a crash between "open" and the
 *     orchestrator's teardown costs three hours of audio nobody heard. Sweeping
 *     these is the single most valuable thing in this file, and the sweep must
 *     go through the manager's `close()`, which is what sends **Terminate**.
 *
 * Everything is driven from an injected clock and an explicit `tick()`, so the
 * tests fault-inject an overrun or a stall by moving a number, not by waiting.
 */

import type { Metrics } from "./metrics.js";
import type { CallOutcome, CallRecord, TranscriptEntry } from "./types.js";

/** Why the watchdog stepped in. */
export type TeardownKind = "overrun" | "stall" | "stray-session";

export interface WatchdogTeardown {
  kind: TeardownKind;
  /** ms since epoch. */
  at: number;
  /** Absent for a stray session — by definition there is no call. */
  callId?: string;
  deviceId: string;
  channelId: string;
  /** How long the call ran, or how long the offending silence lasted. */
  ageMs: number;
  reason: string;
}

/**
 * The slice of the Orchestrator the watchdog observes. Narrow on purpose: a
 * plain `EventEmitter` with an `activeCalls` array satisfies it.
 */
export interface WatchdogSource {
  readonly activeCalls: CallRecord[];
  endCall(callId: string, outcome: CallOutcome, reason: string): void;
  on(event: "transcript", listener: (callId: string, entry: TranscriptEntry) => void): unknown;
  on(event: "state", listener: (callId: string, state: string, reason?: string) => void): unknown;
  on(event: "bargeIn", listener: (callId: string) => void): unknown;
  off(event: "transcript", listener: (callId: string, entry: TranscriptEntry) => void): unknown;
  off(event: "state", listener: (callId: string, state: string, reason?: string) => void): unknown;
  off(event: "bargeIn", listener: (callId: string) => void): unknown;
}

/** The slice of RealtimeSessionManager the stray sweep needs. */
export interface SessionRegistry {
  readonly keys: Array<{ deviceId: string; channelId: string }>;
  close(key: { deviceId: string; channelId: string }, reason?: string): Promise<void>;
}

/** Injectable timers, so a test never has to let real time pass. */
export interface WatchdogScheduler {
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
}

export interface WatchdogOptions {
  orchestrator: WatchdogSource;
  /** Omit and stray sessions are not swept — strongly discouraged in production. */
  sessions?: SessionRegistry;
  /** Bumped once per teardown. */
  metrics?: Metrics;
  /** Hard ceiling on a single call. Default 30 minutes. */
  maxCallMs?: number;
  /**
   * How long an answered call may go with no transcript activity before it is
   * assumed dead. Default 120 s — long enough for a caller reading out a card
   * number, short enough that a dead capture is not a lost afternoon.
   */
  stallMs?: number;
  /**
   * How long a session must look stray before it is closed. Default 0: the
   * orchestrator registers a call *before* opening its session, so there is no
   * window in which a live call has no record. Raise it if a future caller
   * opens sessions ahead of their calls.
   */
  strayGraceMs?: number;
  /**
   * Whether a session with no call behind it is the watchdog's to close.
   * Default: all of them.
   *
   * The stray sweep exists to catch a session the orchestrator leaked, and it
   * finds them by looking for sessions with no call record. But the desktop
   * app's Listen button opens a session on the *same* manager deliberately, to
   * show live captions with no call in progress — which is indistinguishable
   * from a leak by that test alone. Without this predicate the watchdog reaps
   * it a few seconds after the operator presses the button, and the only
   * symptom is captions that stop.
   */
  isSweepable?: (key: { deviceId: string; channelId: string }) => boolean;
  /** Sweep period once `start()` is called. Default 5 s. */
  intervalMs?: number;
  now?: () => number;
  scheduler?: WatchdogScheduler;
  /** Told about every teardown, before it is acted on. */
  onTeardown?: (teardown: WatchdogTeardown) => void;
  /** A sweep that throws reports here rather than crashing the timer. */
  onError?: (err: Error) => void;
}

export class Watchdog {
  private readonly opts: WatchdogOptions;
  private readonly now: () => number;
  private readonly scheduler: WatchdogScheduler;
  private readonly maxCallMs: number;
  private readonly stallMs: number;
  private readonly strayGraceMs: number;

  /** callId -> ms since epoch of the last sign of life. */
  private readonly lastActivity = new Map<string, number>();
  /** session key -> when it was first seen with no call behind it. */
  private readonly strayFirstSeen = new Map<string, number>();
  /** Calls already torn down, so a slow teardown is not asked twice. */
  private readonly ended = new Set<string>();

  private timer: NodeJS.Timeout | null = null;
  private detach: (() => void) | null = null;
  private sweeping: Promise<WatchdogTeardown[]> | null = null;

  constructor(opts: WatchdogOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.scheduler = opts.scheduler ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (timer) => clearInterval(timer),
    };
    this.maxCallMs = opts.maxCallMs ?? 30 * 60_000;
    this.stallMs = opts.stallMs ?? 120_000;
    this.strayGraceMs = opts.strayGraceMs ?? 0;
    this.watchActivity();
  }

  /** Begin sweeping. Idempotent. */
  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 5000;
    this.timer = this.scheduler.setInterval(() => {
      void this.tick().catch((err: unknown) => this.report(err));
    }, interval);
    // A watchdog must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  /** Stop sweeping and drop the event subscriptions. */
  stop(): void {
    if (this.timer) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    this.detach?.();
    this.detach = null;
  }

  /**
   * One sweep. Public so tests (and an operator command) can run it directly.
   * Overlapping sweeps are collapsed: a slow `close()` must not let the next
   * tick try to close the same session again.
   */
  tick(): Promise<WatchdogTeardown[]> {
    if (this.sweeping) return this.sweeping;
    const run = this.sweep().finally(() => {
      this.sweeping = null;
    });
    this.sweeping = run;
    return run;
  }

  private async sweep(): Promise<WatchdogTeardown[]> {
    const at = this.now();
    const teardowns: WatchdogTeardown[] = [];
    const active = this.opts.orchestrator.activeCalls;

    for (const record of active) {
      const teardown = this.judge(record, at);
      if (!teardown) continue;
      teardowns.push(teardown);
      this.ended.add(record.callId);
      this.lastActivity.delete(record.callId);
      this.record(teardown);
      this.opts.orchestrator.endCall(record.callId, "failed", teardown.reason);
    }

    // Forget calls that ended on their own, so neither map grows with uptime.
    const liveIds = new Set(active.map((r) => r.callId));
    for (const id of this.lastActivity.keys()) {
      if (!liveIds.has(id)) this.lastActivity.delete(id);
    }
    for (const id of this.ended) {
      if (!liveIds.has(id)) this.ended.delete(id);
    }

    teardowns.push(...(await this.sweepStraySessions(active, at)));
    return teardowns;
  }

  /** Decide whether a live call has to go. Returns null for a healthy one. */
  private judge(record: CallRecord, at: number): WatchdogTeardown | null {
    if (this.ended.has(record.callId)) return null;

    const age = at - record.startedAt;
    if (age >= this.maxCallMs) {
      return {
        kind: "overrun",
        at,
        callId: record.callId,
        deviceId: record.deviceId,
        channelId: record.channelId,
        ageMs: age,
        reason: `call exceeded ${this.maxCallMs} ms (${age} ms)`,
      };
    }

    // Stall detection only applies once the call is answered: a phone that is
    // still ringing has nothing to transcribe, and killing it here would turn
    // a slow answer into a dropped call. `maxCallMs` still bounds it.
    if (record.answeredAt === null) return null;

    const last = this.lastActivity.get(record.callId) ?? lastKnownActivity(record);
    const idle = at - last;
    if (idle >= this.stallMs) {
      return {
        kind: "stall",
        at,
        callId: record.callId,
        deviceId: record.deviceId,
        channelId: record.channelId,
        ageMs: idle,
        reason: `no transcript activity for ${idle} ms`,
      };
    }
    return null;
  }

  /**
   * Close every realtime session with no call behind it. Goes through the
   * manager's `close()` because that is the path that sends Terminate; a
   * socket merely dropped stays billable until the 3-hour cap.
   */
  private async sweepStraySessions(active: CallRecord[], at: number): Promise<WatchdogTeardown[]> {
    const sessions = this.opts.sessions;
    if (!sessions) return [];

    const live = new Set(active.map((r) => keyId(r.deviceId, r.channelId)));
    const seen = new Set<string>();
    const teardowns: WatchdogTeardown[] = [];
    const closing: Array<Promise<void>> = [];

    for (const key of sessions.keys) {
      const id = keyId(key.deviceId, key.channelId);
      if (live.has(id)) {
        this.strayFirstSeen.delete(id);
        continue;
      }
      // Somebody else opened this on purpose — see `isSweepable`. Forget any
      // stray age accrued for it, so that turning the protection off later
      // starts the grace period fresh rather than closing it immediately.
      if (this.opts.isSweepable && !this.opts.isSweepable(key)) {
        this.strayFirstSeen.delete(id);
        continue;
      }
      seen.add(id);
      const firstSeen = this.strayFirstSeen.get(id) ?? at;
      this.strayFirstSeen.set(id, firstSeen);
      const age = at - firstSeen;
      if (age < this.strayGraceMs) continue;

      this.strayFirstSeen.delete(id);
      seen.delete(id);
      const teardown: WatchdogTeardown = {
        kind: "stray-session",
        at,
        deviceId: key.deviceId,
        channelId: key.channelId,
        ageMs: age,
        reason: "realtime session with no active call",
      };
      teardowns.push(teardown);
      this.record(teardown);
      closing.push(sessions.close(key, teardown.reason).catch((err: unknown) => this.report(err)));
    }

    for (const id of this.strayFirstSeen.keys()) {
      if (!seen.has(id)) this.strayFirstSeen.delete(id);
    }

    await Promise.all(closing);
    return teardowns;
  }

  private watchActivity(): void {
    const source = this.opts.orchestrator;
    const touch = (callId: string): void => {
      this.lastActivity.set(callId, this.now());
    };
    const onState = (callId: string): void => touch(callId);
    const onTranscript = (callId: string): void => touch(callId);
    const onBargeIn = (callId: string): void => touch(callId);

    source.on("transcript", onTranscript);
    source.on("state", onState);
    source.on("bargeIn", onBargeIn);

    this.detach = () => {
      source.off("transcript", onTranscript);
      source.off("state", onState);
      source.off("bargeIn", onBargeIn);
    };
  }

  private record(teardown: WatchdogTeardown): void {
    this.opts.metrics?.increment("watchdogTeardowns");
    try {
      this.opts.onTeardown?.(teardown);
    } catch (err) {
      this.report(err);
    }
  }

  private report(err: unknown): void {
    this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * The most recent evidence the call was alive, for a watchdog that started
 * after the call did (a restart, or a late `new Watchdog`). The answer time is
 * the floor: a call that has never produced a transcript line has still only
 * been silent since it was answered.
 */
function lastKnownActivity(record: CallRecord): number {
  const lastTurn = record.transcript.at(-1)?.at ?? 0;
  return Math.max(lastTurn, record.answeredAt ?? record.startedAt);
}

function keyId(deviceId: string, channelId: string): string {
  return `${deviceId}::${channelId}`;
}
