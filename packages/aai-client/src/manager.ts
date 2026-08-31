import { EventEmitter } from "node:events";
import type { AppConfig } from "@neuracall/config";
import { RealtimeStream } from "./realtime.js";
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
  private readonly auth:
    | { mode: "server-key" }
    | { mode: "temp-token"; ttlSeconds: number };

  constructor(
    config: AppConfig,
    opts: {
      maxConcurrent?: number;
      auth?: "server-key" | "temp-token";
      tokenTtlSeconds?: number;
    } = {},
  ) {
    super();
    this.config = config;
    this.maxConcurrent = opts.maxConcurrent ?? 10;
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
      throw new Error(
        `Session already open for ${key.deviceId}/${key.channelId}.`,
      );
    }
    if (this.sessions.size >= this.maxConcurrent) {
      throw new Error(
        `Concurrent session limit (${this.maxConcurrent}) reached — configure a queue upstream.`,
      );
    }

    const stream = new RealtimeStream(this.config, opts.params);

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
      throw err;
    }

    return stream;
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

  private teardown(
    managed: ManagedSession,
    reason: string,
    force: boolean,
  ): Promise<void> {
    const mapKey = sessionMapKey(managed.key);
    managed.phase = "closing";
    return managed.stream.close({ terminate: true, force }).then(
      () => {
        managed.phase = "closed";
        this.sessions.delete(mapKey);
        this.emit("sessionEnd", managed.key, reason);
      },
      (err: unknown) => {
        managed.stream.destroy();
        managed.phase = "closed";
        this.sessions.delete(mapKey);
        this.emit("sessionEnd", managed.key, `teardown error: ${String(err)}`);
      },
    );
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
    stream.on("error", (err: Error) => this.emit("error", managed.key, err));
    stream.on("close", () => {
      const stillOpen = this.sessions.get(mapKey);
      if (stillOpen && stillOpen.phase === "open") {
        stillOpen.phase = "closed";
        this.sessions.delete(mapKey);
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
