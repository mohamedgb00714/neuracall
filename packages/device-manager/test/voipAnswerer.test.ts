import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../src/adb.js";
import {
  VoipAnswerer,
  findAnswerButton,
  isAnswerLabel,
  isAnswerNode,
  isDeclineLabel,
  isMessageReplyLabel,
  supportsVoipAnswer,
} from "../src/voipAnswerer.js";
import { nodeCentre } from "../src/voipDialer.js";

/**
 * A ringing WhatsApp screen. Accept and decline sit side by side; the decline
 * button is the left-hand one, which is also why it tends to come first in the
 * dump.
 */
function ringingScreen(accept: string, decline: string): string {
  return [
    `<node clickable="true" content-desc="${decline}" bounds="[120,1400][280,1560]"/>`,
    `<node clickable="true" content-desc="${accept}" bounds="[440,1400][600,1560]"/>`,
    '<node clickable="false" text="Appel WhatsApp" bounds="[0,400][720,480]"/>',
  ].join("");
}

/** Centre of [440,1400][600,1560] — the accept node in every screen above. */
const ACCEPT_CENTRE = { x: 520, y: 1480 };

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

test("accept is told apart from the decline button beside it", () => {
  // These pairs are near-twins; a substring or prefix match hits both.
  assert.equal(isDeclineLabel("Refuser"), true);
  assert.equal(isAnswerLabel("Refuser"), false);
  assert.equal(isAnswerLabel("Accepter"), true);
  assert.equal(isAnswerLabel("Répondre"), true);

  assert.equal(isAnswerLabel("Ablehnen"), false); // vs "Abnehmen"
  assert.equal(isAnswerLabel("Abnehmen"), true);
  assert.equal(isAnswerLabel("Annehmen"), true);

  assert.equal(isAnswerLabel("Rechazar"), false); // vs "Aceptar"
  assert.equal(isAnswerLabel("Aceptar"), true);

  assert.equal(isAnswerLabel("Rejeitar"), false); // shares "eitar" with "Aceitar"
  assert.equal(isAnswerLabel("Aceitar"), true);

  assert.equal(isAnswerLabel("Rifiuta"), false); // vs "Rispondi"
  assert.equal(isAnswerLabel("Rispondi"), true);

  assert.equal(isAnswerLabel("Decline"), false);
  assert.equal(isAnswerLabel("Answer"), true);
  assert.equal(isAnswerLabel(""), false);
  assert.equal(isAnswerLabel("Appel WhatsApp"), false);
});

test("a node whose labels disagree is never treated as accept", () => {
  // One label saying "decline" disqualifies the whole node: a mis-tap here
  // hangs up on a real customer, a missed match merely fails loudly.
  assert.equal(
    isAnswerNode({
      contentDesc: "Refuser",
      text: "",
      resourceId: "com.whatsapp:id/accept_call_row",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    }),
    false,
  );
});

test("a French ringing screen taps accept at the centre of the accept node", () => {
  // The development handset's UI is French.
  const button = findAnswerButton(ringingScreen("Accepter", "Refuser"));
  assert.ok(button, "no accept control found on a French ringing screen");
  assert.equal(button.contentDesc, "Accepter");
  assert.deepEqual(nodeCentre(button), ACCEPT_CENTRE);
});

test("decline listed FIRST still yields accept", async () => {
  // The regression that matters: selection is by predicate, never by position.
  const runner = fakeRunner(ringingScreen("Accepter", "Refuser"));
  const answerer = new VoipAnswerer(runner, { sleep: async () => undefined });

  const result = await answerer.answer("SERIAL", "whatsapp");

  assert.deepEqual(result.tappedAt, ACCEPT_CENTRE);
  assert.equal(result.buttonLabel, "Accepter");
  assert.ok(
    runner.commands.some((c) => c.join(" ") === "shell input tap 520 1480"),
    `expected a tap at the accept centre, got ${JSON.stringify(runner.commands)}`,
  );
  assert.ok(
    // Centre of the decline node [120,1400][280,1560].
    !runner.commands.some((c) => c.join(" ") === "shell input tap 200 1480"),
    "tapped the decline button",
  );
});

for (const [language, accept, decline] of [
  ["English", "Answer", "Decline"],
  ["German", "Annehmen", "Ablehnen"],
  ["Spanish", "Aceptar", "Rechazar"],
  ["Italian", "Rispondi", "Rifiuta"],
  ["Portuguese", "Aceitar", "Rejeitar"],
  ["Arabic", "قبول", "رفض"],
] as const) {
  test(`a ${language} ringing screen is answered`, async () => {
    const runner = fakeRunner(ringingScreen(accept, decline));
    const answerer = new VoipAnswerer(runner, { sleep: async () => undefined });

    const result = await answerer.answer("SERIAL", "whatsapp");

    assert.equal(result.buttonLabel, accept);
    assert.deepEqual(result.tappedAt, ACCEPT_CENTRE);
  });
}

