/**
 * Answering an incoming call inside a messaging app.
 *
 * `KEYCODE_CALL` is the *cellular* answer gesture: it is handled by telephony,
 * and WhatsApp, Telegram, Signal, Messenger and every other VoIP app ignore it
 * outright. Their answer control is a button in the app's own UI. Sending the
 * keyevent to a ringing WhatsApp call therefore does nothing at all — and
 * because a keyevent that nobody listens to still exits 0, it fails *silently*,
 * which is how a real inbound call was detected and never answered. Answering
 * has to be channel-aware, and for a VoIP channel it has to be a tap.
 *
 * This mirrors `voipDialer.ts` — same UI-automation approach, same fragility,
 * kept honest the same way:
 *
 *  - The button is located by *accessibility description / text / resource-id*,
 *    never by fixed coordinates. The tap point is the centre of the node that
 *    was actually found, so it survives a different screen size or layout.
 *  - Decline patterns are matched FIRST and excluded, exactly as the dialler
 *    excludes video before matching voice. On a ringing screen Accept and
 *    Decline sit side by side, so a loose match does not merely fail — it hangs
 *    up on a real customer. See DECLINE_HINTS for why the pairs are so easy to
 *    confuse.
 *  - An unmatched locale fails loudly with the labels it did see. A silent
 *    no-op is the bug this file exists to fix, so "found nothing, did nothing,
 *    reported success" must be unreachable.
 */

import type { CommandRunner } from "./adb.js";
import type { ChannelKind } from "./types.js";
import { ScreenController, type ScreenState } from "./screen.js";
import { clickableLabels, nodeCentre, parseClickableNodes, type UiNode } from "./voipDialer.js";

/**
 * Decline labels. Checked FIRST and excluded, because on a ringing screen the
 * accept and decline controls are adjacent and their labels are near-twins:
 *
 *   German     "Abnehmen" (accept)  /  "Ablehnen" (decline)  — 8 letters, 2 apart
 *   Portuguese "Aceitar"  (accept)  /  "Rejeitar" (decline)  — share "eitar"
 *   Spanish    "Aceptar"  (accept)  /  "Rechazar" (decline)
 *   French     "Répondre" (accept)  /  "Refuser"  (decline)  — share "Re"
 *   Italian    "Rispondi" (accept)  /  "Rifiuta"  (decline)  — share "Ri"
 *
 * Any prefix, suffix or substring match keyed on the shared part matches both
 * buttons, and the localised noun ("call" / "appel" / "llamada" / "المكالمة")
 * appears in both labels too. Whole-word patterns plus a decline-first veto are
 * what stop a mis-tap, and a mis-tap here rejects a real caller.
 */
const DECLINE_HINTS: readonly RegExp[] = [
  /\bdecline\b/i,
  /\breject\b/i,
  /\bdismiss\b/i,
  /\bignore\b/i,
  /\bhang\s*up\b/i,
  /\bend\s*call\b/i,
  /\brefuser\b/i,
  /\brejeter\b/i,
  /\braccrocher\b/i,
  /\bignorer\b/i,
  /\bablehnen\b/i,
  /\babweisen\b/i,
  /\bauflegen\b/i,
  /\brechazar\b/i,
  /\bcolgar\b/i,
  /\bignorar\b/i,
  /\brifiuta(re)?\b/i,
  /\briagganciare?\b/i,
  /\brecusar\b/i,
  /\brejeitar\b/i,
  /\bdesligar\b/i,
  // Arabic: reject / end / ignore. \b is meaningless against Arabic script, so
  // these are bare substrings, as in voipDialer.
  /رفض/,
  /إنهاء/,
  /تجاهل/,
  // Resource ids are not localised. "_" counts as a word character, so \b would
  // not fire inside "decline_call" — these are deliberately unanchored.
  /decline_?call/i,
  /reject_?call/i,
  /decline_?b(utto)?n/i,
  /reject_?b(utto)?n/i,
  /btn_decline/i,
  /call_decline/i,
  /hang_?up/i,
  /end_?call/i,
];

