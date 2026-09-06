#!/usr/bin/env node
/**
 * Live capture — phone QA detection harness.
 *
 * While a call happens, record per-second
 *   - detection verdict (callState / present / channel / stage / mode / mModeOwnerPid / focus)
 *   - a screencap PNG
 *   - a uiautomator UI XML dump
 *   - (when populated) dumpsys telecom and logcat change tapes
 * so a missed/mis-detected call can be replayed from artifacts afterwards.
 *
 * Detection semantics are unchanged from the ad-hoc live script: this runs the
 * same AdbCallChannelDetector.detect() verdict, reads the same dumpsys audio
 * fields, and takes the same per-tick snapshot. Only the CLI, the
 * machine-readable summary, and the exit code were standardised.
 *
 * Usage:
 *   node scripts/live-capture.mjs [--device=SERIAL] [--seconds=N] [--json=PATH]
 *   node scripts/live-capture.mjs [seconds] [device]    # legacy order also accepted
 *
 * Defaults:
 *   device  = first device adb reports as online
 *   seconds = 60
 *
 * Exit codes:
 *   0  PASS         present=true on at least one tick — the call was detected
 *   1  INCONCLUSIVE ran to the end but no call was seen (artifacts are kept)
 *   2  HARD ERROR   no online device, adb unusable, or a fatal capture failure
 *
 * A completed run prints one JSON summary as its last stdout line; with
 * --json=PATH it also writes that object (per-tick detection + verdict) to a
 * file, which is how qa-run-all.mjs reads the result.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  realRunner,
  defaultSpawner,
  AndroidCallController,
  AdbCallChannelDetector,
} from "@neuracall/device-manager";

const HEAD = `Live capture — phone QA detection harness.
  node scripts/live-capture.mjs [--device=SERIAL] [--seconds=N] [--json=PATH]
  node scripts/live-capture.mjs [seconds] [device]
default device = first online adb device, default seconds = 60
exit: 0 PASS (call detected) / 1 INCONCLUSIVE (no call seen) / 2 HARD ERROR`;

// --- CLI ------------------------------------------------------------------

const flags = {};
const positionals = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "--help" || arg === "-h") {
    console.log(HEAD);
    process.exit(0);
  } else if (arg.startsWith("--device=")) {
    flags.device = arg.slice("--device=".length);
  } else if (arg.startsWith("--seconds=")) {
    flags.seconds = arg.slice("--seconds=".length);
  } else if (arg.startsWith("--json=")) {
    flags.json = arg.slice("--json=".length);
  } else {
    positionals.push(arg);
  }
}

const [p0, p1] = positionals;
const seconds = Number(flags.seconds ?? (/^\d+$/.test(p0) ? p0 : /^\d+$/.test(p1) ? p1 : 60));
const serialArg = flags.device ?? (/^\d+$/.test(p0) ? p1 : p0);

// --- device ----------------------------------------------------------------

function onlineDevices() {
  const out = execFileSync("adb", ["devices"], {
    encoding: "utf8",
    maxBuffer: 1 << 20,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
  });
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === "device")
    .map((p) => p[0]);
}

let DEVICE;
try {
  const online = onlineDevices();
  DEVICE = serialArg ?? online[0];
  if (!DEVICE) throw new Error("no device online — plug one in or run ./scripts/adb-setup.sh");
  const state = execFileSync("adb", ["-s", DEVICE, "get-state"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
  })
    .trim();
  if (state !== "device") throw new Error(`device ${DEVICE} reports state ${state}`);
} catch (err) {
  console.error(`HARD ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

// --- harness ----------------------------------------------------------------

const startedAt = new Date().toISOString();
const dir = `/tmp/opencode/captures/${startedAt.replace(/[:.]/g, "-")}`;
mkdirSync(dir, { recursive: true });
const timeline = [];
const ticks = [];

const runner = realRunner(defaultSpawner);
const ctrl = new AndroidCallController(runner, DEVICE);
const det = new AdbCallChannelDetector(runner);

function adb(args, binary = true) {
  return execFileSync("adb", ["-s", DEVICE, ...args], {
    encoding: binary ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15000,
  });
}

async function tick(i) {
  let verdict = null;
  try {
    verdict = await det.detect(DEVICE);
  } catch {}
  let state = "?";
  try {
    state = await ctrl.callState();
  } catch {}

  const audioRaw = adb(["shell", "dumpsys", "audio"], false).toString();
  const modeInt = (audioRaw.match(/- mode \(internal\) = (\w+)/) || [])[1] ?? "?";
  const modeExt = (audioRaw.match(/- mode \(external\) = (\w+)/) || [])[1] ?? "?";
  const ownerName = (audioRaw.match(/- Mode owner: (.*)/) || [])[1] ?? "?";
  const ownerPid = (audioRaw.match(/mModeOwnerPid: (\d+)/) || [])[1] ?? "?";

  let focus = "?";
  try {
    const win = adb(["shell", "dumpsys", "window"], false).toString();
    focus = (win.match(/mCurrentFocus=Window\{[^}]*\}\s+([^\s\]]+)/) || [])[1] ?? "?";
  } catch {}

  // Telecom's call list: mode-independent home of self-managed (WhatsApp) calls.
  let telecomCalls = "";
  try {
    const tel = adb(["shell", "dumpsys", "telecom"], false).toString();
    telecomCalls = tel
      .split("\n")
      .filter((l) => /mCalls|Foreground call|State:|ConnectionService|whatsapp|Call \[/i.test(l))
      .join("\n");
  } catch {}

  // The change tape: Telecom/AudioService lines actually emitted during the run.
  let logTape = "";
  try {
    logTape = adb(["logcat", "-d", "-t", "200", "-s", "Telecom AudioService CallAudioModeStateMachine"], false)
      .toString()
      .split("\n")
      .filter((l) => /whatsapp|mModeOwnerPid|setMode|InCallController|Call \[|self.?managed|RINGING|ACTIVE/i.test(l))
      .join("\n");
  } catch {}

  let pkg = "?";
  try {
    const ps = adb(["shell", "ps", "-A", "-o", "PID,NAME"], false).toString();
    const hit = ps.split("\n").find((l) => l.trim().startsWith(`${ownerPid} `));
    pkg = hit ? hit.trim().split(/\s+/)[1] : "-";
  } catch {}

  const t = `t+${String(i).padStart(3, "0")}`;
  const line =
    `${t} state=${state} present=${verdict?.present ?? "err"} channel=${verdict?.channel ?? "-"}` +
    ` stage=${verdict?.stage ?? "-"} ownerPkg=${verdict?.ownerPackage ?? "-"} | ` +
    `modeInt=${modeInt} modeExt=${modeExt} owner="${ownerName}" pid=${ownerPid}(${pkg}) focus=${focus}\n`;
  timeline.push(line);
  if (telecomCalls) writeFileSync(join(dir, `${t}_telecom.txt`), `${t} telecom:\n${telecomCalls}\n`);
  if (logTape) writeFileSync(join(dir, `${t}_logcat.txt`), `${t} logcat:\n${logTape}\n`);
  process.stdout.write(line);

  ticks.push({
    t: i,
    state: state === "?" ? null : state,
    present: verdict?.present ?? false,
    channel: verdict?.channel ?? null,
    stage: verdict?.stage ?? null,
    ownerPackage: verdict?.ownerPackage ?? null,
    modeInternal: modeInt,
    modeExternal: modeExt,
    modeOwnerName: ownerName,
    modeOwnerPid: ownerPid,
    modeOwnerPkg: pkg,
    focus,
  });

  const png = adb(["exec-out", "screencap", "-p"], true);
  writeFileSync(join(dir, `${t}_screen.png`), png);

  try {
    const xmlPath = `/sdcard/neuracall_capture_${i}.xml`;
    execFileSync("adb", ["-s", DEVICE, "shell", "uiautomator", "dump", xmlPath], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const xml = execFileSync("adb", ["-s", DEVICE, "shell", "cat", xmlPath], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (xml && xml.includes("<"))
      writeFileSync(join(dir, `${t}_ui.xml`), xml);
  } catch {
    /* dump is sticky when the screen is locked or mid-transition */
  }
}

