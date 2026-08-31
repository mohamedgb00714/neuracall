import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../src/adb.js";
import { DeviceManager } from "../src/deviceManager.js";
import {
  AdbCallChannelDetector,
  isWhatsAppPackage,
  hasIncomingCallUi,
  parseForegroundPackage,
  parseAudioMode,
  parseAudioModeOwner,
  isVoipCallActive,
} from "../src/whatsAppDetector.js";
import { callChannelForOwner, channelForPackage } from "../src/callingApps.js";
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

// `dumpsys audio`, trimmed to the mode sections. A live WhatsApp call puts the
// device in MODE_IN_COMMUNICATION owned by the calling package; this is what
// the realme RMX3624 reported during an actual WhatsApp Business call.
const AUDIO_W4B_IN_COMMUNICATION = [
  "Audio Focus stack entries (last is top of stack):",
  "  source:android.media.AudioAttributes@d0a12 -- pack: com.whatsapp.w4b -- client: 8f21c3e",
  "",
  "Mode dump:",
  "- Current mode = MODE_IN_COMMUNICATION",
  "- Mode owner: pid=6543 uid=10235 package=com.whatsapp.w4b",
  "",
  "mode (dates in Aug):",
  " 31/08 12:04:09.001 setMode(MODE_NORMAL) from package=com.android.systemui pid=1421",
  " 31/08 12:04:11.132 setMode(MODE_IN_COMMUNICATION) from package=com.whatsapp.w4b pid=6543",
];
const AUDIO_IDLE = [
  "Mode dump:",
  "- Current mode = MODE_NORMAL",
  "- Mode owner: pid=0 uid=0",
  "",
  "mode (dates in Aug):",
  " 31/08 11:58:02.507 setMode(MODE_IN_COMMUNICATION) from package=com.whatsapp.w4b pid=6543",
  " 31/08 11:59:44.918 setMode(MODE_NORMAL) from package=com.whatsapp.w4b pid=6543",
];

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
    AUDIO_IDLE,
    WA_FOREGROUND,
    NO_CALL_DUMP, // uiautomator dump command (output ignored)
    WA_DUMP, // cat of the dump
  ]);
  const detector = new AdbCallChannelDetector(runner);
  const det = await detector.detect("SERIAL");
  assert.equal(det.present, true);
  assert.equal(det.channel, "whatsapp");
  assert.equal(det.stage, "ringing");
});