test("a label that reads as accept AND as decline is not accept", () => {
  // The swipe control carries one description covering both gestures. Both of
  // these match an accept pattern outright, so only the decline veto keeps them
  // from being tapped — delete it and this test is the one that goes red.
  for (const slider of [
    "Swipe up to answer, swipe down to decline",
    "Faites glisser vers le haut pour répondre, vers le bas pour refuser",
    "Nach oben wischen zum Annehmen, nach unten zum Ablehnen",
  ]) {
    assert.equal(isDeclineLabel(slider), true, slider);
    assert.equal(
      isAnswerLabel(slider),
      false,
      `a two-gesture slider was read as accept: ${slider}`,
    );
  }
});

for (const [language, reply] of [
  ["English", "Reply"],
  ["French", "Répondre par SMS"],
  ["French", "Répondre par message"],
  ["German", "Mit Nachricht antworten"],
  ["Spanish", "Responder con mensaje"],
  ["Portuguese", "Responder com mensagem"],
  ["Italian", "Rispondi con un messaggio"],
  ["Arabic", "الرد برسالة"],
] as const) {
  test(`${language} quick reply "${reply}" is never mistaken for accept`, () => {
    // Android's telecom ringing screen and WhatsApp's put this control on the
    // accept row. It rejects the call and sends a canned text, and its label is
    // the accept verb plus a noun.
    assert.equal(isMessageReplyLabel(reply), true, reply);
    assert.equal(isAnswerLabel(reply), false, `quick reply read as accept: ${reply}`);
  });
}

test("the quick-reply button listed before accept is not the one tapped", async () => {
  // Dump order is decline, quick-reply, accept — the order the ringing screen
  // lays them out left to right.
  const runner = fakeRunner(
    [
      '<node clickable="true" content-desc="Refuser" bounds="[120,1400][280,1560]"/>',
      '<node clickable="true" content-desc="Répondre par SMS" bounds="[280,1400][440,1560]"/>',
      '<node clickable="true" content-desc="Accepter" bounds="[440,1400][600,1560]"/>',
    ].join(""),
  );
  const answerer = new VoipAnswerer(runner, { skipWake: true, sleep: async () => undefined });

  const result = await answerer.answer("SERIAL", "whatsapp");

  assert.equal(result.buttonLabel, "Accepter");
  assert.deepEqual(result.tappedAt, ACCEPT_CENTRE);
  assert.ok(
    // Centre of the quick-reply node [280,1400][440,1560].
    !runner.commands.some((c) => c.join(" ") === "shell input tap 360 1480"),
    "tapped the quick-reply button, which rejects the call and texts the caller",
  );
});

test("a package name containing a message word does not block its accept button", () => {
  // "messenger", "messaging" and "securesms" are calling apps, not quick replies.
  for (const id of [
    "org.telegram.messenger:id/accept_btn",
    "org.thoughtcrime.securesms:id/accept_call",
    "com.google.android.apps.messaging:id/answer_button",
  ]) {
    assert.equal(isMessageReplyLabel(id), false, id);
    assert.equal(isAnswerLabel(id), true, `accept id was vetoed: ${id}`);
  }
});

test("_btn resource ids are read, both ways", () => {
  // "_" is a word character on both sides, so \b reaches neither of these.
  assert.equal(isDeclineLabel("com.whatsapp:id/decline_btn"), true);
  assert.equal(isDeclineLabel("com.foo:id/reject_btn"), true);
  assert.equal(isAnswerLabel("com.foo:id/accept_btn"), true);
  assert.equal(isAnswerLabel("org.telegram.messenger:id/answer_btn"), true);
  assert.equal(isAnswerLabel("com.whatsapp:id/decline_btn"), false);
});

test("Italian Riaggancia is a decline, with or without the infinitive ending", () => {
  assert.equal(isDeclineLabel("Riaggancia"), true);
  assert.equal(isDeclineLabel("Riagganciare"), true);
});

test("a row wrapping both buttons is not tapped at its centre", async () => {
  // A clickable container carrying an accept-ish id, with both buttons inside
  // it: its centre is the gap between them, and answering would report success
  // having pressed nothing.
  const runner = fakeRunner(
    [
      '<node clickable="true" resource-id="com.whatsapp:id/accept_call_layout" bounds="[0,1300][720,1700]">',
      '<node clickable="true" content-desc="Refuser" bounds="[120,1400][280,1560]"/>',
      '<node clickable="true" content-desc="Accepter" bounds="[440,1400][600,1560]"/>',
      "</node>",
    ].join(""),
  );
  const answerer = new VoipAnswerer(runner, { skipWake: true, sleep: async () => undefined });

  const result = await answerer.answer("SERIAL", "whatsapp");

  assert.equal(result.buttonLabel, "Accepter");
  assert.deepEqual(result.tappedAt, ACCEPT_CENTRE);
  assert.ok(
    // Centre of the wrapper [0,1300][720,1700].
    !runner.commands.some((c) => c.join(" ") === "shell input tap 360 1500"),
    "tapped the wrapper's centre, which is between the two buttons",
  );
});

