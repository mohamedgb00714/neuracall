import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_SPEECH_MODEL,
  DEFAULT_VOICE_AGENT_VOICE,
  REGIONS,
  VOICE_AGENT_SAMPLE_RATE,
  endpointsForRegion,
  voiceAgentEndpointsForRegion,
  type AppConfig,
  type Region,
} from "@neuracall/config";
import { selectTtsClient } from "@neuracall/agent";
import { VOICE_IDS, type RealtimeMode } from "@neuracall/aai-client";
import type { ScrcpyAudioSource } from "@neuracall/scrcpy-bridge";

/**
 * Operator-editable settings, and the only place their shape is defined in the
 * main process (`apps/desktop/src/types.d.ts` mirrors it for the renderer).
 *
 * Everything here can be changed from the UI while the app runs. The one thing
 * that cannot is ASSEMBLYAI_API_KEY: it is required before the runtime will
 * start at all and `@neuracall/config` validates it, so it stays in the
 * environment where a misconfigured install fails loudly at launch.
 */
export interface NeuraCallSettings {
  assemblyai: {
    region: Region;
    speechModel: string;
    mode: RealtimeMode;
    /** Terms biasing recognition (brand names, SKUs). Max 100. */
    keyterms: string[];
    /** Steer transcription toward these languages (U3.5 Pro only), e.g. ["en","fr"]. */
    languageCodes: string[];
    /** VAD confidence threshold 0-1; null = the service default. */
    vadThreshold: number | null;
    /** Silence (ms) before a speculative end-of-turn check; null = the service default. */
    minTurnSilence: number | null;
    /** Max silence (ms) before the turn is forced to end; null = the service default. */
    maxTurnSilence: number | null;
    /** Emit Heartbeat every 5 s. */
    sessionHeartbeat: boolean;
  };
  /**
   * AssemblyAI's Voice Agent API: one socket in place of the llm and tts
   * sections below, authenticated by the AssemblyAI key the app already
   * requires. It therefore holds no secret of its own, which is why it is the
   * one section that survives redaction untouched.
   */
  voiceAgent: {
    /** Off unless asked for: turning it on bypasses llm and tts entirely. */
    enabled: boolean;
    /**
     * uuid of an agent stored via POST /v1/agents; "" configures one inline
     * from the fields below. Never both — a session carrying an agent_id *and*
     * inline fields is rejected, so a stored agent wins and the rest is unused.
     */
    agentId: string;
    /** A voice_id from VOICE_IDS. The catalogue has no Arabic voice. */
    voice: string;
    /** The agent's opening line; "" lets it answer rather than open. */
    greeting: string;
    /** The agent's persona and instructions; "" keeps the service default. */
    systemPrompt: string;
  };
  llm: {
    apiKey: string;
    model: string;
    baseUrl: string;
    systemPrompt: string;
    greeting: string;
  };
  tts: {
    provider: TtsProvider;
    apiKey: string;
    model: string;
    voice: string;
    baseUrl: string;
  };
  audio: {
    /** scrcpy `--audio-source` used for far-end capture. */
    captureSource: string;
    /** PulseAudio/PipeWire sink the agent speaks into. "" turns injection off. */
    injectSink: string;
  };
  autopilot: {
    /**
     * Start answering inbound calls as soon as the app is up.
     *
     * On by default, which is a deliberate change from how this began. It is
     * still worth being clear about what it means: the app picks up real calls
     * on real phones with no further confirmation, so a machine that is running
     * NeuraCall is a machine that is answering the phone. Turn it off in
     * Settings, or set NEURACALL_AUTOPILOT_AUTOSTART=0, for a console that
     * watches without acting.
     */
    autoStart: boolean;
    maxCallMs: number;
    stallMs: number;
    defaultCountryCode: string;
    healthPort: number | null;
  };
  /**
   * One AssemblyAI voice agent per attached phone, keyed by device serial.
   * An entry for a device wins over the global `voiceAgent` section on that
   * device's calls; a missing entry falls back to the global configuration.
   */
  voipAgents: Record<string, DeviceAgentConfig>;
}

export type VoiceAgentTranscriptionMode = "min_latency" | "balanced" | "max_accuracy";
export type VoiceAgentFocus = "near-field" | "far-field";

/** Per-device turn-detection knobs; `null` leaves the service default. */
export interface DeviceAgentTurnDetection {
  vadThreshold: number | null;
  minSilenceMs: number | null;
  maxSilenceMs: number | null;
  interruptResponse: boolean;
  interruptionDelayMs: number | null;
}

/**
 * A stored per-phone voice agent. `agentId` — the uuid from POST /v1/agents —
 * wins whenever it is non-empty; "" means the other fields configure the
 * session inline instead.
 */
export interface DeviceAgentConfig {
  agentId: string;
  /** Human label; becomes the stored agent's `name`. */
  name: string;
  /** A voice_id from VOICE_IDS. The catalogue has no Arabic voice. */
  voice: string;
  /** The agent's opening line; "" lets it answer rather than open. */
  greeting: string;
  /** The agent's persona and instructions; "" keeps the service default. */
  systemPrompt: string;
  /** Domain terms biasing recognition (names, products, street names). */
  keyterms: string[];
  transcriptionMode: VoiceAgentTranscriptionMode | null;
  voiceFocus: VoiceAgentFocus | null;
  /** Voice-focus aggressiveness 0-1; requires `voiceFocus`. */
  voiceFocusThreshold: number | null;
  turnDetection: DeviceAgentTurnDetection;
  /** 0-100. */
  volume: number | null;
}

export type TtsProvider = "auto" | "openai" | "elevenlabs" | "command" | "silent";

/**
 * What the renderer is allowed to see. Every `apiKey` is blanked and replaced
 * by a `hasApiKey` flag: the UI needs to know whether a key is stored so it can
 * say so, and never needs the key itself. `voiceAgent` passes through whole
 * because nothing in it is a secret.
 */
