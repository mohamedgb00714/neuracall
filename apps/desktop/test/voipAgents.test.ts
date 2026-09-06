import { test } from "node:test";
import assert from "node:assert/strict";
import type { VoiceAgentInlineConfig } from "@neuracall/aai-client";
import type { VoiceAgentClientConfig } from "@neuracall/orchestrator";
import {
  deviceAgentClientConfig,
  storedAgentDefinition,
  voiceAgentFor,
} from "../electron/service/voipAgents.js";
import { defaultSettings, type DeviceAgentConfig } from "../electron/service/settings.js";

/**
 * The per-device voice agent feature, tested at the seam that matters: the
 * Settings form is in one shape, the stored-agent API wants another, and the
 * inline session wants a third. Every assertion here is about what is present
 * and what is deliberately absent — the service rejects an empty payload field
 * it needs and a turn_detection block full of nulls is noise on the wire, so
 * "only send what was set" is the behaviour these tests pin down.
 */

const AGENT_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function deviceConfig(overrides: Partial<DeviceAgentConfig> = {}): DeviceAgentConfig {
  return {
    agentId: "",
    name: "Front desk",
    voice: "alba",
    greeting: "",
    systemPrompt: "You are helpful.",
    keyterms: [],
    transcriptionMode: null,
    voiceFocus: null,
    voiceFocusThreshold: null,
    turnDetection: {
      vadThreshold: null,
      minSilenceMs: null,
      maxSilenceMs: null,
      interruptResponse: true,
      interruptionDelayMs: null,
    },
    volume: null,
    ...overrides,
  };
}

function asSession(config: VoiceAgentClientConfig): VoiceAgentInlineConfig {
  if (!("session" in config)) throw new Error("expected an inline session, got a stored agent id");
  return config.session;
}

// ------------------------------------------------------- storedAgentDefinition

test("a blank device name falls back to the device label, and the prompt is always sent", () => {
  const def = storedAgentDefinition(deviceConfig({ name: "   " }), "DEV-1234");
  assert.equal(def.name, "DEV-1234");
  assert.equal(def.systemPrompt, "You are helpful.");
  assert.equal(def.voice, "alba");
});

test("an operator-given name wins over the device label", () => {
  assert.equal(storedAgentDefinition(deviceConfig(), "DEV-1234").name, "Front desk");
});

test("every optional is absent when nothing is set", () => {
  const def = storedAgentDefinition(deviceConfig(), "DEV-1234");
  assert.deepEqual(def, {
    name: "Front desk",
    systemPrompt: "You are helpful.",
    voice: "alba",
  });
  assert.ok(!("greeting" in def), "an empty greeting must not be sent");
  assert.ok(!("input" in def), "an empty input block is noise the API must not receive");
  assert.ok(!("output" in def), "no volume means no output block");
});

test("a greeting is carried only when non-empty", () => {
  const def = storedAgentDefinition(deviceConfig({ greeting: "NeuraCall, bonjour." }), "D");
  assert.equal(def.greeting, "NeuraCall, bonjour.");
  assert.ok(!("greeting" in storedAgentDefinition(deviceConfig(), "D")));
});

test("the input knobs the operator set are mapped whole", () => {
  const def = storedAgentDefinition(
    deviceConfig({
      keyterms: ["NeuraCall", "warranty"],
      transcriptionMode: "max_accuracy",
      voiceFocus: "far-field",
      voiceFocusThreshold: 0.75,
    }),
    "D",
  );
  assert.deepEqual(def.input, {
    keyterms: ["NeuraCall", "warranty"],
    transcriptionMode: "max_accuracy",
    voiceFocus: "far-field",
    voiceFocusThreshold: 0.75,
  });
});

test("keyterms are copied, not aliased into the definition", () => {
  const config = deviceConfig({ keyterms: ["warranty"] });
  const def = storedAgentDefinition(config, "D");
  assert.notEqual(def.input?.keyterms, config.keyterms);
});

test("turn-detection knobs map to the stored-agent camel case", () => {
  const def = storedAgentDefinition(
    deviceConfig({
      turnDetection: {
        vadThreshold: 0.5,
        minSilenceMs: 350,
        maxSilenceMs: 1200,
        interruptResponse: true,
        interruptionDelayMs: 250,
      },
    }),
    "D",
  );
  assert.deepEqual(def.input?.turnDetection, {
    vadThreshold: 0.5,
    minSilence: 350,
    maxSilence: 1200,
    interruptResponse: true,
    interruptionDelayMs: 250,
  });
});

test("a fully-default turn detection sends no turnDetection block", () => {
  const def = storedAgentDefinition(deviceConfig(), "D");
  assert.ok(!("input" in def), "nothing set means no input block at all");
  const armed = storedAgentDefinition(deviceConfig({ keyterms: ["warranty"] }), "D");
  assert.ok(!("turnDetection" in armed.input!), "defaults stay off the wire next to real settings");
});

