import type { CommandRunner } from "./adb.js";
import type { CallController, CallState } from "./types.js";
import { KeyCodes } from "./types.js";

/**
 * AndroidCallController drives a single device's telephony through adb. Call
 * placement uses the standard CALL/DIAL intents (works on every OEM dialer);
 * answer / hang-up / mute press the physical-style keys (KEYCODE_CALL /
 * KEYCODE_ENDCALL) which the active call UI responds to regardless of OEM or
 * app; call state comes from `dumpsys telephony.registry`.
 */
export class AndroidCallController implements CallController {
  constructor(
    private readonly runner: CommandRunner,
    private readonly endpoint: string,
  ) {}

  async answer(): Promise<void> {
    await this.keyEvent(KeyCodes.KEYCODE_CALL);
  }

  async hangUp(): Promise<void> {
    await this.keyEvent(KeyCodes.KEYCODE_ENDCALL);
  }

  async safeHangUp(): Promise<void> {
    try {
      await this.hangUp();
    } catch {
      // Swallow: the call may already be over and the phone may not respond
      // to an ENDCALL press. This is intentionally best-effort.
    }
  }

  /**
   * Place an outgoing call. The CALL intent starts ringing the number
   * immediately (adb shell holds CALL_PHONE), so callers must treat this as an
   * outward-facing action.
   */
  async dial(number: string): Promise<void> {
    const tel = normalizeTel(number);
    await this.runner.runForDevice(this.endpoint, [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.CALL",
      "-d",
      telUri(tel),
    ]);
  }

  /** Open the dialer, prefilled with `number` when given. Nothing is placed. */
  async openDialer(number?: string): Promise<void> {
    const args = ["shell", "am", "start", "-a", "android.intent.action.DIAL"];
    if (number !== undefined && number.trim() !== "") {
      args.push("-d", telUri(normalizeTel(number)));
    }
    await this.runner.runForDevice(this.endpoint, args);
  }

  /** Type digits as key events — for in-call DTMF menus or a dialer field. */
  async pressDigits(digits: string): Promise<void> {
    const cleaned = digits.replace(/[^\d*#]/g, "");
    if (!cleaned) throw new Error(`Dial number invalid: ${JSON.stringify(digits)}`);
    for (const ch of cleaned) {
      await this.keyEvent(digitToKey(ch));
    }
  }

  async toggleMute(): Promise<void> {
    await this.keyEvent(KeyCodes.KEYCODE_MUTE);
  }

  async callState(): Promise<CallState> {
    const out = await this.runner.runForDevice(this.endpoint, [
      "shell",
      "dumpsys",
      "telephony.registry",
    ]);
    return parseCallState(out);
  }

  private async keyEvent(code: number): Promise<void> {
    await this.runner.runForDevice(this.endpoint, [
      "shell",
      "input",
      "keyevent",
      String(code),
    ]);
  }
}

/**
 * Reduce a human-typed number to what a tel: URI accepts: digits, `*`, `#`
 * and at most one leading `+`. Throws when no digit survives.
 */
export function normalizeTel(number: string): string {
  const cleaned = number.replace(/[^\d+*#]/g, "");
  if (!/\d/.test(cleaned)) {
    throw new Error(`Dial number invalid: ${JSON.stringify(number)}`);
  }
  const plus = cleaned.startsWith("+") ? "+" : "";
  return plus + cleaned.replace(/\+/g, "");
}

/** Build the `tel:` URI, escaping `*`/`#` which the device shell would mangle. */
export function telUri(tel: string): string {
  return `tel:${tel.replace(/\*/g, "%2A").replace(/#/g, "%23")}`;
}

/**
 * Parse `dumpsys telephony.registry` output. Multi-SIM devices print one
 * mCallState per phone; the most active one wins (2=offhook, 1=ringing, 0=idle).
 */
export function parseCallState(dumpsys: string): CallState {
  const states = [...dumpsys.matchAll(/mCallState=(\d)/g)].map((m) => Number(m[1]));
  if (states.length === 0) return "unknown";
  const max = Math.max(...states);
  if (max >= 2) return "offhook";
  if (max === 1) return "ringing";
  return "idle";
}

function digitToKey(ch: string): number {
  switch (ch) {
    case "*":
      return KeyCodes.KEYCODE_STAR;
    case "#":
      return KeyCodes.KEYCODE_POUND;
    default: {
      const n = Number(ch);
      if (Number.isInteger(n) && n >= 0 && n <= 9) {
        // KEYCODE_0..9 are contiguous starting at 7
        return KeyCodes.KEYCODE_0 + n;
      }
      throw new Error(`Unsupported dialer character: ${JSON.stringify(ch)}`);
    }
  }
}
