/**
 * Placing an outbound call through a messaging app.
 *
 * Android gives no public intent for "start a WhatsApp voice call". The
 * documented route — an `ActivityRecord` on the contact's
 * `vnd.android.cursor.item/vnd.com.whatsapp.voip.call` data row — only exists
 * once the app has been granted contacts access *and* has run a sync, which is
 * not true on a freshly permitted install. So the reliable path is the one a
 * person uses: open the conversation by deep link, then press the call button.
 *
 * That means UI automation, with the fragility that implies. Two things keep it
 * honest:
 *
 *  - The button is located by *accessibility description*, not by fixed
 *    coordinates, so it survives a different screen size or layout. Coordinates
 *    are read from the node that was actually found.
 *  - Voice and video buttons sit next to each other and their labels differ by
 *    one word ("Appel vocal" / "Appel vidéo"). Video patterns are matched
 *    first and excluded, because starting a video call when a voice call was
 *    asked for is the kind of mistake that is embarrassing rather than merely
 *    broken.
 *
 * Descriptions are localised, so the patterns cover the languages this is
 * likely to meet. An unmatched locale fails loudly with the descriptions it did
 * see, which is far better than tapping something arbitrary.
 */

import type { CommandRunner } from "./adb.js";
import type { ChannelKind } from "./types.js";
import { ScreenController, type ScreenState } from "./screen.js";

/** A clickable node from a uiautomator dump. */
export interface UiNode {
  resourceId: string;
  contentDesc: string;
  text: string;
  bounds: { left: number; top: number; right: number; bottom: number };
}

/** Centre point of a node, which is where a tap goes. */
export function nodeCentre(node: UiNode): { x: number; y: number } {
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}

/**
 * Video-call labels. Checked FIRST and excluded: "Appel vidéo" also contains
 * "Appel", so a naive voice match would happily start a video call.
 */
const VIDEO_CALL_HINTS: readonly RegExp[] = [
  /\bvideo\s*call\b/i,
  /\bappel\s*vid[ée]o\b/i,
  /\bvideoanruf\b/i,
  /\bvideollamada\b/i,
  /\bvideochiamata\b/i,
  /\bchamada\s*de\s*v[íi]deo\b/i,
  /مكالمة\s*فيديو/,
];

/** Voice-call labels, once video has been ruled out. */
const VOICE_CALL_HINTS: readonly RegExp[] = [
  /\bvoice\s*call\b/i,
  /\bappel\s*vocal\b/i,
  /\bsprachanruf\b/i,
  /\bllamada\s*de\s*voz\b/i,
  /\bchiamata\s*vocale\b/i,
  /\bchamada\s*de\s*voz\b/i,
  /مكالمة\s*صوتية/,
  // Resource ids are not localised; a couple of apps expose one.
  /menuitem_voice_call/i,
  /\baudio\s*call\b/i,
];

/** True when a label denotes a video call. */
export function isVideoCallLabel(label: string): boolean {
  return VIDEO_CALL_HINTS.some((re) => re.test(label));
}

/** True when a label denotes a voice call and is definitely not video. */
export function isVoiceCallLabel(label: string): boolean {
  if (label.trim() === "") return false;
  if (isVideoCallLabel(label)) return false;
  return VOICE_CALL_HINTS.some((re) => re.test(label));
}

const NODE_RE = /<node\b[^>]*>/g;

function attr(node: string, name: string): string {
  const m = node.match(new RegExp(`${name}="([^"]*)"`));
  return m?.[1] ?? "";
}

/** Parse the clickable nodes out of a uiautomator XML dump. */
export function parseClickableNodes(dump: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of dump.matchAll(NODE_RE)) {
    const raw = match[0];
    if (!/clickable="true"/.test(raw)) continue;
    const bounds = attr(raw, "bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bounds) continue;
    nodes.push({
      resourceId: attr(raw, "resource-id"),
      contentDesc: attr(raw, "content-desc"),
      text: attr(raw, "text"),
      bounds: {
        left: Number(bounds[1]),
        top: Number(bounds[2]),
        right: Number(bounds[3]),
        bottom: Number(bounds[4]),
      },
    });
  }
  return nodes;
}

/** The voice-call button in a dump, or null when none is on screen. */
export function findVoiceCallButton(dump: string): UiNode | null {
  const nodes = parseClickableNodes(dump);
  return (
    nodes.find((n) =>
      [n.contentDesc, n.text, n.resourceId].some((label) => isVoiceCallLabel(label)),
    ) ?? null
  );
}

/** Every clickable label in a dump, for the error message when nothing matched. */
export function clickableLabels(dump: string): string[] {
  return parseClickableNodes(dump)
    .map((n) => n.contentDesc || n.text || n.resourceId)
    .filter((l) => l !== "");
}

/**
 * Deep links that open a conversation with a number, per channel. The number
 * is digits-only in international form (no "+"), which is what all of these
 * expect.
 */
const CHAT_DEEP_LINKS: Partial<Record<ChannelKind, (digits: string) => string>> = {
  whatsapp: (d) => `https://wa.me/${d}`,
  telegram: (d) => `tg://resolve?phone=${d}`,
  signal: (d) => `https://signal.me/#p/+${d}`,
};

/** Whether an outbound VoIP call can be attempted on this channel. */
export function supportsVoipDial(channel: ChannelKind): boolean {
  return channel in CHAT_DEEP_LINKS;
}

