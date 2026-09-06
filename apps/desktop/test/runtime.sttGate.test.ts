import { test } from "node:test";
import assert from "node:assert/strict";

import { canOpenStt } from "../electron/service/runtime.js";

test("STT is only allowed while the device is on a call", () => {
  // A session on an idle phone transcribes ambient silence and bills for it.
  for (const phase of ["incoming", "in-call"] as const) {
    assert.equal(canOpenStt(phase), true, `a ${phase} device has a call`);
  }
  for (const phase of ["online", "offline", "busy", "unknown", undefined] as const) {
    assert.equal(canOpenStt(phase), false, `phase ${String(phase)} must not open STT`);
  }
});