import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlCallRecordStore, MemoryCallRecordStore } from "../src/callStore.js";
import type { CallRecord, CallRecordStore } from "../src/types.js";

function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    deviceId: "SERIAL",
    channelId: "cellular",
    direction: "inbound",
    state: "ended",
    outcome: "completed",
    remoteParty: null,
    startedAt: 1000,
    answeredAt: 1100,
    endedAt: 2000,
    transcript: [{ speaker: "caller", text: "hello", at: 1200 }],
    audioPath: null,
    states: [{ state: "idle", at: 1000 }],
    ...overrides,
  };
}

/** The behaviour every implementation must share. */
function behavesLikeACallStore(name: string, make: () => CallRecordStore): void {
  test(`${name}: saves and reads back a record`, async () => {
    const store = make();
    await store.save(record());
    const found = await store.get("call-1");
    assert.equal(found?.callId, "call-1");
    assert.equal(found?.transcript[0]?.text, "hello");
    assert.equal(await store.get("nope"), undefined);
  });

  test(`${name}: save is an upsert, so a call can be written as it progresses`, async () => {
    const store = make();
    await store.save(record({ state: "answered", outcome: null }));
    await store.save(record({ state: "ended", outcome: "completed" }));

    const found = await store.get("call-1");
    assert.equal(found?.state, "ended");
    assert.equal(found?.outcome, "completed");
    assert.equal((await store.list()).length, 1, "an upsert must not duplicate the call");
  });

  test(`${name}: lists newest first, filtered and capped`, async () => {
    const store = make();
    await store.save(record({ callId: "a", startedAt: 100, deviceId: "PHONE-1" }));
    await store.save(record({ callId: "b", startedAt: 300, deviceId: "PHONE-2" }));
    await store.save(record({ callId: "c", startedAt: 200, deviceId: "PHONE-1" }));

    assert.deepEqual(
      (await store.list()).map((r) => r.callId),
      ["b", "c", "a"],
    );
    assert.deepEqual(
      (await store.list({ deviceId: "PHONE-1" })).map((r) => r.callId),
      ["c", "a"],
    );
    assert.deepEqual(
      (await store.list({ limit: 2 })).map((r) => r.callId),
      ["b", "c"],
    );
  });

  test(`${name}: hands out copies, so a caller cannot mutate the store`, async () => {
    const store = make();
    await store.save(record());
    const first = await store.get("call-1");
    first!.transcript.push({ speaker: "agent", text: "injected", at: 9999 });

    const second = await store.get("call-1");
    assert.equal(second!.transcript.length, 1);
  });
}

behavesLikeACallStore("memory", () => new MemoryCallRecordStore());

behavesLikeACallStore("jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-store-"));
  return new JsonlCallRecordStore(join(dir, "calls.jsonl"));
});

test("jsonl: a record survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-store-"));
  const path = join(dir, "nested", "calls.jsonl");
  try {
    const first = new JsonlCallRecordStore(path);
    await first.save(record({ state: "answered", outcome: null }));
    await first.save(record({ state: "ended", outcome: "completed" }));

    // A fresh process replays the log; the last write for a callId wins.
    const reopened = new JsonlCallRecordStore(path);
    const found = await reopened.get("call-1");
    assert.equal(found?.state, "ended");
    assert.equal(found?.outcome, "completed");
    assert.equal((await reopened.list()).length, 1);
    assert.equal(reopened.corruptLines, 0);

    // Every save is appended, so the intermediate state is still on disk.
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jsonl: a truncated tail from an unclean shutdown does not lose the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-store-"));
  const path = join(dir, "calls.jsonl");
  try {
    const store = new JsonlCallRecordStore(path);
    await store.save(record({ callId: "good" }));
    appendFileSync(path, '{"callId":"half-writ');

    const reopened = new JsonlCallRecordStore(path);
    assert.equal(reopened.corruptLines, 1);
    assert.equal((await reopened.get("good"))?.callId, "good");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
