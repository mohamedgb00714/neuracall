/**
 * Ending an in-progress call inside a messaging app.
 *
 * `KEYCODE_ENDCALL` is the *cellular* hang-up gesture: it is handled by
 * telephony, and the same VoIP apps that ignore `KEYCODE_CALL` on a ringing
 * screen (see `voipAnswerer.ts`) ignore the end-call keyevent once the call is
 * up. WhatsApp's accept control is a button, and so is its hang-up control —
 * ending a WhatsApp call that way has to be a tap too.
 *
 * This mirrors the answerer's discipline:
 *
 *  - The button is located by *accessibility description / text / resource-id*,
 *    never by fixed coordinates, and the tap point is the centre of the node
 *    that was found.
 *  - Labels the handler could confuse the hang-up with (an "accept" reading on
 *    the same node) veto the node outright. On an in-progress call the hang-up
 *    is the destructive control on screen, so a wrong tap is a dropped call.
 *  - An unmatched UI fails loudly with the labels it did see. A silent no-op is
 *    the bug this file exists to fix.
 *
 * The call is already off the hook by the time this runs, so unlike the
 * answerer there is no wake/unlock step — the screen is on because the call is.
 * There is no OCR fallback either: the ringing overlay that blinded the dump
 * was not the focused window, but an in-progress call *is* the focused app
 * (live-verified on the Realme RMX3624), so the dump sees the hang-up control.
 */

import type { CommandRunner } from "./adb.js";
import { dumpUi as dumpUiSerialised } from "./uiDump.js";
import type { ChannelKind } from "./types.js";
import { clickableLabels, nodeCentre, parseClickableNodes, type UiNode } from "./voipDialer.js";
import { isAnswerLabel } from "./voipAnswerer.js";

/**
 * Hang-up labels and resource-ids, in the vocabularies the dialler and the
 * answerer already carry so the three stay in step on the same handsets.
 *
 * The resource-id patterns are deliberately unanchored — `_` is a word
 * character both sides, so `\b` would never reach inside "end_call_btn".
 * Long phrases ("put an end to the call") are not matched: a match here is a
 * tap, and a tap on the destructive control must come from a reading that
 * cannot be interpreted any other way.
 */
const END_CALL_HINTS: readonly RegExp[] = [
  /\bhang\s*up\b/i,
  /\bend(?:\s*the?)?\s*call\b/i,
  /\braccrocher\b/i,
  /\bauflegen\b/i,
  /\bcolgar\b/i,
  /\bdesligar\b/i,
  /\briaggancia(re)?\b/i,
  /\btermina?\s*chiamata\b/i,
  /\bfinalizar\s*llamada\b/i,
  /\bterminar\s*llamada\b/i,
  /\benc[ée]rrar\s*chamada\b/i,
  // Arabic: end / hang up. \b is meaningless against Arabic script, so these
  // are bare substrings, as in voipDialer.
  /إنهاء/,
  /إنهاء\s*المكالمة/,
  /أنهي\s*المكالمة/,
  /hang_?up/i,
  /end_?call/i,
  /endcall/i,
  /call_?end/i,
  /hangup/i,
];

/** True when a label denotes the hang-up / end-call control. */
export function isEndCallLabel(label: string): boolean {
  return END_CALL_HINTS.some((re) => re.test(label));
}

/** The description, text and id of a node — every string it can be judged by. */
function nodeLabels(node: UiNode): string[] {
  return [node.contentDesc, node.text, node.resourceId];
}

/**
 * True when a node is the hang-up control.
 *
 * The accept veto is applied to the *whole node*, not per-label: on a ringing
 * overlay the accept button would sit beside a hang-up-only reading that never
 * fires, but an (accept + end-call) pair of readings on one node means the
 * reading is ambiguous, and a destructive tap must come from the clearer one.
 */
export function isEndCallNode(node: UiNode): boolean {
  if (nodeLabels(node).some(isAnswerLabel)) return false;
  return nodeLabels(node).some(isEndCallLabel);
}