/**
 * Accept labels, once decline has been ruled out. Covers the languages the
 * dialler covers; the development handset's UI is FRENCH, which is why
 * "Accepter" / "Répondre" / "Décrocher" are all here.
 */
const ANSWER_HINTS: readonly RegExp[] = [
  /\banswer\b/i,
  /\baccept\b/i,
  /\bpick\s*up\b/i,
  /\baccepter\b/i,
  /\br[ée]pondre\b/i,
  /\bd[ée]crocher\b/i,
  /\bannehmen\b/i,
  /\babnehmen\b/i,
  /\bantworten\b/i,
  /\bacepta(r)?\b/i,
  /\bresponder\b/i,
  /\bcontestar\b/i,
  /\bdescolgar\b/i,
  /\baccetta(re)?\b/i,
  /\brispondi(re)?\b/i,
  /\batender\b/i,
  /\baceitar\b/i,
  /قبول/,
  /الرد/,
  /إجابة/,
  // Resource-id hints. WhatsApp's ringing screen is known to expose
  // accept_call / decline_call, and the generic in-call layouts use
  // answer_button. Hints only — the label patterns above are the real route,
  // because ids change between app versions without warning.
  /accept_?call/i,
  /answer_?call/i,
  /accept_?b(utto)?n/i,
  /answer_?b(utto)?n/i,
  /btn_accept/i,
  /call_accept/i,
  /voip_?accept/i,
];

/** True when a label denotes the decline / reject control. */
export function isDeclineLabel(label: string): boolean {
  return DECLINE_HINTS.some((re) => re.test(label));
}

/** True when a label denotes the accept control and is definitely not decline. */
export function isAnswerLabel(label: string): boolean {
  if (label.trim() === "") return false;
  if (isDeclineLabel(label)) return false;
  return ANSWER_HINTS.some((re) => re.test(label));
}

/** The description, text and id of a node — every string it can be judged by. */
function nodeLabels(node: UiNode): string[] {
  return [node.contentDesc, node.text, node.resourceId];
}

/** True when any of a node's labels marks it as the decline control. */
export function isDeclineNode(node: UiNode): boolean {
  return nodeLabels(node).some(isDeclineLabel);
}

/**
 * True when a node is the accept control.
 *
 * The decline veto is applied to the *whole node*, not per-label, and that is a
 * deliberate strengthening of the dialler's `.some()` test. A node whose
 * content-desc is "Refuser" but whose id happens to contain an accept-ish word
 * would pass a per-label check on the id alone and get tapped. One label saying
 * "decline" disqualifies the node outright: when the two readings disagree,
 * refusing to tap costs a missed answer, and tapping costs a hung-up customer.
 */
export function isAnswerNode(node: UiNode): boolean {
  if (isDeclineNode(node)) return false;
  return nodeLabels(node).some(isAnswerLabel);
}

/**
 * The accept control in a dump, or null when none is on screen.
 *
 * Selection is by predicate rather than by position, so it does not matter
 * whether decline is listed before accept in the XML — which it often is, since
 * the decline button is usually the left-hand one.
 */
export function findAnswerButton(dump: string): UiNode | null {
  return parseClickableNodes(dump).find(isAnswerNode) ?? null;
}

/**
 * Whether this channel is answered by tapping an in-app button.
 *
 * False for "cellular" only: there the call belongs to telephony and
 * `KEYCODE_CALL` is exactly right. Every other channel is a VoIP app that
 * ignores that keyevent, including the generic "voip" fallback — an
 * unrecognised calling app still draws an accept button, so attempting the tap
 * is strictly better than sending a keyevent known to do nothing.
 */
export function supportsVoipAnswer(channel: ChannelKind): boolean {
  return channel !== "cellular";
}

export interface VoipAnswererOptions {
  /** How long to wait for the accept control to appear, in ms. Default 15000. */
  buttonTimeoutMs?: number;
  /** Poll interval while waiting for the button. Default 500 ms. */
  pollIntervalMs?: number;
  /** Injectable sleep, so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress reporting. */
  onStep?: (step: string) => void;
  /**
   * Skip the wake/unlock step. Only for a caller that has already done it — a
   * tap on a sleeping or keyguarded phone is swallowed and the call rings on
   * unanswered, with no error.
   */
  skipWake?: boolean;
}