test("disabling barge-in alone is still worth sending", () => {
  const def = storedAgentDefinition(
    deviceConfig({
      turnDetection: {
        vadThreshold: null,
        minSilenceMs: null,
        maxSilenceMs: null,
        interruptResponse: false,
        interruptionDelayMs: null,
      },
    }),
    "D",
  );
  assert.deepEqual(def.input?.turnDetection, { interruptResponse: false });
});

test("an output block appears only when a volume is set", () => {
  assert.deepEqual(storedAgentDefinition(deviceConfig({ volume: 85 }), "D").output, { volume: 85 });
  assert.ok(!("output" in storedAgentDefinition(deviceConfig(), "D")));
});

// --------------------------------------------------- deviceAgentClientConfig

test("a stored agent id binds the session and builds no inline config", () => {
  const config = deviceAgentClientConfig(deviceConfig({ agentId: AGENT_ID }));
  assert.deepEqual(config, { agentId: AGENT_ID });
  assert.ok(!("session" in config), "a stored agent and inline fields are mutually exclusive");
});

test("the inline session carries voice, prompt and greeting only when non-empty", () => {
  const config = asSession(
    deviceAgentClientConfig(
      deviceConfig({ voice: "vera", greeting: "Hello.", systemPrompt: "Be brief." }),
    ),
  );
  assert.deepEqual(config, {
    voice: "vera",
    system_prompt: "Be brief.",
    greeting: "Hello.",
  });
});

test("an empty inline session is empty, not full of present-but-empty keys", () => {
  const config = asSession(
    deviceAgentClientConfig(deviceConfig({ voice: "", greeting: "", systemPrompt: "" })),
  );
  assert.deepEqual(config, {});
  assert.ok(!("input" in config));
});

test("nested input maps to snake_case keys", () => {
  const config = asSession(
    deviceAgentClientConfig(
      deviceConfig({
        keyterms: ["NeuraCall"],
        transcriptionMode: "balanced",
        voiceFocus: "near-field",
        voiceFocusThreshold: 0.6,
      }),
    ),
  );
  assert.deepEqual(config.input, {
    keyterms: ["NeuraCall"],
    transcription_mode: "balanced",
    voice_focus: "near-field",
    voice_focus_threshold: 0.6,
  });
});

test("turn detection maps to snake_case keys on the inline session", () => {
  const config = asSession(
    deviceAgentClientConfig(
      deviceConfig({
        turnDetection: {
          vadThreshold: 0.5,
          minSilenceMs: 350,
          maxSilenceMs: 1200,
          interruptResponse: true,
          interruptionDelayMs: 250,
        },
      }),
    ),
  );
  assert.deepEqual(config.input?.turn_detection, {
    vad_threshold: 0.5,
    min_silence: 350,
    max_silence: 1200,
    interrupt_response: true,
    interruption_delay: 250,
  });
});

test("a fully-default turn detection sends no turn_detection key", () => {
  const config = asSession(deviceAgentClientConfig(deviceConfig()));
  assert.ok(!("input" in config), "nothing set means no input block at all");
  const armed = asSession(deviceAgentClientConfig(deviceConfig({ keyterms: ["warranty"] })));
  assert.ok(!("turn_detection" in armed.input!), "defaults stay off the wire next to real settings");
});

test("disabling barge-in alone still sends interrupt_response false", () => {
  const config = asSession(
    deviceAgentClientConfig(
      deviceConfig({
        turnDetection: {
          vadThreshold: null,
          minSilenceMs: null,
          maxSilenceMs: null,
          interruptResponse: false,
          interruptionDelayMs: null,
        },
      }),
    ),
  );
  assert.deepEqual(config.input?.turn_detection, { interrupt_response: false });
});

// -------------------------------------------------------------- voiceAgentFor

test("a device resolves to its own agent, and an unconfigured one resolves to nothing", () => {
  const settings = defaultSettings();
  settings.voipAgents["D1"] = deviceConfig({ agentId: AGENT_ID });
  settings.voipAgents["D2"] = deviceConfig({ greeting: "Bonjour." });
  const resolve = voiceAgentFor(settings);

  assert.deepEqual(resolve({ deviceId: "D1", channelId: "call-1" }), { agentId: AGENT_ID });
  const d2 = resolve({ deviceId: "D2", channelId: "call-1" });
  assert.ok(d2 !== undefined);
  assert.equal(asSession(d2).greeting, "Bonjour.");
  assert.equal(
    resolve({ deviceId: "D3", channelId: "call-1" }),
    undefined,
    "a device with no entry falls back to the global config on the bridge's side",
  );
});

test("the resolver reads the live settings object rather than a snapshot", () => {
  const settings = defaultSettings();
  settings.voipAgents["D1"] = deviceConfig({ voice: "alba" });
  const resolve = voiceAgentFor(settings);

  assert.equal(asSession(resolve({ deviceId: "D1", channelId: "call-1" })!).voice, "alba");

  settings.voipAgents["D1"]!.voice = "vera";
  assert.equal(
    asSession(resolve({ deviceId: "D1", channelId: "call-1" })!).voice,
    "vera",
    "a save made while the app runs must be picked up on the next call",
  );
});