/**
 * Live end-to-end check of the AssemblyAI Voice Agent path, using the product's
 * own code rather than a bespoke client.
 *
 * There is usually no text-to-speech on the machine running this, so the
 * "caller" is synthesised by a throwaway Voice Agent whose *greeting* is the
 * sentence we want spoken. That audio is then streamed into a second agent
 * exactly as a real caller's would be, paced in real time. Nothing is faked:
 * the socket, the transcription, the model and the voice are all real, which is
 * the point — every bug this path has shipped was environmental.
 *
 * It touches no phone and places no call. Both temporary agents are deleted on
 * the way out, including after a failure.
 *
 *   node scripts/live-voice-agent.mjs [--voice=alba] [--keep-audio]
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, getConfig } from "@neuracall/config";
import {
  VOICE_AGENT_SAMPLE_RATE,
  VoiceAgentAdminClient,
  VoiceAgentSession,
  VOICES,
} from "@neuracall/aai-client";
import { Pcm16Resampler } from "@neuracall/audio-pipeline";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const voice = arg("voice", "alba");
const keepAudio = process.argv.includes("--keep-audio");

const QUESTION = "Hello, I would like to book an appointment for tomorrow morning. Are you free at ten?";
const CHUNK_MS = 20;
const CHUNK_BYTES = (VOICE_AGENT_SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

loadEnv();
const config = getConfig();
if (!config.assemblyai.apiKey) {
  console.error("ASSEMBLYAI_API_KEY is not set.");
  process.exit(2);
}
if (!VOICES.some((v) => v.id === voice)) {
  console.error(`Unknown voice "${voice}". Available: ${VOICES.map((v) => v.id).join(", ")}`);
  process.exit(2);
}

const admin = new VoiceAgentAdminClient(config);
const created = [];

async function makeAgent(definition) {
  const agent = await admin.createAgent(definition);
  created.push(agent.id);
  return agent.id;
}

function session(agentId) {
  return new VoiceAgentSession({
    apiKey: config.assemblyai.apiKey,
    agentId,
    url: config.voiceAgent.wsUrl,
  });
}

/** Have a throwaway agent speak `text`, and collect the PCM it produces. */
async function synthesize(text) {
  const id = await makeAgent({
    name: `neuracall-selftest-speaker-${Date.now()}`,
    systemPrompt: "Say only what you are told.",
    greeting: text,
    voice: "michael",
  });
  const s = session(id);
  const chunks = [];
  let done = false;
  s.on("replyAudio", (pcm) => chunks.push(Buffer.from(pcm)));
  s.on("replyDone", () => {
    done = true;
  });
  s.on("error", () => {});
  await s.connect();
  for (let i = 0; i < 300 && !done; i += 1) await sleep(100);
  await s.close({ end: true }).catch(() => s.destroy());
  return Buffer.concat(chunks);
}