export interface RedactedSettings {
  assemblyai: NeuraCallSettings["assemblyai"];
  voiceAgent: NeuraCallSettings["voiceAgent"];
  voipAgents: Record<string, DeviceAgentConfig>;
  llm: NeuraCallSettings["llm"] & { hasApiKey: boolean };
  tts: NeuraCallSettings["tts"] & { hasApiKey: boolean };
  audio: NeuraCallSettings["audio"];
  autopilot: NeuraCallSettings["autopilot"];
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * A validated save request: `DeepPartial<NeuraCallSettings>` as it arrives over
 * IPC, narrowed. `apiKey` is tri-state where the rest of the shape is not —
 * see `applyPatch` for what each state means.
 */
export interface SettingsPatch {
  assemblyai?: Partial<NeuraCallSettings["assemblyai"]>;
  voiceAgent?: Partial<NeuraCallSettings["voiceAgent"]>;
  /** Per-device upserts; a `null` value deletes that device's agent. */
  voipAgents?: Record<string, DeviceAgentConfig | null>;
  llm?: Partial<Omit<NeuraCallSettings["llm"], "apiKey">> & { apiKey?: string | null };
  tts?: Partial<Omit<NeuraCallSettings["tts"], "apiKey">> & { apiKey?: string | null };
  audio?: Partial<NeuraCallSettings["audio"]>;
  autopilot?: Partial<NeuraCallSettings["autopilot"]>;
}

export interface ProbeResult {
  ok: boolean;
  /** One line for the UI. Scrubbed of every configured key before it is returned. */
  detail: string;
}

export interface ProbeReport {
  assemblyai: ProbeResult;
  llm: ProbeResult;
  tts: ProbeResult;
}

/** OpenRouter fronts Anthropic, OpenAI, Google and the rest behind one key. */
export const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";

const OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";
const ELEVENLABS_TTS_BASE_URL = "https://api.elevenlabs.io/v1";

/** Value `.env.example` ships for every unset key; treat it as unconfigured. */
const PLACEHOLDER = "replace-me";

/** Reachability probes are diagnostics, not call work — they get a short leash. */
const PROBE_TIMEOUT_MS = 8000;

const MAX_KEYTERMS = 100;
/** Per the Universal-Streaming spec; a longer term is rejected by the socket. */
const MAX_KEYTERM_CHARS = 50;
/** How many of the service's supported languages one session may be steered to. */
const MAX_LANGUAGE_CODES = 20;
/** Longest form a language code takes in practice ("zh-Hant", "en-US"). */
const MAX_LANGUAGE_CODE_CHARS = 10;

/**
 * Spellings a boolean may arrive as, matching the ones `@neuracall/config`
 * accepts: the same `.env` feeds both, so a variable that works for the
 * headless runtime has to work here too.
 */
const TRUE_SPELLINGS = ["1", "true", "yes", "on"];
const FALSE_SPELLINGS = ["0", "false", "no", "off"];

/** Canonical 8-4-4-4-12 form — the only shape the agents API issues. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODES: readonly RealtimeMode[] = ["min_latency", "balanced", "max_accuracy"];

const VOIP_AGENT_TRANSCRIPTION_MODES: readonly VoiceAgentTranscriptionMode[] = [
  "min_latency",
  "balanced",
  "max_accuracy",
];
const VOIP_AGENT_FOCUS_MODES: readonly VoiceAgentFocus[] = ["near-field", "far-field"];
const TTS_PROVIDERS: readonly TtsProvider[] = ["auto", "openai", "elevenlabs", "command", "silent"];

/**
 * scrcpy's `--audio-source` values. Typed as the bridge's union so a rename
 * there fails this file at compile time rather than at the next call.
 */
const AUDIO_SOURCES: readonly ScrcpyAudioSource[] = [
  "output",
  "mic",
  "playback",
  "mic-unprocessed",
  "mic-camcorder",
  "mic-voice-recognition",
  "mic-voice-communication",
  "voice-call",
  "voice-call-uplink",
  "voice-call-downlink",
  "voice-communication",
  "voice-performance",
];

/** Built-in defaults: the lowest layer, and what `reset` returns to. */
export function defaultSettings(): NeuraCallSettings {
  return {
    assemblyai: {
      region: "edge",
      speechModel: DEFAULT_SPEECH_MODEL,
      mode: "balanced",
      keyterms: [],
      languageCodes: [],
      vadThreshold: null,
      minTurnSilence: null,
      maxTurnSilence: null,
      sessionHeartbeat: false,
    },
    voiceAgent: {
      enabled: false,
      agentId: "",
      voice: DEFAULT_VOICE_AGENT_VOICE,
      greeting: "",
      systemPrompt: "",
    },
    voipAgents: {},
    llm: { apiKey: "", model: "", baseUrl: DEFAULT_LLM_BASE_URL, systemPrompt: "", greeting: "" },
    tts: { provider: "auto", apiKey: "", model: "", voice: "", baseUrl: "" },
    audio: { captureSource: "mic", injectSink: "" },
    autopilot: {
      autoStart: true,
      // The orchestrator's watchdog defaults, restated so the UI has something
      // concrete to show instead of an empty field meaning "whatever it is".
      maxCallMs: 30 * 60_000,
      stallMs: 120_000,
      defaultCountryCode: "",
      healthPort: null,
    },
  };
}

// ------------------------------------------------------------ security boundary

/**
 * Blank every key and report only whether one is stored.
 *
 * Half of the asymmetry described on `applyPatch`: the renderer may set a key
 * but must never receive one, so nothing that leaves the main process carries
 * a secret. Keep this function trivial — it is the last thing between a stored
 * key and the window.
 */
export function toRedacted(settings: NeuraCallSettings): RedactedSettings {
  return {
    assemblyai: {
      ...settings.assemblyai,
      keyterms: [...settings.assemblyai.keyterms],
      // Same aliasing rule as keyterms: `assemblyai` crosses to the renderer as
      // a live object, and a mutation there must not leak into the main process.
      languageCodes: [...settings.assemblyai.languageCodes],
    },
    voiceAgent: { ...settings.voiceAgent },
    voipAgents: structuredClone(settings.voipAgents),
    llm: { ...settings.llm, apiKey: "", hasApiKey: settings.llm.apiKey !== "" },
    tts: { ...settings.tts, apiKey: "", hasApiKey: settings.tts.apiKey !== "" },
    audio: { ...settings.audio },
    autopilot: { ...settings.autopilot },
  };
}

/**
 * Fold a validated patch into the current settings.
 *
 * `apiKey` is deliberately tri-state, and it is the other half of the
 * asymmetry: the renderer only ever holds the redacted view, in which every
 * key reads as `""`. If `""` meant "set to empty", saving an untouched form
 * would wipe a stored key. So:
 *   - `""`            leave the stored key unchanged
 *   - a non-empty     replace it
 *   - `null`          clear it (the only way to remove one)
 * Every other field is plain last-write-wins.
 */
export function applyPatch(current: NeuraCallSettings, patch: SettingsPatch): NeuraCallSettings {
  const next = structuredClone(current);
  if (patch.assemblyai) Object.assign(next.assemblyai, patch.assemblyai);
  if (patch.voiceAgent) Object.assign(next.voiceAgent, patch.voiceAgent);
  if (patch.voipAgents) applyVoipAgents(next.voipAgents, patch.voipAgents);
  if (patch.audio) Object.assign(next.audio, patch.audio);
  if (patch.autopilot) Object.assign(next.autopilot, patch.autopilot);

  if (patch.llm) {
    const { apiKey, ...rest } = patch.llm;
    Object.assign(next.llm, rest);
    next.llm.apiKey = mergeSecret(current.llm.apiKey, apiKey);
  }
  if (patch.tts) {
    const { apiKey, ...rest } = patch.tts;
    Object.assign(next.tts, rest);
    next.tts.apiKey = mergeSecret(current.tts.apiKey, apiKey);
  }
  return next;
}

function mergeSecret(stored: string, incoming: string | null | undefined): string {
  if (incoming === undefined || incoming === "") return stored;
  if (incoming === null) return "";
  return incoming;
}

/**
 * Fold a device-agent upsert map into the settings record. `null` deletes the
 * device's agent; anything else is deep-merged over the existing entry so a
 * partial update keeps the untouched nested fields (turn-detection knobs,
 * keyterms) rather than resetting them.
 */
function applyVoipAgents(
  target: Record<string, DeviceAgentConfig>,
  patch: Record<string, DeviceAgentConfig | null>,
): void {
  for (const [serial, config] of Object.entries(patch)) {
    if (config === null) {
      delete target[serial];
      continue;
    }
    const current = target[serial];
    target[serial] =
      current === undefined
        ? structuredClone(config)
        : {
            ...current,
            ...config,
            keyterms: config.keyterms,
            turnDetection: { ...current.turnDetection, ...config.turnDetection },
          };
  }
}

/**
 * Fold a *trusted* layer — the settings file, the environment — into the one
 * beneath it. Plain last-write-wins, deliberately unlike `applyPatch`: these
 * layers are complete stored values, not form submissions, so an empty apiKey
 * means an empty apiKey. Sharing `applyPatch` here would resurrect a key the
 * operator cleared from whatever `.env` still holds.
 */
function mergeLayer(base: NeuraCallSettings, layer: SettingsPatch): NeuraCallSettings {
  const next = structuredClone(base);
  if (layer.assemblyai) Object.assign(next.assemblyai, layer.assemblyai);
  if (layer.voiceAgent) Object.assign(next.voiceAgent, layer.voiceAgent);
  if (layer.voipAgents) applyVoipAgents(next.voipAgents, layer.voipAgents);
  if (layer.audio) Object.assign(next.audio, layer.audio);
  if (layer.autopilot) Object.assign(next.autopilot, layer.autopilot);

  if (layer.llm) {
    const { apiKey, ...rest } = layer.llm;
    Object.assign(next.llm, rest);
    if (apiKey !== undefined) next.llm.apiKey = apiKey ?? "";
  }
  if (layer.tts) {
    const { apiKey, ...rest } = layer.tts;
    Object.assign(next.tts, rest);
    if (apiKey !== undefined) next.tts.apiKey = apiKey ?? "";
  }
  return next;
}

// ------------------------------------------------------------------ validation

/**
 * Turn an untrusted IPC payload into a patch, or throw explaining what is
 * wrong. Unknown regions, modes and providers are rejected here so junk never
 * reaches the settings file — a value the app cannot interpret at startup is
 * far worse than a rejected save.
 */
export function parseSettingsPatch(raw: unknown): SettingsPatch {
  const root = asObject(raw, "settings");
  const patch: SettingsPatch = {};

  const aai = optionalObject(root, "assemblyai");
  if (aai) {
    const section: SettingsPatch["assemblyai"] = {};
    if ("region" in aai) section.region = oneOf(aai["region"], REGIONS, "assemblyai.region");
    if ("speechModel" in aai) {
      section.speechModel = nonEmpty(aai["speechModel"], "assemblyai.speechModel");
    }
    if ("mode" in aai) section.mode = oneOf(aai["mode"], MODES, "assemblyai.mode");
    if ("keyterms" in aai) section.keyterms = keyterms(aai["keyterms"]);
    if ("languageCodes" in aai) section.languageCodes = languageCodes(aai["languageCodes"]);
    if ("vadThreshold" in aai) {
      const value = aai["vadThreshold"];
      section.vadThreshold =
        value === null || value === ""
          ? null
          : numberInRange(value, "assemblyai.vadThreshold", 0, 1);
    }
    if ("minTurnSilence" in aai) {
      const value = aai["minTurnSilence"];
      section.minTurnSilence =
        value === null || value === ""
          ? null
          : integer(value, "assemblyai.minTurnSilence", 50, 10000);
    }
    if ("maxTurnSilence" in aai) {
      const value = aai["maxTurnSilence"];
      section.maxTurnSilence =
        value === null || value === ""
          ? null
          : integer(value, "assemblyai.maxTurnSilence", 50, 10000);
    }
    if ("sessionHeartbeat" in aai) {
      section.sessionHeartbeat = boolean(aai["sessionHeartbeat"], "assemblyai.sessionHeartbeat");
    }
    patch.assemblyai = section;
  }

  const voiceAgent = optionalObject(root, "voiceAgent");
  if (voiceAgent) {
    const section: SettingsPatch["voiceAgent"] = {};
    if ("enabled" in voiceAgent) {
      section.enabled = boolean(voiceAgent["enabled"], "voiceAgent.enabled");
    }
    if ("agentId" in voiceAgent) section.agentId = agentId(voiceAgent["agentId"]);
    // Both of these are rejected by the service at session start, where the
    // error arrives as a socket close during a call. Cheaper to fail the save.
    if ("voice" in voiceAgent) {
      section.voice = oneOf(voiceAgent["voice"], VOICE_IDS, "voiceAgent.voice");
    }
    if ("greeting" in voiceAgent) {
      section.greeting = text(voiceAgent["greeting"], "voiceAgent.greeting");
    }
    if ("systemPrompt" in voiceAgent) {
      section.systemPrompt = text(voiceAgent["systemPrompt"], "voiceAgent.systemPrompt");
    }
    patch.voiceAgent = section;
  }

  const voipAgents = optionalObject(root, "voipAgents");
  if (voipAgents) {
    const map: NonNullable<SettingsPatch["voipAgents"]> = {};
    for (const [serial, raw] of Object.entries(voipAgents)) {
      if (serial.trim() === "") {
        throw new Error("voipAgents keys must be non-empty device serials.");
      }
      if (raw === null) {
        map[serial] = null;
        continue;
      }
      map[serial] = deviceAgentConfig(raw, `voipAgents["${serial}"]`);
    }
    if (Object.keys(map).length > 0) patch.voipAgents = map;
  }

  const llm = optionalObject(root, "llm");
  if (llm) {
    const section: NonNullable<SettingsPatch["llm"]> = {};
    if ("apiKey" in llm) section.apiKey = secret(llm["apiKey"], "llm.apiKey");
    if ("model" in llm) section.model = text(llm["model"], "llm.model");
    if ("baseUrl" in llm) section.baseUrl = url(llm["baseUrl"], "llm.baseUrl");
    if ("systemPrompt" in llm) section.systemPrompt = text(llm["systemPrompt"], "llm.systemPrompt");
    if ("greeting" in llm) section.greeting = text(llm["greeting"], "llm.greeting");
    patch.llm = section;
  }

  const tts = optionalObject(root, "tts");
  if (tts) {
    const section: NonNullable<SettingsPatch["tts"]> = {};
    if ("provider" in tts) section.provider = oneOf(tts["provider"], TTS_PROVIDERS, "tts.provider");
    if ("apiKey" in tts) section.apiKey = secret(tts["apiKey"], "tts.apiKey");
    if ("model" in tts) section.model = text(tts["model"], "tts.model");
    if ("voice" in tts) section.voice = text(tts["voice"], "tts.voice");
    if ("baseUrl" in tts) section.baseUrl = url(tts["baseUrl"], "tts.baseUrl");
    patch.tts = section;
  }

  const audio = optionalObject(root, "audio");
  if (audio) {
    const section: SettingsPatch["audio"] = {};
    if ("captureSource" in audio) {
      section.captureSource = oneOf(audio["captureSource"], AUDIO_SOURCES, "audio.captureSource");
    }
    if ("injectSink" in audio) section.injectSink = text(audio["injectSink"], "audio.injectSink");
    patch.audio = section;
  }

  const autopilot = optionalObject(root, "autopilot");
  if (autopilot) {
    const section: SettingsPatch["autopilot"] = {};
    if ("autoStart" in autopilot) {
      section.autoStart = boolean(autopilot["autoStart"], "autopilot.autoStart");
    }
    if ("maxCallMs" in autopilot) {
      section.maxCallMs = integer(
        autopilot["maxCallMs"],
        "autopilot.maxCallMs",
        1000,
        6 * 3600_000,
      );
    }
    if ("stallMs" in autopilot) {
      section.stallMs = integer(autopilot["stallMs"], "autopilot.stallMs", 1000, 3600_000);
    }
    if ("defaultCountryCode" in autopilot) {
      section.defaultCountryCode = countryCode(autopilot["defaultCountryCode"]);
    }
    if ("healthPort" in autopilot) {
      const port = autopilot["healthPort"];
      section.healthPort =
        port === null || port === "" ? null : integer(port, "autopilot.healthPort", 1, 65535);
    }
    patch.autopilot = section;
  }

  return patch;
}

// ------------------------------------------------------------------- the store

export interface SettingsStoreOptions {
  /** Absolute path of settings.json. */
  file: string;
  /** Environment supplying the middle layer. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The settings file, layered over the environment.
 *
 * Precedence is defaults < environment < settings.json. The environment seeds
 * a fresh install (and a `reset`) so an existing `.env` keeps working, but it
 * is authoritative for nothing: the point of this store is configuring the app
 * without editing `.env`, so a saved file wins outright. Because a save writes
 * the whole resolved snapshot, a value that arrived from the environment is
 * copied into the file the first time anything is saved — which is why the
 * file is written 0600 and never leaves the main process unredacted.
 */
export class SettingsStore {
  readonly file: string;
  /** Defaults with the environment folded in — the two lower layers, parsed once. */
  private readonly base: NeuraCallSettings;
  private settings: NeuraCallSettings;
  private readonly issues: string[] = [];

