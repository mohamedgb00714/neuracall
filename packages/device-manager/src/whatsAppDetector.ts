import type { CommandRunner } from "./adb.js";
import { dumpUi } from "./uiDump.js";
import { parseClickableNodes } from "./voipDialer.js";
import { isAnswerNode, isDeclineNode } from "./voipAnswerer.js";
import { parseCallState } from "./callController.js";
import type { CallState, ChannelKind } from "./types.js";
import { callChannelForOwner, channelForPackage } from "./callingApps.js";

/** How far along a detected call is. */
export type CallStage = "ringing" | "in-progress";

/** Result of asking a device whether an inbound call is ringing and on which channel. */
export interface DetectedIncomingCall {
  present: boolean;
  channel: ChannelKind | null;
  /**
   * Ringing vs already connected. Purely additive: `present`/`channel` keep
   * their meaning ("there is an inbound call, on this channel"), so callers
   * that ignore `stage` behave as before.
   */
  stage?: CallStage;
  /**
   * Package the call belongs to, when a signal named one — `com.whatsapp` or
   * `com.whatsapp.w4b`. Absent for cellular, where there is no owning app.
   */
  ownerPackage?: string;
}

/** Audio focus mode from `dumpsys audio`, normalized off Android's MODE_* names. */
export type AudioMode = "normal" | "ringtone" | "in_call" | "in_communication" | "unknown";

/** Current audio mode and the package that requested it. */
export interface AudioModeState {
  mode: AudioMode;
  /** "" when the dump reports a mode but does not name the requesting package. */
  owner: string;
}

/** Capability that detects an incoming call's channel on a device. */
export interface CallChannelDetector {
  detect(endpoint: string): Promise<DetectedIncomingCall>;
}

export const WHATSAPP_APP_ID = "com.whatsapp";
export const WHATSAPP_BUSINESS_APP_ID = "com.whatsapp.w4b";

/** UI/accessibility hints that a WhatsApp screen is showing an incoming call. */
const INCOMING_CALL_HINTS: RegExp[] = [
  /incoming\s+voice\s+call/i,
  /incoming\s+video\s+call/i,
  /\baccept\b/i,
  /\bdecline\b/i,
  /\bis\s+calling\b/i,
  /\bswipe\s+up\s+to\s+answer\b/i,
  // These were English-only, and the handset this was built for runs in French:
  // its ringing banner reads "Appel vocal entrant" with REFUSER / RÉPONDRE, so
  // every hint above missed and inbound calls were never reported at all.
  /appel\s+(vocal|vid[ée]o)\s+entrant/i,
  /llamada\s+entrante/i,
  /chiamata\s+in\s+arrivo/i,
  /eingehender\s+anruf/i,
  /chamada\s+recebida/i,
  /مكالمة\s+واردة/,
];

/**
 * Detects which channel an inbound call is on, via adb only (no scrcpy needed),
 * trying signals from most to least trustworthy:
 * - Cellular is authoritative: `dumpsys telephony.registry` (ringing/offhook).
 * - `dumpsys audio`: MODE_IN_COMMUNICATION owned by a WhatsApp package means a
 *   WhatsApp call is up. This is locale- and layout-independent, unlike the UI
 *   scrape below, and it is the only signal that sees a call already answered.
 * - `uiautomator` text hints, which distinguish *ringing* from *connected* —
 *   the audio mode alone cannot, and only a ringing call may be auto-answered.
 */
export class AdbCallChannelDetector implements CallChannelDetector {
  constructor(private readonly runner: CommandRunner) {}

