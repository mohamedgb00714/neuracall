import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHealthServer, renderPrometheus, type HealthServer } from "../src/health.js";
import { Metrics } from "../src/metrics.js";
import type { CallRecord } from "../src/types.js";

/** Looks like a real key, so a test that finds it in a body has found a leak. */
const API_KEY = "aai_5f3a91c0b7e24d8fa0c16b2d4e7f8091";

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A metrics object with a few of everything on it. */
function busyMetrics(now: () => number): Metrics {
  const metrics = new Metrics({ now });
  const orchestrator = new EventEmitter();
  metrics.attach(orchestrator);

  orchestrator.emit("state", "call-1", "incoming");
  orchestrator.emit("transcript", "call-1", { speaker: "caller", text: "hello", at: 1 });
  orchestrator.emit("transcript", "call-1", { speaker: "agent", text: "hi", at: 2 });
  orchestrator.emit("bargeIn", "call-1");
  orchestrator.emit("state", "call-1", "ended");
  orchestrator.emit("call", ended("call-1"));

  orchestrator.emit("state", "call-2", "incoming");
  metrics.increment("sttSessionsOpened", 2);
  metrics.increment("sttSessionsClosed");
  metrics.setGauge("queuedSessions", 3);
  return metrics;
}

function ended(callId: string): CallRecord {
  return {
    callId,
    deviceId: "192.168.1.44:5555",
    channelId: "cellular",
    direction: "inbound",
    state: "ended",
    outcome: "completed",
    remoteParty: null,
    startedAt: 1000,
    answeredAt: 1100,
    endedAt: 2000,
    transcript: [],
    audioPath: null,
    states: [],
  };
}

async function withServer(
  metrics: Metrics,
  fn: (server: HealthServer) => Promise<void>,
  opts: { readiness?: () => boolean; version?: string } = {},
): Promise<void> {
  const server = createHealthServer({
    metrics,
    port: 0,
    ...(opts.readiness ? { readiness: opts.readiness } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
  });
  await server.listen();
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

/**
 * A deliberately strict reader of the text exposition format: every sample
 * line must be `name value`, must be preceded by a HELP and a TYPE for that
 * exact name, and no name may be declared twice.
 */
function parsePrometheus(body: string): Map<string, { type: string; help: string; value: number }> {
  assert.ok(body.endsWith("\n"), "the exposition format must end with a newline");
  const out = new Map<string, { type: string; help: string; value: number }>();
  const help = new Map<string, string>();
  const type = new Map<string, string>();

  for (const line of body.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# HELP ")) {
      const [name, ...rest] = line.slice(7).split(" ");
      assert.ok(name, "HELP without a metric name");
      assert.equal(help.has(name), false, `duplicate HELP for ${name}`);
      assert.ok(rest.length > 0, `empty HELP for ${name}`);
      help.set(name, rest.join(" "));
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const [name, kind] = line.slice(7).split(" ");
      assert.ok(name && kind, "TYPE without a metric name and kind");
      assert.match(kind, /^(counter|gauge|histogram|summary|untyped)$/);
      assert.equal(type.has(name), false, `duplicate TYPE for ${name}`);
      type.set(name, kind);
      continue;
    }
    assert.equal(line.startsWith("#"), false, `unexpected comment: ${line}`);

    const match =
      /^([a-zA-Z_:][a-zA-Z0-9_:]*) (-?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[+-]?Inf|NaN))$/.exec(line);
    assert.ok(match, `malformed sample line: ${line}`);
    const name = match[1]!;
    assert.ok(type.has(name), `sample ${name} has no # TYPE`);
    assert.ok(help.has(name), `sample ${name} has no # HELP`);
    assert.equal(out.has(name), false, `duplicate sample for ${name}`);
    out.set(name, {
      type: type.get(name)!,
      help: help.get(name)!,
      value: Number(match[2]),
    });
  }
  return out;
}

test("/health returns the counters and gauges as JSON", async () => {
  const c = clock();
  const metrics = busyMetrics(c.now);
  c.advance(90_000);

  await withServer(
    metrics,
    async (server) => {
      const res = await fetch(`${server.url}/health`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);

      const body = (await res.json()) as {
        status: string;
        version: string;
        uptimeMs: number;
        startedAt: number;
        counters: Record<string, number>;
        gauges: Record<string, number>;
      };
      assert.equal(body.status, "ok");
      assert.equal(body.version, "test-build");
      assert.equal(body.uptimeMs, 90_000);
      assert.equal(body.startedAt, 1_700_000_000_000);
      assert.equal(body.counters.callsStarted, 2);
      assert.equal(body.counters.callsCompleted, 1);
      assert.equal(body.counters.transcriptTurns, 2);
      assert.equal(body.counters.agentReplies, 1);
      assert.equal(body.counters.bargeIns, 1);
      assert.equal(body.counters.sttSessionsOpened, 2);
      assert.equal(body.counters.sttSessionsClosed, 1);
      assert.equal(body.gauges.activeCalls, 1);
      assert.equal(body.gauges.queuedSessions, 3);
    },
    { version: "test-build" },
  );
});