  constructor(opts: SettingsStoreOptions) {
    this.file = opts.file;
    this.base = baseline(opts.env ?? process.env, this.issues);
    this.settings = this.base;
  }

  /** The merged settings in force. */
  get current(): NeuraCallSettings {
    return this.settings;
  }

  /**
   * Non-fatal complaints from the last load: a corrupt file, an environment
   * value the validator rejected. Loading never throws — an unreadable
   * settings file must not stop the app from opening and letting the operator
   * fix it.
   */
  get problems(): readonly string[] {
    return this.issues;
  }

  redacted(): RedactedSettings {
    return toRedacted(this.settings);
  }

  /** Read settings.json over the environment layer, falling back to defaults. */
  load(): NeuraCallSettings {
    let contents: string;
    try {
      contents = readFileSync(this.file, "utf8");
    } catch {
      this.settings = this.base; // no file yet — defaults+environment are the settings
      return this.settings;
    }

    try {
      this.settings = mergeLayer(this.base, parseSettingsPatch(JSON.parse(contents)));
    } catch (err) {
      // A half-written or hand-edited file must not brick startup. Report it
      // and run on the lower layers; the next successful save replaces it.
      this.issues.push(`${this.file} could not be read (${describe(err)}); using defaults.`);
      this.settings = this.base;
    }
    return this.settings;
  }