  async detect(endpoint: string): Promise<DetectedIncomingCall> {
    const tel = await this.telephonyState(endpoint);
    if (tel === "ringing" || tel === "offhook") {
      return {
        present: true,
        channel: "cellular",
        stage: tel === "ringing" ? "ringing" : "in-progress",
      };
    }

    // MODE_IN_COMMUNICATION plus the owning package identifies a VoIP call on
    // *any* app without knowing anything about that app's UI. An owner missing
    // from the registry still counts as a call — it reports the generic
    // "voip" channel rather than being dropped.
    const audio = parseAudioModeState(await this.dump(endpoint, ["dumpsys", "audio"]));
    const audioCall = audio.mode === "in_communication" && audio.owner !== "";

    const foreground = await this.foregroundApp(endpoint);
    const foregroundChannel = channelForPackage(foreground);
    if (!audioCall && foregroundChannel === null) {
      return { present: false, channel: null };
    }

    // The UI scrape costs two round-trips and a file write, so it is only worth
    // it while a calling app is on screen — a ringing call always is.
    if (foregroundChannel !== null && hasIncomingCallUi(await this.uiDump(endpoint))) {
      return {
        present: true,
        channel: foregroundChannel,
        stage: "ringing",
        ownerPackage: audioCall ? audio.owner : foreground,
      };
    }
    if (audioCall) {
      return {
        present: true,
        channel: callChannelForOwner(audio.owner),
        stage: "in-progress",
        ownerPackage: audio.owner,
      };
    }
    return { present: false, channel: null };
  }

  private async telephonyState(endpoint: string): Promise<CallState> {
    try {
      const out = await this.runner.runForDevice(endpoint, [
        "shell",
        "dumpsys",
        "telephony.registry",
      ]);
      return parseCallState(out);
    } catch {
      return "unknown";
    }
  }

  /**
   * Which package is in the foreground.
   *
   * There is no single field for this across OEMs and Android versions, which
   * is not a theoretical concern: on the realme RMX3624 (Android 13) this was
   * developed against, `dumpsys activity activities` contains **no**
   * `mResumedActivity` line at all, so a parser that only looked for that one
   * silently returned "" and WhatsApp calls were never detected on the device.
   *
   * So each known field is tried in turn and the first that yields a package
   * wins. `dumpsys window`'s `mFocusedApp` is the last resort because it is a
   * different service and costs a second shell round-trip, but it is also the
   * one that works where the activity fields are missing.
   */
  private async foregroundApp(endpoint: string): Promise<string> {
    const activities = await this.dump(endpoint, ["dumpsys", "activity", "activities"]);
    const fromActivities = parseForegroundPackage(activities);
    if (fromActivities !== "") return fromActivities;

    const windows = await this.dump(endpoint, ["dumpsys", "window"]);
    return parseForegroundPackage(windows);
  }

  private async dump(endpoint: string, args: string[]): Promise<string> {
    try {
      return await this.runner.runForDevice(endpoint, ["shell", ...args]);
    } catch {
      return "";
    }
  }

  private async uiDump(endpoint: string): Promise<string> {
    // Serialised: the answerer dumps while the phone is ringing, which is
    // exactly when this poll is running. Concurrent dumps kill each other.
    return dumpUi(this.runner, endpoint, { path: "/sdcard/neuracall_window.xml" });
  }
}

/**
 * Fields that name the foreground activity, in the order they are tried.
 * Each captures the package from an `ActivityRecord{<hash> <user> <pkg>/<cls>}`
 * or a bare `<pkg>/<cls>` payload.
 *
 * `mResumedActivity` and `topResumedActivity` come from
 * `dumpsys activity activities`; `mFocusedApp` from `dumpsys window`. Which of
 * them exists varies by OEM and Android version — see `foregroundApp`.
 */
const FOREGROUND_PATTERNS: readonly RegExp[] = [
  /mResumedActivity:? *(?:ActivityRecord\{)?[^\s}]*\s+(?:u\d+\s+)?([A-Za-z][\w.]+)\//,
  /topResumedActivity=?:? *(?:ActivityRecord\{)?[^\s}]*\s+(?:u\d+\s+)?([A-Za-z][\w.]+)\//,
  /ResumedActivity:? *(?:ActivityRecord\{)?[^\s}]*\s+(?:u\d+\s+)?([A-Za-z][\w.]+)\//,
  /mFocusedApp=(?:ActivityRecord\{)?[^\s}]*\s+(?:u\d+\s+)?([A-Za-z][\w.]+)\//,
  /mCurrentFocus=Window\{[^}]*\s+([A-Za-z][\w.]+)\//,
];

