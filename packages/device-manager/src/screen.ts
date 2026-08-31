/**
 * Screen and lock-screen control.
 *
 * Everything NeuraCall does through a messaging app — placing a call by
 * tapping its call button, and on some OEMs answering one — is UI automation,
 * and UI automation does nothing useful on a phone that is asleep or behind a
 * keyguard: `input tap` is delivered to the lock screen, `uiautomator dump`
 * describes the lock screen, and the call is never placed. The failure is
 * silent, which is the worst kind.
 *
 * So a device is woken and unlocked before it is driven. Two limits are worth
 * being explicit about:
 *
 *  - `wm dismiss-keyguard` only clears an *insecure* keyguard (swipe-to-open).
 *    A PIN, pattern or password cannot be dismissed by adb without the
 *    credential, so `ensureAwake` reports honestly rather than pretending.
 *    A NeuraCall handset should have no screen lock; that is a deployment
 *    requirement, recorded in docs/RUNBOOK.md.
 *  - Field names vary by OEM, so each signal is read from several, the same
 *    way the foreground package is.
 */

import type { CommandRunner } from "./adb.js";

/** Android KEYCODE_WAKEUP — turns the screen on without toggling it off. */
const KEYCODE_WAKEUP = 224;

export interface ScreenState {
  /** Whether the display is on. */
  awake: boolean;
  /** Whether a keyguard is covering the screen. */
  locked: boolean;
  /**
   * True when the keyguard needs a credential we cannot supply. Distinct from
   * `locked`: a swipe keyguard is dismissible, a PIN is not.
   */
  secure: boolean;
}

/** True when a `dumpsys power` blob says the display is on. */
export function parseAwake(powerDump: string): boolean {
  const wakefulness = powerDump.match(/mWakefulness=(\w+)/)?.[1];
  if (wakefulness) return wakefulness.toLowerCase() === "awake";
  const screenOn = powerDump.match(/mScreenOn=(\w+)/)?.[1];
  if (screenOn) return screenOn.toLowerCase() === "true";
  // Absence of a signal is not evidence the screen is off; assume awake and
  // let the wake keyevent be a harmless no-op.
  return true;
}

/** True when a `dumpsys window`/`activity` blob shows a keyguard. */
export function parseLocked(dump: string): boolean {
  for (const pattern of [
    /mKeyguardShowing=(\w+)/,
    /isKeyguardShowing=(\w+)/,
    /mShowingLockscreen=(\w+)/,
    /mDreamingLockscreen=(\w+)/,
  ]) {
    const value = dump.match(pattern)?.[1];
    if (value) return value.toLowerCase() === "true";
  }
  return false;
}

/**
 * True when the keyguard requires a credential. `wm dismiss-keyguard` cannot
 * clear one of these, so the caller must be told rather than left to wonder
 * why its taps went nowhere.
 */
export function parseSecureLock(dump: string): boolean {
  for (const pattern of [/mIsSecure=(\w+)/, /isSecure=(\w+)/, /mSecure=(\w+)/]) {
    const value = dump.match(pattern)?.[1];
    if (value) return value.toLowerCase() === "true";
  }
  return false;
}

export interface ScreenControllerOptions {
  /** Pause after a wake/dismiss before re-reading state. Default 700 ms. */
  settleMs?: number;
  /** Injectable sleep so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Wakes and unlocks a device so UI automation can actually reach the app. */
export class ScreenController {
  private readonly settleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly runner: CommandRunner,
    private readonly endpoint: string,
    opts: ScreenControllerOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? 700;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Read the current screen and keyguard state. */
  async state(): Promise<ScreenState> {
    const power = await this.dump(["dumpsys", "power"]);
    const windows = await this.dump(["dumpsys", "window"]);
    return {
      awake: parseAwake(power),
      locked: parseLocked(windows),
      secure: parseSecureLock(windows),
    };
  }

  /** Turn the display on. Harmless when it already is. */
  async wake(): Promise<void> {
    await this.runner.runForDevice(this.endpoint, [
      "shell",
      "input",
      "keyevent",
      String(KEYCODE_WAKEUP),
    ]);
  }

  /** Ask the window manager to drop an insecure keyguard. */
  async dismissKeyguard(): Promise<void> {
    await this.runner.runForDevice(this.endpoint, ["shell", "wm", "dismiss-keyguard"]);
  }

  /**
   * Get the device to a state where taps land on the app.
   *
   * Returns the state afterwards. When it comes back `locked: true` with
   * `secure: true`, the phone has a PIN or pattern and no amount of adb will
   * clear it — the caller should surface that rather than tapping into a lock
   * screen and reporting a mysterious failure.
   */
  async ensureAwake(): Promise<ScreenState> {
    let state = await this.state();
    if (state.awake && !state.locked) return state;

    if (!state.awake) {
      await this.wake();
      await this.sleep(this.settleMs);
      state = await this.state();
    }
    if (state.locked) {
      await this.dismissKeyguard();
      await this.sleep(this.settleMs);
      state = await this.state();
    }
    return state;
  }

  private async dump(args: string[]): Promise<string> {
    try {
      return await this.runner.runForDevice(this.endpoint, ["shell", ...args]);
    } catch {
      return "";
    }
  }
}