  /** Validate, fold in and persist. Throws with a useful message on bad input. */
  save(raw: unknown): NeuraCallSettings {
    const next = applyPatch(this.settings, parseSettingsPatch(raw));
    this.persist(next);
    this.settings = next;
    return this.settings;
  }

  /** Back to defaults over the environment, discarding the file's contents. */
  reset(): NeuraCallSettings {
    this.persist(this.base);
    this.settings = this.base;
    return this.settings;
  }

  /**
   * Write via a temp file and rename. The file holds API keys, so it is 0600;
   * and because rename is atomic, a crash mid-save leaves either the old file
   * or the new one — never a truncated one that fails to parse on next launch.
   */
  private persist(settings: NeuraCallSettings): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      // writeFileSync's mode only applies when it creates the file; a temp left
      // by a crashed save could otherwise survive with looser permissions.
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch (err) {
      // Cleaning up the temp file must not mask why the save failed: an
      // ENOTDIR from rmSync would replace "Could not write <file>" with an
      // unrelated error about a path the operator never named.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the temp file is not the problem being reported */
      }
      throw new Error(`Could not write ${this.file}: ${describe(err)}`);
    }
  }
}

/** Defaults with the environment layer folded in, complaining rather than throwing. */
function baseline(env: NodeJS.ProcessEnv, issues: string[]): NeuraCallSettings {
  const defaults = defaultSettings();
  try {
    return mergeLayer(defaults, parseSettingsPatch(settingsFromEnv(env)));
  } catch (err) {
    issues.push(`Ignoring the environment settings layer: ${describe(err)}`);
    return defaults;
  }
}