export interface VoipAnswerResult {
  channel: ChannelKind;
  /** Screen state after waking, when the answerer did the waking. */
  screen?: ScreenState;
  /** Where the tap landed. */
  tappedAt: { x: number; y: number };
  /** The button label that was matched, for the audit trail. */
  buttonLabel: string;
}

/**
 * Answers incoming VoIP calls by driving the ringing screen.
 *
 * Kept separate from `AndroidCallController` for the same reason `VoipDialer`
 * is: the cellular path is one keyevent, this is a scripted interaction with
 * more ways to go wrong, and the split makes it obvious at the call site which
 * one is in play.
 */
export class VoipAnswerer {
  private readonly opts: VoipAnswererOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly runner: CommandRunner,
    opts: VoipAnswererOptions = {},
  ) {
    this.opts = opts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Find the accept control on the ringing screen and tap its centre. */
  async answer(endpoint: string, channel: ChannelKind): Promise<VoipAnswerResult> {
    if (!supportsVoipAnswer(channel)) {
      throw new Error(
        `"${channel}" is answered by telephony, not by a tap. ` +
          `Use the call controller's KEYCODE_CALL path for it.`,
      );
    }

    // An incoming call usually shows over the lock screen, but the display may
    // still be off, and a keyguard swallows every tap without complaint.
    let screen: ScreenState | undefined;
    if (!this.opts.skipWake) {
      screen = await new ScreenController(this.runner, endpoint).ensureAwake();
      this.opts.onStep?.(`screen: awake=${screen.awake} locked=${screen.locked}`);
      if (screen.locked) {
        throw new Error(
          screen.secure
            ? "The phone is locked with a PIN, pattern or password, which adb cannot clear. " +
                "Remove the screen lock on handsets NeuraCall drives (see docs/RUNBOOK.md)."
            : "The phone is still showing a keyguard after dismiss-keyguard; taps would not reach the call screen.",
        );
      }
    }

    const button = await this.waitForButton(endpoint);
    const at = nodeCentre(button);
    const label = button.contentDesc || button.text || button.resourceId;
    this.opts.onStep?.(`answering "${label}" at ${at.x},${at.y}`);
    await this.runner.runForDevice(endpoint, ["shell", "input", "tap", String(at.x), String(at.y)]);
    return { channel, tappedAt: at, buttonLabel: label, ...(screen ? { screen } : {}) };
  }

  /**
   * Poll the ringing screen until the accept control is there.
   *
   * Unlike the dialler this dumps *before* the first sleep: the call is already
   * ringing and the button is usually on screen this instant, so an opening
   * sleep would be latency spent on a caller who is waiting.
   */
  private async waitForButton(endpoint: string): Promise<UiNode> {
    const timeout = this.opts.buttonTimeoutMs ?? 15_000;
    const interval = this.opts.pollIntervalMs ?? 500;
    const attempts = Math.max(1, Math.ceil(timeout / interval));
    let lastLabels: string[] = [];

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.sleep(interval);
      const dump = await this.dumpUi(endpoint);
      const button = findAnswerButton(dump);
      if (button) return button;
      // A failed dump reads as "", which is not evidence the screen was empty;
      // keep the last thing actually seen so the error stays informative.
      const labels = clickableLabels(dump);
      if (labels.length > 0) lastLabels = labels;
    }

    throw new Error(
      `No accept control appeared within ${timeout}ms. ` +
        `Buttons seen: ${lastLabels.slice(0, 12).join(", ") || "(none)"}. ` +
        `The call may have stopped ringing, or this locale's label is not recognised.`,
    );
  }

  private async dumpUi(endpoint: string): Promise<string> {
    try {
      // A distinct path from the dialler's, so a dial and an answer racing on
      // one handset cannot read each other's half-written dump.
      await this.runner.runForDevice(endpoint, [
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/neuracall_answer.xml",
      ]);
      return await this.runner.runForDevice(endpoint, [
        "shell",
        "cat",
        "/sdcard/neuracall_answer.xml",
      ]);
    } catch {
      return "";
    }
  }
}