try {
  console.log("\n== the product's own client against the real service ==");

  console.log("\n1. synthesising the caller's voice");
  const callerPcm = await synthesize(QUESTION);
  check(
    "a throwaway agent produced speech",
    callerPcm.length > 0,
    `${(callerPcm.length / 2 / VOICE_AGENT_SAMPLE_RATE).toFixed(1)}s at ${VOICE_AGENT_SAMPLE_RATE} Hz`,
  );
  if (callerPcm.length === 0) throw new Error("no caller audio; the rest cannot run");

  console.log("\n2. placing that audio into a NeuraCall agent");
  const agentId = await makeAgent({
    name: `neuracall-selftest-${Date.now()}`,
    systemPrompt:
      "You are NeuraCall, an AI receptionist answering a phone call. Reply in ONE short sentence.",
    greeting: "Hello, NeuraCall answering. How can I help?",
    voice,
  });
  check("a stored agent was created", Boolean(agentId), agentId);

  const s = session(agentId);
  const heard = [];
  const said = [];
  const replyPcm = [];
  let greetingDone = false;
  let sawSpeechStart = false;
  let endOfSpeechAt = 0;
  let firstReplyAt = 0;

  s.on("userTranscript", (e) => {
    if (e.final) heard.push(e.text);
  });
  s.on("agentTranscript", (e) => {
    if (e.final) said.push(e.text);
  });
  s.on("speechStarted", () => {
    sawSpeechStart = true;
  });
  // `speechStopped` is emitted when the service *decides* the turn is over,
  // which is already after it has waited out its end-of-turn silence window.
  // So what this measures is generation: model plus synthesis, observed at
  // around 10 ms. It is not what a caller perceives — add the silence window
  // (roughly 1.5 s on the defaults) for that. Two different numbers, both real;
  // conflating them is how a pipeline gets called fast when it feels slow.
  s.on("speechStopped", () => {
    if (!endOfSpeechAt) endOfSpeechAt = Date.now();
  });
  s.on("replyAudio", (pcm) => {
    if (endOfSpeechAt && !firstReplyAt) firstReplyAt = Date.now();
    replyPcm.push(Buffer.from(pcm));
  });
  s.on("replyDone", () => {
    greetingDone = true;
  });
  s.on("error", (err) => console.log(`  (session error: ${err.message})`));

  const ready = await s.connect();
  check("the session reached session.ready", Boolean(ready), `session ${s.sessionId ?? "?"}`);

  // Let the greeting finish so we are not talking over it.
  for (let i = 0; i < 150 && !greetingDone; i += 1) await sleep(100);
  check("the agent spoke its greeting unprompted", said.length > 0, said[0] ?? "");
  const greetingBytes = replyPcm.reduce((n, b) => n + b.length, 0);
  replyPcm.length = 0;

  // Stream the caller in at real-time pace, then trailing silence so the turn
  // ends — endpointing is driven by silence, not by the socket going quiet.
  for (let off = 0; off < callerPcm.length; off += CHUNK_BYTES) {
    s.sendAudio(callerPcm.subarray(off, Math.min(off + CHUNK_BYTES, callerPcm.length)));
    await sleep(CHUNK_MS);
  }
  const silence = new Uint8Array(CHUNK_BYTES);
  for (let i = 0; i < 150; i += 1) {
    s.sendAudio(silence);
    await sleep(CHUNK_MS);
  }
  for (let i = 0; i < 100 && replyPcm.length === 0; i += 1) await sleep(50);
  await sleep(2500);

  console.log("\n3. results");
  check("the service detected the caller speaking", sawSpeechStart);
  const transcript = heard.join(" ");
  check("the caller was transcribed", transcript.trim() !== "", `"${transcript}"`);
  const answers = said.slice(1);
  check("the agent generated a reply", answers.length > 0, `"${answers.join(" ")}"`);
  const answerBytes = replyPcm.reduce((n, b) => n + b.length, 0);
  check(
    "the agent's reply came back as speech",
    answerBytes > 0,
    `${(answerBytes / 2 / VOICE_AGENT_SAMPLE_RATE).toFixed(1)}s`,
  );
  if (firstReplyAt && endOfSpeechAt) {
    const latency = firstReplyAt - endOfSpeechAt;
    check(
      "the agent starts speaking as soon as the turn ends",
      latency < 3000,
      `${latency} ms to generate and synthesise, plus the end-of-turn silence window`,
    );
  } else {
    check("reply latency was measurable", false, "no speechStopped or no reply audio");
  }

  // The rate NeuraCall actually runs calls at is 16 kHz, so prove the
  // conversion the bridge does on every chunk is sane rather than assuming it.
  const down = new Pcm16Resampler(VOICE_AGENT_SAMPLE_RATE, 16000);
  const converted = down.process(Buffer.concat(replyPcm));
  const expected = Math.round((answerBytes / 2) * (16000 / VOICE_AGENT_SAMPLE_RATE));
  check(
    "24 kHz agent speech converts to the 16 kHz call rate",
    Math.abs(converted.length / 2 - expected) <= 2,
    `${converted.length / 2} samples, expected ~${expected}`,
  );

  if (keepAudio && answerBytes > 0) {
    const path = join(tmpdir(), "neuracall-agent-reply.pcm");
    writeFileSync(path, Buffer.concat(replyPcm));
    console.log(`\n  wrote raw 24 kHz mono PCM16 to ${path}`);
    console.log(`  play it with: ffplay -f s16le -ar 24000 -ac 1 ${path}`);
  }
  console.log(`  (greeting was ${(greetingBytes / 2 / VOICE_AGENT_SAMPLE_RATE).toFixed(1)}s of speech)`);

  await s.close({ end: true }).catch(() => s.destroy());
} catch (err) {
  fail += 1;
  console.log(`\n  FAIL unexpected error — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  // Every agent created here is billable server-side state; leaving them behind
  // would accumulate one per run.
  for (const id of created) {
    await admin.deleteAgent(id).catch((err) => {
      console.log(`  (could not delete agent ${id}: ${err.message})`);
    });
  }
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed  ·  cleaned up ${created.length} temporary agents`);
  process.exitCode = fail > 0 ? 1 : 0;
}
