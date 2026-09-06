import { realRunner, defaultSpawner, AndroidCallController, AdbCallChannelDetector } from "@neuracall/device-manager";
const DEVICE = process.argv[2] ?? "2B26295410JA0CN2";
const runner = realRunner(defaultSpawner);
const ctrl = new AndroidCallController(runner, DEVICE);
const det = new AdbCallChannelDetector(runner);
console.log(`polling detection on ${DEVICE} (15s)...`);
for (let i = 0; i < 15; i++) {
  try {
    const [state, verdict, audio] = await Promise.all([
      ctrl.callState(),
      det.detect(DEVICE),
      runner.runForDevice(DEVICE, ["shell", "dumpsys", "audio"]),
    ]);
    const mode = (audio.match(/- Mode owner: (.*)/) || [])[1] ?? "?";
    const owner = (audio.match(/mModeOwnerPid: (\d+)/) || [])[1] ?? "?";
    const fgM = audio.match(/- mode \(external\) = (\w+)/) || [];
    const modeExt = fgM[1] ?? "?";
    console.log(`t+${i}s  callState=${state}  present=${verdict.present}  channel=${verdict.channel ?? "-"}  stage=${verdict.stage ?? "-"}  owner="${mode}" pid=${owner} extMode=${modeExt}`);
  } catch (err) {
    console.log(`t+${i}s  ERROR ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
process.exit(0);