/** The hang-up control in a dump, or null when none is on screen. */
export function findEndCallButton(dump: string): UiNode | null {
  const nodes = parseClickableNodes(dump);
  return nodes.find(isEndCallNode) ?? null;
}

/**
 * Whether this channel is ended by tapping an in-app button.
 *
 * False for "cellular" only: there the call belongs to telephony and
 * `KEYCODE_ENDCALL` is exactly right. Every other channel is a VoIP app that
 * ignores that keyevent, including the generic "voip" fallback.
 */
export function supportsVoipHangup(channel: ChannelKind): boolean {
  return channel !== "cellular";
}

export interface VoipHangupOptions {
  /** How long to wait for the hang-up control to appear, in ms. Default 8000. */
  buttonTimeoutMs?: number;
  /** Poll interval while waiting for the button. Default 400 ms. */
  pollIntervalMs?: number;
  /** Injectable sleep, so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress reporting. */
  onStep?: (step: string) => void;
}

export interface VoipHangupResult {
  channel: ChannelKind;
  /** Where the tap landed. */
  tappedAt: { x: number; y: number };
  /** The button label that was matched, for the audit trail. */
  buttonLabel: string;
}

/**
 * Ends in-progress VoIP calls by driving the call screen.
 *
 * Kept separate from `AndroidCallController` for the same reason `VoipAnswerer`
 * is: the cellular path is one keyevent, this is a scripted interaction with
 * more ways to go wrong, and the split makes it obvious at the call site which
 * one is in play.
 */
export class VoipHangup {
  private readonly opts: VoipHangupOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly runner: CommandRunner,
    opts: VoipHangupOptions = {},
  ) {
    this.opts = opts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Find the hang-up control on the call screen and tap its centre. */
  async hangUp(endpoint: string, channel: ChannelKind): Promise<VoipHangupResult> {
    if (!supportsVoipHangup(channel)) {
      throw new Error(
        `"${channel}" is ended by telephony, not by a tap. ` +
          `Use the call controller's KEYCODE_ENDCALL path for it.`,
      );
    }

    const button = await this.waitForButton(endpoint);
    const at = nodeCentre(button);
    const label = button.contentDesc || button.text || button.resourceId || "(unknown)";
    this.opts.onStep?.(`hanging up "${label}" at ${at.x},${at.y}`);
    await this.runner.runForDevice(endpoint, ["shell", "input", "tap", String(at.x), String(at.y)]);
    return { channel, tappedAt: at, buttonLabel: label };
  }

  /**
   * Poll the call screen until the hang-up control is there.
   *
   * As in the answerer, the first dump happens before any sleep: the call is
   * already up and the button is usually on screen at this instant.
   */
  private async waitForButton(endpoint: string): Promise<UiNode> {
    const timeout = this.opts.buttonTimeoutMs ?? 8000;
    const interval = this.opts.pollIntervalMs ?? 400;
    const attempts = Math.max(1, Math.ceil(timeout / interval));
    let lastLabels: string[] = [];

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.sleep(interval);
      const dump = await this.dumpUi(endpoint);
      const button = findEndCallButton(dump);
      if (button) return button;
      // A failed dump reads as "", which is not evidence the screen was empty;
      // keep the last thing actually seen so the error stays informative.
      const labels = clickableLabels(dump);
      if (labels.length > 0) lastLabels = labels;
    }

    throw new Error(
      `No hang-up control appeared within ${timeout}ms. ` +
        `Buttons seen: ${lastLabels.slice(0, 12).join(", ") || "(none)"}. ` +
        `The call may already have ended, or this locale's label is not recognised.`,
    );
  }

  private async dumpUi(endpoint: string): Promise<string> {
    // Through the serialiser: the detector polls this same tool every couple of
    // seconds, and two concurrent dumps kill each other with a bare SIGKILL.
    return dumpUiSerialised(this.runner, endpoint, { path: "/sdcard/neuracall_hangup.xml" });
  }
}