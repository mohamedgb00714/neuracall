/**
 * The serialiser exists because of a failure seen on a real handset: a
 * `uiautomator dump` run while the detector's poll was dumping came back with
 * exit 137 (SIGKILL), empty stdout and empty stderr. Nothing named the cause.
 *
 * The consequence is not cosmetic. The answerer dumps the screen to find the
 * accept button *while the phone is ringing*, which is precisely when the
 * detector polls hardest — so losing that race means no accept button, no tap,
 * and a call that rings out. These tests are about that race.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../src/adb.js";
import { dumpUi, resetUiDumpQueues } from "../src/uiDump.js";

const XML = '<?xml version="1.0"?><hierarchy><node text="ok"/></hierarchy>';

/** Records overlap: how many dumps were in flight at once. */
function overlapTrackingRunner(opts: { delayMs?: number } = {}) {
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];
  const runner: CommandRunner = {
    run: async () => "",
    runForDevice: async (_endpoint, args) => {
      calls.push(args.join(" "));
      if (args[1] !== "uiautomator") return XML;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
      inFlight -= 1;
      return "";
    },
  } as CommandRunner;
  return { runner, peak: () => peak, calls };
}

test("concurrent dumps on one device never overlap", async () => {
  resetUiDumpQueues();
  const { runner, peak } = overlapTrackingRunner();

  await Promise.all(
    Array.from({ length: 6 }, (_, i) => dumpUi(runner, "DEV1", { path: `/sdcard/p${i}.xml` })),
  );

  assert.equal(peak(), 1, "two dumps in flight on one device kill each other on the handset");
});

test("different devices are not serialised against each other", async () => {
  // The constraint is per-handset. Queuing across devices would make a rack of
  // phones answer calls one at a time.
  resetUiDumpQueues();
  let concurrent = 0;
  let peak = 0;
  const runner = {
    run: async () => "",
    runForDevice: async (_e: string, args: string[]) => {
      if (args[1] !== "uiautomator") return XML;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent -= 1;
      return "";
    },
  } as unknown as CommandRunner;

  await Promise.all([
    dumpUi(runner, "DEV1", { path: "/sdcard/a.xml" }),
    dumpUi(runner, "DEV2", { path: "/sdcard/b.xml" }),
  ]);

  assert.equal(peak, 2, "separate handsets have separate uiautomator");
});

test("a dump killed mid-race is retried and succeeds", async () => {
  resetUiDumpQueues();
  let attempts = 0;
  const runner = {
    run: async () => "",
    runForDevice: async (_e: string, args: string[]) => {
      if (args[1] === "uiautomator") {
        attempts += 1;
        // Exit 137: what the handset actually returned when two dumps raced.
        if (attempts === 1) throw new Error("Command failed: ... code 137");
        return "";
      }
      return XML;
    },
  } as unknown as CommandRunner;

  const xml = await dumpUi(runner, "DEV1", { path: "/sdcard/a.xml" });
  assert.equal(attempts, 2, "one retry, because a lost race deserves a second go");
  assert.match(xml, /<hierarchy/);
});

test('"ERROR: could not get idle state" is a failure despite exiting zero', async () => {
  // uiautomator prints this on stdout and exits 0 when the screen will not
  // settle. A ringing screen animates, so this is a normal path, and taking it
  // as a dump would mean searching junk for the accept button.
  resetUiDumpQueues();
  let reads = 0;
  const runner = {
    run: async () => "",
    runForDevice: async (_e: string, args: string[]) => {
      if (args[1] === "uiautomator") return "";
      reads += 1;
      return reads === 1 ? "ERROR: could not get idle state." : XML;
    },
  } as unknown as CommandRunner;

  const xml = await dumpUi(runner, "DEV1", { path: "/sdcard/a.xml" });
  assert.match(xml, /<hierarchy/, "the retry should have produced a real dump");
});

test("a dump that never succeeds returns empty rather than throwing", async () => {
  // Callers poll; "the screen could not be read" and "the button is not there
  // yet" deserve the same handling, and each surfaces its own error on timeout.
  resetUiDumpQueues();
  const runner = {
    run: async () => "",
    runForDevice: async () => {
      throw new Error("device offline");
    },
  } as unknown as CommandRunner;

  assert.equal(await dumpUi(runner, "DEV1", { path: "/sdcard/a.xml" }), "");
});

test("one caller's failure does not block the next", async () => {
  // The queue chains every dump on a device; a rejection that poisoned the
  // chain would stop the answerer dead the first time a poll failed.
  resetUiDumpQueues();
  let calls = 0;
  const runner = {
    run: async () => "",
    runForDevice: async (_e: string, args: string[]) => {
      if (args[1] !== "uiautomator") return XML;
      calls += 1;
      if (calls <= 2) throw new Error("boom");
      return "";
    },
  } as unknown as CommandRunner;

  const first = await dumpUi(runner, "DEV1", { path: "/sdcard/a.xml" });
  const second = await dumpUi(runner, "DEV1", { path: "/sdcard/b.xml" });

  assert.equal(first, "", "the first caller exhausted its attempts");
  assert.match(second, /<hierarchy/, "the second caller must still run");
});
