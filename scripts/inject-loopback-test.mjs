#!/usr/bin/env node
/**
 * Live injection loopback test — phone QA harness.
 *
 *   host (CommandAudioInjector → aplay) → speaker → phone mic → scrcpy → capture
 *
 * Proves the injector's output actually reaches the phone's microphone (the
 * same path the agent's voice uses during a speakerphone call). Compares mic
 * energy in three windows: baseline (silence), injection (440 Hz tone playing),
 * post-injection.
 *
 * Measurement windows are unchanged from the ad-hoc live script: 1.5 s idle
 * baseline, the tone, a 1 s tail. Only the CLI, the machine-readable summary,
 * and the exit code were standardised.
 *
 * Usage:
 *   node scripts/inject-loopback-test.mjs [--device=SERIAL] [--duration=N] [--json=PATH]
 *   node scripts/inject-loopback-test.mjs [device] [--duration=N]   # legacy
 *
 * Defaults:
 *   device   = first device adb reports as online
 *   duration = 4 s (tone length; sample rate 16 kHz, 1 ch, s16, 440 Hz)
 *
 * Exit codes:
 *   0  PASS         mic RMS rose > 2x during the tone — injection is audible
 *   1  INCONCLUSIVE the transport ran but energy did not clearly couple
 *                   (includes NO SIGNAL; the ratio is environment-dependent:
 *                   speaker volume, phone distance, OEM mic gains)
 *   2  HARD ERROR   no online device, scrcpy did not start, or no audio player
 *
 * A completed run prints one JSON summary as its last stdout line; with
 * --json=PATH it also writes that object (RMS windows + verdict) to a file,
 * which is how qa-run-all.mjs reads the result.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CommandAudioInjector } from "@neuracall/orchestrator";
import { ScrcpyBridge } from "@neuracall/scrcpy-bridge";

const HEAD = `Injection loopback — phone QA harness.
  node scripts/inject-loopback-test.mjs [--device=SERIAL] [--duration=N] [--json=PATH]
default device = first online adb device, default duration = 4s
exit: 0 PASS (tone raised mic RMS) / 1 INCONCLUSIVE (no clear coupling) / 2 HARD ERROR`;

// --- CLI ------------------------------------------------------------------

const flags = {};
const positionals = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "--help" || arg === "-h") {
    console.log(HEAD);
    process.exit(0);
  } else if (arg.startsWith("--device=")) {
    flags.device = arg.slice("--device=".length);
  } else if (arg.startsWith("--duration=")) {
    flags.duration = arg.slice("--duration=".length);
  } else if (arg.startsWith("--json=")) {
    flags.json = arg.slice("--json=".length);
  } else {
    positionals.push(arg);
  }
}

const [p0, p1] = positionals;
const TONE_SECONDS = Number(
  flags.duration ?? (/^\d+$/.test(p0) ? p0 : /^\d+$/.test(p1) ? p1 : 4),
);
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

// --- tone + measurement ------------------------------------------------------

const SR = 16000;
const AMP = 0.8;

function makeTone(seconds, freq = 440) {
  const n = Math.floor(SR * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / SR) * AMP;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

function rms(buf) {
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / (n || 1));
}

const frames = [];
let fmt = null;
const sink = {
  format(f) {
    fmt = f;
    console.log(`[format] ${f.sampleRate}Hz ${f.channels}ch ${f.bitsPerSample}bit`);
  },
  push(buf) {
    frames.push({ t: performance.now(), buf: Buffer.from(buf) });
  },
  end() {},
};

const startedAt = new Date().toISOString();
console.log(`== injection loopback on ${DEVICE} (${TONE_SECONDS}s tone) ==`);

try {
  const bridge = new ScrcpyBridge({ endpoint: DEVICE, audioSource: "mic", sink });
  bridge.on("log", (m) => {
    if (/INFO|WARN|ERROR/i.test(m)) console.log("[scrcpy]", m);
  });
  bridge.on("error", (m) => console.log("[error]", m));

  let injector;
  try {
    injector = new CommandAudioInjector({
      sampleRate: SR,
      channels: 1,
      onError: (m) => console.log("[injector]", m),
    });
  } catch (err) {
    console.error(`HARD ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  bridge.start();
  await new Promise((r) => setTimeout(r, 2000)); // baseline silence
  console.log("[test] baseline captured; starting injection…");
  injector.write(makeTone(TONE_SECONDS));
  const started = performance.now();
  const sentBytes = injector.bytesWritten;
  // stars printed as the tone should finish
  for (let i = 1; i <= TONE_SECONDS; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`[tone] ${i}s`);
  }
  await new Promise((r) => setTimeout(r, 1000)); // post-injection tail
  bridge.stop();
  injector.end();
  await new Promise((r) => setTimeout(r, 500));

  const tStart = frames.length ? frames[0].t : started;
  console.log("\n=== RMS by window ===");
  const win = (from, to) => {
    const fs = frames.filter((f) => f.t - tStart >= from * 1000 && f.t - tStart < to * 1000);
    if (fs.length === 0) return { n: 0, rms: 0 };
    const vals = fs.map((f) => rms(f.buf));
    return { n: fs.length, rms: vals.reduce((a, b) => a + b, 0) / vals.length };
  };
  const base = win(0, 1.5);
  const tone = win(1.5, 1.5 + TONE_SECONDS);
  const post = win(1.5 + TONE_SECONDS, 1.5 + TONE_SECONDS + 1);
  console.log(`baseline:    n=${base.n}  rms=${base.rms.toFixed(1)}`);
  console.log(`injection:   n=${tone.n}  rms=${tone.rms.toFixed(1)}`);
  console.log(`post-inj:    n=${post.n}  rms=${post.rms.toFixed(1)}`);
  console.log(`tone bytes fed to ${injector.player}: ${sentBytes}`);

  const ratio = base.rms > 1 ? tone.rms / base.rms : tone.rms;

  let verdict;
  let message;
  console.log(`\n=== RESULT ===`);
  if (base.rms < 5 && tone.rms < 5) {
    verdict = "inconclusive";
    message = "NO SIGNAL — mic streamed but energy stayed at floor in all windows.";
    console.log(message);
    console.log("Phone may be too far from the host speaker, or the OEM gains down the mic.");
  } else if (tone.rms > base.rms * 2) {
    verdict = "pass";
    message = `INJECTION REACHES MIC — mic RMS rose ${ratio.toFixed(1)}x during the tone.`;
    console.log(message);
  } else {
    verdict = "inconclusive";
    message = `INCONCLUSIVE — mic energy present but the tone did not clearly raise it (${ratio.toFixed(1)}x).`;
    console.log(message);
  }

  const summary = {
    tool: "inject-loopback-test",
    verdict,
    exitCode: verdict === "pass" ? 0 : 1,
    device: DEVICE,
    durationSec: TONE_SECONDS,
    startedAt,
    audio: {
      sampleRate: SR,
      channels: 1,
      toneFreqHz: 440,
      toneBytes: sentBytes,
      player: injector.player,
      totalFrames: frames.length,
      baselineRms: base.rms,
      baselineFrames: base.n,
      injectionRms: tone.rms,
      injectionFrames: tone.n,
      postRms: post.rms,
      postFrames: post.n,
      ratio,
    },
    message,
  };
  if (flags.json) writeFileSync(flags.json, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(summary.exitCode);
} catch (err) {
  console.error(`HARD ERROR: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
}