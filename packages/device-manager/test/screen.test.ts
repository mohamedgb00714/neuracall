import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../src/adb.js";
import { ScreenController, parseAwake, parseLocked, parseSecureLock } from "../src/screen.js";

// Verbatim from the realme RMX3624 (Android 13) while awake and unlocked.
const POWER_AWAKE = "  mWakefulness=Awake\n  Display Power: state=ON";
const POWER_ASLEEP = "  mWakefulness=Asleep";
const WINDOW_UNLOCKED = [
  "    mAwake=true mScreenOnEarly=true mScreenOnFully=true",
  "    mShowingDream=false mDreamingLockscreen=false",
  "    isKeyguardShowing=false",
  "  KeyguardController:",
  "    mKeyguardShowing=false",
].join("\n");
const WINDOW_LOCKED_INSECURE = [
  "    isKeyguardShowing=true",
  "    mKeyguardShowing=true mIsSecure=false",
].join("\n");
const WINDOW_LOCKED_SECURE = [
  "    isKeyguardShowing=true",
  "    mKeyguardShowing=true mIsSecure=true",
].join("\n");

function runner(script: Record<string, string>): CommandRunner & { commands: string[][] } {
  const commands: string[][] = [];
  return {
    commands,
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      commands.push(args);
      const joined = args.join(" ");
      for (const [needle, out] of Object.entries(script)) {
        if (joined.includes(needle)) return out;
      }
      return "";
    },
  };
}

test("wakefulness and keyguard are read from this device's real fields", () => {
  assert.equal(parseAwake(POWER_AWAKE), true);
  assert.equal(parseAwake(POWER_ASLEEP), false);
  assert.equal(parseLocked(WINDOW_UNLOCKED), false);
  assert.equal(parseLocked(WINDOW_LOCKED_INSECURE), true);
  assert.equal(parseSecureLock(WINDOW_LOCKED_SECURE), true);
  assert.equal(parseSecureLock(WINDOW_LOCKED_INSECURE), false);
});

test("a dump with no signal is assumed awake rather than assumed asleep", () => {
  // Absence of a field is not evidence the screen is off; a needless wake
  // keyevent is harmless, refusing to dial is not.
  assert.equal(parseAwake("nothing useful"), true);
  assert.equal(parseLocked("nothing useful"), false);
});

test("an already-awake, unlocked phone is left alone", async () => {
  const r = runner({ "dumpsys power": POWER_AWAKE, "dumpsys window": WINDOW_UNLOCKED });
  const state = await new ScreenController(r, "SERIAL", {
    sleep: async () => undefined,
  }).ensureAwake();
  assert.deepEqual(state, { awake: true, locked: false, secure: false });
  assert.ok(
    !r.commands.some((c) => c.join(" ").includes("keyevent")),
    "should not have sent a wake keyevent to an awake phone",
  );
});

test("a sleeping phone is woken and its keyguard dismissed", async () => {
  let windowDump = WINDOW_LOCKED_INSECURE;
  const commands: string[][] = [];
  const r: CommandRunner = {
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      commands.push(args);
      const joined = args.join(" ");
      // The keyguard clears once dismiss-keyguard has been issued.
      if (joined.includes("dismiss-keyguard")) windowDump = WINDOW_UNLOCKED;
      if (joined.includes("dumpsys power")) return POWER_AWAKE;
      if (joined.includes("dumpsys window")) return windowDump;
      return "";
    },
  };
  const state = await new ScreenController(r, "SERIAL", {
    sleep: async () => undefined,
  }).ensureAwake();
  assert.equal(state.locked, false);
  assert.ok(commands.some((c) => c.join(" ").includes("dismiss-keyguard")));
});

test("a PIN-locked phone is reported, not silently tapped into", async () => {
  // adb cannot clear a secure keyguard. Saying so beats sending taps to a lock
  // screen and reporting a mysterious dialling failure.
  const r = runner({ "dumpsys power": POWER_AWAKE, "dumpsys window": WINDOW_LOCKED_SECURE });
  const state = await new ScreenController(r, "SERIAL", {
    sleep: async () => undefined,
  }).ensureAwake();
  assert.equal(state.locked, true);
  assert.equal(state.secure, true);
});
