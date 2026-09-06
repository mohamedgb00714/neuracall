import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceManager } from "../src/deviceManager.js";
import { AndroidCallController, normalizeTel, parseCallState } from "../src/callController.js";
import type { CommandRunner } from "../src/adb.js";
import { KeyCodes } from "../src/types.js";

function stubRunner(queue: string[][]): CommandRunner {
  let i = 0;
  return {
    async run() {
      const out = queue[i++];
      if (out === undefined) throw new Error("unexpected adb call");
      return out.join("\n");
    },
    async runForDevice(endpoint, args) {
      const out = queue[i++];
      if (out === undefined) throw new Error(`unexpected adb -s ${endpoint} ${args.join(" ")}`);
      return out.join("\n");
    },
  };
}

test("DeviceManager reconciles connected devices", async () => {
  const runner = stubRunner([
    ["List of devices attached", "emulator-5554\tdevice", "192.168.0.10:5555\tdevice"],
  ]);
  const dm = new DeviceManager({ runner });
  await dm.refresh();

  const snap = dm.snapshot;
  assert.equal(snap.length, 2);
  assert.equal(snap.find((d) => d.id === "emulator-5554")?.kind, "usb");
  assert.equal(snap.find((d) => d.id === "192.168.0.10:5555")?.kind, "wifi");
  assert.equal(
    snap.every((d) => d.adbState === "device"),
    true,
  );
});

test("DeviceManager flattens a USB device as offline when it disappears", async () => {
  const runner = stubRunner([
    ["List of devices attached", "emulator-5554\tdevice"],
    ["List of devices attached"],
  ]);
  const dm = new DeviceManager({ runner });
  await dm.refresh();
  assert.equal(dm.get("emulator-5554")?.phase, "online");
  await dm.refresh();
  assert.equal(dm.get("emulator-5554")?.phase, "offline");
  assert.equal(dm.get("emulator-5554")?.adbState, "offline");
});

test("DeviceManager emits device/adb-state/phase events when a device vanishes", async () => {
  // Regression: consumers (the orchestrator, the UI) learned a device dropped
  // only by polling — the vanish loop and markAllOffline() used to update the
  // device map silently, emitting no events. The fix emits on both paths.
  const runner = stubRunner([
    ["List of devices attached", "emulator-5554\tdevice", "192.168.0.10:5555\tdevice"],
    ["List of devices attached", "emulator-5554\tdevice"],
  ]);
  const dm = new DeviceManager({ runner });
  await dm.refresh();
  assert.equal(dm.snapshot.length, 2);

  const adbStates: Array<{ id: string; state: string }> = [];
  const phases: Array<{ id: string; phase: string }> = [];
  const devices: string[] = [];
  dm.on("adb-state", (id: string, state: string) => adbStates.push({ id, state }));
  dm.on("phase", (id: string, phase: string) => phases.push({ id, phase }));
  dm.on("device", (device: { id: string }) => devices.push(device.id));

  // Second pass: 192.168.0.10:5555 disappears from adb devices.
  await dm.refresh();

  assert.ok(adbStates.some((e) => e.id === "192.168.0.10:5555" && e.state === "offline"));
  assert.ok(phases.some((e) => e.id === "192.168.0.10:5555" && e.phase === "offline"));
  assert.ok(devices.includes("192.168.0.10:5555"), "the 'device' event must fire too");
  assert.equal(dm.get("192.168.0.10:5555")?.phase, "offline");
});

test("DeviceManager emits offline events when adb fails entirely (markAllOffline)", async () => {
  // Regression: when `adb devices` throws, markAllOffline() used to update every
  // device silently. The fix emits device/adb-state/phase for each.
  const runner = stubRunner([["List of devices attached", "emulator-5554\tdevice"]]);
  const dm = new DeviceManager({ runner });
  await dm.refresh();
  assert.equal(dm.get("emulator-5554")?.phase, "online");

  const adbStates: string[] = [];
  const phases: string[] = [];
  dm.on("adb-state", (_id: string, state: string) => adbStates.push(state));
  dm.on("phase", (_id: string, phase: string) => phases.push(phase));

  const failing: CommandRunner = {
    async run() {
      throw new Error("adb missing");
    },
    async runForDevice() {
      throw new Error("adb missing");
    },
  };
  // Same manager, new runner that throws: refresh triggers markAllOffline.
  (dm as unknown as { runner: CommandRunner }).runner = failing;
  await dm.refresh();

  assert.equal(dm.get("emulator-5554")?.phase, "offline");
  assert.ok(adbStates.includes("offline"), "adb-state offline must be emitted");
  assert.ok(phases.includes("offline"), "phase offline must be emitted");
});

test("DeviceManager keeps a custom phase across refreshes", async () => {
  const runner = stubRunner([
    ["List of devices attached", "emulator-5554\tdevice"],
    ["List of devices attached", "emulator-5554\tdevice"],
  ]);
  const dm = new DeviceManager({ runner });
  await dm.refresh();
  dm.setPhase("emulator-5554", "in-call");
  await dm.refresh();
  assert.equal(dm.get("emulator-5554")?.phase, "in-call");
});

