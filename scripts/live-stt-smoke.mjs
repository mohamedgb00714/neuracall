// Live smoke test: stream a real speech fixture to the REAL AssemblyAI v3
// endpoint using our own hand-rolled RealtimeStream. Proves auth, URL/params,
// the protocol handshake and Terminate against the actual service.
import { readFileSync } from "node:fs";
import { loadEnv, getConfig, describeConfig } from "@neuracall/config";
import { RealtimeStream } from "@neuracall/aai-client";
import { parseWavHeader } from "@neuracall/audio-pipeline";

loadEnv();
const config = getConfig();
console.log(describeConfig(config));

const wav = readFileSync(process.argv[2]);
const h = parseWavHeader(wav);
console.log(`\nfixture: ${h.sampleRate}Hz ${h.channels}ch ${h.bitsPerSample}bit, ${(h.frames / h.sampleRate).toFixed(2)}s\n`);
if (h.sampleRate !== 16000 || h.channels !== 1) throw new Error("fixture must be 16k mono");

const pcm = wav.subarray(h.dataOffset, h.dataOffset + h.dataBytes);
const stream = new RealtimeStream(config, {
  sampleRate: 16000,
  speechModel: config.assemblyai.speechModel,
  mode: "balanced",
});

const finals = [];
stream.on("begin", (m) => console.log(`[Begin] id=${m.id} model=${m.configuration?.model ?? "(not echoed)"}`));
stream.on("speechStarted", (e) => console.log(`[SpeechStarted] t=${e.timestamp}ms`));
stream.on("turn", (t) => {
  if (t.final) { finals.push(t.transcript); console.log(`[FINAL]   ${t.transcript}`); }
  else console.log(`[partial] ${t.transcript}`);
});
stream.on("warn", (m) => console.log(`[warn] ${m}`));
stream.on("error", (e) => console.log(`[error] ${e.message}`));
stream.on("termination", (m) =>
  console.log(`[Termination] audio=${m.audio_duration_seconds}s billed_session=${m.session_duration_seconds}s`));
stream.on("close", (c) => console.log(`[close] code=${c.code}`));

console.log("connecting to", config.assemblyai.realtimeHost, "...");
await stream.connect();
console.log("connected. streaming at real-time pace...\n");

// 100 ms chunks at 16 kHz mono PCM16 = 3200 bytes, paced in real time (the
// server closes with 3007 if audio arrives faster than real time).
const CHUNK = 3200;
for (let off = 0; off < pcm.length; off += CHUNK) {
  stream.sendAudio(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 1500)); // let the last turn finalize
await stream.close({ terminate: true });
console.log(`\n=== RESULT: ${finals.length} final turn(s) ===`);
console.log(finals.join(" ") || "(no transcript)");
