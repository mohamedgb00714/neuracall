/**
 * Process-wide counters and gauges for a running NeuraCall install.
 *
 * This is deliberately an *observer*: it learns everything from the events the
 * orchestrator already emits, so wiring it up is one line and no call-path code
 * has to remember to report anything. Nothing here can fail a call — every
 * handler is arithmetic on a number.
 *
 * Two rules the shape of this file follows:
 *
 *  - **Counters only ever go up.** A dashboard that subtracts is a dashboard
 *    that lies after a restart; `uptimeMs` and `startedAt` are what let a
 *    scraper tell "no calls today" from "the process came back a minute ago".
 *  - **No wall clock is read at module scope.** The clock is injected, so a
 *    test can assert an exact `uptimeMs` instead of sleeping for one.
 */

import type { CallOutcome, CallRecord, TranscriptEntry } from "./types.js";

const COUNTERS = [
  "callsStarted",
  "callsCompleted",
  "callsFailed",
  "callsMissed",
  "callsRejected",
  "transcriptTurns",
  "agentReplies",
  "bargeIns",
  "sttSessionsOpened",
  "sttSessionsClosed",
  "errors",
  "watchdogTeardowns",
] as const;

const GAUGES = ["activeCalls", "queuedSessions"] as const;

export type CounterName = (typeof COUNTERS)[number];
export type GaugeName = (typeof GAUGES)[number];

export type Counters = Record<CounterName, number>;
export type Gauges = Record<GaugeName, number>;

/** One-line description per metric, used verbatim as Prometheus `# HELP`. */
export const COUNTER_HELP: Record<CounterName, string> = {
  callsStarted: "Inbound calls the orchestrator has begun handling.",
  callsCompleted: "Calls that ended normally.",
  callsFailed: "Calls that ended because something broke mid-call.",
  callsMissed: "Calls that rang but were never answered.",
  callsRejected: "Calls that were deliberately declined.",
  transcriptTurns: "Transcript lines recorded, both speakers.",
  agentReplies: "Transcript lines spoken by the agent.",
  bargeIns: "Times a caller talked over the agent.",
  sttSessionsOpened: "Realtime speech-to-text sessions opened.",
  sttSessionsClosed: "Realtime speech-to-text sessions closed with Terminate.",
  errors: "Non-fatal errors reported by the orchestrator.",
  watchdogTeardowns: "Calls or stray sessions torn down by the watchdog.",
};

export const GAUGE_HELP: Record<GaugeName, string> = {
  activeCalls: "Calls currently in flight.",
  queuedSessions: "Callers waiting for a speech-to-text concurrency slot.",
};

/** A plain JSON object: safe to serve, log or diff. Contains no configuration. */
export interface MetricsSnapshot {
  /** ms since epoch when this Metrics was constructed. */
  startedAt: number;
  /** ms since epoch, read from the injected clock when the snapshot was taken. */
  at: number;
  uptimeMs: number;
  counters: Counters;
  gauges: Gauges;
}

/**
 * The slice of the Orchestrator that `attach` needs. Narrow on purpose — a
 * plain `EventEmitter` satisfies it, so tests need no orchestrator at all.
 */
export interface MetricsSource {
  on(event: "call", listener: (record: CallRecord) => void): unknown;
  on(event: "state", listener: (callId: string, state: string, reason?: string) => void): unknown;
  on(event: "transcript", listener: (callId: string, entry: TranscriptEntry) => void): unknown;
  on(event: "bargeIn", listener: (callId: string) => void): unknown;
  on(event: "error", listener: (err: Error, callId?: string) => void): unknown;
  off(event: "call", listener: (record: CallRecord) => void): unknown;
  off(event: "state", listener: (callId: string, state: string, reason?: string) => void): unknown;
  off(event: "transcript", listener: (callId: string, entry: TranscriptEntry) => void): unknown;
  off(event: "bargeIn", listener: (callId: string) => void): unknown;
  off(event: "error", listener: (err: Error, callId?: string) => void): unknown;
}

/** The shape of a session manager, kept generic so no import is needed. */
export interface SessionOpener<K, O, S> {
  open(key: K, opts: O): Promise<S>;
  close(key: K, reason?: string): Promise<void>;
}

export interface MetricsOptions {
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Process start, ms since epoch. Defaults to `now()` at construction. */
  startedAt?: number;
}

/** Removes the listeners a previous `attach` installed. */
export type Detach = () => void;