/**
 * The environment layer, as a raw patch for `parseSettingsPatch` to validate —
 * a typo in `.env` should be reported the same way a bad IPC payload is, not
 * quietly typed into shape here.
 *
 * Only variables that are actually set contribute, and `.env.example`
 * placeholders count as unset: an unedited copy of it must behave exactly like
 * an empty one.
 */
export function settingsFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return compactSections({
    assemblyai: compact({
      region: clean(env["ASSEMBLYAI_REGION"])?.toLowerCase(),
      speechModel: clean(env["ASSEMBLYAI_SPEECH_MODEL"]),
      mode: clean(env["ASSEMBLYAI_MODE"])?.toLowerCase(),
      keyterms: splitList(env["ASSEMBLYAI_KEYTERMS"]),
      languageCodes: splitList(env["ASSEMBLYAI_LANGUAGE_CODES"]),
      vadThreshold: envThreshold(env["ASSEMBLYAI_VAD_THRESHOLD"]),
      minTurnSilence: envSilenceMs(env["ASSEMBLYAI_MIN_TURN_SILENCE"]),
      maxTurnSilence: envSilenceMs(env["ASSEMBLYAI_MAX_TURN_SILENCE"]),
      // Left as a raw string for `boolean()` to judge, like autoStart and
      // enabled — a misspelling is a loud startup problem, not a silent "off".
      sessionHeartbeat: clean(env["ASSEMBLYAI_SESSION_HEARTBEAT"]),
    }),
    voiceAgent: compact({
      // VOICE_AGENT_ENABLED stays the string it was written as; `boolean()`
      // decides what "on" means, so a misspelling is rejected out loud instead
      // of reading as off.
      enabled: clean(env["VOICE_AGENT_ENABLED"]),
      agentId: clean(env["VOICE_AGENT_ID"]),
      voice: clean(env["VOICE_AGENT_VOICE"])?.toLowerCase(),
      greeting: clean(env["VOICE_AGENT_GREETING"]),
      systemPrompt: clean(env["VOICE_AGENT_SYSTEM_PROMPT"]),
    }),
    llm: compact({
      apiKey: clean(env["LLM_API_KEY"]),
      model: clean(env["LLM_MODEL"]),
      baseUrl: clean(env["LLM_BASE_URL"]),
      systemPrompt: clean(env["NEURACALL_SYSTEM_PROMPT"]),
      greeting: clean(env["NEURACALL_GREETING"]),
    }),
    tts: compact({
      provider: clean(env["TTS_PROVIDER"])?.toLowerCase(),
      apiKey: clean(env["TTS_API_KEY"]),
      model: clean(env["TTS_MODEL"]),
      voice: clean(env["TTS_VOICE"]),
      baseUrl: clean(env["TTS_BASE_URL"]),
    }),
    audio: compact({
      captureSource: clean(env["NEURACALL_AUDIO_SOURCE"]),
      injectSink: clean(env["NEURACALL_INJECT_SINK"]),
    }),
    autopilot: compact({
      // Left as a raw string for `boolean()` to judge, so a typo is a loud
      // startup error rather than a silent "off".
      autoStart: clean(env["NEURACALL_AUTOPILOT_AUTOSTART"]),
      maxCallMs: numeric(env["NEURACALL_MAX_CALL_MS"]),
      stallMs: numeric(env["NEURACALL_STALL_MS"]),
      defaultCountryCode: clean(env["NEURACALL_COUNTRY_CODE"]),
      healthPort: envPort(env["NEURACALL_HEALTH_PORT"]),
    }),
  });
}

// -------------------------------------------------------------- derived config

/**
 * The AppConfig the runtime and agent actually run on: the AssemblyAI key from
 * the environment (it is required at startup and `@neuracall/config` validates
 * it, so it is the one value the UI cannot supply) with everything else taken
 * from settings. The endpoints are re-derived from the chosen region so no
 * hostname survives a region change — that includes the Voice Agent hosts,
 * which live on their own agents.* family and would otherwise keep serving the
 * previous region's cluster after the operator switched for data residency.
 *
 * `voiceAgent` comes from settings like everything else, so the UI is what
 * turns a speech-to-speech call on. Five of the six VOICE_AGENT_* variables in
 * .env.example still reach it, but through `settingsFromEnv` seeding the
 * settings layers — not through getConfig(), which main.ts calls only to lift
 * the API key out of. The sixth, VOICE_AGENT_LLM_MODEL, has deliberately no
 * settings field: an inline session rejects an `llm` block, so a model can only
 * be chosen when creating a stored agent, which happens outside this app.
 *
 * agentId, greeting and systemPrompt are spread in only when non-empty. Under
 * exactOptionalPropertyTypes AppConfig's optionals mean absent, and "" is not
 * absent: an empty agentId would be sent as an agent_id and rejected, and an
 * empty greeting would silence the opening line rather than leave it to the
 * service.
 */