/**
 * Reduce a dialled number to the digits a deep link wants: international form
 * without "+" or separators. A national number is promoted using
 * `defaultCountryCode`, because a deep link with a national number opens a
 * chat with the wrong person or none at all.
 */
export function deepLinkDigits(number: string, defaultCountryCode?: string): string {
  const trimmed = number.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") throw new Error(`Not a dialable number: ${JSON.stringify(number)}`);
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);

  const cc = (defaultCountryCode ?? "").replace(/\D/g, "");
  if (cc === "") return digits;
  // A single leading zero is the national trunk prefix and is never part of
  // the international number.
  const national = digits.length > 1 && digits.startsWith("0") ? digits.slice(1) : digits;
  return national.startsWith(cc) ? national : cc + national;
}

export interface VoipDialerOptions {
  /** Country code for numbers dialled without one. */
  defaultCountryCode?: string;
  /** How long to wait for the call button to appear, in ms. Default 12000. */
  buttonTimeoutMs?: number;
  /** Poll interval while waiting for the button. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Injectable sleep, so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress reporting. */
  onStep?: (step: string) => void;
  /**
   * Skip the wake/unlock step. Only for a caller that has already done it —
   * taps on a sleeping or locked phone go to the lock screen and the call is
   * never placed, with no error.
   */
  skipWake?: boolean;
}

export interface VoipDialResult {
  channel: ChannelKind;
  /** Screen state after waking, when the dialler did the waking. */
  screen?: ScreenState;
  /** The digits the deep link was built from. */
  digits: string;
  /** Where the tap landed. */
  tappedAt: { x: number; y: number };
  /** The button label that was matched, for the audit trail. */
  buttonLabel: string;
}

/**
 * Places outbound calls through a messaging app by driving its UI.
 *
 * Outward-facing: a successful `call()` makes a real phone ring. It is a
 * separate class from `AndroidCallController` for that reason — cellular
 * dialling is one intent, this is a scripted interaction that can go wrong in
 * more ways, and keeping them apart makes it obvious at the call site which
 * one is being used.
 */
export class VoipDialer {
  private readonly opts: VoipDialerOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly runner: CommandRunner,
    opts: VoipDialerOptions = {},
  ) {
    this.opts = opts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Build the deep link that opens a conversation. */
  chatLink(channel: ChannelKind, number: string): string {
    const build = CHAT_DEEP_LINKS[channel];
    if (!build) {
      throw new Error(
        `Outbound calling is not implemented for "${channel}". Supported: ${Object.keys(CHAT_DEEP_LINKS).join(", ")}.`,
      );
    }
    return build(deepLinkDigits(number, this.opts.defaultCountryCode));
  }

  /**
   * Open the conversation and press the voice-call button. The far end rings.
   */
  async call(endpoint: string, channel: ChannelKind, number: string): Promise<VoipDialResult> {
    const digits = deepLinkDigits(number, this.opts.defaultCountryCode);
    const link = this.chatLink(channel, number);

    // A sleeping or locked phone swallows every tap silently, so the call
    // simply never happens. Fail with the reason instead.
    let screen: ScreenState | undefined;
    if (!this.opts.skipWake) {
      screen = await new ScreenController(this.runner, endpoint).ensureAwake();
      this.opts.onStep?.(`screen: awake=${screen.awake} locked=${screen.locked}`);
      if (screen.locked) {
        throw new Error(
          screen.secure
            ? "The phone is locked with a PIN, pattern or password, which adb cannot clear. " +
              "Remove the screen lock on handsets NeuraCall drives (see docs/RUNBOOK.md)."
            : "The phone is still showing a keyguard after dismiss-keyguard; taps would not reach the app.",
        );
      }
    }
    this.opts.onStep?.(`opening ${link}`);
    await this.runner.runForDevice(endpoint, [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      link,
    ]);

    const button = await this.waitForButton(endpoint);
    const at = nodeCentre(button);
    const label = button.contentDesc || button.text || button.resourceId;
    this.opts.onStep?.(`tapping "${label}" at ${at.x},${at.y}`);
    await this.runner.runForDevice(endpoint, [
      "shell",
      "input",
      "tap",
      String(at.x),
      String(at.y),
    ]);
    return { channel, digits, tappedAt: at, buttonLabel: label, ...(screen ? { screen } : {}) };
  }

  /** Poll the screen until the voice-call button is there. */
  private async waitForButton(endpoint: string): Promise<UiNode> {
    const timeout = this.opts.buttonTimeoutMs ?? 12_000;
    const interval = this.opts.pollIntervalMs ?? 1000;
    const deadline = timeout / interval;
    let lastLabels: string[] = [];

    for (let attempt = 0; attempt < Math.max(1, deadline); attempt += 1) {
      await this.sleep(interval);
      const dump = await this.dumpUi(endpoint);
      const button = findVoiceCallButton(dump);
      if (button) return button;
      lastLabels = clickableLabels(dump);
    }

    throw new Error(
      `No voice-call button appeared within ${timeout}ms. ` +
        `Buttons seen: ${lastLabels.slice(0, 12).join(", ") || "(none)"}. ` +
        `The conversation may not have opened, or this locale's label is not recognised.`,
    );
  }

  private async dumpUi(endpoint: string): Promise<string> {
    try {
      await this.runner.runForDevice(endpoint, [
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/neuracall_dial.xml",
      ]);
      return await this.runner.runForDevice(endpoint, [
        "shell",
        "cat",
        "/sdcard/neuracall_dial.xml",
      ]);
    } catch {
      return "";
    }
  }
}
