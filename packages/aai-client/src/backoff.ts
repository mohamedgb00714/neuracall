/**
 * Reconnect policy for realtime sessions.
 *
 * Not every close code deserves a retry, and retrying the wrong ones is
 * actively harmful. A 1008 means the API key is wrong — reconnecting in a loop
 * turns a configuration mistake into a stream of rejected auth attempts against
 * the provider. A 3009 means we are already over the concurrency limit, so an
 * immediate retry makes the thing we are colliding with worse. Both need
 * *different* handling from an ordinary network drop.
 *
 * So each code is classified once, here, and the decision carries both whether
 * to retry and how long to wait. Delays use full jitter: with several devices
 * reconnecting after the same Wi-Fi blip, a fixed backoff would have them all
 * retry in lockstep and collide again.
 *
 * Close-code meanings are recorded in docs/DECISIONS.md §4.
 */

import { RealtimeCloseCode } from "./types.js";

/** What the caller should do about a closed session. */
export interface RetryDecision {
  /** Whether to open a new session at all. */
  retry: boolean;
  /** How long to wait first, in ms. */
  delayMs: number;
  /** Human-readable reason, for logs and the call record. */
  reason: string;
  /**
   * True when retrying is pointless until a human changes something (bad key,
   * retired endpoint, malformed client messages). The caller should surface
   * this rather than loop.
   */
  fatal: boolean;
  /** True when the chunk size must be reduced before reconnecting (3007). */
  adjustChunkSize: boolean;
  /** True when the close was a normal, expected end of session. */
  expected: boolean;
}

export interface ReconnectPolicyOptions {
  /** Give up after this many attempts. Default 5. */
  maxAttempts?: number;
  /** First backoff step in ms. Default 250. */
  baseDelayMs?: number;
  /** Ceiling for a single wait, in ms. Default 15000. */
  maxDelayMs?: number;
  /**
   * Extra floor for 3009 (too many sessions): we are provably over the limit,
   * so the shortest sensible wait is longer than for a network blip.
   * Default 2000 ms.
   */
  capacityDelayMs?: number;
  /** Apply full jitter. Default true. Disable for deterministic tests. */
  jitter?: boolean;
  /** Random source in [0,1). Injectable for tests. */
  random?: () => number;
}

/** How each close code is treated. */
interface Classification {
  retry: boolean;
  fatal: boolean;
  expected: boolean;
  adjustChunkSize: boolean;
  /** Use the capacity floor rather than the normal schedule. */
  capacity: boolean;
  reason: string;
}

const CLASSIFICATIONS: Record<number, Classification> = {
  [RealtimeCloseCode.Normal]: {
    retry: false,
    fatal: false,
    expected: true,
    adjustChunkSize: false,
    capacity: false,
    reason: "normal closure after Termination",
  },
  [RealtimeCloseCode.Abnormal]: {
    retry: true,
    fatal: false,
    expected: false,
    adjustChunkSize: false,
    capacity: false,
    reason: "abnormal closure (1006) — network drop",
  },
  [RealtimeCloseCode.Unauthorized]: {
    // Retrying cannot fix a bad key, and hammering an auth endpoint is worse
    // than failing loudly.
    retry: false,
    fatal: true,
    expected: false,
    adjustChunkSize: false,
    capacity: false,
    reason: "unauthorized (1008) — check ASSEMBLYAI_API_KEY and region",
  },
  [RealtimeCloseCode.InternalError]: {
    retry: true,
    fatal: false,
    expected: false,
    adjustChunkSize: false,
    capacity: false,
    reason: "server error establishing the connection (1011)",
  },
  [RealtimeCloseCode.SessionCancelled]: {
    retry: true,
    fatal: false,
    expected: false,
    adjustChunkSize: false,
    capacity: false,
    reason: "session cancelled server-side (3005)",
  },
  [RealtimeCloseCode.InvalidMessage]: {
    // Either we sent something malformed (a bug a retry will reproduce) or the
    // session idled out. Neither is fixed by reconnecting in a loop.
    retry: false,
    fatal: true,
    expected: false,
    adjustChunkSize: false,
    capacity: false,
    reason: "invalid message or inactivity timeout (3006)",
  },
  [RealtimeCloseCode.BadAudioChunk]: {
    retry: true,
    fatal: false,
    expected: false,
    adjustChunkSize: true,
    capacity: false,
    reason: "audio chunk outside 50-1000 ms or sent faster than real time (3007)",
  },
  [RealtimeCloseCode.SessionExpired]: {
    // Expected on a very long call: the 3-hour cap. A fresh session continues it.
    retry: true,
    fatal: false,
    expected: false,
    adjustChunkSize: false,
    capacity: false,
    reason: "session hit the duration cap (3008) — opening a fresh session",
  },
  [RealtimeCloseCode.TooManySessions]: {
    retry: true,
    fatal: false,
    expected: false,
    adjustChunkSize: false,
    capacity: true,
    reason: "too many concurrent sessions (3009) — backing off for capacity",
  },
  [RealtimeCloseCode.DeprecatedEndpoint]: {
    retry: false,
    fatal: true,
    expected: false,
    adjustChunkSize: false,
    capacity: false,
    reason: "the V2 streaming endpoint is retired (410) — use /v3/ws",
  },
};