/**
 * Extract the foreground package from a dumpsys blob, trying each known field.
 * Returns "" when none matched, which callers treat as "unknown", never as
 * "no app is running".
 */
export function parseForegroundPackage(dump: string): string {
  for (const pattern of FOREGROUND_PATTERNS) {
    const match = dump.match(pattern);
    const pkg = match?.[1];
    // A dotted package name; guards against capturing a window title.
    if (pkg && pkg.includes(".")) return pkg;
  }
  return "";
}

/**
 * True when `pkg` is a WhatsApp application package: consumer WhatsApp, or
 * anything in its namespace (`com.whatsapp.w4b`, the Business build most test
 * devices actually carry).
 *
 * The trailing dot is load-bearing — a bare `startsWith("com.whatsapp")` also
 * matches unrelated apps such as `com.whatsappstatus.saver`.
 */
export function isWhatsAppPackage(pkg: string): boolean {
  const p = pkg.trim();
  return p === WHATSAPP_APP_ID || p.startsWith(`${WHATSAPP_APP_ID}.`);
}

/**
 * Fields that report the current audio mode, in the order they are tried.
 * As with the foreground activity, the spelling varies by Android version and
 * OEM: `Audio mode:`, `- Current mode =` and a `setMode(...)` event log have
 * all been seen on devices this runs against.
 */
/**
 * Fields that state the CURRENT audio mode.
 *
 * The third pattern is not hypothetical tolerance: this handset prints
 * `- mode (internal) = NORMAL` — a parenthetical qualifier, and the bare name
 * without the `MODE_` prefix. Neither of the first two matches it, so parsing
 * fell through to the `setMode` event log and reported a call that had already
 * ended, because the log keeps every past transition. A stale
 * MODE_IN_COMMUNICATION reads as "a call is in progress" forever.
 */
const AUDIO_MODE_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)[\s-]*(?:Audio\s+)?mode\s*[:=]\s*(MODE_[A-Z_]+)/i,
  /(?:Current|Actual|Requested)\s+mode\s*[:=]\s*(MODE_[A-Z_]+)/i,
  /(?:^|\n)[\s-]*mode\s*(?:\([a-z]+\))?\s*[:=]\s*((?:MODE_)?[A-Z_]+)/,
];

/**
 * The current mode owner, printed as its own field on builds that have one.
 * Authoritative even when empty — an empty `Mode owner:` means nobody owns the
 * mode right now, which must NOT be overridden by a package name scraped from
 * the historical log below.
 */
const CURRENT_OWNER_PATTERN = /(?:^|\n)[\s-]*Mode owner\s*[:=][ \t]*([^\n]*)/i;

/** `setMode` entries in the phone-state event log, oldest first. */
const SET_MODE_PATTERN = /setMode\((?:mode=)?(MODE_[A-Z_]+)\)/g;

/**
 * Package fields on a mode line. `dumpsys audio` names the mode owner
 * differently across versions (`package=`, `from package=`, `caller=`), and on
 * some builds only by pid/uid — hence the "" fallback.
 */
const MODE_OWNER_PATTERN =
  /(?:package|caller|callerPackage|pkg)\s*[=:]\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/;

/** Lines worth scanning for the owner: those that talk about the mode at all. */
const MODE_LINE_PATTERN = /mode\s+owner|setMode\(|MODE_[A-Z_]+/i;

/** A bare package name in a free-text field, or "" when there is none. */
function extractPackage(text: string): string {
  return text.match(/\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}\b/i)?.[0] ?? "";
}

