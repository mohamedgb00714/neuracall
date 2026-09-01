/**
 * What would the answerer do with the screen that is on the phone right now?
 *
 * Answering a VoIP call is UI automation, and the whole risk is that a wrong
 * match taps a control that hangs up on a customer. The unit tests cover
 * hand-written dumps; this shows the decision against the *real* screen of a
 * *real* handset, which is the only place the labels are authoritative.
 *
 * Read-only: it dumps the view hierarchy and prints the verdict. It never taps.
 * Safe to run while a call is ringing — that is the point.
 *
 *   node scripts/inspect-ringing-screen.mjs [--device=SERIAL]
 */

import {
  DeviceManager,
  clickableLabels,
  defaultSpawner,
  dumpUi,
  findAnswerButton,
  isAnswerLabel,
  isDeclineLabel,
  nodeCentre,
  parseClickableNodes,
  realRunner,
} from "@neuracall/device-manager";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const runner = realRunner(defaultSpawner);
const devices = new DeviceManager({ runner, pollIntervalMs: 60_000 });
await devices.refresh();
const online = devices.snapshot.filter((d) => d.adbState === "device");
if (online.length === 0) {
  console.error("No adb device online.");
  process.exit(1);
}
const endpoint = arg("device", online[0].id);

// Its own file, so a dump on the app's poll loop and this one cannot truncate
// each other's output.
//
// Note the limit: the serialiser is per-process, and the running app is a
// different process. `uiautomator` is a singleton on the *device*, so this can
// still lose a race with the app's detector and come back with a bare exit 137.
// dumpUi retries once, which is enough in practice; if it reports nothing, run
// it again rather than concluding the screen has no buttons.
const dump = await dumpUi(runner, endpoint, {
  path: "/sdcard/neuracall_inspect.xml",
  attempts: 4,
});
if (dump === "") {
  console.error("Could not read the screen — most likely lost a race with the running app.");
  process.exit(1);
}

const foreground = await runner
  .runForDevice(endpoint, ["shell", "dumpsys", "window"])
  .then((w) => w.match(/mCurrentFocus=[^\n]*/)?.[0] ?? "(unknown)")
  .catch(() => "(unknown)");

console.log(`device     : ${endpoint}`);
console.log(`foreground : ${foreground.trim()}`);
console.log(`dump bytes : ${dump.length}`);

const nodes = parseClickableNodes(dump);
console.log(`\nclickable controls (${nodes.length}):`);
for (const node of nodes) {
  const label = node.contentDesc || node.text || node.resourceId || "(unlabelled)";
  const at = nodeCentre(node);
  // Report both readings: a control can look like an answer by one label and a
  // decline by another, and that disagreement is exactly what must not be
  // resolved in favour of tapping.
  const marks = [
    isAnswerLabel(label) ? "ANSWER?" : "",
    isDeclineLabel(label) ? "DECLINE?" : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(`  ${at.x},${at.y}  ${JSON.stringify(label)}  ${marks}`);
}

const chosen = findAnswerButton(dump);
console.log(`\n${"=".repeat(60)}`);
if (chosen) {
  const at = nodeCentre(chosen);
  const label = chosen.contentDesc || chosen.text || chosen.resourceId;
  console.log(`WOULD TAP: ${JSON.stringify(label)} at ${at.x},${at.y}`);
  console.log("Check that against the screen before trusting it on a live call.");
} else {
  console.log("WOULD TAP: nothing — no control on this screen reads as accept.");
  const labels = clickableLabels(dump);
  console.log(`Labels seen: ${labels.slice(0, 15).join(" | ") || "(none)"}`);
}
