#!/usr/bin/env node
/**
 * Phone QA harness — combined runner.
 *
 * Runs the detection harness (scripts/live-capture.mjs) for a short window and
 * then the injection loopback (scripts/inject-loopback-test.mjs) on the same
 * device, and prints one combined report with each check's verdict. Read-only
 * towards the phone (dumpsys / screencap / uiautomator reads, plus a locally
 * played 440 Hz tone for the loopback); it never dials or answers a call.
 *
 * Usage:
 *   node scripts/qa-run-all.mjs [--device=SERIAL] [--detect-seconds=N]
 *                               [--tone-seconds=N] [--json=PATH]
 *
 * Defaults:
 *   device         = first device adb reports as online
 *   detect-seconds = 10   (window for the detection tick loop)
 *   tone-seconds   = 4    (tone length for the injection loopback)
 *
 * Exit codes (each check keeps its own; the combined verdict is the worst):
 *   0  PASS         every check passed
 *   1  INCONCLUSIVE any check inconclusive and none hard-failed
 *   2  HARD ERROR   any check could not run (no device, transport failure, ...)
 *
 * A combined JSON summary is printed as the last stdout line; with --json=PATH
 * it is also written to a file.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEAD = `Phone QA harness — combined runner.
  node scripts/qa-run-all.mjs [--device=SERIAL] [--detect-seconds=N] [--tone-seconds=N] [--json=PATH]
defaults: device = first online adb device, detect-seconds = 10, tone-seconds = 4
runs live-capture.mjs then inject-loopback-test.mjs; exits 0 PASS / 1 INCONCLUSIVE / 2 HARD ERROR`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HEAD);
  process.exit(0);
}

const flags = {};
for (const a of args) {
  if (a.startsWith("--device=")) flags.device = a.slice("--device=".length);
  else if (a.startsWith("--detect-seconds=")) flags.detect = a.slice("--detect-seconds=".length);
  else if (a.startsWith("--tone-seconds=")) flags.tone = a.slice("--tone-seconds=".length);
  else if (a.startsWith("--json=")) flags.json = a.slice("--json=".length);
}

const detectSeconds = Number(flags.detect ?? 10);
const toneSeconds = Number(flags.tone ?? 4);
const startedAt = new Date().toISOString();
const scriptDir = import.meta.dirname;
const scratch = mkdtempSync(join(tmpdir(), "neuracall-qa-"));
const detectJson = join(scratch, "detect.json");
const loopJson = join(scratch, "loopback.json");

function runCheck(script, name, argsToPass, jsonPath) {
  const res = spawnSync(process.execPath, [join(scriptDir, script), ...argsToPass], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {}
  return {
    name,
    script,
    summary,
    exitCode: typeof res.status === "number" ? res.status : 2,
  };
}

try {
  console.log(`=== NeuraCall phone QA harness === device: ${flags.device ?? "(first online)"}`);
  console.log(`--- [1/2] detection poll  ${detectSeconds}s — start the WhatsApp Business call now ---\n`);

  const detectArgs = [];
  if (flags.device) detectArgs.push(`--device=${flags.device}`);
  detectArgs.push(`--seconds=${detectSeconds}`, `--json=${detectJson}`);

  const detect = runCheck("live-capture.mjs", "detection poll", detectArgs, detectJson);

  console.log(`\n--- [2/2] injection loopback  ${toneSeconds}s tone ---\n`);
  const loopArgs = [];
  if (flags.device) loopArgs.push(`--device=${flags.device}`);
  loopArgs.push(`--duration=${toneSeconds}`, `--json=${loopJson}`);
  const loop = runCheck("inject-loopback-test.mjs", "injection loopback", loopArgs, loopJson);

  const label = (c) =>
    c.summary ? c.summary.verdict.toUpperCase() : c.exitCode === 2 ? "HARD ERROR" : `exit ${c.exitCode}`;
  const verdictOf = (c) =>
    c.summary ? c.summary.verdict : c.exitCode === 0 ? "pass" : c.exitCode === 1 ? "inconclusive" : "hard-error";

  const detectDetail = detect.summary?.detection?.callSeen
    ? `present=true at t+${detect.summary.detection.firstSeenTick} · ` +
      `${detect.summary.detection.ticks?.[detect.summary.detection.firstSeenTick]?.channel ?? "?"} · ` +
      `${detect.summary.detection.ticks?.[detect.summary.detection.firstSeenTick]?.stage ?? "?"}`
    : detect.summary?.detection?.callSeen === false
      ? "no call seen in window"
      : "";
  const loopDetail = loop.summary?.audio
    ? `ratio ${loop.summary.audio.ratio.toFixed(1)}x (baseline ${loop.summary.audio.baselineRms.toFixed(1)} → injection ${loop.summary.audio.injectionRms.toFixed(1)})`
    : "";

  console.log(`\n=== combined report ===`);
  console.log(`[1] detection poll     ${String(detectSeconds).padEnd(3)}s : ${label(detect).padEnd(12)} ${detectDetail}`);
  console.log(`[2] injection loopback ${String(toneSeconds).padEnd(3)}s : ${label(loop).padEnd(12)} ${loopDetail}`);

  const overall = Math.max(detect.exitCode, loop.exitCode);
  const overallVerdict = overall === 0 ? "pass" : overall === 1 ? "inconclusive" : "hard-error";
  console.log(`overall: ${overallVerdict.toUpperCase()}`);

  const summary = {
    tool: "qa-run-all",
    verdict: overallVerdict,
    exitCode: overall,
    device: detect.summary?.device ?? loop.summary?.device ?? flags.device ?? null,
    startedAt,
    checks: [
      { name: "detection poll", tool: "live-capture", verdict: verdictOf(detect), exitCode: detect.exitCode, summary: detect.summary },
      { name: "injection loopback", tool: "inject-loopback-test", verdict: verdictOf(loop), exitCode: loop.exitCode, summary: loop.summary },
    ],
  };
  if (flags.json) writeFileSync(flags.json, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exitCode = overall;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}