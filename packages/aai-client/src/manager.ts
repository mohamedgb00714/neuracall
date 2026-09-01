import { EventEmitter } from "node:events";
import type { AppConfig } from "@neuracall/config";
import { RealtimeStream } from "./realtime.js";
import type { WebSocketFactory } from "./realtime.js";
import type {
  TurnEvent,
  SpeechStartedEvent,
  SpeakerRevisionEvent,
  RealtimeParams,
} from "./types.js";
import { mintRealtimeToken } from "./token.js";

export interface SessionKey {
  deviceId: string;
  channelId: string;
}

export interface OpenSessionOptions {
  /** Realtime connection parameters (sample rate, model, etc.). */
  params: RealtimeParams;
}

/**
 * Manages N concurrent realtime STT sessions, keyed by (deviceId, channelId),
 * so cellular and WhatsApp calls on overlapping devices never cross-talk.
 * Enforces a bound on concurrent sessions (the server closes at 3009).
 */
export class RealtimeSessionManager extends EventEmitter {
  private readonly config: AppConfig;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly maxConcurrent: number;
  private readonly wsFactory?: WebSocketFactory;
  private readonly auth: { mode: "server-key" } | { mode: "temp-token"; ttlSeconds: number };
  /** FIFO of callers waiting for a concurrency slot. */
  private readonly queue: Array<() => void> = [];
  /** Number of callers currently parked in the queue (for observability). */
  private queued = 0;

  get queuedCount(): number {
    return this.queued;
  }

  constructor(
    config: AppConfig,
    opts: {
      maxConcurrent?: number;
      auth?: "server-key" | "temp-token";
      tokenTtlSeconds?: number;
      wsFactory?: WebSocketFactory;
    } = {},
  ) {
    super();
    this.config = config;
    this.maxConcurrent = opts.maxConcurrent ?? 10;
    this.wsFactory = opts.wsFactory;
    this.auth =
      (opts.auth ?? "server-key") === "temp-token"
        ? { mode: "temp-token", ttlSeconds: opts.tokenTtlSeconds ?? 60 }
        : { mode: "server-key" };
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  get keys(): SessionKey[] {
    return [...this.sessions.keys()].map(keyOf);
  }

  async open(key: SessionKey, opts: OpenSessionOptions): Promise<RealtimeStream> {
    const mapKey = sessionMapKey(key);
    if (this.sessions.has(mapKey)) {
      throw new Error(`Session already open for ${key.deviceId}/${key.channelId}.`);
    }

    await this.acquireSlot();

    // A slot may have been taken by an earlier queued caller while we waited.
    if (this.sessions.has(mapKey)) {
      throw new Error(`Session already open for ${key.deviceId}/${key.channelId}.`);
    }

    const stream = new RealtimeStream(this.config, opts.params, {
      wsFactory: this.wsFactory,
    });

    if (this.auth.mode === "temp-token") {
      const token = await mintRealtimeToken(this.config, this.auth.ttlSeconds);
      stream.withToken(token);
    }

    const managed: ManagedSession = {
      key,
      stream,
      phase: "open",
    };
    this.sessions.set(mapKey, managed);
    this.attachCallbacks(managed);

    try {
      await stream.connect();
    } catch (err) {
      this.sessions.delete(mapKey);
      this.releaseSlot();
      throw err;
    }

    return stream;
  }

  /**
   * Reserve a concurrency slot, waiting in FIFO order when the bound is met.
   * AssemblyAI closes new sessions past the limit with 3009, so we queue rather
   * than let calls race each other; slots free on sessionEnd.
   */
  private acquireSlot(): Promise<void> {
    if (this.sessions.size < this.maxConcurrent) {
      return Promise.resolve();
    }
    this.queued += 1;
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private releaseSlot(): void {
    this.queued = Math.max(0, this.queued - 1);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.sessions.size < this.maxConcurrent) {
      const next = this.queue.shift();
      next?.();
    }
  }

  /** Get an open stream by key, or undefined. */
  get(key: SessionKey): RealtimeStream | undefined {
    return this.sessions.get(sessionMapKey(key))?.stream;
  }

  /** Close a single session, always sending Terminate. */
  async close(key: SessionKey, reason = "ended"): Promise<void> {
    const managed = this.sessions.get(sessionMapKey(key));
    if (!managed) return;
    await this.teardown(managed, reason, false);
  }

  /** Close every open session (application shutdown / watchdog). */
  async closeAll(reason = "shutdown"): Promise<void> {
    const all = [...this.sessions.values()];
    await Promise.allSettled(all.map((m) => this.teardown(m, reason, false)));
  }

  private teardown(managed: ManagedSession, reason: string, force: boolean): Promise<void> {
    const mapKey = sessionMapKey(managed.key);
    managed.phase = "closing";
    return managed.stream.close({ terminate: true, force }).then(
      () => {
        managed.phase = "closed";
        this.sessions.delete(mapKey);
        this.releaseSlot();
        this.emit("sessionEnd", managed.key, reason);
      },
      (err: unknown) => {
        managed.stream.destroy();
        managed.phase = "closed";
        this.sessions.delete(mapKey);
        this.releaseSlot();
        this.emit("sessionEnd", managed.key, `teardown error: ${String(err)}`);
      },
    );
  }

  /**
   * Report a session error without being able to kill the host process.
   *
   * Node treats "error" specially: emitting it with no listener attached
   * throws ERR_UNHANDLED_ERROR. That turns an ordinary, recoverable A2I
   * failure — a dropped socket, a 3009 — into a crash of whatever is hosting
   * the manager, purely because nobody subscribed to this optional diagnostic
   * channel. Session teardown does not depend on anyone listening, so when
   * there is no subscriber the error is dropped here rather than thrown; the
   * per-stream "error" event (which the orchestrator always subscribes to)
   * remains the channel that actually drives call handling.
   */
  private reportError(key: SessionKey, err: Error): void {
    if (this.listenerCount("error") === 0) return;
    this.emit("error", key, err);
  }

  private attachCallbacks(managed: ManagedSession): void {
    const stream = managed.stream;
    const mapKey = sessionMapKey(managed.key);
    stream.on("turn", (turn: TurnEvent) => this.emit("turn", managed.key, turn));
    stream.on("speechStarted", (ev: SpeechStartedEvent) =>
      this.emit("speechStarted", managed.key, ev),
    );
    stream.on("speakerRevision", (ev: SpeakerRevisionEvent) =>
      this.emit("speakerRevision", managed.key, ev),
    );
    stream.on("error", (err: Error) => this.reportError(managed.key, err));
    stream.on("close", () => {
      const stillOpen = this.sessions.get(mapKey);
      if (stillOpen && stillOpen.phase === "open") {
        stillOpen.phase = "closed";
        this.sessions.delete(mapKey);
        this.releaseSlot();
        this.emit("sessionEnd", managed.key, "socket closed unexpectedly");
      }
    });
  }
}

interface ManagedSession {
  key: SessionKey;
  stream: RealtimeStream;
  phase: "open" | "closing" | "closed";
}

function sessionMapKey(key: SessionKey): string {
  return `${key.deviceId}::${key.channelId}`;
}

function keyOf(mapKey: string): SessionKey {
  const [deviceId, channelId] = mapKey.split("::");
  return { deviceId: deviceId ?? "", channelId: channelId ?? "" };
}
