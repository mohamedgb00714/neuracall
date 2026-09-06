import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../src/adb.js";
import {
  VoipHangup,
  findEndCallButton,
  isEndCallLabel,
  isEndCallNode,
  supportsVoipHangup,
} from "../src/voipHangup.js";
import { nodeCentre } from "../src/voipDialer.js";

/**
 * An in-progress WhatsApp call screen. The hang-up control is the red button;
 * WhatsApp marks it with a content-desc that is localised per handset.
 */
function callScreen(hangUp: string): string {
  return [
    `'<node clickable="true" content-desc="${hangUp}" bounds="[440,1400][600,1560]"/>`,
    '<node clickable="false" text="Appel en cours" bounds="[0,400][720,480]"/>',
  ].join("");
}

/** Centre of [440,1400][600,1560] — the hang-up node in every screen above. */
const HANGUP_CENTRE = { x: 520, y: 1480 };

function fakeRunner(dump: string): CommandRunner & { commands: string[][] } {
  const commands: string[][] = [];
  return {
    commands,
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      commands.push(args);
      return args.includes("cat") ? dump : "";
    },
  };
}

test("hang-up is told apart from the accept/decline readings of the ringing screen", () => {
  assert.equal(isEndCallLabel("End call"), true);
  assert.equal(isEndCallLabel("Hang up"), true);
  assert.equal(isEndCallLabel("Raccrocher"), true);
  assert.equal(isEndCallLabel("Auflegen"), true);
  assert.equal(isEndCallLabel("Colgar"), true);
  assert.equal(isEndCallLabel("Desligar"), true);
  assert.equal(isEndCallLabel("Rifiuta"), false); // decline, not hang-up
  assert.equal(isEndCallLabel("إنهاء المكالمة"), true);
  assert.equal(isEndCallLabel("Accepter"), false);
  assert.equal(isEndCallLabel("Answer"), false);
  assert.equal(isEndCallLabel(""), false);
  assert.equal(isEndCallLabel("Appel en cours"), false);
});

test("a node whose labels disagree is never treated as hang-up", () => {
  // The destructive control must come from a reading that cannot be interpreted
  // any other way: a node whose id carries an accept reading is vetoed outright.
  assert.equal(
    isEndCallNode({
      contentDesc: "End call",
      text: "",
      resourceId: "com.whatsapp:id/accept_call",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    }),
    false,
    "an accept resource-id vetoed an end-call content-desc",
  );
  assert.equal(
    isEndCallNode({
      contentDesc: "End call",
      text: "",
      resourceId: "com.whatsapp:id/end_call",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    }),
    true,
  );
});

test("a French in-progress call screen taps hang-up at the centre of the node", () => {
  const button = findEndCallButton(callScreen("Raccrocher"));
  assert.ok(button, "no hang-up control found on a French call screen");
  assert.equal(button.contentDesc, "Raccrocher");
  assert.deepEqual(nodeCentre(button), HANGUP_CENTRE);
});

test("hangUp taps the centre of the control it found", async () => {
  const runner = fakeRunner(callScreen("End call"));
  const hangup = new VoipHangup(runner, { sleep: async () => undefined });

  const result = await hangup.hangUp("SERIAL", "whatsapp");

  assert.deepEqual(result.tappedAt, HANGUP_CENTRE);
  assert.equal(result.buttonLabel, "End call");
  assert.ok(
    runner.commands.some((c) => c.join(" ") === "shell input tap 520 1480"),
    `expected a tap at the hang-up centre, got ${JSON.stringify(runner.commands)}`,
  );
});

test("hangUp fails loudly when no hang-up control appears", async () => {
  const runner = fakeRunner('<node clickable="false" text="Conversation" bounds="[0,0][720,400]"/>');
  const hangup = new VoipHangup(runner, {
    buttonTimeoutMs: 100,
    pollIntervalMs: 40,
    sleep: async () => undefined,
  });

  await assert.rejects(
    hangup.hangUp("SERIAL", "whatsapp"),
    /No hang-up control appeared within 100ms/,
  );
});

test("supportsVoipHangup: only cellular is ended by the keyevent", () => {
  assert.equal(supportsVoipHangup("cellular"), false);
  assert.equal(supportsVoipHangup("whatsapp"), true);
  assert.equal(supportsVoipHangup("voip"), true);
});

test("hangUp refuses a cellular channel with a clear error", async () => {
  const hangup = new VoipHangup(fakeRunner(""), { sleep: async () => undefined });
  await assert.rejects(hangup.hangUp("SERIAL", "cellular"), /KEYCODE_ENDCALL/);
});