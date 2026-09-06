/**
 * The OCR stage exists because a ringing overlay can float over the focused
 * window — on the realme RMX3624 the uiautomator dump keeps returning the
 * launcher's XML, byte-identical, while the ring is live. These tests pin the
 * pure parts: parsing tesseract's TSV layout (the real thing, including its
 * ragged trailing text column), classifying a frame from its words (reusing
 * the answerer's multi-language readings, decline veto included), and lifting
 * a word's bounding box into the node shape the tap logic presses.
 *
 * Tesseract is never spawned here — every fixture is text a live frame is
 * known to OCR to ("Appel vocal entrant", RÉPONDRE / REFUSER).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { OcrWord } from "../src/ocrStageDetector.js";
import {
  classifyCallWords,
  ocrToUiNode,
  parseTesseractTsv,
} from "../src/ocrStageDetector.js";

/** Build an OcrWord without repeating the four other fields everywhere. */
function word(text: string, conf: number, left = 0, top = 0): OcrWord {
  return { text, left, top, width: 100, height: 50, conf };
}

/** A raw tesseract row, as `level\tpage\t...\tconf\ttext`. */
function row(cols: (string | number)[]): string {
  return cols.join("\t");
}

/** A realistic `tsv` dump of the French ringing overlay. */
function frenchOverlayTsv(): string {
  return [
    row([
      "level",
      "page_num",
      "block_num",
      "par_num",
      "line_num",
      "word_num",
      "left",
      "top",
      "width",
      "height",
      "conf",
      "text",
    ]),
    // A block row (level 1) and a line row (level 4): neither is a word.
    row([1, 1, 0, 0, 0, 0, 0, 0, 720, 60, -1, ""]),
    row([4, 1, 1, 0, 0, 0, 0, 0, 720, 60, -1, ""]),
    row([5, 1, 1, 1, 2, 1, 0, 0, 258, 60, 85, "Appel"]),
    row([5, 1, 1, 1, 2, 2, 266, 0, 200, 60, 82, "vocal"]),
    row([5, 1, 1, 1, 3, 1, 470, 0, 250, 60, 78, "entrant"]),
    // A negative-confidence word tesseract decided was not real text.
    row([5, 1, 1, 2, 4, 1, 120, 120, 300, 60, -12, "confused"]),
    // An empty-text word: the trailing tab that ends a real dump. The 12th
    // column is present but empty, exactly as tesseract writes it.
    row([5, 1, 1, 2, 5, 1, 500, 120, 200, 60, 95, ""]),
    row([5, 1, 1, 3, 7, 1, 244, 1940, 258, 180, 91, "RÉPONDRE"]),
    row([5, 1, 1, 3, 8, 1, 0, 1940, 180, 180, 93, "REFUSER"]),
    // A word whose text spans spaces — tesseract merges run-on buttons.
    row([5, 1, 1, 4, 9, 1, 700, 120, 280, 60, 88, "Appel vocal"]),
  ].join("\n");
}

test("parseTesseractTsv reads word rows and skips everything else", () => {
  const words = parseTesseractTsv(frenchOverlayTsv());

  assert.deepEqual(words, [
    { text: "Appel", left: 0, top: 0, width: 258, height: 60, conf: 85 },
    { text: "vocal", left: 266, top: 0, width: 200, height: 60, conf: 82 },
    { text: "entrant", left: 470, top: 0, width: 250, height: 60, conf: 78 },
    { text: "RÉPONDRE", left: 244, top: 1940, width: 258, height: 180, conf: 91 },
    { text: "REFUSER", left: 0, top: 1940, width: 180, height: 180, conf: 93 },
    { text: "Appel vocal", left: 700, top: 120, width: 280, height: 60, conf: 88 },
  ]);
  assert.ok(
    !words.some((w) => w.text === "confused"),
    "a negative-confidence word must be dropped",
  );
});

test("a French ringing overlay classifies as ringing with RÉPONDRE as accept", () => {
  const repondre = word("RÉPONDRE", 91);
  const refuser = word("REFUSER", 93);
  const result = classifyCallWords([
    word("Appel", 85),
    word("vocal", 82),
    word("entrant", 78),
    repondre,
    refuser,
  ]);

  assert.equal(result.stage, "ringing");
  assert.equal(result.accept, repondre, "the accept word is the RÉPONDRE word itself");
  assert.notEqual(result.accept, refuser);
  assert.deepEqual(
    result.labels,
    ["Appel", "vocal", "entrant", "RÉPONDRE", "REFUSER"],
    "labels are the confident words in reading order, deduped",
  );
});

test("the decline veto holds: REFUSER listed first never becomes accept", () => {
  // On the real overlay decline sits left of accept, so it comes first in
  // reading order. The veto must hold even so, or a left-first frame taps it.
  const result = classifyCallWords([
    word("REFUSER", 93),
    word("RÉPONDRE", 91),
    word("Refuser", 95),
  ]);
  assert.equal(result.accept?.text, "RÉPONDRE");
  assert.equal(result.stage, "ringing");
});

test("a lone confident 'Refuser' is not accept and the frame is unknown", () => {
  const result = classifyCallWords([word("Refuser", 95)]);
  assert.equal(result.accept, null);
  assert.equal(result.stage, "unknown");
});

test("an accept word below minConf is not accepted", () => {
  const result = classifyCallWords([word("Appel", 90), word("RÉPONDRE", 12)]);
  assert.equal(result.accept, null);
  assert.equal(result.stage, "unknown");
});

test("minConf can be raised per call", () => {
  const result = classifyCallWords([word("RÉPONDRE", 50)], { minConf: 80 });
  assert.equal(result.accept, null);
  assert.equal(result.stage, "unknown");
});

test("an in-progress frame shows a duration and no accept word", () => {
  const result = classifyCallWords([
    word("Appel", 88),
    word("en", 80),
    word("cours", 85),
    word("0:12", 70),
  ]);
  assert.equal(result.accept, null);
  assert.equal(result.stage, "in-progress");
});

test("in-call markers: duration, '»' and 'now' words all read as in-progress", () => {
  for (const marker of ["12:34", "0:05", "maintenant", "»"]) {
    const result = classifyCallWords([word("Appel", 90), word(marker, 75)]);
    assert.equal(result.accept, null, marker);
    assert.equal(result.stage, "in-progress", `marker ${JSON.stringify(marker)} was missed`);
  }
});

test("empty words classify as unknown with nothing to tap or report", () => {
  const result = classifyCallWords([]);
  assert.equal(result.accept, null);
  assert.equal(result.stage, "unknown");
  assert.deepEqual(result.labels, []);
});

test("ocrToUiNode maps the word's box to node bounds and passes text through", () => {
  const node = ocrToUiNode({
    text: "RÉPONDRE",
    left: 244,
    top: 1940,
    width: 258,
    height: 180,
    conf: 91,
  });
  assert.deepEqual(node.bounds, { left: 244, top: 1940, right: 502, bottom: 2120 });
  assert.equal(node.text, "RÉPONDRE");
  assert.equal(node.contentDesc, "RÉPONDRE");
  assert.equal(node.resourceId, "");
});