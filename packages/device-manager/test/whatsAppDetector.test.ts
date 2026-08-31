import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../src/adb.js";
import { DeviceManager } from "../src/deviceManager.js";
import {
  AdbCallChannelDetector,
  isWhatsAppPackage,
  hasIncomingCallUi,
} from "../src/whatsAppDetector.js";
import type { DetectedIncomingCall } from "../src/whatsAppDetector.js";

/** Queued stdout per adb call, in order. */
function stubRunner(queue: string[][]): CommandRunner {
  let i = 0;
  return {
    async run() {
      const out = queue[i++];
      if (out === undefined) throw new Error("unexpected adb call (run)");
      return out.join("\n");
    },
    async runForDevice(endpoint, args) {
      const out = queue[i++];
      if (out === undefined)
        throw new Error(`unexpected adb -s ${endpoint} ${args.join(" ")}`);
      return out.join("\n");
    },
  };
}

const TEL_IDLE = ["mCallState=0 mCallState=0"];
const TEL_OFFHOOK = ["mCallState=2 telephonyRegistry"];
const WA_FOREGROUND = [
  "  mResumedActivity: ActivityRecord{abc123 u0 com.whatsapp/.ui.voicecall.VoiceCallActivity t42}",
];
const OTHER_FOREGROUND = [
  "  mResumedActivity: ActivityRecord{abc123 u0 com.android.dialer/.DialtactsActivity t42}",
];
const WA_DUMP = [
  '<?xml><node text="Incoming voice call" resource-id="com.whatsapp:id/incoming_call_wrapper"/>',
];
const NO_CALL_DUMP = ['<?xml><node text="Chats" resource-id="com.whatsapp:id/chats_list"/>'];

test("detects an incoming cellular call from telephony registry", async () => {
  const runner = stubRunner([["mCallState=1 telephonyRegistry"]]);
  const detector = new AdbCallChannelDetector(runner);
  const det = await detector.detect("SERIAL");
  assert.equal(det.present, true);
  assert.equal(det.channel, "cellular");
});

test("detects an incoming WhatsApp call via foreground + call UI", async () => {
  const runner = stubRunner([
    TEL_IDLE,
    WA_FOREGROUND,
    NO_CALL_DUMP, // uiautomator dump command (output ignored)
    WA_DUMP, // cat of the dump
  ]);
  const detector = new AdbCallChannelDetector(runner);
  const det = await detector.detect("SERIAL");
  assert.equal(det.present, true);
  assert.equal(det.channel, "whatsapp");
});

test("reports no inbound call when WhatsApp is foreground but no call UI", async () => {
  const runner = stubRunner([
    TEL_IDLE,
    WA_FOREGROUND,
    NO_CALL_DUMP, // uiautomator dump command
    NO_CALL_DUMP, // cat of the dump (no call hints)
  ]);
  const detector = new AdbCallChannelDetector(runner);
  const det = await detector.detect("SERIAL");
  assert.equal(det.present, false);
  assert.equal(det.channel, null);
});

test("reports no inbound call when a non-WhatsApp app is foreground", async () => {
  const runner = stubRunner([TEL_IDLE, OTHER_FOREGROUND]);
  const detector = new AdbCallChannelDetector(runner);
  const det = await detector.detect("SERIAL");
  assert.equal(det.present, false);
  assert.equal(det.channel, null);
});

test("cellular call wins even when WhatsApp is in the foreground", async () => {
  const runner = stubRunner([TEL_OFFHOOK]);
  const detector = new AdbCallChannelDetector(runner);
  const det = await detector.detect("SERIAL");
  // Off-hook cellular is authoritative; never mislabel a WhatsApp call.
  assert.equal(det.present, true);
  assert.equal(det.channel, "cellular");
});

test("device-manager reports channel=whatsapp and phase=incoming before answer", async () => {
  const runner = stubRunner([
    // DeviceManager.refresh(): `adb devices`
    ["List of devices attached", "emulator-5554\tdevice"],
  ]);
  const dm = new DeviceManager({ runner });
  await dm.refresh();
  assert.equal(dm.get("emulator-5554")?.phase, "online");

  // Now a WhatsApp call arrives; the orchestrator detects before auto-answer.
  const detector = new AdbCallChannelDetector(
    stubRunner([
      TEL_IDLE,
      WA_FOREGROUND,
      NO_CALL_DUMP,
      WA_DUMP,
    ]),
  );

  const incomingEvents: Array<{ id: string; channel: string }> = [];
  dm.on("incoming", (id: string, channel: string) =>
    incomingEvents.push({ id, channel }),
  );

  const det: DetectedIncomingCall = await dm.detectIncomingCall(
    "emulator-5554",
    detector,
  );
  assert.equal(det.present, true);
  assert.equal(det.channel, "whatsapp");

  const dev = dm.get("emulator-5554")!;
  assert.equal(dev.phase, "incoming", "device-manager must report state=incoming");
  assert.equal(dev.channel, "whatsapp", "device-manager must report channel=whatsapp");
  assert.equal(incomingEvents.length, 1);
  assert.equal(incomingEvents[0]!.id, "emulator-5554");
  assert.equal(incomingEvents[0]!.channel, "whatsapp");
});

test("isWhatsAppPackage and hasIncomingCallUi helpers", () => {
  assert.equal(isWhatsAppPackage("com.whatsapp"), true);
  assert.equal(isWhatsAppPackage("com.whatsapp.w4b"), true);
  assert.equal(isWhatsAppPackage("com.whatsapp"), true);
  assert.equal(isWhatsAppPackage("com.android.dialer"), false);
  assert.equal(hasIncomingCallUi('text="Incoming voice call"'), true);
  assert.equal(hasIncomingCallUi('text="Swipe up to answer"'), true);
  assert.equal(hasIncomingCallUi('text="Chats"'), false);
});

test("detectIncomingCall throws for an unknown device", async () => {
  const dm = new DeviceManager({ runner: stubRunner([]) });
  const detector = new AdbCallChannelDetector(stubRunner([TEL_IDLE]));
  await assert.rejects(
    () => dm.detectIncomingCall("nope", detector),
    /Unknown device/,
  );
});