test("DeviceManager marks everything offline when adb fails", async () => {
  const runner = stubRunner([["List of devices attached", "emulator-5554\tdevice"]]);
  const dm = new DeviceManager({ runner });
  await dm.refresh();
  assert.equal(dm.get("emulator-5554")?.phase, "online");

  const failing: CommandRunner = {
    async run() {
      throw new Error("adb missing");
    },
    async runForDevice() {
      throw new Error("adb missing");
    },
  };
  const dm2 = new DeviceManager({ runner: failing });
  await dm2.refresh();
  // adb entirely unavailable: last known state cleared
  assert.equal(dm2.snapshot.length, 0);
});

test("AndroidCallController.answer sends KEYCODE_CALL via input keyevent", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(["global", ...args]);
      return "";
    },
    async runForDevice(endpoint, args) {
      calls.push([endpoint, ...args]);
      return "";
    },
  };
  const ctl = new AndroidCallController(runner, "192.168.0.10:5555");
  await ctl.answer();
  assert.deepEqual(calls, [
    ["192.168.0.10:5555", "shell", "input", "keyevent", String(KeyCodes.KEYCODE_CALL)],
  ]);
});

test("AndroidCallController.hangUp sends KEYCODE_ENDCALL", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(args);
      return "";
    },
    async runForDevice(endpoint, args) {
      calls.push(args);
      return "";
    },
  };
  const ctl = new AndroidCallController(runner, "serial1");
  await ctl.hangUp();
  assert.deepEqual(calls, [["shell", "input", "keyevent", String(KeyCodes.KEYCODE_ENDCALL)]]);
});

function recordingRunner(reply = ""): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(args);
      return reply;
    },
    async runForDevice(_endpoint, args) {
      calls.push(args);
      return reply;
    },
  };
  return { runner, calls };
}

test("AndroidCallController.dial places the call via the CALL intent", async () => {
  const { runner, calls } = recordingRunner();
  const ctl = new AndroidCallController(runner, "serial1");
  await ctl.dial("+1 (234) 567-89");
  assert.deepEqual(calls, [
    ["shell", "am", "start", "-a", "android.intent.action.CALL", "-d", "tel:+123456789"],
  ]);
});

test("AndroidCallController.openDialer prefills without placing a call", async () => {
  const { runner, calls } = recordingRunner();
  const ctl = new AndroidCallController(runner, "serial1");
  await ctl.openDialer("*123#");
  await ctl.openDialer();
  assert.deepEqual(calls, [
    ["shell", "am", "start", "-a", "android.intent.action.DIAL", "-d", "tel:%2A123%23"],
    ["shell", "am", "start", "-a", "android.intent.action.DIAL"],
  ]);
});

test("AndroidCallController.pressDigits presses each digit as a keyevent", async () => {
  const { runner, calls } = recordingRunner();
  const ctl = new AndroidCallController(runner, "serial1");
  await ctl.pressDigits("1#");
  assert.deepEqual(calls, [
    ["shell", "input", "keyevent", String(KeyCodes.KEYCODE_1)],
    ["shell", "input", "keyevent", String(KeyCodes.KEYCODE_POUND)],
  ]);
});

test("normalizeTel keeps one leading plus and strips noise", () => {
  assert.equal(normalizeTel("+33 6 12 34"), "+3361234");
  assert.equal(normalizeTel("00+44 20"), "004420");
  assert.equal(normalizeTel("*#06#"), "*#06#");
  assert.throws(() => normalizeTel("+"), /Dial number invalid/);
});

test("parseCallState picks the most active SIM and handles unknown output", () => {
  assert.equal(parseCallState("mCallState=0\nmCallState=0"), "idle");
  assert.equal(parseCallState("mCallState=0\n  mCallState=1"), "ringing");
  assert.equal(parseCallState("mCallState=2\nmCallState=0"), "offhook");
  assert.equal(parseCallState("garbage"), "unknown");
});

test("AndroidCallController.callState reads dumpsys telephony.registry", async () => {
  const { runner, calls } = recordingRunner("  mCallState=2\n");
  const ctl = new AndroidCallController(runner, "serial1");
  assert.equal(await ctl.callState(), "offhook");
  assert.deepEqual(calls, [["shell", "dumpsys", "telephony.registry"]]);
});

test("AndroidCallController.dial rejects a number with no dialable digits", async () => {
  const runner: CommandRunner = {
    async run() {
      return "";
    },
    async runForDevice() {
      return "";
    },
  };
  const ctl = new AndroidCallController(runner, "serial1");
  await assert.rejects(() => ctl.dial("abc"), /Dial number invalid/);
});

test("AndroidCallController.safeHangUp swallows errors", async () => {
  const runner: CommandRunner = {
    async run() {
      throw new Error("phone gone");
    },
    async runForDevice() {
      throw new Error("phone gone");
    },
  };
  const ctl = new AndroidCallController(runner, "serial1");
  await assert.doesNotReject(() => ctl.safeHangUp());
});