console.log(`== capturing ${seconds}s on ${DEVICE} → ${dir} ==`);
console.log(`CALL NOW — start the WhatsApp Business call immediately.\n`);
let done = false;

async function loop() {
  for (let i = 0; i < seconds && !done; i++) await tick(i);
  writeFileSync(join(dir, "timeline.txt"), timeline.join(""));
  const pngCount = readdirSync(dir).filter((f) => f.endsWith(".png")).length;
  console.log(`\n== done: ${pngCount} screenshots, timeline.txt in ${dir} ==`);
  return pngCount;
}

try {
  await loop();

  const firstSeen = ticks.findIndex((tk) => tk.present === true);
  const pass = firstSeen !== -1;
  const summary = {
    tool: "live-capture",
    verdict: pass ? "pass" : "inconclusive",
    exitCode: pass ? 0 : 1,
    device: DEVICE,
    durationSec: seconds,
    startedAt,
    captureDir: dir,
    detection: {
      callSeen: pass,
      firstSeenTick: pass ? firstSeen : null,
      ticks,
    },
  };
  if (flags.json) writeFileSync(flags.json, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(summary.exitCode);
} catch (err) {
  console.error(`HARD ERROR: ${err instanceof Error ? err.stack : String(err)}`);
  writeFileSync(join(dir, "timeline.txt"), timeline.join(""));
  process.exit(2);
}

process.on("SIGINT", () => {
  done = true;
});