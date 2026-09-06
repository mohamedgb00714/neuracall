/**
 * OCR fallback for finding the accept button when the ringing overlay is not
 * the focused window.
 *
 * `uiautomator dump` serialises the view hierarchy of the *focused* window. On
 * OEM builds like the realme RMX3624 a ringing overlay can float over the
 * launcher without ever becoming focused, and then every dump returns the
 * launcher's XML — byte-identical on each poll — with no accept control
 * anywhere in it. The overlay IS in every `screencap`, though, and tesseract
 * reads it back: live frames OCR to "Appel vocal entrant" with RÉPONDRE /
 * REFUSER, the two rows `voipAnswerer.ts`' locale patterns already know.
 *
 * So this file turns one OCR frame into the same thing the uiautomator path
 * produces: a `UiNode` the tap logic already knows how to press. tesseract's
 * TSV layout gives every word an axis-aligned bounding box, and that box is
 * the tap target — no fixed coordinates, exactly like the dialler and the
 * answerer.
 *
 * What this file is NOT is a call detector. The pid/audio signals stay the
 * presence source of truth; this only labels a frame (ringing / in-progress /
 * unknown) to steer the answer. Reaching for OCR means "a call is already
 * known to be ringing and the dump came back blind", never "the dump told me
 * a call exists".
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import type { CommandRunner } from "./adb.js";
import type { UiNode } from "./voipDialer.js";
import { isAnswerLabel } from "./voipAnswerer.js";

const execFileAsync = promisify(execFile);

/** A word read by tesseract with the bounding box and confidence tsv gives. */
export interface OcrWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
}

/** What a frame looks like it is, from the words on it. */
export type OcrStage = "ringing" | "in-progress" | "unknown";

export interface OcrClassification {
  stage: OcrStage;
  /** The accept control's word, or null when none cleared the thresholds. */
  accept: OcrWord | null;
  /**
   * The distinctive words seen, deduped in reading order, trimmed to 12 —
   * enough for the answerer's "what did you actually see" audit trail.
   */
  labels: string[];
}

/**
 * Parse tesseract's `tsv` layout into words.
 *
 * Rows are `level page_num block_num par_num line_num word_num left top width
 * height conf text`; only word-level rows (`level == 5`) become words. The
 * text column is the ragged last one — tesseract ends an empty word with a
 * trailing tab, so a missing `text` element is the same as an empty string and
 * is filtered out with it. Rows are returned in document (reading) order.
 */
export function parseTesseractTsv(tsv: string): OcrWord[] {
  const words: OcrWord[] = [];
  for (const rawLine of tsv.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const cols = line.split("\t");
    if (cols[0] === "level") continue; // the header row
    if (cols.length < 11) continue;
    const level = Number(cols[0]);
    if (!Number.isFinite(level) || level !== 5) continue;
    const conf = Number(cols[10]);
    if (!Number.isFinite(conf) || conf < 0) continue;
    const text = (cols[11] ?? "").trim();
    if (text === "") continue;
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      continue;
    }
    words.push({ text, left, top, width, height, conf });
  }
  return words;
}

/**
 * An in-call elapsed marker: a running duration, the "»" indicator several
 * apps draw, or a "now" word in the covered languages. These sit on an active
 * call's screen and never on a ringing one, so seeing one means the frame is
 * not waiting to be answered.
 */
const ELAPSED_DURATION = /(?:^|\s)\d{1,3}:\d{2}(?=\s|$)/;
const NOW_WORDS = /\b(?:now|maintenant|anon|jetzt|ahora|adesso|agora)\b/i;

function isInCallMarker(word: OcrWord): boolean {
  return ELAPSED_DURATION.test(word.text) || word.text.includes("»") || NOW_WORDS.test(word.text);
}

/**
 * Classify a frame from its OCR words, reusing the answerer's label readings.
 *
 * The first word that is accept (conf >= minConf and `isAnswerLabel`) wins in
 * document order — reading order is top-to-bottom, so the button that would
 * get tapped is the one judged. A frame with an accept word is ringing; else
 * an in-call elapsed marker makes it in-progress; else unknown. The decline
 * veto rides inside `isAnswerLabel`, so REFUSER never becomes accept.
 */
export function classifyCallWords(
  words: readonly OcrWord[],
  opts: { minConf?: number } = {},
): OcrClassification {
  const minConf = opts.minConf ?? 40;

  const accept = words.find((w) => w.conf >= minConf && isAnswerLabel(w.text)) ?? null;

  let stage: OcrStage;
  if (accept !== null) {
    stage = "ringing";
  } else if (words.some(isInCallMarker)) {
    stage = "in-progress";
  } else {
    stage = "unknown";
  }

  const labels: string[] = [];
  for (const w of words) {
    if (labels.length >= 12) break;
    if (w.conf < minConf) continue;
    const text = w.text.trim();
    if (text === "") continue;
    if (!labels.includes(text)) labels.push(text);
  }

  return { stage, accept, labels };
}

