import { test } from "node:test";
import assert from "node:assert/strict";

import { planOutboundVoipDial } from "../electron/service/runtime.js";

// The full Runtime is not built here: it constructs its own DeviceManager on
// the real adb runner (no injection point) plus the realtime-session and
// scrcpy stack, so an in-call phase could not be observed from a stub. The
// runtime's WhatsApp dial path is distilled into `planOutboundVoipDial` and
// asserted through that seam — the two guarantees `dialWhatsApp` makes are the
// same `am start` argv (offered to whichever dialer it runs) and the same
// device phase (in-call) it sets afterwards.

test("the runtime WhatsApp dial path issues the exact am start argv and tracks the device as in-call", () => {
  const plan = planOutboundVoipDial("0541685472", "213");
  assert.equal(plan.phase, "in-call");
  assert.equal(plan.command.channel, "whatsapp");
  assert.equal(plan.command.link, "whatsapp://send?phone=213541685472");
  assert.deepEqual(plan.command.args, [
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "whatsapp://send?phone=213541685472",
  ]);
});

test("an international number is not re-prefixed by the country code", () => {
  const plan = planOutboundVoipDial("+213541685472", "213");
  assert.equal(plan.command.link, "whatsapp://send?phone=213541685472");
});

test("with no country code configured a national number goes out as typed", () => {
  const plan = planOutboundVoipDial("0541685472", "");
  assert.equal(plan.command.link, "whatsapp://send?phone=0541685472");
});