export function buildAppConfig(assemblyAiKey: string, settings: NeuraCallSettings): AppConfig {
  const { agentId, greeting, systemPrompt } = settings.voiceAgent;
  const aai = settings.assemblyai;
  return {
    assemblyai: {
      apiKey: assemblyAiKey,
      region: aai.region,
      speechModel: aai.speechModel,
      // Absent rather than null/[] for the same reason agentId is spread in only
      // when non-empty: AppConfig's optionals mean "don't send this on the
      // socket", and null/"" are not "absent".
      ...(aai.languageCodes.length > 0 ? { languageCodes: aai.languageCodes } : {}),
      ...(aai.vadThreshold !== null ? { vadThreshold: aai.vadThreshold } : {}),
      ...(aai.minTurnSilence !== null ? { minTurnSilence: aai.minTurnSilence } : {}),
      ...(aai.maxTurnSilence !== null ? { maxTurnSilence: aai.maxTurnSilence } : {}),
      // Off and unset both mean "do not ask for Heartbeats", so only on is carried.
      ...(aai.sessionHeartbeat ? { sessionHeartbeat: true } : {}),
      ...endpointsForRegion(aai.region),
    },
    voiceAgent: {
      enabled: settings.voiceAgent.enabled,
      voice: settings.voiceAgent.voice,
      sampleRate: VOICE_AGENT_SAMPLE_RATE,
      ...(agentId ? { agentId } : {}),
      ...(greeting ? { greeting } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...voiceAgentEndpointsForRegion(settings.assemblyai.region),
    },
    llm: {
      ...(settings.llm.apiKey ? { apiKey: settings.llm.apiKey } : {}),
      model: settings.llm.model,
    },
    tts: {
      ...(settings.tts.apiKey ? { apiKey: settings.tts.apiKey } : {}),
      model: settings.tts.model,
    },
  };
}

/**
 * The TTS knobs `selectTtsClient` reads from the environment, rebuilt from
 * settings. Passing this as its `env` keeps provider selection in one place
 * (the agent package) instead of reimplementing the preference order here.
 */
/**
 * The env vars `selectTtsClient` reads that settings owns outright.
 *
 * Listed explicitly because clearing a setting has to *remove* the variable,
 * not just stop emitting it. Spreading `ttsEnvFor` over `process.env` would
 * leave a stale `TTS_PROVIDER` from `.env` in place when the operator switched
 * the provider back to "auto" — the UI would look like it had done nothing.
 */
const TTS_CONTROLLED_ENV = [
  "TTS_PROVIDER",
  "TTS_BASE_URL",
  "TTS_VOICE",
  "TTS_COMMAND_VOICE",
] as const;

/**
 * Overlay the settings-derived TTS variables onto a base environment, deleting
 * the ones settings does not set so the file layer is authoritative.
 */
export function mergeTtsEnv(
  base: NodeJS.ProcessEnv,
  settings: NeuraCallSettings,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  const overrides = ttsEnvFor(settings);
  for (const key of TTS_CONTROLLED_ENV) {
    const value = overrides[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function ttsEnvFor(settings: NeuraCallSettings): NodeJS.ProcessEnv {
  const { provider, voice, baseUrl } = settings.tts;
  return {
    ...(provider !== "auto" ? { TTS_PROVIDER: provider } : {}),
    ...(baseUrl ? { TTS_BASE_URL: baseUrl } : {}),
    ...(voice ? { TTS_VOICE: voice } : {}),
    // TTS_VOICE means a different thing per provider (an OpenAI voice name, an
    // ElevenLabs voice id, an espeak language code), so the local engine only
    // gets it when the operator picked the local engine.
    ...(voice && provider === "command" ? { TTS_COMMAND_VOICE: voice } : {}),
  };
}

// ----------------------------------------------------------------- reachability

export interface ProbeOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Cheapest credible "does this work" check per provider.
 *
 * Nothing here spends tokens or synthesises audio: AssemblyAI mints a
 * throwaway realtime token (the one call that proves the key is live), and the
 * LLM/TTS providers get a read against their configured base URL. Every
 * `detail` is scrubbed of the configured keys before it is returned, because
 * provider error bodies are not required to be discreet.
 */
export async function probeSettings(
  config: AppConfig,
  settings: NeuraCallSettings,
  opts: ProbeOptions = {},
): Promise<ProbeReport> {
  const secrets = [config.assemblyai.apiKey, settings.llm.apiKey, settings.tts.apiKey];
  const [assemblyai, llm, tts] = await Promise.all([
    probeAssemblyAI(config, opts),
    probeLlm(settings, opts),
    probeTts(config, settings, opts),
  ]);
  return {
    assemblyai: scrubResult(assemblyai, secrets),
    llm: scrubResult(llm, secrets),
    tts: scrubResult(tts, secrets),
  };
}

async function probeAssemblyAI(config: AppConfig, opts: ProbeOptions): Promise<ProbeResult> {
  if (!config.assemblyai.apiKey) {
    return { ok: false, detail: "ASSEMBLYAI_API_KEY is not set — export it or put it in .env" };
  }
  const url = `${config.assemblyai.tokenUrl}?expires_in_seconds=60`;
  try {
    // Minted directly rather than via `mintRealtimeToken` so the probe carries
    // a deadline; a diagnostic must not hang the settings dialog.
    const res = await request(url, { authorization: config.assemblyai.apiKey }, opts);
    if (!res.ok) {
      return {
        ok: false,
        detail: `${config.assemblyai.realtimeHost} rejected the key ${status(res)}`,
      };
    }
    const body = (await res.json()) as { token?: string };
    return body.token
      ? {
          ok: true,
          detail: `key accepted by ${config.assemblyai.realtimeHost} (region ${config.assemblyai.region})`,
        }
      : { ok: false, detail: `${config.assemblyai.realtimeHost} returned no token` };
  } catch (err) {
    return {
      ok: false,
      detail: `could not reach ${config.assemblyai.realtimeHost}: ${describe(err)}`,
    };
  }
}

async function probeLlm(settings: NeuraCallSettings, opts: ProbeOptions): Promise<ProbeResult> {
  const { apiKey, model, baseUrl } = settings.llm;
  if (!apiKey)
    return { ok: false, detail: "no API key stored — the agent will listen but not reply" };
  if (!model) return { ok: false, detail: "no model set — the agent will listen but not reply" };
  const base = trimSlashes(baseUrl || DEFAULT_LLM_BASE_URL);
  return reachable(`${base}/models`, { authorization: `Bearer ${apiKey}` }, base, opts);
}

async function probeTts(
  config: AppConfig,
  settings: NeuraCallSettings,
  opts: ProbeOptions,
): Promise<ProbeResult> {
  // Selection is the agent package's decision, including which provider "auto"
  // resolves to and whether a local engine exists; constructing a client makes
  // no network call.
  const selection = selectTtsClient(config, { env: ttsEnvFor(settings) });
  if (selection.provider === "silent") return { ok: false, detail: selection.description };
  if (selection.provider === "command") return { ok: true, detail: selection.description };

  const key = settings.tts.apiKey;
  const base = trimSlashes(
    settings.tts.baseUrl ||
      (selection.provider === "elevenlabs" ? ELEVENLABS_TTS_BASE_URL : OPENAI_TTS_BASE_URL),
  );
  // ElevenLabs authenticates with its own header, not Bearer.
  const headers: Record<string, string> =
    selection.provider === "elevenlabs"
      ? { "xi-api-key": key }
      : { authorization: `Bearer ${key}` };
  const result = await reachable(`${base}/models`, headers, base, opts);
  return { ok: result.ok, detail: `${selection.description} — ${result.detail}` };
}

/** GET a provider's model listing and turn the response into one line. */
async function reachable(
  url: string,
  headers: Record<string, string>,
  base: string,
  opts: ProbeOptions,
): Promise<ProbeResult> {
  try {
    const res = await request(url, headers, opts);
    if (res.ok) return { ok: true, detail: `${base} answered ${status(res)}` };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `${base} rejected the key ${status(res)}` };
    }
    // Not every OpenAI-compatible server implements /models. The host answered,
    // which is all this probe set out to establish.
    if (res.status === 404 || res.status === 405) {
      return { ok: true, detail: `${base} is reachable (no /models listing, ${status(res)})` };
    }
    return { ok: false, detail: `${base} answered ${status(res)}` };
  } catch (err) {
    return { ok: false, detail: `could not reach ${base}: ${describe(err)}` };
  }
}

function request(
  url: string,
  headers: Record<string, string>,
  opts: ProbeOptions,
): Promise<Response> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  return fetchFn(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
  });
}

