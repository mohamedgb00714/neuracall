import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVoiceId } from "@neuracall/aai-client";
import {
  SettingsStore,
  applyPatch,
  buildAppConfig,
  defaultSettings,
  parseSettingsPatch,
  settingsFromEnv,
  toRedacted,
} from "../electron/service/settings.js";

/**
 * The Voice Agent section: the switch that makes a call one speech-to-speech
 * socket instead of transcription plus an LLM plus a voice.
 *
 * Two properties here matter more than field-by-field coverage. A junk
 * VOICE_AGENT_ENABLED has to be a loud error, because the alternative reading
 * — "off" — presents as a feature that was never implemented. And an empty
 * optional has to be *absent* from the AppConfig rather than "": the service
 * rejects an empty agent_id and an empty greeting suppresses the opening line,
 * so a "" that survives the mapping breaks the call it was meant to configure.
 */

/** A well-formed stored-agent id; the API issues nothing but canonical uuids. */
const AGENT_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const AAI_KEY = "aai_5f3a91c0b7e24d8fa0c16b2d4e7f8091";

function withTempDir(body: (dir: string, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-voice-agent-"));
  try {
    body(dir, join(dir, "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- defaults

test("the section defaults to off, inline, and on a voice the service knows", () => {
  const { voiceAgent } = defaultSettings();
  assert.deepEqual(voiceAgent, {
    enabled: false,
    agentId: "",
    voice: "alba",
    greeting: "",
    systemPrompt: "",
  });
  assert.ok(
    isVoiceId(voiceAgent.voice),
    "the default has to be in the catalogue, not just a string",
  );
});

// ------------------------------------------------------------- env  booleans

test("every .env spelling of a boolean is understood, in either case", () => {
  for (const on of ["1", "true", "yes", "on", "TRUE", "On", "  yes  "]) {
    const patch = parseSettingsPatch(settingsFromEnv({ VOICE_AGENT_ENABLED: on }));
    assert.equal(patch.voiceAgent?.enabled, true, `${JSON.stringify(on)} must read as on`);
  }
  for (const off of ["0", "false", "no", "off", "FALSE", "Off"]) {
    const patch = parseSettingsPatch(settingsFromEnv({ VOICE_AGENT_ENABLED: off }));
    assert.equal(patch.voiceAgent?.enabled, false, `${JSON.stringify(off)} must read as off`);
  }

  // The renderer sends a real JSON boolean rather than a spelling of one.
  assert.equal(parseSettingsPatch({ voiceAgent: { enabled: true } }).voiceAgent?.enabled, true);
  assert.equal(parseSettingsPatch({ voiceAgent: { enabled: false } }).voiceAgent?.enabled, false);
});

test('a misspelled VOICE_AGENT_ENABLED is an error, never a silent "off"', () => {
  for (const junk of ["flase", "enabled", "2", "y"]) {
    assert.throws(
      () => parseSettingsPatch(settingsFromEnv({ VOICE_AGENT_ENABLED: junk })),
      (err: unknown) => err instanceof Error && err.message.includes("voiceAgent.enabled"),
      `${junk} must be rejected by name`,
    );
  }
  assert.throws(() => parseSettingsPatch({ voiceAgent: { enabled: 1 } }), /voiceAgent\.enabled/);

  withTempDir((_dir, file) => {
    // Through the store it is a reported problem, not a crash: an unopenable
    // app cannot be used to fix the value that stopped it opening.
    const store = new SettingsStore({ file, env: { VOICE_AGENT_ENABLED: "flase" } });
    store.load();
    assert.equal(store.current.voiceAgent.enabled, false, "the default holds");
    assert.equal(store.problems.length, 1);
    assert.ok(store.problems.join("\n").includes("voiceAgent.enabled"));
  });
});

test("an unset or placeholder Voice Agent environment contributes nothing", () => {
  const raw = settingsFromEnv({
    VOICE_AGENT_ENABLED: "",
    VOICE_AGENT_ID: "replace-me",
    VOICE_AGENT_VOICE: "   ",
  });
  assert.deepEqual(raw, {}, "an unedited .env.example must behave like an empty one");
});

// ----------------------------------------------------------------- the voice

test("only a voice the service will accept gets past the validator", () => {
  assert.equal(parseSettingsPatch({ voiceAgent: { voice: "vera" } }).voiceAgent?.voice, "vera");
  assert.equal(
    parseSettingsPatch(settingsFromEnv({ VOICE_AGENT_VOICE: "VERA" })).voiceAgent?.voice,
    "vera",
    "the environment layer is normalised like every other enum",
  );

  for (const bad of ["amina", "Alba", "alba ", "", null, 42]) {
    assert.throws(
      () => parseSettingsPatch({ voiceAgent: { voice: bad } }),
      (err: unknown) => err instanceof Error && err.message.includes("voiceAgent.voice"),
      `${JSON.stringify(bad)} must be rejected by name`,
    );
  }

  withTempDir((_dir, file) => {
    const store = new SettingsStore({ file, env: { VOICE_AGENT_VOICE: "amina" } });
    store.load();
    assert.equal(store.current.voiceAgent.voice, "alba");
    assert.ok(store.problems.join("\n").includes("voiceAgent.voice"));
  });
});

// -------------------------------------------------------------- the agent id

test('an agentId is a uuid, or "" meaning "configure the agent inline"', () => {
  assert.equal(
    parseSettingsPatch({ voiceAgent: { agentId: AGENT_ID } }).voiceAgent?.agentId,
    AGENT_ID,
  );
  assert.equal(
    parseSettingsPatch({ voiceAgent: { agentId: AGENT_ID.toUpperCase() } }).voiceAgent?.agentId,
    AGENT_ID.toUpperCase(),
    "uuids are case-insensitive",
  );
  assert.equal(parseSettingsPatch({ voiceAgent: { agentId: "" } }).voiceAgent?.agentId, "");
  assert.equal(
    parseSettingsPatch({ voiceAgent: { agentId: "   " } }).voiceAgent?.agentId,
    "",
    "whitespace is no agent id at all",
  );

  const malformed = [
    "agent-1",
    AGENT_ID.slice(0, -1), // one digit short
    `${AGENT_ID}0`, // one too many
    AGENT_ID.replace(/-/g, ""), // unhyphenated
    "3f2504e0-4f89-11d3-9a0c-0305e82c330g", // not hex
    AGENT_ID.replace("-", "_"),
  ];
  for (const bad of malformed) {
    assert.throws(
      () => parseSettingsPatch({ voiceAgent: { agentId: bad } }),
      (err: unknown) => err instanceof Error && err.message.includes("voiceAgent.agentId"),
      `${bad} must be rejected by name, not at session start`,
    );
  }
});

// ------------------------------------------------------------ derived config

test("buildAppConfig carries the section over and drops what is empty", () => {
  const settings = defaultSettings();
  settings.voiceAgent.enabled = true;
  settings.voiceAgent.voice = "vera";
  settings.voiceAgent.agentId = AGENT_ID;

  const { voiceAgent } = buildAppConfig(AAI_KEY, settings);
  assert.equal(voiceAgent.enabled, true);
  assert.equal(voiceAgent.voice, "vera");
  assert.equal(voiceAgent.agentId, AGENT_ID);
  assert.equal(voiceAgent.sampleRate, 24000, "the one rate the API accepts");
  assert.ok(voiceAgent.wsUrl.startsWith("wss://"), "the endpoints still come from the region");

  // Absent, not "": exactOptionalPropertyTypes makes the difference real, and
  // so does the service — an empty greeting silences the opening line.
  assert.ok(!("greeting" in voiceAgent), "an empty greeting must not be sent");
  assert.ok(!("systemPrompt" in voiceAgent), "an empty system prompt must not be sent");
});

test("an inline agent sends no agent_id at all", () => {
  const settings = defaultSettings();
  settings.voiceAgent.greeting = "NeuraCall, bonjour.";
  settings.voiceAgent.systemPrompt = "Answer in French, in one sentence.";

  const { voiceAgent } = buildAppConfig(AAI_KEY, settings);
  assert.ok(!("agentId" in voiceAgent), "an empty agentId would be rejected as an agent_id");
  assert.equal(voiceAgent.greeting, "NeuraCall, bonjour.");
  assert.equal(voiceAgent.systemPrompt, "Answer in French, in one sentence.");
  assert.equal(voiceAgent.enabled, false, "off until the operator turns it on");
  assert.equal(voiceAgent.voice, "alba");
});

test("the Voice Agent hosts follow a region change like every other endpoint", () => {
  const settings = defaultSettings();
  settings.assemblyai.region = "eu";
  const { voiceAgent } = buildAppConfig(AAI_KEY, settings);
  assert.ok(
    voiceAgent.wsUrl.includes("eu") && voiceAgent.restBaseUrl.includes("eu"),
    `data residency must survive the mapping (got ${voiceAgent.wsUrl})`,
  );
});

// ------------------------------------------------------------------ layering

test("the layers stack: defaults, then the environment, then a save", () => {
  withTempDir((_dir, file) => {
    const env: NodeJS.ProcessEnv = {
      VOICE_AGENT_ENABLED: "yes",
      VOICE_AGENT_VOICE: "VERA",
      VOICE_AGENT_GREETING: "NeuraCall, bonjour.",
      VOICE_AGENT_SYSTEM_PROMPT: "Be brief.",
    };

    const store = new SettingsStore({ file, env });
    store.load();
    assert.deepEqual(store.problems, []);
    assert.equal(store.current.voiceAgent.enabled, true, "the environment beats the default");
    assert.equal(store.current.voiceAgent.voice, "vera");
    assert.equal(store.current.voiceAgent.greeting, "NeuraCall, bonjour.");
    assert.equal(
      store.current.voiceAgent.agentId,
      "",
      "what the environment says nothing about stays at the default",
    );

    store.save({ voiceAgent: { agentId: AGENT_ID, greeting: "" } });
    assert.equal(store.current.voiceAgent.agentId, AGENT_ID);
    assert.equal(
      store.current.voiceAgent.greeting,
      "",
      "an empty greeting is a value, not a no-op",
    );
    assert.equal(store.current.voiceAgent.systemPrompt, "Be brief.", "an untouched field survives");
    assert.equal(store.current.voiceAgent.enabled, true);

    // And the file wins on the next launch, over the same .env that is still
    // shouting "NeuraCall, bonjour." at it.
    const reopened = new SettingsStore({ file, env });
    reopened.load();
    assert.deepEqual(reopened.current.voiceAgent, store.current.voiceAgent);

    // A stored agent ignores the inline fields, so the config carries the id
    // and the greeting the operator cleared is gone from it.
    const { voiceAgent } = buildAppConfig(AAI_KEY, reopened.current);
    assert.equal(voiceAgent.agentId, AGENT_ID);
    assert.ok(!("greeting" in voiceAgent));
    assert.equal(voiceAgent.systemPrompt, "Be brief.");
  });
});

test("reset returns the section to the environment layer", () => {
  withTempDir((_dir, file) => {
    const env: NodeJS.ProcessEnv = { VOICE_AGENT_ENABLED: "1" };
    const store = new SettingsStore({ file, env });
    store.load();
    store.save({ voiceAgent: { enabled: false, agentId: AGENT_ID } });
    assert.equal(store.current.voiceAgent.enabled, false);

    store.reset();
    assert.equal(store.current.voiceAgent.enabled, true, "back to what .env asked for");
    assert.equal(store.current.voiceAgent.agentId, "");
  });
});

// ----------------------------------------------------------------- redaction

test("the section reaches the renderer whole: there is no secret in it", () => {
  const settings = defaultSettings();
  settings.voiceAgent = {
    enabled: true,
    agentId: AGENT_ID,
    voice: "vera",
    greeting: "NeuraCall, bonjour.",
    systemPrompt: "Be brief.",
  };

  const redacted = toRedacted(settings);
  assert.deepEqual(redacted.voiceAgent, settings.voiceAgent);

  redacted.voiceAgent.agentId = "mutated";
  assert.equal(settings.voiceAgent.agentId, AGENT_ID, "and it is a copy, not the stored object");
});

test("autopilot answers from startup by default, and the env can turn it off", () => {
  // The default is deliberately on, and deliberately load-bearing: it is the
  // difference between an app that watches and an app that picks up the phone.
  assert.equal(defaultSettings().autopilot.autoStart, true);

  const off = settingsFromEnv({ NEURACALL_AUTOPILOT_AUTOSTART: "0" } as NodeJS.ProcessEnv);
  assert.equal(
    (parseSettingsPatch(off).autopilot ?? {}).autoStart,
    false,
    "an operator must be able to run a console that does not answer",
  );

  const on = settingsFromEnv({ NEURACALL_AUTOPILOT_AUTOSTART: "yes" } as NodeJS.ProcessEnv);
  assert.equal((parseSettingsPatch(on).autopilot ?? {}).autoStart, true);

  // A typo must be loud rather than silently leaving the phone unanswered.
  assert.throws(
    () =>
      parseSettingsPatch(
        settingsFromEnv({ NEURACALL_AUTOPILOT_AUTOSTART: "ye" } as NodeJS.ProcessEnv),
      ),
    /autopilot\.autoStart must be true or false/,
  );
});

// ---------------------------------------------------------------- per-device agents

function deviceAgentPatch() {
  return parseSettingsPatch({
    voipAgents: {
      "DEV-SERIAL-1": {
        agentId: "",
        name: "Front desk EN",
        voice: "charles",
        greeting: "Hello, how can I help?",
        systemPrompt: "You are the front desk.",
        keyterms: ["NeuraCall", "warranty"],
        transcriptionMode: "max_accuracy",
        voiceFocus: "far-field",
        voiceFocusThreshold: 0.75,
        turnDetection: {
          vadThreshold: 0.5,
          minSilenceMs: 350,
          maxSilenceMs: 1200,
          interruptResponse: true,
          interruptionDelayMs: 250,
        },
        volume: 85,
      },
    },
  });
}

test("a device agent upsert is validated and stored whole", () => {
  const patch = deviceAgentPatch();
  const next = applyPatch(defaultSettings(), patch);
  const saved = next.voipAgents["DEV-SERIAL-1"];
  assert.ok(saved, "the device's agent is stored under the serial");
  assert.equal(saved.name, "Front desk EN");
  assert.equal(saved.voice, "charles");
  assert.equal(saved.transcriptionMode, "max_accuracy");
  assert.equal(saved.voiceFocus, "far-field");
  assert.equal(saved.voiceFocusThreshold, 0.75);
  assert.deepEqual(saved.turnDetection, {
    vadThreshold: 0.5,
    minSilenceMs: 350,
    maxSilenceMs: 1200,
    interruptResponse: true,
    interruptionDelayMs: 250,
  });
  assert.equal(saved.volume, 85);
});

test("a null entry deletes a device's agent and leaves the rest", () => {
  const withAgent = applyPatch(defaultSettings(), deviceAgentPatch());
  const next = applyPatch(withAgent, parseSettingsPatch({ voipAgents: { "DEV-SERIAL-1": null } }));
  assert.equal("DEV-SERIAL-1" in next.voipAgents, false);
});

test("a partial device agent update keeps the untouched turn-detection knobs", () => {
  const withAgent = applyPatch(defaultSettings(), deviceAgentPatch());
  const next = applyPatch(withAgent, {
    voipAgents: { "DEV-SERIAL-1": { ...withAgent.voipAgents["DEV-SERIAL-1"]!, turnDetection: { interruptResponse: false } } },
  } as never);
  const merged = next.voipAgents["DEV-SERIAL-1"]!;
  assert.equal(merged.turnDetection.interruptResponse, false);
  assert.equal(merged.turnDetection.vadThreshold, 0.5, "untouched knob survives the merge");
  assert.equal(merged.volume, 85, "untouched scalar survives the merge");
});

test("a device agent voice must be in the catalogue, and a serial must be non-empty", () => {
  assert.throws(
    () => parseSettingsPatch({ voipAgents: { "D": { voice: "nope" } } }),
    /one of/,
  );
  assert.throws(() => parseSettingsPatch({ voipAgents: { "": { voice: "alba" } } }), /serial/);
});

test("toRedacted hands the renderer its own copy of the device-agent map", () => {
  const configured = defaultSettings();
  configured.voipAgents["D1"] = {
    agentId: "",
    name: "n",
    voice: "alba",
    greeting: "",
    systemPrompt: "",
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
  };
  const redacted = toRedacted(configured);
  redacted.voipAgents["D1"]!.name = "mutated";
  assert.equal(configured.voipAgents["D1"]!.name, "n", "renderer mutation stays in the renderer");
});
