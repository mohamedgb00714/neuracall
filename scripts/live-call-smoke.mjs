/**
 * Live end-to-end smoke test on real hardware.
 *
 *   phone mic (scrcpy) → audio pipeline (48k stereo → 16k mono, VAD)
 *                      → AssemblyAI realtime → live transcript on stdout
 *
 * This is the "does the main functionality actually work" script: it uses the
 * real ScrcpyBridge, the real CallAudioSession/AudioPipeline and the real
 * RealtimeStream against the real service. Nothing is stubbed.
 *
 * Usage:
 *   node scripts/live-call-smoke.mjs [seconds] [--source=mic] [--device=SERIAL]
 *
 * Then talk into the phone (or put a call on speakerphone) and watch the
 * transcript appear.
 *
 * Audio source note: the default `mic` captures the phone's own microphone —
 * i.e. YOUR side of a call, plus whatever the room hears. To transcribe the
 * far end of a real call you either need a privileged source
 * (--source=voice-call-downlink, often denied by the OEM) or the call on
 * speakerphone so the caller's voice reaches the mic. See docs/AUDIO-ABI.md.
 */

import { Writable } from "node:stream";
import { loadEnv, getConfig, describeConfig } from "@neuracall/config";
import { RealtimeStream } from "@neuracall/aai-client";
import { CallAudioSession } from "@neuracall/audio-pipeline";
import { ScrcpyBridge, detectRequiredTools } from "@neuracall/scrcpy-bridge";
import { realRunner, defaultSpawner } from "@neuracall/device-manager";

const args = process.argv.slice(2);
const seconds = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const source = (args.find((a) => a.startsWith("--source=")) ?? "--source=mic").split("=")[1];
const deviceArg = args.find((a) => a.startsWith("--device="))?.split("=")[1];

// --- preflight: the external tools must exist before anything else matters.
const tools = detectRequiredTools();
for (const [name, t] of Object.entries(tools)) {
  console.log(`${t.installed ? "OK  " : "MISS"} ${name}: ${t.version ?? t.installGuide?.split("\n")[0]}`);
  if (!t.installed) process.exit(1);
}

const runner = realRunner(defaultSpawner);
const devicesOut = await runner.run(["devices"]);
const online = devicesOut
  .split("\n")
  .slice(1)
  .map((l) => l.trim().split(/\s+/))
  .filter(([id, state]) => id && state === "device")
  .map(([id]) => id);

if (online.length === 0) {
  console.error("\nNo adb device is online. Plug a phone in or run ./scripts/adb-setup.sh");
  process.exit(1);
}
const endpoint = deviceArg ?? online[0];
console.log(`\ndevice: ${endpoint}   audio-source: ${source}   duration: ${seconds}s`);

loadEnv();
const config = getConfig();
console.log(describeConfig(config));

// --- real realtime session
const stream = new RealtimeStream(config, {
  sampleRate: 16000,
  speechModel: config.assemblyai.speechModel,
  mode: "balanced",
});
const finals = [];
stream.on("begin", (m) => console.log(`\n[Begin] model=${m.configuration?.model ?? "(not echoed)"}`));
stream.on("turn", (t) => {
  if (t.final) {
    finals.push(t.transcript);
    console.log(`[FINAL]   ${t.transcript}`);
  } else if (t.transcript) {
    process.stdout.write(`\r[partial] ${t.transcript.slice(0, 100)}`.padEnd(112) + "\n");
  }
});
stream.on("warn", (m) => console.log(`[warn] ${m}`));
stream.on("error", (e) => console.log(`[error] ${e.message}`));
stream.on("termination", (m) =>
  console.log(`[Termination] audio=${m.audio_duration_seconds}s billed=${m.session_duration_seconds}s`),
);

await stream.connect();

// --- real pipeline: labelled far-end stream feeding the session
let chunksToStt = 0;
const sttSink = new Writable({
  objectMode: true,
  write(chunk, _enc, cb) {
    chunksToStt += 1;
    stream.sendAudio(chunk.pcm);
    cb();
  },
});

const session = new CallAudioSession({
  deviceId: endpoint,
  callId: `smoke-${Date.now()}`,
  channelId: "cellular",
  sink: sttSink,
});

// --- real scrcpy capture
let rawBytes = 0;
const bridge = new ScrcpyBridge({ endpoint, audioSource: source, sink: session.remoteIn });
bridge.on("format", (f) => console.log(`[capture] ${f.sampleRate}Hz ${f.channels}ch ${f.bitsPerSample}bit`));
bridge.on("frame", (f) => {
  rawBytes += f.length;
});
bridge.on("error", (m) => console.log(`[scrcpy] ${m}`));
bridge.on("exit", (r) => console.log(`[scrcpy] exited code=${r.code} signal=${r.signal}`));

console.log("\nstarting capture — TALK INTO THE PHONE now\n");
bridge.start();

await new Promise((r) => setTimeout(r, seconds * 1000));

bridge.stop();
session.close();
await new Promise((r) => setTimeout(r, 1200)); // let the last turn finalize
await stream.close({ terminate: true });

console.log(`\n=== RESULT ===`);
console.log(`raw capture: ${rawBytes} bytes   chunks to STT (post-VAD): ${chunksToStt}`);
console.log(`transcript: ${finals.join(" ") || "(nothing — was anyone speaking?)"}`);
if (rawBytes === 0) console.log("\nNo audio captured. Try a different --source= (see docs/AUDIO-ABI.md).");
process.exit(0);