function status(res: Response): string {
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

/** Last line of defence: a key must not reach the renderer inside a diagnostic. */
function scrubResult(result: ProbeResult, secrets: readonly string[]): ProbeResult {
  let detail = result.detail;
  for (const secret of secrets) {
    if (secret.length >= 8) detail = detail.split(secret).join("***");
  }
  return { ok: result.ok, detail };
}

// --------------------------------------------------------------------- helpers

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = root[key];
  return value === undefined ? undefined : asObject(value, key);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new Error(`${path} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(value)}).`);
}

/**
 * A boolean, or one of the `.env` spellings of one — the environment layer is
 * validated through this same parser and arrives as strings.
 *
 * An unrecognised spelling throws rather than falling back, because the
 * alternative is `VOICE_AGENT_ENABLED=flase` meaning "off" and a feature that
 * looks like it was never implemented.
 */
function boolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const spelling = value.trim().toLowerCase();
    if (TRUE_SPELLINGS.includes(spelling)) return true;
    if (FALSE_SPELLINGS.includes(spelling)) return false;
  }
  throw new Error(
    `${path} must be true or false, or one of: ${[...TRUE_SPELLINGS, ...FALSE_SPELLINGS].join(", ")} ` +
      `(got ${JSON.stringify(value)}).`,
  );
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value.trim();
}

function nonEmpty(value: unknown, path: string): string {
  const trimmed = text(value, path);
  if (trimmed === "") throw new Error(`${path} must not be empty.`);
  return trimmed;
}

/** A secret is a string (possibly "") or an explicit null meaning "clear it". */
function secret(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${path} must be a string or null.`);
  return value.trim();
}

function url(value: unknown, path: string): string {
  const trimmed = text(value, path);
  if (trimmed === "") return trimmed; // "" means "use the provider default"
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${path} must be an absolute http(s) URL (got ${JSON.stringify(value)}).`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${path} must use http or https, not ${parsed.protocol.replace(":", "")}.`);
  }
  return trimmed;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${path} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Like `integer`, but for the VAD threshold, which is meaningful as a fraction
 * (0.6 is a legitimately stricter gate than 0.65). A whole-number-only rule
 * would have rejected the values operators most want to set.
 */
function numberInRange(value: unknown, path: string, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`${path} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

function countryCode(value: unknown): string {
  const trimmed = text(value, "autopilot.defaultCountryCode");
  if (trimmed === "") return trimmed;
  if (!/^\+?\d{1,4}$/.test(trimmed)) {
    throw new Error(`autopilot.defaultCountryCode must be a calling code like "1" or "+212".`);
  }
  return trimmed.replace(/^\+/, "");
}

/**
 * A stored agent's uuid, or "" for an inline one.
 *
 * Checked here because a typo'd id is not caught until session start, where it
 * surfaces as a server error mid-call rather than as anything naming the field.
 */
function agentId(value: unknown): string {
  const trimmed = text(value, "voiceAgent.agentId");
  if (trimmed === "") return trimmed;
  if (!UUID_PATTERN.test(trimmed)) {
    throw new Error(
      `voiceAgent.agentId must be the uuid of a stored agent, or "" to configure one inline ` +
        `(got ${JSON.stringify(value)}).`,
    );
  }
  return trimmed;
}

function keyterms(value: unknown, path: string = "assemblyai.keyterms"): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings.`);
  const terms: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${path} must contain strings only.`);
    }
    const term = entry.trim();
    if (term === "") continue;
    if (term.length > MAX_KEYTERM_CHARS) {
      throw new Error(
        `${path} entries are limited to ${MAX_KEYTERM_CHARS} characters ` +
          `("${term.slice(0, 20)}…" is ${term.length}).`,
      );
    }
    terms.push(term);
  }
  if (terms.length > MAX_KEYTERMS) {
    throw new Error(`${path} accepts at most ${MAX_KEYTERMS} terms (got ${terms.length}).`);
  }
  return terms;
}