export class Metrics {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly counters: Counters = zeroed(COUNTERS);
  private readonly gauges: Gauges = zeroed(GAUGES);
  private readonly reads = new Map<GaugeName, () => number>();

  /**
   * Calls seen but not yet finished, and calls whose `ended` transition has
   * arrived but whose final record has not. They are separate because the
   * transition and the record that carries the *outcome* are two events: the
   * gauge must drop on the first, the outcome can only be counted on the
   * second.
   */
  private readonly live = new Set<string>();
  private readonly ending = new Set<string>();

  constructor(opts: MetricsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
  }

  /** Bump a counter. Never accepts a negative delta — counters are monotonic. */
  increment(name: CounterName, by = 1): void {
    if (by <= 0) return;
    this.counters[name] += by;
  }

  setGauge(name: GaugeName, value: number): void {
    this.gauges[name] = value;
  }

  /**
   * Read a gauge from a live source at snapshot time instead of storing it.
   * Lets `queuedSessions` track `RealtimeSessionManager.queuedCount` without
   * anything having to poll it.
   */
  bindGauge(name: GaugeName, read: () => number): void {
    this.reads.set(name, read);
  }

  snapshot(): MetricsSnapshot {
    const at = this.now();
    const gauges = { ...this.gauges };
    for (const [name, read] of this.reads) {
      try {
        gauges[name] = read();
      } catch {
        // A gauge source that throws must not take the health endpoint down
        // with it; the last stored value is a better answer than a 500.
      }
    }
    return {
      startedAt: this.startedAt,
      at,
      uptimeMs: Math.max(0, at - this.startedAt),
      counters: { ...this.counters },
      gauges,
    };
  }

  /**
   * Subscribe to an orchestrator. Returns a detach function; a process that
   * only ever has one orchestrator can ignore it.
   */
  attach(source: MetricsSource): Detach {
    const onState = (callId: string, state: string): void => {
      if (state === "incoming") {
        this.increment("callsStarted");
        this.live.add(callId);
        this.setGauge("activeCalls", this.live.size);
      } else if (state === "ended") {
        this.live.delete(callId);
        this.ending.add(callId);
        this.setGauge("activeCalls", this.live.size);
      }
    };

    // The outcome only exists on the final record, so the counters for how a
    // call ended are driven from "call" rather than from the transition.
    const onCall = (record: CallRecord): void => {
      if (record.state !== "ended") return;
      if (!this.ending.delete(record.callId)) return;
      this.increment(outcomeCounter(record.outcome));
    };

    const onTranscript = (_callId: string, entry: TranscriptEntry): void => {
      this.increment("transcriptTurns");
      if (entry.speaker === "agent") this.increment("agentReplies");
    };

    const onBargeIn = (): void => this.increment("bargeIns");
    const onError = (): void => this.increment("errors");

    source.on("state", onState);
    source.on("call", onCall);
    source.on("transcript", onTranscript);
    source.on("bargeIn", onBargeIn);
    source.on("error", onError);

    return () => {
      source.off("state", onState);
      source.off("call", onCall);
      source.off("transcript", onTranscript);
      source.off("bargeIn", onBargeIn);
      source.off("error", onError);
    };
  }

  /**
   * Wrap a session manager so opens and closes are counted. Pass the result
   * where the manager itself would have gone:
   *
   *   sessions: metrics.instrumentSessions(manager)
   *
   * A wrapper rather than an event subscription because the manager has no
   * "opened" event, and because closes must be counted even when the watchdog
   * — not a call — is the thing sending Terminate.
   */
  instrumentSessions<K, O, S>(sessions: SessionOpener<K, O, S>): SessionOpener<K, O, S> {
    return {
      open: async (key: K, opts: O): Promise<S> => {
        const stream = await sessions.open(key, opts);
        this.increment("sttSessionsOpened");
        return stream;
      },
      close: async (key: K, reason?: string): Promise<void> => {
        try {
          await sessions.close(key, reason);
        } finally {
          // Counted even on failure: the intent to stop the meter is what an
          // operator is looking for when opened and closed diverge.
          this.increment("sttSessionsClosed");
        }
      },
    };
  }
}

function outcomeCounter(outcome: CallOutcome | null): CounterName {
  switch (outcome) {
    case "failed":
      return "callsFailed";
    case "missed":
      return "callsMissed";
    case "rejected":
      return "callsRejected";
    default:
      return "callsCompleted";
  }
}

function zeroed<T extends string>(names: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const name of names) out[name] = 0;
  return out;
}
