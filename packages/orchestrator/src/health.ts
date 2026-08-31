/**
 * The operator endpoint: `GET /health` and `GET /metrics`.
 *
 * Two constraints shape it, and neither is negotiable:
 *
 *  - **It binds 127.0.0.1 by default.** This is a desktop app on someone's
 *    network, not a service behind a load balancer. Defaulting to 0.0.0.0
 *    would publish call counts, and the ability to fingerprint the install, to
 *    every device on the LAN.
 *  - **It can only ever serve a `MetricsSnapshot`.** There is no route to the
 *    config, so there is no route to `ASSEMBLYAI_API_KEY`. The snapshot is
 *    numbers; that is the entire reason this takes a `Metrics` rather than
 *    something with a config on it.
 *
 * `/metrics` emits Prometheus text exposition format (version 0.0.4) so an
 * existing scraper needs no adapter.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  COUNTER_HELP,
  GAUGE_HELP,
  type CounterName,
  type GaugeName,
  type Metrics,
  type MetricsSnapshot,
} from "./metrics.js";

/** Prefix on every exported series. */
const PREFIX = "neuracall";

const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface HealthServerOptions {
  metrics: Metrics;
  /** Default 0 — an ephemeral port, which is what the tests want. */
  port?: number;
  /** Default "127.0.0.1". Change it only behind an authenticated proxy. */
  host?: string;
  /**
   * Reports whether the process is fit to take calls. `false` makes /health
   * answer 503 with `status: "degraded"`, which is what a supervisor restarts
   * on. Defaults to always healthy.
   */
  readiness?: () => boolean;
  /** Build identifier, echoed in /health. Never put a secret here. */
  version?: string;
}

export interface HealthServer {
  /** The underlying node:http server, for anyone who needs to hook it. */
  readonly server: Server;
  /** The bound port. 0 until `listen()` has resolved. */
  readonly port: number;
  readonly host: string;
  /** Base URL of the endpoint, valid once listening. */
  readonly url: string;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

/**
 * Build the operator endpoint. It is not listening yet — call `listen()`, so a
 * caller that fails to bind can report it rather than discovering an
 * asynchronous 'error' event later.
 */
export function createHealthServer(opts: HealthServerOptions): HealthServer {
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;
  let boundPort = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(opts, req, res);
  });

  return {
    server,
    get port(): number {
      return boundPort;
    },
    host,
    get url(): string {
      return `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}`;
    },
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen(requestedPort, host, () => {
          server.off("error", onError);
          const address = server.address();
          boundPort = isAddressInfo(address) ? address.port : requestedPort;
          resolve({ host, port: boundPort });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        // Keep-alive sockets otherwise hold the server open long past the
        // point the process wanted to exit.
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function handle(opts: HealthServerOptions, req: IncomingMessage, res: ServerResponse): void {
  const path = pathOf(req.url);
  if (req.method !== "GET") {
    send(res, 404, "text/plain; charset=utf-8", "not found\n");
    return;
  }

  if (path === "/health") {
    const healthy = isHealthy(opts);
    const snapshot = opts.metrics.snapshot();
    const body = {
      status: healthy ? "ok" : "degraded",
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      startedAt: snapshot.startedAt,
      at: snapshot.at,
      uptimeMs: snapshot.uptimeMs,
      counters: snapshot.counters,
      gauges: snapshot.gauges,
    };
    send(res, healthy ? 200 : 503, "application/json; charset=utf-8", `${JSON.stringify(body)}\n`);
    return;
  }

  if (path === "/metrics") {
    send(res, 200, PROM_CONTENT_TYPE, renderPrometheus(opts.metrics.snapshot()));
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "not found\n");
}

function isHealthy(opts: HealthServerOptions): boolean {
  if (!opts.readiness) return true;
  try {
    return opts.readiness();
  } catch {
    // A readiness probe that throws is itself a symptom.
    return false;
  }
}

/** Render a snapshot as Prometheus text exposition format. */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(snapshot.counters)) {
    const help = COUNTER_HELP[name as CounterName];
    emit(lines, `${PREFIX}_${snake(name)}_total`, "counter", help, value);
  }
  for (const [name, value] of Object.entries(snapshot.gauges)) {
    const help = GAUGE_HELP[name as GaugeName];
    emit(lines, `${PREFIX}_${snake(name)}`, "gauge", help, value);
  }

  emit(
    lines,
    `${PREFIX}_uptime_seconds`,
    "gauge",
    "Seconds since the process started.",
    snapshot.uptimeMs / 1000,
  );
  emit(
    lines,
    `${PREFIX}_start_time_seconds`,
    "gauge",
    "Unix time at which the process started.",
    snapshot.startedAt / 1000,
  );

  return `${lines.join("\n")}\n`;
}

function emit(
  lines: string[],
  name: string,
  type: "counter" | "gauge",
  help: string | undefined,
  value: number,
): void {
  lines.push(`# HELP ${name} ${help ?? name}`);
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(`${name} ${format(value)}`);
}

/** Prometheus wants a plain number; `Number#toString` already gives one. */
function format(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : Number.isNaN(value) ? "NaN" : "-Inf";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function pathOf(url: string | undefined): string {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  // Trailing slashes are the one normalisation worth doing: /health/ is the
  // same endpoint, and a 404 there wastes an operator's afternoon.
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === "object" && address !== null;
}
