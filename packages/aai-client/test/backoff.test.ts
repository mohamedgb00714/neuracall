import { test } from "node:test";
import assert from "node:assert/strict";
import { ReconnectPolicy, parseRetryAfter } from "../src/backoff.js";
import { RealtimeCloseCode } from "../src/types.js";

/** Deterministic policy: no jitter, so delays are exactly predictable. */
function policy(opts: Partial<ConstructorParameters<typeof ReconnectPolicy>[0]> = {}) {
  return new ReconnectPolicy({ jitter: false, baseDelayMs: 100, maxDelayMs: 5000, ...opts });
}

test("a network drop is retried with exponential backoff", () => {
  const p = policy();
  const delays = [0, 1, 2, 3].map(
    (attempt) => p.decide({ code: RealtimeCloseCode.Abnormal, attempt }).delayMs,
  );
  assert.deepEqual(delays, [100, 200, 400, 800]);
});

test("backoff is capped so a long outage does not push retries into next week", () => {
  const p = policy({ maxDelayMs: 5000, maxAttempts: 50 });
  assert.equal(p.decide({ code: RealtimeCloseCode.Abnormal, attempt: 20 }).delayMs, 5000);
  // The cap applies to the schedule itself, independently of attempt limits.
  assert.equal(policy().delayFor({ code: RealtimeCloseCode.Abnormal, attempt: 20 }), 5000);
});

test("retries are bounded", () => {
  const p = policy({ maxAttempts: 3 });
  assert.equal(p.decide({ code: RealtimeCloseCode.Abnormal, attempt: 2 }).retry, true);
  const exhausted = p.decide({ code: RealtimeCloseCode.Abnormal, attempt: 3 });
  assert.equal(exhausted.retry, false);
  assert.match(exhausted.reason, /giving up after 3 attempts/);
});

test("codes a retry cannot fix are fatal, not retried", () => {
  const p = policy();
  for (const code of [
    RealtimeCloseCode.Unauthorized, // bad key — hammering auth is worse than failing
    RealtimeCloseCode.InvalidMessage, // our bug, or an idle session
    RealtimeCloseCode.DeprecatedEndpoint,
  ]) {
    const decision = p.decide({ code, attempt: 0 });
    assert.equal(decision.retry, false, `close ${code} must not be retried`);
    assert.equal(decision.fatal, true, `close ${code} must be reported as fatal`);
    assert.equal(ReconnectPolicy.isFatal(code), true);
  }
  assert.match(p.decide({ code: 1008, attempt: 0 }).reason, /ASSEMBLYAI_API_KEY/);
});

test("a normal close is expected and ends the session quietly", () => {
  const decision = policy().decide({ code: RealtimeCloseCode.Normal, attempt: 0 });
  assert.equal(decision.expected, true);
  assert.equal(decision.retry, false);
  assert.equal(decision.fatal, false);
});

test("3007 retries and tells the caller to shrink its chunk first", () => {
  const decision = policy().decide({ code: RealtimeCloseCode.BadAudioChunk, attempt: 0 });
  assert.equal(decision.retry, true);
  assert.equal(decision.adjustChunkSize, true);
});

test("3009 backs off harder than a network blip, because we are over the limit", () => {
  const p = policy({ capacityDelayMs: 2000 });
  const capacity = p.decide({ code: RealtimeCloseCode.TooManySessions, attempt: 0 });
  const network = p.decide({ code: RealtimeCloseCode.Abnormal, attempt: 0 });
  assert.equal(capacity.retry, true);
  assert.ok(
    capacity.delayMs > network.delayMs,
    `capacity backoff ${capacity.delayMs}ms should exceed network backoff ${network.delayMs}ms`,
  );
});

test("3008 (the 3-hour cap) opens a fresh session rather than failing", () => {
  const decision = policy().decide({ code: RealtimeCloseCode.SessionExpired, attempt: 0 });
  assert.equal(decision.retry, true);
  assert.equal(decision.fatal, false);
});

test("a server Retry-After overrides our own schedule", () => {
  const p = policy();
  const decision = p.decide({
    code: RealtimeCloseCode.TooManySessions,
    attempt: 0,
    retryAfterMs: 4200,
  });
  assert.equal(decision.delayMs, 4200);
  // Still clamped to the ceiling, so a hostile value cannot stall a call forever.
  assert.equal(
    p.decide({ code: RealtimeCloseCode.Abnormal, attempt: 0, retryAfterMs: 999_999 }).delayMs,
    5000,
  );
});

test("an unrecognised close code is treated as transient", () => {
  const decision = policy().decide({ code: 4999, attempt: 0 });
  assert.equal(decision.retry, true);
  assert.equal(decision.fatal, false);
});

test("jitter spreads a fleet's retries instead of retrying in lockstep", () => {
  // Full jitter picks uniformly in [floor, capped]; two different random draws
  // must be able to produce different delays.
  const low = new ReconnectPolicy({ baseDelayMs: 100, random: () => 0 });
  const high = new ReconnectPolicy({ baseDelayMs: 100, random: () => 0.999 });
  const attempt = 3;
  const a = low.decide({ code: RealtimeCloseCode.Abnormal, attempt }).delayMs;
  const b = high.decide({ code: RealtimeCloseCode.Abnormal, attempt }).delayMs;
  assert.ok(a < b, `jittered delays should differ, got ${a} and ${b}`);
  assert.ok(a >= 100, "never shorter than the base delay");
});

test("parseRetryAfter accepts both header forms", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter("  30 "), 30_000);

  const now = Date.parse("2026-08-31T12:00:00Z");
  assert.equal(parseRetryAfter("Mon, 31 Aug 2026 12:00:30 GMT", now), 30_000);
  // A date in the past means "retry now", not a negative wait.
  assert.equal(parseRetryAfter("Mon, 31 Aug 2026 11:59:00 GMT", now), 0);

  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
});