function toAudioMode(raw: string): AudioMode {
  // Some builds print the bare name ("NORMAL") rather than the constant
  // ("MODE_NORMAL"). Both must resolve, or a recognised mode is reported as
  // "unknown" and the caller falls back to the stale event log.
  const normalised = raw.toUpperCase().startsWith("MODE_")
    ? raw.toUpperCase()
    : `MODE_${raw.toUpperCase()}`;
  switch (normalised) {
    case "MODE_NORMAL":
      return "normal";
    case "MODE_RINGTONE":
      return "ringtone";
    case "MODE_IN_CALL":
      return "in_call";
    case "MODE_IN_COMMUNICATION":
      return "in_communication";
    default:
      return "unknown";
  }
}

/**
 * Current audio mode and its owning package from a `dumpsys audio` blob.
 *
 * Explicit "current mode" fields win; failing those, the last `setMode(...)`
 * in the event log is the most recent state (the log is printed oldest first).
 * The owner is read from the last mode-related line that names a package, for
 * the same reason.
 */
export function parseAudioModeState(dump: string): AudioModeState {
  let mode: AudioMode = "unknown";
  for (const pattern of AUDIO_MODE_PATTERNS) {
    const raw = dump.match(pattern)?.[1];
    if (raw) {
      mode = toAudioMode(raw);
      break;
    }
  }
  // The event log is a LAST resort. It records every transition ever made, so
  // its final entry is the last mode the device was *ever* in, not the mode it
  // is in now — using it while a current-mode field exists reports calls that
  // ended minutes ago.
  const hasCurrentMode = mode !== "unknown";
  if (!hasCurrentMode) {
    for (const match of dump.matchAll(SET_MODE_PATTERN)) {
      const raw = match[1];
      if (raw) mode = toAudioMode(raw);
    }
  }

  // A device that is not in a call has no owner, whatever the log remembers.
  if (mode === "normal") return { mode, owner: "" };

  const currentOwnerField = dump.match(CURRENT_OWNER_PATTERN);
  if (currentOwnerField) {
    const stated = currentOwnerField[1] ?? "";
    return { mode, owner: stated.match(MODE_OWNER_PATTERN)?.[1] ?? extractPackage(stated) };
  }

  let owner = "";
  for (const line of dump.split("\n")) {
    if (!MODE_LINE_PATTERN.test(line)) continue;
    const pkg = line.match(MODE_OWNER_PATTERN)?.[1];
    if (pkg) owner = pkg;
  }

  return { mode, owner };
}

/** Current audio mode from a `dumpsys audio` blob. */
export function parseAudioMode(dump: string): AudioMode {
  return parseAudioModeState(dump).mode;
}

/** Package that owns the current audio mode, or "" when the dump names none. */
export function parseAudioModeOwner(dump: string): string {
  return parseAudioModeState(dump).owner;
}

/**
 * True when an app-level (VoIP) call is up on the device.
 *
 * MODE_IN_COMMUNICATION only — MODE_IN_CALL is the telephony stack's, and that
 * is `dumpsys telephony.registry`'s business, not this one's.
 */
export function isVoipCallActive(dump: string): boolean {
  return parseAudioMode(dump) === "in_communication";
}

/** True when a UIAutomator dump looks like an incoming WhatsApp call screen. */
export function hasIncomingCallUi(dump: string): boolean {
  if (INCOMING_CALL_HINTS.some((re) => re.test(dump))) return true;

  // Fall back to the shape of the screen rather than its wording: a ringing
  // call is the one moment an accept control and a decline control are on
  // screen together. A conversation has a call button but nothing to decline,
  // and a call in progress has hang-up but nothing to accept.
  //
  // This reuses the answerer's predicates on purpose. They already cover seven
  // languages and are the same readings that decide where to tap, so detection
  // and answering cannot drift apart into a state where one recognises a screen
  // the other does not.
  const nodes = parseClickableNodes(dump);
  return nodes.some(isAnswerNode) && nodes.some(isDeclineNode);
}