/** Lift an OCR word into the node shape the tap logic already presses. */
export function ocrToUiNode(word: OcrWord): UiNode {
  return {
    resourceId: "",
    contentDesc: word.text,
    text: word.text,
    bounds: {
      left: word.left,
      top: word.top,
      right: word.left + word.width,
      bottom: word.top + word.height,
    },
  };
}

/** Which tessdata dir the OCR call will actually use, honouring TESSDATA_PREFIX. */
function resolvedEnv(tessdataPrefix?: string): NodeJS.ProcessEnv {
  return tessdataPrefix === undefined
    ? process.env
    : { ...process.env, TESSDATA_PREFIX: tessdataPrefix };
}

let cachedLangs: string[] | undefined;

/**
 * The languages matching `wanted` that the current tessdata actually has.
 *
 * The OCR default targets French + English, but only `eng` (or `ara`) ships
 * with a default apt install; the `fra` traineddata lives in
 * `$HOME/.tessdata` (TESSDATA_PREFIX). Asking tesseract for a language it
 * does not have makes it fail, so the default asks for exactly what is
 * installed. The result is cached per process because list-langs is a ~100ms
 * spawn; an explicit `opts.langs` never touches this path.
 */
async function installedLangs(
  env: NodeJS.ProcessEnv,
  wanted: readonly string[],
): Promise<string[]> {
  if (cachedLangs !== undefined) return cachedLangs;
  const available = new Set<string>();
  try {
    const { stdout } = await execFileAsync("tesseract", ["--list-langs"], {
      env,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of (stdout ?? "").split("\n")) available.add(line.trim());
    // Cache only on success; a broken install should be re-probed next time.
    cachedLangs = wanted.filter((l) => available.has(l));
  } catch {
    cachedLangs = [];
  }
  return cachedLangs;
}

/** Run tesseract on a PNG and return the raw `tsv` output. */
export async function runTesseract(
  png: Buffer,
  opts: { langs?: string; tessdataPrefix?: string; timeoutMs?: number } = {},
): Promise<string> {
  const env = resolvedEnv(opts.tessdataPrefix);
  const langs =
    opts.langs ?? ((await installedLangs(env, ["fra", "eng"])).join("+") || "eng");
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("tesseract", ["stdin", "stdout", "-l", langs, "tsv"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (stderr += d));
    child.stdout.on("data", (d: Buffer) => chunks.push(d));

    child.on("error", (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(
          new Error(
            "tesseract is not installed on this host. " +
              "Install the tesseract-ocr package with the eng and fra traineddata " +
              "(e.g. apt install tesseract-ocr, or --tessdata-dir with eng + fra).",
          ),
        );
      } else {
        reject(new Error(`tesseract could not run: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join("\n");
        reject(
          new Error(`tesseract failed (exit ${code ?? "unknown"}): ${tail || `langs=${langs}`}`),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    child.stdin.end(png, "binary");
  });
}

/**
 * Pull a screencap from the device into a local buffer.
 *
 * The device keeps a private staging file (`/sdcard/neuracall_frame.png`) so a
 * concurrent poll CANNOT overwrite a file this reader is still pulling; the
 * local copy is removed on the way out. `tmpPath` exists for callers that want
 * the frame next to other captured artifacts.
 */
export async function captureScreen(
  runner: CommandRunner,
  endpoint: string,
  tmpPath?: string,
): Promise<Buffer> {
  const local =
    tmpPath ??
    join(
      tmpdir(),
      `neuracall-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
  try {
    await runner.runForDevice(endpoint, ["shell", "screencap", "-p", "/sdcard/neuracall_frame.png"]);
    await runner.runForDevice(endpoint, ["pull", "/sdcard/neuracall_frame.png", local]);
    return await readFile(local);
  } finally {
    // Cleanup is best-effort: a leftover staging file on the device or a tmp
    // file on the host must not mask the error that made them stay behind.
    await runner
      .runForDevice(endpoint, ["shell", "rm", "-f", "/sdcard/neuracall_frame.png"])
      .catch(() => undefined);
    await unlink(local).catch(() => undefined);
  }
}

/**
 * OCR a frame and, when it shows a ringing accept button, return it ready to
 * tap. `null` when the frame is not a recognisable ringing screen — the caller
 * decides what that means, this only labels.
 */
export async function ocrAcceptButton(
  png: Buffer,
  opts: { langs?: string; tessdataPrefix?: string; minConf?: number } = {},
): Promise<{ node: UiNode; word: OcrWord } | null> {
  const tsv = await runTesseract(png, opts);
  const words = parseTesseractTsv(tsv);
  const { accept } = classifyCallWords(words, { minConf: opts.minConf });
  if (accept === null) return null;
  return { node: ocrToUiNode(accept), word: accept };
}