test("an asymmetric row wrapper does not put the tap inside decline", () => {
  // Decline owns the left half here, so the wrapper's centre is its own edge.
  const button = findAnswerButton(
    [
      '<node clickable="true" resource-id="com.foo:id/call_accept_row" bounds="[0,1400][720,1560]">',
      '<node clickable="true" content-desc="Refuser" bounds="[0,1400][360,1560]"/>',
      '<node clickable="true" content-desc="Accepter" bounds="[360,1400][720,1560]"/>',
      "</node>",
    ].join(""),
  );
  assert.ok(button, "the accept button nested in the row was not found");
  assert.equal(button.contentDesc, "Accepter");
  assert.deepEqual(nodeCentre(button), { x: 540, y: 1480 });
});

test("WhatsApp's resource ids answer a screen whose labels are unreadable", () => {
  // Ids are a hint, not the only route — but an unlabelled button still has one.
  const button = findAnswerButton(
    [
      '<node clickable="true" resource-id="com.whatsapp:id/decline_call" bounds="[120,1400][280,1560]"/>',
      '<node clickable="true" resource-id="com.whatsapp:id/accept_call" bounds="[440,1400][600,1560]"/>',
    ].join(""),
  );
  assert.ok(button, "no accept control found by resource id");
  assert.equal(button.resourceId, "com.whatsapp:id/accept_call");
  assert.deepEqual(nodeCentre(button), ACCEPT_CENTRE);
});

test("a screen with only a decline control taps nothing and says so", async () => {
  // A silent no-op is the bug being fixed; it must be impossible to reintroduce.
  const runner = fakeRunner(
    '<node clickable="true" content-desc="Refuser" bounds="[120,1400][280,1560]"/>',
  );
  const answerer = new VoipAnswerer(runner, {
    buttonTimeoutMs: 30,
    pollIntervalMs: 10,
    sleep: async () => undefined,
  });

  await assert.rejects(
    () => answerer.answer("SERIAL", "whatsapp"),
    /No accept control appeared.*Refuser/s,
    "an unanswerable screen must fail loudly",
  );
  assert.ok(
    !runner.commands.some((c) => c.includes("tap")),
    `nothing should have been tapped, got ${JSON.stringify(runner.commands)}`,
  );
});

test("the error names the labels that were on screen", async () => {
  const runner = fakeRunner(
    [
      '<node clickable="true" content-desc="Refuser" bounds="[0,0][10,10]"/>',
      '<node clickable="true" content-desc="Message" bounds="[20,0][30,10]"/>',
    ].join(""),
  );
  const answerer = new VoipAnswerer(runner, {
    buttonTimeoutMs: 30,
    pollIntervalMs: 10,
    sleep: async () => undefined,
  });

  await assert.rejects(
    () => answerer.answer("SERIAL", "whatsapp"),
    (err: Error) => {
      assert.match(err.message, /Refuser/);
      assert.match(err.message, /Message/);
      return true;
    },
  );
});

test("cellular is not answered by a tap", () => {
  // KEYCODE_CALL is correct there, and only there.
  assert.equal(supportsVoipAnswer("cellular"), false);
  assert.equal(supportsVoipAnswer("whatsapp"), true);
  assert.equal(supportsVoipAnswer("telegram"), true);
  // An unrecognised calling app still draws an accept button.
  assert.equal(supportsVoipAnswer("voip"), true);
});

test("answering a cellular call through the tap path refuses instead of guessing", async () => {
  const runner = fakeRunner(ringingScreen("Answer", "Decline"));
  const answerer = new VoipAnswerer(runner, { sleep: async () => undefined });
  await assert.rejects(
    () => answerer.answer("SERIAL", "cellular"),
    /answered by telephony, not by a tap/,
  );
});

test("a secure keyguard produces the honest error rather than a tap", async () => {
  // Taps on a keyguard are swallowed silently, so the call would ring on
  // unanswered with no error to explain it.
  const commands: string[][] = [];
  const runner: CommandRunner = {
    async run() {
      return "";
    },
    async runForDevice(_e, args) {
      commands.push(args);
      const joined = args.join(" ");
      if (joined.includes("dumpsys power")) return "  mWakefulness=Awake";
      if (joined.includes("dumpsys window")) return "    mKeyguardShowing=true mIsSecure=true";
      return "";
    },
  };
  const answerer = new VoipAnswerer(runner, { sleep: async () => undefined });

  await assert.rejects(
    () => answerer.answer("SERIAL", "whatsapp"),
    /locked with a PIN, pattern or password/,
  );
  assert.ok(
    !commands.some((c) => c.includes("tap")),
    "nothing should be tapped into a lock screen",
  );
});

test("skipWake lets a caller that already woke the phone answer without re-checking", async () => {
  const runner = fakeRunner(ringingScreen("Accepter", "Refuser"));
  const answerer = new VoipAnswerer(runner, { skipWake: true, sleep: async () => undefined });

  const result = await answerer.answer("SERIAL", "whatsapp");

  assert.deepEqual(result.tappedAt, ACCEPT_CENTRE);
  assert.equal(result.screen, undefined);
  assert.ok(
    !runner.commands.some((c) => c.join(" ").includes("dumpsys power")),
    "skipWake should not query the screen",
  );
});