/** Anything not in the table: assume transient and retry. */
const UNKNOWN: Classification = {
  retry: true,
  fatal: false,
  expected: false,
  adjustChunkSize: false,
  capacity: false,
  reason: "unrecognised close code",
};

export interface RetryContext {
  /** The WebSocket close code. */
  code: number;
  /** How many attempts have already been made (0 for the first failure). */
  attempt: number;
  /**
   * A server-supplied delay in ms — from a 429's `Retry-After` header when the
   * failure came from token minting. It overrides the computed backoff, since
   * the server knows better than our schedule does.
   */
  retryAfterMs?: number;
}

export class ReconnectPolicy {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly capacityDelayMs: number;
  private readonly jitter: boolean;
  private readonly random: () => number;

  constructor(opts: ReconnectPolicyOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 250;
    this.maxDelayMs = opts.maxDelayMs ?? 15_000;
    this.capacityDelayMs = opts.capacityDelayMs ?? 2000;
    this.jitter = opts.jitter ?? true;
    this.random = opts.random ?? Math.random;
  }

  /** How a given close code is treated, before attempt limits are applied. */
  static classify(code: number): Classification {
    return CLASSIFICATIONS[code] ?? UNKNOWN;
  }

  /** Whether reconnecting could ever help for this code. */
  static isFatal(code: number): boolean {
    return ReconnectPolicy.classify(code).fatal;
  }

  /** Decide what to do about a closed session. */
  decide(ctx: RetryContext): RetryDecision {
    const c = ReconnectPolicy.classify(ctx.code);
    const base: RetryDecision = {
      retry: false,
      delayMs: 0,
      reason: c.reason,
      fatal: c.fatal,
      adjustChunkSize: c.adjustChunkSize,
      expected: c.expected,
    };

    if (!c.retry) return base;

    if (ctx.attempt >= this.maxAttempts) {
      return {
        ...base,
        retry: false,
        reason: `${c.reason}; giving up after ${this.maxAttempts} attempts`,
      };
    }

    return { ...base, retry: true, delayMs: this.delayFor(ctx, c) };
  }

  /** The backoff for one attempt. Exposed so tests and logs can predict it. */
  delayFor(ctx: RetryContext, classification = ReconnectPolicy.classify(ctx.code)): number {
    // A server-specified Retry-After is authoritative; never retry sooner.
    if (ctx.retryAfterMs !== undefined && ctx.retryAfterMs > 0) {
      return Math.min(ctx.retryAfterMs, this.maxDelayMs);
    }

    const floor = classification.capacity ? this.capacityDelayMs : this.baseDelayMs;
    const exponential = floor * 2 ** ctx.attempt;
    const capped = Math.min(exponential, this.maxDelayMs);

    // Full jitter: pick uniformly in [floor, capped] so a fleet of devices
    // recovering from one outage spreads out instead of retrying in lockstep.
    if (!this.jitter) return capped;
    const span = capped - floor;
    return span <= 0 ? capped : Math.round(floor + this.random() * span);
  }
}

/**
 * Parse an HTTP `Retry-After` header into ms. Accepts both forms the spec
 * allows: delta-seconds, and an HTTP-date. Returns undefined when absent or
 * unparseable, so the caller falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