/**
 * Validate one per-device voice agent entry. `null` fields mean "leave the
 * service default"; missing fields are tolerated for a partial save so the UI
 * does not have to round-trip the whole record every time.
 */
function deviceAgentConfig(value: unknown, path: string): DeviceAgentConfig {
  const raw = asObject(value, path);
  const turn = optionalObject(raw, "turnDetection");
  const nullOr = <T,>(field: unknown, reject: (v: unknown, p: string) => T, p: string): T | null =>
    field === null || field === undefined || field === "" ? null : reject(field, p);
  return {
    agentId: "agentId" in raw ? agentId(raw["agentId"]) : "",
    name: "name" in raw ? text(raw["name"], `${path}.name`) : "",
    voice:
      "voice" in raw
        ? oneOf(raw["voice"], VOICE_IDS, `${path}.voice`)
        : DEFAULT_VOICE_AGENT_VOICE,
    greeting: "greeting" in raw ? text(raw["greeting"], `${path}.greeting`) : "",
    systemPrompt:
      "systemPrompt" in raw ? text(raw["systemPrompt"], `${path}.systemPrompt`) : "",
    keyterms: "keyterms" in raw ? keyterms(raw["keyterms"], `${path}.keyterms`) : [],
    transcriptionMode: nullOr(
      raw["transcriptionMode"],
      (v, p) => oneOf(v, VOIP_AGENT_TRANSCRIPTION_MODES, p),
      `${path}.transcriptionMode`,
    ),
    voiceFocus: nullOr(
      raw["voiceFocus"],
      (v, p) => oneOf(v, VOIP_AGENT_FOCUS_MODES, p),
      `${path}.voiceFocus`,
    ),
    voiceFocusThreshold: nullOr(
      raw["voiceFocusThreshold"],
      (v, p) => numberInRange(v, p, 0, 1),
      `${path}.voiceFocusThreshold`,
    ),
    turnDetection: {
      vadThreshold: nullOr(
        turn?.["vadThreshold"],
        (v, p) => numberInRange(v, p, 0, 1),
        `${path}.turnDetection.vadThreshold`,
      ),
      minSilenceMs: nullOr(
        turn?.["minSilenceMs"],
        (v, p) => integer(v, p, 50, 10000),
        `${path}.turnDetection.minSilenceMs`,
      ),
      maxSilenceMs: nullOr(
        turn?.["maxSilenceMs"],
        (v, p) => integer(v, p, 50, 10000),
        `${path}.turnDetection.maxSilenceMs`,
      ),
      interruptResponse:
        turn && "interruptResponse" in turn
          ? boolean(turn["interruptResponse"], `${path}.turnDetection.interruptResponse`)
          : true,
      interruptionDelayMs: nullOr(
        turn?.["interruptionDelayMs"],
        (v, p) => integer(v, p, 0, 5000),
        `${path}.turnDetection.interruptionDelayMs`,
      ),
    },
    volume: nullOr(raw["volume"], (v, p) => integer(v, p, 0, 100), `${path}.volume`),
  };
}

/**
 * The service's supported language codes, e.g. "en", "fr", "ar-LB". Checked
 * here so a long or non-string entry is rejected at save time rather than
 * surfacing as a socket reject a few seconds into a call — the same reason
 * keyterms are checked. The codes themselves are not spell-checked against a
 * catalogue: the service adds codes, and a code it does not know is the
 * operator's to try.
 */
function languageCodes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("assemblyai.languageCodes must be an array of strings.");
  const codes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("assemblyai.languageCodes must contain strings only.");
    }
    const code = entry.trim();
    if (code === "") continue;
    if (code.length > MAX_LANGUAGE_CODE_CHARS) {
      throw new Error(
        `assemblyai.languageCodes entries are limited to ${MAX_LANGUAGE_CODE_CHARS} characters ` +
          `("${code.slice(0, 20)}…" is ${code.length}).`,
      );
    }
    codes.push(code);
  }
  if (codes.length > MAX_LANGUAGE_CODES) {
    throw new Error(
      `assemblyai.languageCodes accepts at most ${MAX_LANGUAGE_CODES} codes (got ${codes.length}).`,
    );
  }
  return codes;
}

/** Drop undefined entries; return undefined when nothing is left. */
function compact(source: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(source).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Drop sections the environment said nothing about. */
function compactSections(
  sections: Record<string, Record<string, unknown> | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sections).filter(([, section]) => section !== undefined),
  );
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes(PLACEHOLDER)) return undefined;
  return trimmed;
}

function splitList(value: string | undefined): string[] | undefined {
  const raw = clean(value);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function numeric(value: string | undefined): number | undefined {
  const raw = clean(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * A port from the environment. 0 is useless (the health server would bind an
 * ephemeral port nobody knows) and `parseSettingsPatch` rejects it, which would
 * make `baseline` discard the *entire* environment layer — every other variable
 * — for one bad port value. So here out-of-range just means "say nothing"; the
 * settings UI still rejects 0 loudly.
 */
function envPort(value: string | undefined): number | undefined {
  const n = numeric(value);
  return n !== undefined && n >= 1 && n <= 65535 ? n : undefined;
}

/** Any parseable number from the environment, or "say nothing". */
function envNumber(value: string | undefined): number | undefined {
  const raw = clean(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * A VAD threshold (0-1) from the environment. Out-of-range or unparseable means
 * "say nothing", for the same reason envPort does: a rejected value here would
 * make `baseline` discard the *entire* environment layer over one typo.
 */
function envThreshold(value: string | undefined): number | undefined {
  const n = envNumber(value);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
}

/**
 * A turn-silence length (50-10000 ms) from the environment. Same "say nothing"
 * lenience as envThreshold, so a bad fine-tune never takes the region and the
 * mode down with it.
 */
function envSilenceMs(value: string | undefined): number | undefined {
  const n = envNumber(value);
  return n !== undefined && Number.isInteger(n) && n >= 50 && n <= 10000 ? n : undefined;
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
