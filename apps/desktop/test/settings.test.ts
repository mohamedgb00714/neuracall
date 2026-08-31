import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LLM_BASE_URL,
  SettingsStore,
  applyPatch,
  defaultSettings,
  parseSettingsPatch,
  settingsFromEnv,
  toRedacted,
  type NeuraCallSettings,
} from "../electron/service/settings.js";

/**
 * Long enough to look like the real thing, and distinct per provider so a leak
 * test can say which key escaped.
 */
const LLM_KEY = "sk-or-v1-9f3c7a1e08b24d6ea5c0f1b73d29e845";
const TTS_KEY = "sk-openai-4b1d90c7e6a3418fbb27d05f8c6a91e2";

/** Settings with both secrets populated and nothing else unusual. */
function configured(): NeuraCallSettings {
  const settings = defaultSettings();
  settings.llm.apiKey = LLM_KEY;
  settings.llm.model = "anthropic/claude-sonnet-4";
  settings.tts.apiKey = TTS_KEY;
  settings.tts.model = "gpt-4o-mini-tts";
  return settings;
}

/** Run `body` against a fresh settings.json path, then delete the directory. */
function withTempDir(body: (dir: string, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-settings-"));
  try {
    body(dir, join(dir, "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ redaction

test("toRedacted carries no key anywhere in what it returns", () => {
  const redacted = toRedacted(configured());

  assert.equal(redacted.llm.apiKey, "");
  assert.equal(redacted.llm.hasApiKey, true);
  assert.equal(redacted.tts.apiKey, "");
  assert.equal(redacted.tts.hasApiKey, true);

  // The property that actually matters: not "the apiKey field is blank" but
  // "no serialisation of this object contains the secret", whatever fields a
  // later refactor adds.
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes(LLM_KEY), "the LLM key must not survive redaction");
  assert.ok(!json.includes(TTS_KEY), "the TTS key must not survive redaction");
});

test("toRedacted reports an absent key as absent, and keeps the rest intact", () => {
  const settings = defaultSettings();
  settings.assemblyai.keyterms = ["NeuraCall", "SKU-1"];
  settings.autopilot.healthPort = 9464;

  const redacted = toRedacted(settings);
  assert.equal(redacted.llm.hasApiKey, false);
  assert.equal(redacted.tts.hasApiKey, false);
  assert.equal(redacted.llm.baseUrl, DEFAULT_LLM_BASE_URL);
  assert.deepEqual(redacted.assemblyai.keyterms, ["NeuraCall", "SKU-1"]);
  assert.equal(redacted.autopilot.healthPort, 9464);

  redacted.assemblyai.keyterms.push("mutated");
  assert.deepEqual(settings.assemblyai.keyterms, ["NeuraCall", "SKU-1"], "the copy must be deep");
});

test("a whitespace-only key still counts as no key once parsed", () => {
  const patch = parseSettingsPatch({ llm: { apiKey: "   " } });
  const next = applyPatch(defaultSettings(), patch);
  assert.equal(next.llm.apiKey, "");
  assert.equal(toRedacted(next).llm.hasApiKey, false);
});

// ------------------------------------------------------------ patch asymmetry

test('saving the redacted view back keeps the stored keys ("" means unchanged)', () => {
  const stored = configured();
  // Exactly what the renderer holds and posts back: the redacted view, through
  // JSON, with every apiKey reading "". If "" meant "set to empty", saving an
  // untouched settings form would silently wipe both keys.
  const fromRenderer: unknown = JSON.parse(JSON.stringify(toRedacted(stored)));

  const next = applyPatch(stored, parseSettingsPatch(fromRenderer));
  assert.equal(next.llm.apiKey, LLM_KEY);
  assert.equal(next.tts.apiKey, TTS_KEY);
  assert.equal(next.llm.model, "anthropic/claude-sonnet-4", "the rest still round-trips");
});

test("a non-empty apiKey replaces the stored one", () => {
  const next = applyPatch(configured(), parseSettingsPatch({ llm: { apiKey: "sk-or-v1-replacement" } }));
  assert.equal(next.llm.apiKey, "sk-or-v1-replacement");
  assert.equal(next.tts.apiKey, TTS_KEY, "an untouched section keeps its key");
});

test("an explicit null clears the stored key", () => {
  const next = applyPatch(configured(), parseSettingsPatch({ llm: { apiKey: null }, tts: { apiKey: null } }));
  assert.equal(next.llm.apiKey, "");
  assert.equal(next.tts.apiKey, "");
  assert.equal(toRedacted(next).llm.hasApiKey, false);
});

test("a cleared key does not come back from the environment layer", () => {
  withTempDir((_dir, file) => {
    const env: NodeJS.ProcessEnv = { LLM_API_KEY: LLM_KEY, LLM_MODEL: "anthropic/claude-sonnet-4" };

    const first = new SettingsStore({ file, env });
    first.load();
    assert.equal(first.current.llm.apiKey, LLM_KEY, "the environment seeds the key");
    first.save({ llm: { apiKey: null } });
    assert.equal(first.current.llm.apiKey, "");

    // The next launch reads the same .env. The saved file says "no key", and a
    // trusted layer means what it says — otherwise clearing a key in the UI
    // would appear to work and then undo itself at restart.
    const reopened = new SettingsStore({ file, env });
    reopened.load();
    assert.equal(reopened.current.llm.apiKey, "");
    assert.equal(reopened.redacted().llm.hasApiKey, false);
    assert.equal(reopened.current.llm.model, "anthropic/claude-sonnet-4");
  });
});

test("applyPatch does not mutate the settings it was given", () => {
  const stored = configured();
  applyPatch(stored, parseSettingsPatch({ llm: { apiKey: null }, assemblyai: { keyterms: ["x"] } }));
  assert.equal(stored.llm.apiKey, LLM_KEY);
  assert.deepEqual(stored.assemblyai.keyterms, []);
});

// ----------------------------------------------------------------- validation

test("every rejected value names the field it came from", () => {
  const rejected: ReadonlyArray<readonly [string, unknown, string]> = [
    ["unknown region", { assemblyai: { region: "apac" } }, "assemblyai.region"],
    ["unknown mode", { assemblyai: { mode: "turbo" } }, "assemblyai.mode"],
    ["empty speech model", { assemblyai: { speechModel: "  " } }, "assemblyai.speechModel"],
    ["unknown TTS provider", { tts: { provider: "polly" } }, "tts.provider"],
    ["unknown audio source", { audio: { captureSource: "line-in" } }, "audio.captureSource"],
    ["non-http base URL", { llm: { baseUrl: "ftp://models.example" } }, "llm.baseUrl"],
    ["file:// base URL", { tts: { baseUrl: "file:///etc/passwd" } }, "tts.baseUrl"],
    ["unparseable base URL", { llm: { baseUrl: "openrouter.ai/api/v1" } }, "llm.baseUrl"],
    ["port zero", { autopilot: { healthPort: 0 } }, "autopilot.healthPort"],
    ["port above the range", { autopilot: { healthPort: 65536 } }, "autopilot.healthPort"],
    ["fractional port", { autopilot: { healthPort: 8080.5 } }, "autopilot.healthPort"],
    ["timeout below the floor", { autopilot: { maxCallMs: 999 } }, "autopilot.maxCallMs"],
    ["timeout above the ceiling", { autopilot: { maxCallMs: 6 * 3600_000 + 1 } }, "autopilot.maxCallMs"],
    ["stall above the ceiling", { autopilot: { stallMs: 3600_001 } }, "autopilot.stallMs"],
    ["nonsense country code", { autopilot: { defaultCountryCode: "morocco" } }, "autopilot.defaultCountryCode"],
    [
      "too many keyterms",
      { assemblyai: { keyterms: Array.from({ length: 101 }, (_, i) => `term-${i}`) } },
      "assemblyai.keyterms",
    ],
    ["an over-long keyterm", { assemblyai: { keyterms: ["x".repeat(51)] } }, "assemblyai.keyterms"],
    ["a non-string keyterm", { assemblyai: { keyterms: [42] } }, "assemblyai.keyterms"],
    ["keyterms that are not a list", { assemblyai: { keyterms: "a,b" } }, "assemblyai.keyterms"],
    ["a numeric secret", { llm: { apiKey: 12345 } }, "llm.apiKey"],
    ["a section that is not an object", { llm: [] }, "llm"],
    ["a payload that is not an object", "settings", "settings"],
  ];

  for (const [name, raw, field] of rejected) {
    assert.throws(
      () => parseSettingsPatch(raw),
      (err: unknown) => err instanceof Error && err.message.includes(field),
      `${name} must be rejected with a message naming ${field}`,
    );
  }
});

test("values at the edge of each range are accepted", () => {
  const patch = parseSettingsPatch({
    assemblyai: { keyterms: Array.from({ length: 100 }, (_, i) => `term-${i}`) },
    autopilot: { healthPort: 65535, maxCallMs: 1000, stallMs: 1000, defaultCountryCode: "+212" },
    llm: { baseUrl: "" },
  });
  assert.equal(patch.assemblyai?.keyterms?.length, 100);
  assert.equal(patch.autopilot?.healthPort, 65535);
  assert.equal(patch.autopilot?.defaultCountryCode, "212", "the + is normalised away");
  assert.equal(patch.llm?.baseUrl, "", '"" means "use the provider default"');

  assert.equal(parseSettingsPatch({ autopilot: { healthPort: null } }).autopilot?.healthPort, null);
  assert.equal(parseSettingsPatch({ autopilot: { healthPort: "" } }).autopilot?.healthPort, null);
  assert.equal(parseSettingsPatch({ autopilot: { healthPort: "9464" } }).autopilot?.healthPort, 9464);
});

test("a rejected save leaves nothing behind on disk or in memory", () => {
  withTempDir((dir, file) => {
    const store = new SettingsStore({ file, env: {} });
    store.load();

    // Nothing saved yet: a rejected save must not even create the file.
    assert.throws(() => store.save({ assemblyai: { region: "apac" } }), /assemblyai\.region/);
    assert.equal(existsSync(file), false, "a rejected save must not create settings.json");

    store.save({ llm: { model: "anthropic/claude-sonnet-4" } });

    // A patch is all-or-nothing: the valid half must not slip through with it.
    assert.throws(
      () => store.save({ llm: { model: "junk/model" }, tts: { provider: "polly" } }),
      /tts\.provider/,
    );
    assert.equal(store.current.llm.model, "anthropic/claude-sonnet-4");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as NeuraCallSettings;
    assert.equal(onDisk.llm.model, "anthropic/claude-sonnet-4");
    assert.equal(onDisk.tts.provider, "auto");
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  });
});

// ------------------------------------------------------------------- layering

test("precedence is defaults < environment < settings.json", () => {
  withTempDir((_dir, file) => {
    const env: NodeJS.ProcessEnv = {
      ASSEMBLYAI_REGION: "EU",
      ASSEMBLYAI_MODE: "max_accuracy",
      ASSEMBLYAI_KEYTERMS: "NeuraCall, SKU-1 ,",
      LLM_MODEL: "from/env",
      LLM_API_KEY: LLM_KEY,
      NEURACALL_HEALTH_PORT: "9464",
    };

    // No file yet: defaults with the environment folded in.
    const fresh = new SettingsStore({ file, env });
    fresh.load();
    assert.equal(fresh.current.assemblyai.region, "eu", "the environment beats the default");
    assert.equal(fresh.current.assemblyai.mode, "max_accuracy");
    assert.deepEqual(fresh.current.assemblyai.keyterms, ["NeuraCall", "SKU-1"]);
    assert.equal(fresh.current.llm.model, "from/env");
    assert.equal(fresh.current.autopilot.healthPort, 9464);
    assert.equal(
      fresh.current.autopilot.stallMs,
      defaultSettings().autopilot.stallMs,
      "what the environment says nothing about stays at the default",
    );
    assert.deepEqual(fresh.problems, []);

    writeFileSync(file, JSON.stringify({ assemblyai: { region: "us" }, llm: { model: "from/file" } }));

    const loaded = new SettingsStore({ file, env });
    loaded.load();
    assert.equal(loaded.current.assemblyai.region, "us", "the file beats the environment");
    assert.equal(loaded.current.llm.model, "from/file");
    assert.equal(loaded.current.assemblyai.mode, "max_accuracy", "the environment still fills the gaps");
    assert.equal(loaded.current.llm.apiKey, LLM_KEY);
    assert.equal(loaded.current.audio.captureSource, "mic", "and the defaults fill the rest");
  });
});

test("an unedited .env.example contributes nothing", () => {
  const raw = settingsFromEnv({ LLM_API_KEY: "replace-me", TTS_API_KEY: "  ", ASSEMBLYAI_REGION: "" });
  assert.deepEqual(raw, {}, "placeholders and blanks must read as unset");
});

test("a bad environment value is reported, not thrown, and the defaults hold", () => {
  withTempDir((_dir, file) => {
    const store = new SettingsStore({ file, env: { ASSEMBLYAI_REGION: "apac" } });
    store.load();
    assert.equal(store.current.assemblyai.region, defaultSettings().assemblyai.region);
    assert.equal(store.problems.length, 1);
    assert.ok(store.problems.join("\n").includes("assemblyai.region"));
  });
});

test("reset discards the file and returns to defaults over the environment", () => {
  withTempDir((_dir, file) => {
    const env: NodeJS.ProcessEnv = { LLM_MODEL: "from/env" };
    const store = new SettingsStore({ file, env });
    store.load();
    store.save({ llm: { model: "from/ui", apiKey: LLM_KEY }, assemblyai: { region: "us" } });

    store.reset();
    assert.equal(store.current.llm.model, "from/env");
    assert.equal(store.current.llm.apiKey, "", "reset drops the saved key");
    assert.equal(store.current.assemblyai.region, defaultSettings().assemblyai.region);

    const reopened = new SettingsStore({ file, env });
    reopened.load();
    assert.equal(reopened.current.llm.apiKey, "", "and it stays dropped");
  });
});

// --------------------------------------------------------------- persistence

test("a save leaves one valid 0600 file and no temp file", () => {
  withTempDir((dir, file) => {
    const store = new SettingsStore({ file, env: {} });
    store.load();
    store.save({ llm: { apiKey: LLM_KEY, model: "anthropic/claude-sonnet-4" } });

    assert.deepEqual(readdirSync(dir), ["settings.json"], "the temp file must not survive the rename");

    const parsed = JSON.parse(readFileSync(file, "utf8")) as NeuraCallSettings;
    assert.equal(parsed.llm.apiKey, LLM_KEY);
    assert.equal(parsed.llm.model, "anthropic/claude-sonnet-4");

    if (process.platform !== "win32") {
      // The file holds API keys in the clear; nobody else on the machine reads it.
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  });
});

test("a save into a directory that does not exist yet creates it", () => {
  withTempDir((dir) => {
    const file = join(dir, "nested", "config", "settings.json");
    const store = new SettingsStore({ file, env: {} });
    store.load();
    store.save({ llm: { model: "anthropic/claude-sonnet-4" } });
    assert.ok(existsSync(file));
  });
});

test("a failed save names the file and leaves no temp file behind", () => {
  withTempDir((dir) => {
    // A directory where settings.json should be: the rename at the end of
    // persist() fails, which is the step a real crash or a full disk hits.
    const file = join(dir, "settings.json");
    mkdirSync(file);
    const store = new SettingsStore({ file, env: {} });
    store.load();

    assert.throws(() => store.save({ llm: { model: "x" } }), /Could not write .*settings\.json/);
    assert.deepEqual(readdirSync(dir), ["settings.json"], "the temp file must be cleaned up");
    assert.equal(store.current.llm.model, "", "a failed save must not update the in-memory settings");
  });
});

// ------------------------------------------------------------- corrupt input

test("a corrupt settings file falls back to defaults and records a problem", () => {
  withTempDir((_dir, file) => {
    // What a crash mid-write, or a hand-edit, actually leaves behind.
    writeFileSync(file, '{"llm": {"model": "anthropic/clau');

    const store = new SettingsStore({ file, env: { LLM_MODEL: "from/env" } });
    const loaded = store.load();

    assert.equal(loaded.llm.model, "from/env", "the lower layers still apply");
    assert.equal(store.problems.length, 1);
    const problem = store.problems.join("\n");
    assert.ok(problem.includes(file), "the operator needs to know which file to fix");
    assert.ok(problem.includes("using defaults"));
  });
});

test("a settings file that parses but validates badly is treated the same way", () => {
  withTempDir((_dir, file) => {
    writeFileSync(file, JSON.stringify({ assemblyai: { region: "apac" }, llm: { model: "ok/model" } }));

    const store = new SettingsStore({ file, env: {} });
    store.load();
    assert.equal(store.current.assemblyai.region, defaultSettings().assemblyai.region);
    assert.equal(store.current.llm.model, "", "a rejected file contributes nothing at all");
    assert.equal(store.problems.length, 1);
    assert.ok(store.problems.join("\n").includes("assemblyai.region"));
  });
});

test("an empty file and a JSON non-object are survivable too", () => {
  for (const contents of ["", "null", "[]", "42"]) {
    withTempDir((_dir, file) => {
      writeFileSync(file, contents);
      const store = new SettingsStore({ file, env: {} });
      assert.deepEqual(store.load(), defaultSettings(), `"${contents}" must fall back to defaults`);
      assert.equal(store.problems.length, 1, `"${contents}" must be reported`);
    });
  }
});

test("a store whose file has never existed reports no problem", () => {
  withTempDir((dir) => {
    const store = new SettingsStore({ file: join(dir, "missing.json"), env: {} });
    assert.deepEqual(store.load(), defaultSettings());
    assert.deepEqual(store.problems, [], "a first launch is not a problem");
  });
});
