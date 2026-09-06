import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../src/adb.js";
import {
  VoipDialer,
  buildDialCommand,
  deepLinkDigits,
  findVoiceCallButton,
  isVideoCallLabel,
  isVoiceCallLabel,
  nodeCentre,
  parseClickableNodes,
  supportsVoipDial,
} from "../src/voipDialer.js";

/** The real WhatsApp Business chat screen from the development handset. */
const WA_CHAT_DUMP = [
  '<node clickable="true" content-desc="Retour" bounds="[0,104][96,200]"/>',
  '<node clickable="true" content-desc="Appel vidéo" bounds="[448,104][544,200]"/>',
  '<node clickable="true" content-desc="Appel vocal" bounds="[544,104][640,200]"/>',
  '<node clickable="false" content-desc="Message" bounds="[0,900][720,980]"/>',
].join("");

test("the voice button is told apart from the video button beside it", () => {
  // "Appel vidéo" contains "Appel"; a loose match would start a video call.
  assert.equal(isVideoCallLabel("Appel vidéo"), true);
  assert.equal(isVoiceCallLabel("Appel vidéo"), false);
  assert.equal(isVoiceCallLabel("Appel vocal"), true);
  assert.equal(isVoiceCallLabel("Voice call"), true);
  assert.equal(isVoiceCallLabel("Video call"), false);
  assert.equal(isVoiceCallLabel(""), false);
  assert.equal(isVoiceCallLabel("Retour"), false);
});

test("the call button is found by description, not by fixed coordinates", () => {
  const button = findVoiceCallButton(WA_CHAT_DUMP);
  assert.ok(button, "no voice-call button found in a real dump");
  assert.equal(button.contentDesc, "Appel vocal");
  // Centre of [544,104][640,200].
  assert.deepEqual(nodeCentre(button), { x: 592, y: 152 });
});

test("only clickable nodes are considered", () => {
  const nodes = parseClickableNodes(WA_CHAT_DUMP);
  assert.equal(nodes.length, 3);
  assert.ok(!nodes.some((n) => n.contentDesc === "Message"));
});

test("a screen with no call button yields none rather than a wrong tap", () => {
  assert.equal(
    findVoiceCallButton('<node clickable="true" content-desc="Retour" bounds="[0,0][10,10]"/>'),
    null,
  );
});

test("numbers are promoted to international form for the deep link", () => {
  assert.equal(deepLinkDigits("+213541685472"), "213541685472");
  assert.equal(deepLinkDigits("0541685472", "213"), "213541685472");
  assert.equal(deepLinkDigits("00213541685472"), "213541685472");
  assert.equal(deepLinkDigits("0541 68 54 72", "213"), "213541685472");
  // Already carrying the country code must not gain a second one.
  assert.equal(deepLinkDigits("213541685472", "213"), "213541685472");
  assert.throws(() => deepLinkDigits("private"), /Not a dialable number/);
});

test("channels without an implementation say so instead of guessing", () => {
  assert.equal(supportsVoipDial("whatsapp"), true);
  assert.equal(supportsVoipDial("telegram"), true);
  assert.equal(supportsVoipDial("zoom"), false);
  const dialer = new VoipDialer({ run: async () => "", runForDevice: async () => "" });
  assert.throws(() => dialer.chatLink("zoom", "+213541685472"), /not implemented for "zoom"/);
  // wa.me resolves to the system resolver on the realme (Chrome shares the
  // handler); the whatsapp:// scheme reaches WhatsApp alone.
  assert.equal(dialer.chatLink("whatsapp", "+213541685472"), "whatsapp://send?phone=213541685472");
});

test("buildDialCommand returns the exact am start argv", () => {
  const cmd = buildDialCommand("whatsapp", "+213541685472", "213");
  assert.equal(cmd.channel, "whatsapp");
  assert.equal(cmd.link, "whatsapp://send?phone=213541685472");
  assert.deepEqual(cmd.args, [
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "whatsapp://send?phone=213541685472",
  ]);
  assert.throws(() => buildDialCommand("zoom", "+213541685472"), /not implemented for "zoom"/);
});

test("calling opens the chat then taps the voice button", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      calls.push(args);
      return args.includes("cat") ? WA_CHAT_DUMP : "";
    },
  };
  const dialer = new VoipDialer(runner, {
    defaultCountryCode: "213",
    sleep: async () => undefined,
  });

  const result = await dialer.call("SERIAL", "whatsapp", "0541685472");

  assert.deepEqual(result.tappedAt, { x: 592, y: 152 });
  assert.equal(result.buttonLabel, "Appel vocal");
  assert.equal(result.digits, "213541685472");
  assert.ok(
    calls.some((a) => a.join(" ").includes("whatsapp://send?phone=213541685472")),
    "the chat deep link was not opened",
  );
  assert.ok(
    calls.some((a) => a.join(" ") === "shell input tap 592 152"),
    `expected a tap at the button centre, got ${JSON.stringify(calls)}`,
  );
});

test("a chat that never shows a call button fails loudly with what it saw", async () => {
  const runner: CommandRunner = {
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      return args.includes("cat")
        ? '<node clickable="true" content-desc="Retour" bounds="[0,0][10,10]"/>'
        : "";
    },
  };
  const dialer = new VoipDialer(runner, {
    buttonTimeoutMs: 30,
    pollIntervalMs: 10,
    sleep: async () => undefined,
  });
  await assert.rejects(
    () => dialer.call("SERIAL", "whatsapp", "+213541685472"),
    /No voice-call button appeared.*Retour/s,
  );
});

test("dialling a locked phone refuses instead of tapping the lock screen", async () => {
  // Taps on a keyguard are swallowed silently, so the call would simply never
  // happen with no error to explain it.
  const runner: CommandRunner = {
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      const joined = args.join(" ");
      if (joined.includes("dumpsys power")) return "  mWakefulness=Awake";
      if (joined.includes("dumpsys window")) return "    mKeyguardShowing=true mIsSecure=true";
      return "";
    },
  };
  const dialer = new VoipDialer(runner, { sleep: async () => undefined });
  await assert.rejects(
    () => dialer.call("SERIAL", "whatsapp", "+213541685472"),
    /locked with a PIN, pattern or password/,
  );
});

test("skipWake lets a caller that already woke the phone dial without re-checking", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      calls.push(args);
      return args.includes("cat") ? WA_CHAT_DUMP : "";
    },
  };
  const dialer = new VoipDialer(runner, { skipWake: true, sleep: async () => undefined });
  await dialer.call("SERIAL", "whatsapp", "+213541685472");
  assert.ok(
    !calls.some((c) => c.join(" ").includes("dumpsys power")),
    "skipWake should not query the screen",
  );
});
