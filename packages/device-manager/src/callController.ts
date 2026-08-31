import type { CommandRunner } from "./adb.js";
import type { CallController } from "./types.js";
import { KeyCodes } from "./types.js";

/**
 * AndroidCallController drives a single device's in-call UI through Android
 * key events via adb. It has no knowledge of the dialer app — it presses
 * physical-style keys (KEYCODE_CALL / KEYCODE_ENDCALL) which the active call
 * UI responds to regardless of OEM or app.
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

  async dial(number: string): Promise<void> {
    // A leading "+" is not representable as a single Android keyevent (it maps
    // to a long-press on 0), so drop it. Callers should pass a local-format
    // (e.g. already 0-prefixed) number when they need a country prefix.
    const digits = number.replace(/[^\d*#]/g, "");
    if (!digits) throw new Error(`Dial number invalid: ${JSON.stringify(number)}`);
    for (const ch of digits) {
      const code = digitToKey(ch);
      await this.keyEvent(code);
    }
  }

  async toggleMute(): Promise<void> {
    await this.keyEvent(KeyCodes.KEYCODE_MUTE);
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