test("/metrics parses as valid Prometheus text exposition format", async () => {
  const c = clock();
  const metrics = busyMetrics(c.now);
  c.advance(2500);

  await withServer(metrics, async (server) => {
    const res = await fetch(`${server.url}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);

    const series = parsePrometheus(await res.text());
    assert.equal(series.get("neuracall_calls_started_total")?.value, 2);
    assert.equal(series.get("neuracall_calls_started_total")?.type, "counter");
    assert.equal(series.get("neuracall_calls_completed_total")?.value, 1);
    assert.equal(series.get("neuracall_barge_ins_total")?.value, 1);
    assert.equal(series.get("neuracall_stt_sessions_opened_total")?.value, 2);
    assert.equal(series.get("neuracall_watchdog_teardowns_total")?.value, 0);

    assert.equal(series.get("neuracall_active_calls")?.type, "gauge");
    assert.equal(series.get("neuracall_active_calls")?.value, 1);
    assert.equal(series.get("neuracall_queued_sessions")?.value, 3);
    assert.equal(series.get("neuracall_uptime_seconds")?.value, 2.5);
    assert.equal(series.get("neuracall_start_time_seconds")?.value, 1_700_000_000);
  });
});

test("neither endpoint can leak the API key", async () => {
  const c = clock();
  // The key sits in a config object the way a real process holds it, and that
  // object is even captured by a gauge closure. There is still no route from a
  // request to it, because the server can only ever serve a MetricsSnapshot.
  const config = { assemblyai: { apiKey: API_KEY }, llm: { apiKey: API_KEY } };
  const metrics = new Metrics({ now: c.now });
  metrics.bindGauge("queuedSessions", () => Object.keys(config).length);

  await withServer(
    metrics,
    async (server) => {
      for (const path of ["/health", "/metrics"]) {
        const body = await (await fetch(`${server.url}${path}`)).text();
        assert.equal(body.includes(API_KEY), false, `${path} leaked the API key`);
        assert.equal(/aai_[0-9a-f]{8}/.test(body), false, `${path} leaked something key-shaped`);
        assert.equal(/apiKey|api_key|secret|token/i.test(body), false, `${path} named a secret`);
      }
    },
    { version: "test-build" },
  );
});

test("anything that is not GET /health or GET /metrics is a 404", async () => {
  const metrics = new Metrics({ now: clock().now });

  await withServer(metrics, async (server) => {
    for (const path of ["/", "/healthz", "/metrics/extra", "/../etc/passwd", "/config"]) {
      const res = await fetch(`${server.url}${path}`);
      assert.equal(res.status, 404, `${path} should not be served`);
      await res.text();
    }

    // Writes are not an operator endpoint's business.
    const post = await fetch(`${server.url}/health`, { method: "POST" });
    assert.equal(post.status, 404);
    await post.text();
  });
});

test("query strings and a trailing slash still reach the endpoint", async () => {
  const metrics = new Metrics({ now: clock().now });

  await withServer(metrics, async (server) => {
    assert.equal((await fetch(`${server.url}/health?pretty=1`)).status, 200);
    assert.equal((await fetch(`${server.url}/metrics/`)).status, 200);
  });
});

test("a failing readiness probe answers 503 so a supervisor can act", async () => {
  const metrics = new Metrics({ now: clock().now });

  await withServer(
    metrics,
    async (server) => {
      const res = await fetch(`${server.url}/health`);
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { status: string }).status, "degraded");

      // /metrics stays scrapable while degraded — that is when it matters most.
      assert.equal((await fetch(`${server.url}/metrics`)).status, 200);
    },
    { readiness: () => false },
  );
});

test("a readiness probe that throws is treated as unhealthy, not as a crash", async () => {
  const metrics = new Metrics({ now: clock().now });

  await withServer(
    metrics,
    async (server) => {
      const res = await fetch(`${server.url}/health`);
      assert.equal(res.status, 503);
      await res.text();
    },
    {
      readiness: () => {
        throw new Error("device manager unreachable");
      },
    },
  );
});

test("the endpoint binds loopback unless told otherwise", async () => {
  const metrics = new Metrics({ now: clock().now });
  const server = createHealthServer({ metrics, port: 0 });
  await server.listen();
  try {
    assert.equal(server.host, "127.0.0.1");
    assert.ok(server.port > 0);
    assert.equal(server.url, `http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
});

test("close() is safe on a server that never listened", async () => {
  const metrics = new Metrics({ now: clock().now });
  const server = createHealthServer({ metrics, port: 0 });
  await server.close();
});

test("renderPrometheus formats a snapshot without a server", () => {
  const c = clock();
  const metrics = new Metrics({ now: c.now });
  metrics.increment("watchdogTeardowns", 4);
  c.advance(1234);

  const text = renderPrometheus(metrics.snapshot());
  const series = parsePrometheus(text);
  assert.equal(series.get("neuracall_watchdog_teardowns_total")?.value, 4);
  assert.equal(series.get("neuracall_uptime_seconds")?.value, 1.234);
});
