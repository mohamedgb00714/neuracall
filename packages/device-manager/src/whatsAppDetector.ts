import type { CommandRunner } from "./adb.js";
import { parseCallState } from "./callController.js";
import type { CallState, ChannelKind } from "./types.js";

/** Result of asking a device whether an inbound call is ringing and on which channel. */
export interface DetectedIncomingCall {
  present: boolean;
  channel: ChannelKind | null;
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
];

/**
 * Detects which channel an inbound call is on, via adb only (no scrcpy needed):
 * - Cellular is authoritative: `dumpsys telephony.registry` (ringing/offhook).
 * - Otherwise, if WhatsApp is the resumed app and is showing an incoming-call
 *   UI (uiautomator dump), it is a WhatsApp voice/video call.
 */
export class AdbCallChannelDetector implements CallChannelDetector {
  constructor(private readonly runner: CommandRunner) {}

  async detect(endpoint: string): Promise<DetectedIncomingCall> {
    const tel = await this.telephonyState(endpoint);
    if (tel === "ringing" || tel === "offhook") {
      return { present: true, channel: "cellular" };
    }

    const foreground = await this.foregroundApp(endpoint);
    if (!isWhatsAppPackage(foreground)) {
      return { present: false, channel: null };
    }

    const ui = await this.uiDump(endpoint);
    if (!hasIncomingCallUi(ui)) {
      return { present: false, channel: null };
    }
    return { present: true, channel: "whatsapp" };
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

  private async foregroundApp(endpoint: string): Promise<string> {
    try {
      const out = await this.runner.runForDevice(endpoint, [
        "shell",
        "dumpsys",
        "activity",
        "activities",
      ]);
      // `mResumedActivity: ActivityRecord{... com.whatsapp/...}`
      const m = out.match(/mResumedActivity: ActivityRecord\{[^}]*\s+([^\s/]+)\//);
      return m?.[1] ?? "";
    } catch {
      return "";
    }
  }

  private async uiDump(endpoint: string): Promise<string> {
    try {
      await this.runner.runForDevice(endpoint, [
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/neuracall_window.xml",
      ]);
      return await this.runner.runForDevice(endpoint, [
        "shell",
        "cat",
        "/sdcard/neuracall_window.xml",
      ]);
    } catch {
      return "";
    }
  }
}

/** True when `pkg` is a WhatsApp application package. */
export function isWhatsAppPackage(pkg: string): boolean {
  const p = pkg.trim();
  return p === WHATSAPP_APP_ID || p === WHATSAPP_BUSINESS_APP_ID || p.startsWith(WHATSAPP_APP_ID);
}

/** True when a UIAutomator dump looks like an incoming WhatsApp call screen. */
export function hasIncomingCallUi(dump: string): boolean {
  return INCOMING_CALL_HINTS.some((re) => re.test(dump));
}
