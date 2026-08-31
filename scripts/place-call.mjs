/**
 * Place an outbound call with NeuraCall and watch its own detector see it.
 *
 * OUTWARD-FACING: this makes a real phone ring. It exists to exercise the
 * product's dialling and detection on real hardware, so it hangs up on its own
 * after `--seconds` rather than leaving a call open.
 *
 *   node scripts/place-call.mjs --to=+213541685472 [--channel=whatsapp]
 *                               [--seconds=15] [--device=SERIAL] [--dry-run]
 */

import {
  AdbCallChannelDetector,
  AndroidCallController,
  DeviceManager,
  VoipDialer,
  defaultSpawner,
  parseAudioModeState,
  realRunner,
  supportsVoipDial,
} from "@neuracall/device-manager";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const dryRun = process.argv.includes("--dry-run");
const to = arg("to");
const channel = arg("channel", "whatsapp");
const seconds = Number(arg("seconds", "15"));
const wanted = arg("device");

if (!to) {
  console.error("usage: node scripts/place-call.mjs --to=+213541685472 [--channel=whatsapp] [--seconds=15]");
  process.exit(2);
}
if (!supportsVoipDial(channel)) {
  console.error(`Outbound calling is not implemented for "${channel}".`);
  process.exit(2);
}

const runner = realRunner(defaultSpawner);
const devices = new DeviceManager({ runner, pollIntervalMs: 60_000 });
await devices.refresh();
const online = devices.snapshot.filter((d) => d.adbState === "device");
if (online.length === 0) {
  console.error("No adb device online. Run ./scripts/adb-setup.sh");
  process.exit(1);
}
const endpoint = wanted ?? online[0].id;

const dialer = new VoipDialer(runner, {
  defaultCountryCode: "213",
  onStep: (s) => console.log(`  ${s}`),
});

console.log(`device : ${endpoint}`);
console.log(`channel: ${channel}`);
console.log(`link   : ${dialer.chatLink(channel, to)}`);
if (dryRun) {
  console.log("\n--dry-run: nothing was dialled.");
  process.exit(0);
}

console.log(`\nplacing the call (auto hang-up after ${seconds}s)…`);
const result = await dialer.call(endpoint, channel, to);
console.log(`placed: tapped "${result.buttonLabel}" at ${result.tappedAt.x},${result.tappedAt.y}\n`);

// Now the point of the exercise: does the PRODUCT see its own call?
const detector = new AdbCallChannelDetector(runner);
const controller = new AndroidCallController(runner, endpoint);
const deadline = Date.now() + seconds * 1000;
let sawIt = false;

while (Date.now() < deadline) {
  const detected = await detector.detect(endpoint);
  const audio = parseAudioModeState(
    await runner.runForDevice(endpoint, ["shell", "dumpsys", "audio"]).catch(() => ""),
  );
  const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  console.log(
    `  [${String(left).padStart(2)}s] detector=${detected.present ? `${detected.channel}/${detected.stage}` : "no call"}` +
      `  audio=${audio.mode}${audio.owner ? ` (${audio.owner})` : ""}`,
  );
  if (detected.present) sawIt = true;
  await new Promise((r) => setTimeout(r, 3000));
}

console.log("\nhanging up…");
await controller.safeHangUp();
await new Promise((r) => setTimeout(r, 2500));
const after = parseAudioModeState(
  await runner.runForDevice(endpoint, ["shell", "dumpsys", "audio"]).catch(() => ""),
);
console.log(`audio mode after hang-up: ${after.mode}${after.owner ? ` (${after.owner})` : ""}`);
console.log(sawIt ? "\nRESULT: the product detected its own call." : "\nRESULT: the call was never detected.");
process.exitCode = sawIt ? 0 : 1;
