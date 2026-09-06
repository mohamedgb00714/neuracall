#!/usr/bin/env node
/**
 * OCR environment check — prerequisites for the answering OCR fallback.
 *
 * The VoipAnswerer's `ocrFallback` (packages/device-manager/src/voipAnswerer.ts)
 * labels the accept control on a ringing WhatsApp screen by OCR when
 * `uiautomator dump` does not expose it (see docs/WHATSAPP.md). That route needs
 * the tesseract binary on PATH and the `eng` and `fra` tessdata languages it can
 * resolve. This script verifies both before the fallback is relied on.
 *
 * Usage:
 *   node scripts/check-ocr-env.mjs [--json]
 *
 * Exit codes:
 *   0  OK        tesseract present and both eng + fra resolvable
 *   1  MISSING   one of tesseract / eng / fra is absent (printed with a fix)
 *
 * ffmpeg and aplay (the audio-injection players) are probed too but are
 * informational only — they never change the exit code.
 *
 * With --json the only stdout line is the machine-readable object:
 *   {"tesseract":true,"eng":true,"fra":true,"tessdataPrefix":"<path|null>",
 *    "ffmpeg":true,"aplay":true}
 * Deterministic and dependency-free: child_process.spawnSync only, no async, no reads.
 */

import { spawnSync } from "node:child_process";

const HEAD = `OCR environment check — prerequisites for the answering OCR fallback.
  node scripts/check-ocr-env.mjs [--json]
exit: 0 OK (tesseract + eng/fra resolvable) / 1 MISSING (list printed)
ffmpeg/aplay are informational and never change the exit code.`;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HEAD);
  process.exit(0);
}
const wantJson = args.includes("--json");

/** Exit status from running the command; "" when it ran, null when it did not. */
function probe(cmd, cmdArgs) {
  try {
    const r = spawnSync(cmd, cmdArgs, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error || typeof r.status !== "number" || r.status !== 0) return null;
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } catch {
    return null;
  }
}

const tesseractOk = probe("tesseract", ["--version"]) !== null;

let eng = false;
let fra = false;
if (tesseractOk) {
  const langs = (probe("tesseract", ["--list-langs"]) ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);
  eng = langs.includes("eng");
  fra = langs.includes("fra");
}

const tessdataPrefix = process.env.TESSDATA_PREFIX || "~/.tessdata";
const ffmpeg = probe("ffmpeg", ["-version"]) !== null;
const aplay = probe("aplay", ["--version"]) !== null;

const ok = tesseractOk && eng && fra;

const summary = {
  tesseract: tesseractOk,
  eng,
  fra,
  tessdataPrefix,
  ffmpeg,
  aplay,
};

if (wantJson) {
  console.log(JSON.stringify(summary));
  process.exit(ok ? 0 : 1);
}

const mark = (b) => (b ? `${GREEN}present${RESET}` : `${RED}missing${RESET}`);
const langDetail = (b, name) => {
  if (b) return `${GREEN}present${RESET}`;
  if (!tesseractOk) return `${RED}n/a${RESET} — tesseract missing, not probed`;
  return `${RED}missing${RESET} — install tesseract-ocr-${name}`;
};

console.log("== OCR fallback environment (voipAnswerer ocrFallback) ==");
console.log(`tesseract binary  ${mark(tesseractOk)}${tesseractOk ? "" : "  (install tesseract-ocr)"}`);
console.log(
  `tessdata           TESSDATA_PREFIX=${process.env.TESSDATA_PREFIX ? tessdataPrefix : `unset (default ${tessdataPrefix})`}`,
);
console.log(`  language eng    ${langDetail(eng, "eng")}`);
console.log(`  language fra    ${langDetail(fra, "fra")}`);
console.log(`ffmpeg (optional) ${mark(ffmpeg)}  — audio-injection player, informational only`);
console.log(`aplay  (optional) ${mark(aplay)}  — audio-injection player, informational only`);
console.log(`status            ${ok ? `${GREEN}ok${RESET}` : `${RED}missing${RESET}`}`);
process.exit(ok ? 0 : 1);