test("reports no inbound call when WhatsApp is foreground but no call UI", async () => {
  const runner = stubRunner([
    TEL_IDLE,
    AUDIO_IDLE,
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
  const runner = stubRunner([TEL_IDLE, AUDIO_IDLE, OTHER_FOREGROUND]);
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
      AUDIO_IDLE,
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
  assert.equal(isWhatsAppPackage(" com.whatsapp.w4b "), true);
  assert.equal(isWhatsAppPackage("com.android.dialer"), false);
  // Lookalikes in a neighbouring namespace must not pass as WhatsApp.
  assert.equal(isWhatsAppPackage("com.whatsappstatus.saver"), false);
  assert.equal(isWhatsAppPackage("com.whatsapp2"), false);
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

// Real output from the realme RMX3624 (Android 13) this was developed against.
// It has NO mResumedActivity line, which is exactly why the original
// single-pattern parser reported no foreground app and WhatsApp calls were
// never detected on the device.
const RMX3624_WINDOW_DUMP = [
  "  mCurrentFocus=Window{3939374 u0 NotificationShade}-[Surface(name=*Title#12082)/@0x3906209]",
  "  mFocusedApp=ActivityRecord{1b1b769 u0 com.whatsapp.w4b/com.whatsapp.Conversation} t546 d0}",
].join("\n");

test("foreground package is found via mFocusedApp when mResumedActivity is absent", () => {
  assert.equal(parseForegroundPackage(RMX3624_WINDOW_DUMP), "com.whatsapp.w4b");
  assert.equal(isWhatsAppPackage(parseForegroundPackage(RMX3624_WINDOW_DUMP)), true);
});

test("foreground package is found across the known dumpsys field names", () => {
  assert.equal(
    parseForegroundPackage(
      "  mResumedActivity: ActivityRecord{abc u0 com.android.dialer/.DialtactsActivity t42}",
    ),
    "com.android.dialer",
  );
  assert.equal(
    parseForegroundPackage(
      "  topResumedActivity=ActivityRecord{abc u0 com.whatsapp/.Main t42}",
    ),
    "com.whatsapp",
  );
  assert.equal(parseForegroundPackage("nothing useful here"), "");
});

test("an unparseable dump yields no package rather than a window title", () => {
  // A window title must never be mistaken for a package name.
  assert.equal(parseForegroundPackage("mCurrentFocus=Window{1 u0 NotificationShade}"), "");
});

test("a WhatsApp Business call is detected on a device with no mResumedActivity", async () => {
  const runner = stubRunner([
    TEL_IDLE, // telephony idle — WhatsApp VoIP does not use it
    AUDIO_IDLE, // audio idle — the call is ringing, not yet connected
    ["(no mResumedActivity on this OEM)"], // dumpsys activity activities
    [RMX3624_WINDOW_DUMP], // dumpsys window — the fallback that works
    NO_CALL_DUMP, // uiautomator dump (output ignored)
    WA_DUMP, // cat of the dump
  ]);
  const det = await new AdbCallChannelDetector(runner).detect("2B26295410JA0CN2");
  assert.deepEqual(det, {
    present: true,
    channel: "whatsapp",
    stage: "ringing",
    ownerPackage: "com.whatsapp.w4b",
  });
});

test("audio mode and owner are read from a live WhatsApp Business call", () => {
  const dump = AUDIO_W4B_IN_COMMUNICATION.join("\n");
  assert.equal(parseAudioMode(dump), "in_communication");
  assert.equal(parseAudioModeOwner(dump), "com.whatsapp.w4b");
  assert.equal(isVoipCallActive(dump), true);
});

test("an idle device reports no VoIP call even after a past WhatsApp call", () => {
  const dump = AUDIO_IDLE.join("\n");
  assert.equal(parseAudioMode(dump), "normal");
  assert.equal(isVoipCallActive(dump), false);
  // The owner is still named by the log; the mode is what gates the decision.
  assert.equal(parseAudioModeOwner(dump), "com.whatsapp.w4b");
});

test("audio mode falls back to the last setMode entry when no mode field exists", () => {
  const dump = [
    "mode (dates in Aug):",
    " 31/08 12:04:09.001 setMode(MODE_NORMAL) from package=com.android.systemui pid=1421",
    " 31/08 12:04:11.132 setMode(MODE_IN_COMMUNICATION) from package=com.whatsapp pid=6543",
  ].join("\n");
  assert.equal(parseAudioMode(dump), "in_communication");
  assert.equal(parseAudioModeOwner(dump), "com.whatsapp");
});

test("a cellular call's audio mode is not mistaken for VoIP", () => {
  const dump = ["Mode dump:", "- Current mode = MODE_IN_CALL", "- Mode owner: pid=1421 uid=1001"].join(
    "\n",
  );
  assert.equal(parseAudioMode(dump), "in_call");
  assert.equal(isVoipCallActive(dump), false);
  assert.equal(parseAudioModeOwner(dump), "");
});

test("an unreadable audio dump yields unknown rather than a guess", () => {
  assert.equal(parseAudioMode(""), "unknown");
  assert.equal(parseAudioMode("Audio Focus stack entries (last is top of stack):"), "unknown");
  assert.equal(parseAudioModeOwner("nothing useful here"), "");
  assert.equal(isVoipCallActive("nothing useful here"), false);
});

test("a VoIP call owned by another app is reported on that app's channel, not WhatsApp", async () => {
  // Detection is app-agnostic: MODE_IN_COMMUNICATION plus the owning package
  // identifies the call. What must never happen is another app's call being
  // mislabelled as WhatsApp.
  const runner = stubRunner([
    TEL_IDLE,
    [
      "Mode dump:",
      "- Current mode = MODE_IN_COMMUNICATION",
      "- Mode owner: pid=7001 uid=10412 package=org.telegram.messenger",
    ],
    OTHER_FOREGROUND,
    ["(no window focus)"],
  ]);
  const det = await new AdbCallChannelDetector(runner).detect("SERIAL");
  assert.equal(det.present, true);
  assert.equal(det.channel, "telegram");
  assert.notEqual(det.channel, "whatsapp");
  assert.equal(det.ownerPackage, "org.telegram.messenger");
});

test("a WhatsApp Business call already in progress is detected without call UI", async () => {
  const runner = stubRunner([
    TEL_IDLE, // WhatsApp VoIP never reaches the telephony registry
    AUDIO_W4B_IN_COMMUNICATION, // the locale-independent signal
    ["(no mResumedActivity on this OEM)"], // dumpsys activity activities
    ["  mFocusedApp=ActivityRecord{1b1 u0 com.android.launcher/.Launcher} t9 d0}"], // user left the app
  ]);
  const det = await new AdbCallChannelDetector(runner).detect("2B26295410JA0CN2");
  assert.deepEqual(det, {
    present: true,
    channel: "whatsapp",
    stage: "in-progress",
    ownerPackage: "com.whatsapp.w4b",
  });
});

test("an answered WhatsApp call whose UI is showing reads as in-progress, not ringing", async () => {
  const runner = stubRunner([
    TEL_IDLE,
    AUDIO_W4B_IN_COMMUNICATION,
    [RMX3624_WINDOW_DUMP], // dumpsys activity activities happens to carry it here
    NO_CALL_DUMP, // uiautomator dump (output ignored)
    // In-call screen: no accept/decline strings, so only the audio mode sees it.
    ['<?xml><node text="05:12" resource-id="com.whatsapp.w4b:id/call_duration"/>'],
  ]);
  const det = await new AdbCallChannelDetector(runner).detect("2B26295410JA0CN2");
  assert.deepEqual(det, {
    present: true,
    channel: "whatsapp",
    stage: "in-progress",
    ownerPackage: "com.whatsapp.w4b",
  });
});

test("an off-hook cellular call is staged in-progress", async () => {
  const det = await new AdbCallChannelDetector(stubRunner([TEL_OFFHOOK])).detect("SERIAL");
  assert.equal(det.stage, "in-progress");
  assert.equal(det.ownerPackage, undefined);
});

// --- any calling app, not just WhatsApp -------------------------------------

function audioInCommunication(pkg: string): string[] {
  return [`setMode(MODE_IN_COMMUNICATION) from package=${pkg} pid=1 selected mode=MODE_IN_COMMUNICATION by pid=1`];
}
const IDLE_AUDIO_DUMP = ["- mode (internal) = NORMAL", "Mode owner: "];
const NO_ACTIVITY = ["(this OEM has no mResumedActivity)"];

test("the calling-app registry maps packages to channels and never prefix-matches", () => {
  assert.equal(channelForPackage("com.whatsapp.w4b"), "whatsapp");
  assert.equal(channelForPackage("org.telegram.messenger"), "telegram");
  assert.equal(channelForPackage("org.thoughtcrime.securesms"), "signal");
  assert.equal(channelForPackage("com.facebook.orca"), "messenger");
  // A lookalike package must not be labelled as the real app.
  assert.equal(channelForPackage("com.whatsapp.clone"), null);
  assert.equal(channelForPackage("com.example.notacaller"), null);
  // An unknown owner of a live call is still a call.
  assert.equal(callChannelForOwner("com.some.newapp"), "voip");
  assert.equal(callChannelForOwner("org.telegram.messenger"), "telegram");
});

test("a call in progress is detected on any known calling app", async () => {
  const cases: Array<[string, string]> = [
    ["org.telegram.messenger", "telegram"],
    ["org.thoughtcrime.securesms", "signal"],
    ["com.viber.voip", "viber"],
    ["com.whatsapp.w4b", "whatsapp"],
  ];
  for (const [pkg, channel] of cases) {
    const runner = stubRunner([
      TEL_IDLE,
      audioInCommunication(pkg),
      NO_ACTIVITY, // dumpsys activity activities
      [`  mFocusedApp=ActivityRecord{1 u0 ${pkg}/.Main} t1 d0}`], // dumpsys window
      NO_CALL_DUMP, // uiautomator dump
      NO_CALL_DUMP, // cat — not a ringing screen, so it is in-progress
    ]);
    const det = await new AdbCallChannelDetector(runner).detect("SERIAL");
    assert.equal(det.present, true, `${pkg} should be detected`);
    assert.equal(det.channel, channel);
    assert.equal(det.stage, "in-progress");
    assert.equal(det.ownerPackage, pkg);
  }
});

test("a call on an app we cannot name is still reported, as generic voip", async () => {
  const runner = stubRunner([
    TEL_IDLE,
    audioInCommunication("com.brand.new.dialer"),
    NO_ACTIVITY,
    ["(no focus)"],
  ]);
  const det = await new AdbCallChannelDetector(runner).detect("SERIAL");
  // Dropping it for lack of a registry entry would lose a real call.
  assert.deepEqual(
    { present: det.present, channel: det.channel, stage: det.stage },
    { present: true, channel: "voip", stage: "in-progress" },
  );
});

test("an idle device with a calling app merely open is not a call", async () => {
  const runner = stubRunner([
    TEL_IDLE,
    IDLE_AUDIO_DUMP,
    NO_ACTIVITY,
    ["  mFocusedApp=ActivityRecord{1 u0 org.telegram.messenger/.Main} t1 d0}"],
    NO_CALL_DUMP,
    NO_CALL_DUMP,
  ]);
  assert.deepEqual(await new AdbCallChannelDetector(runner).detect("SERIAL"), {
    present: false,
    channel: null,
  });
});
