import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  AssemblyAIRegion,
  DeviceAgentDraft,
  NeuraCallDevice,
  ProbeResult,
  RedactedSettings,
  SettingsProbe,
  TranscriptionMode,
  TtsProvider,
} from "../types";
import { MAX_KEYTERMS, toPatch, type Form } from "../settingsPatch";
import {
  UNDERSTOOD_LANGUAGE_COUNT,
  VOICES,
  isKnownVoice,
  spokenLanguageList,
  voiceLabel,
} from "../voices";

const REGIONS: { value: AssemblyAIRegion; label: string }[] = [
  { value: "edge", label: "edge — routed, lowest latency" },
  { value: "us", label: "us — pinned to the US cluster" },
  { value: "eu", label: "eu — pinned to the EU cluster" },
];

const MODES: { value: TranscriptionMode; label: string }[] = [
  { value: "min_latency", label: "min_latency — answer fastest" },
  { value: "balanced", label: "balanced" },
  { value: "max_accuracy", label: "max_accuracy — transcribe best" },
];

const TTS_PROVIDERS: TtsProvider[] = ["auto", "openai", "elevenlabs", "command", "silent"];

/** scrcpy --audio-source values that can carry call audio, cleanest first. */
const CAPTURE_SOURCES = ["voice-call-downlink", "voice-call", "output", "playback", "mic"];

type SaveState =
  { kind: "idle" } | { kind: "pending" } | { kind: "saved" } | { kind: "error"; message: string };

function toForm(s: RedactedSettings): Form {
  return {
    region: s.assemblyai.region,
    speechModel: s.assemblyai.speechModel,
    mode: s.assemblyai.mode,
    keyterms: s.assemblyai.keyterms.join("\n"),
    voiceAgentEnabled: s.voiceAgent.enabled,
    voiceAgentId: s.voiceAgent.agentId,
    voiceAgentVoice: s.voiceAgent.voice,
    voiceAgentGreeting: s.voiceAgent.greeting,
    voiceAgentSystemPrompt: s.voiceAgent.systemPrompt,
    // Key inputs always start empty: "" is the wire value for "unchanged".
    llmApiKey: "",
    llmClearKey: false,
    llmModel: s.llm.model,
    llmBaseUrl: s.llm.baseUrl,
    llmSystemPrompt: s.llm.systemPrompt,
    llmGreeting: s.llm.greeting,
    ttsProvider: s.tts.provider,
    ttsApiKey: "",
    ttsClearKey: false,
    ttsModel: s.tts.model,
    ttsVoice: s.tts.voice,
    ttsBaseUrl: s.tts.baseUrl,
    captureSource: s.audio.captureSource,
    injectSink: s.audio.injectSink,
    autopilotAutoStart: s.autopilot.autoStart,
    maxCallMs: String(s.autopilot.maxCallMs),
    stallMs: String(s.autopilot.stallMs),
    defaultCountryCode: s.autopilot.defaultCountryCode,
    healthPort: s.autopilot.healthPort === null ? "" : String(s.autopilot.healthPort),
  };
}

function parseKeyterms(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function parseMs(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** null is a real value (health server off); undefined means the input is junk. */
function parsePort(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Settings for every service a call touches: AssemblyAI, the LLM, TTS, scrcpy
 * capture and the autopilot limits.
 *
 * Secrets move one way only. The page is never given a stored key — it renders
 * "stored"/"not set" from `hasApiKey` — and a blank key field saves as "",
 * which the main process reads as "leave it alone". Clearing a key takes the
 * explicit Clear button, which sends null.
 */
export function SettingsPage() {
  const [settings, setSettings] = useState<RedactedSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [probe, setProbe] = useState<SettingsProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [drifted, setDrifted] = useState(false);
  // A checkbox is only labelled if the <label> can name it, so the id has to
  // exist before the early returns below — hooks cannot run after them.
  const voiceAgentToggleId = useId();
  const autopilotAutoStartId = useId();
  // Ref, not state: the subscription below has to read it without re-running.
  const dirtyRef = useRef(false);

  useEffect(() => {
    const bridge = window.neuracall;
    if (!bridge) return; // electron bridge not ready yet
    let cancelled = false;

    bridge
      .getSettings()
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
        setForm(toForm(next));
        dirtyRef.current = false;
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(String(err));
      });

    const off = bridge.onSettingsChanged((next) => {
      setSettings(next);
      // Someone else (or a reset) changed the file. Adopt it silently when
      // nothing is half-typed; otherwise say so and let the user choose.
      if (dirtyRef.current) setDrifted(true);
      else setForm(toForm(next));
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (loadError) {
    return (
      <div className="settings">
        <p className="settings-error">Could not load settings: {loadError}</p>
      </div>
    );
  }
  if (!settings || !form) {
    return (
      <div className="settings">
        <p className="empty">Loading settings…</p>
      </div>
    );
  }

  const patch = (changes: Partial<Form>) => {
    dirtyRef.current = true;
    setSaveState({ kind: "idle" });
    setForm((prev) => (prev ? { ...prev, ...changes } : prev));
  };

  const reload = (next: RedactedSettings) => {
    setSettings(next);
    setForm(toForm(next));
    dirtyRef.current = false;
    setDrifted(false);
  };

  const terms = parseKeyterms(form.keyterms);
  // Read from the form, not from `settings`: flipping the toggle has to grey
  // out the LLM and TTS sections immediately, or the operator keeps filling in
  // fields that the call it is about to make will never read.
  const voiceAgentOn = form.voiceAgentEnabled;

  const save = async () => {
    const maxCallMs = parseMs(form.maxCallMs);
    const stallMs = parseMs(form.stallMs);
    const healthPort = parsePort(form.healthPort);
    if (maxCallMs === null || stallMs === null) {
      setSaveState({ kind: "error", message: "Durations must be a positive number of ms." });
      return;
    }
    if (healthPort === undefined) {
      setSaveState({ kind: "error", message: "Health port must be 1–65535, or blank for off." });
      return;
    }

    const body = toPatch(form, terms, { maxCallMs, stallMs, healthPort });

    setSaveState({ kind: "pending" });
    try {
      const result = await window.neuracall.saveSettings(body);
      if (result.ok && result.settings) {
        reload(result.settings);
        setSaveState({ kind: "saved" });
      } else {
        setSaveState({ kind: "error", message: result.error ?? "Save failed." });
      }
    } catch (err) {
      setSaveState({ kind: "error", message: String(err) });
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      setProbe(await window.neuracall.probeSettings());
    } catch (err) {
      setProbe(null);
      setProbeError(String(err));
    } finally {
      setProbing(false);
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setSaveState({ kind: "pending" });
    try {
      reload(await window.neuracall.resetSettings());
      setProbe(null);
      setSaveState({ kind: "idle" });
    } catch (err) {
      setSaveState({ kind: "error", message: String(err) });
    }
  };

  return (
    <div className="settings">
      {drifted && (
        <div className="settings-drift">
          Settings changed elsewhere while you were editing.
          <button type="button" onClick={() => reload(settings)}>
            Discard my edits and reload
          </button>
        </div>
      )}

      <section className="settings-group">
        <h2>Speech-to-text (AssemblyAI)</h2>
        <Field label="Region">
          <select
            value={form.region}
            onChange={(e) => patch({ region: e.target.value as AssemblyAIRegion })}
          >
            {REGIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Speech model">
          <input
            type="text"
            value={form.speechModel}
            placeholder="universal-3-5-pro"
            onChange={(e) => patch({ speechModel: e.target.value })}
          />
        </Field>
        <Field label="Mode" hint="Latency against accuracy for the streaming turn model.">
          <select
            value={form.mode}
            onChange={(e) => patch({ mode: e.target.value as TranscriptionMode })}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Key terms"
          hint={
            `One per line. Names, products, anything the model keeps mishearing. ` +
            `${terms.length}/${MAX_KEYTERMS}` +
            (terms.length > MAX_KEYTERMS ? ` — only the first ${MAX_KEYTERMS} are sent` : "")
          }
        >
          <textarea
            rows={5}
            value={form.keyterms}
            placeholder={"NeuraCall\nAssemblyAI"}
            onChange={(e) => patch({ keyterms: e.target.value })}
          />
        </Field>
      </section>

      <section className="settings-group">
        <h2>Voice agent (AssemblyAI)</h2>
        <Toggle
          id={voiceAgentToggleId}
          label="Answer calls with AssemblyAI’s Voice Agent"
          checked={form.voiceAgentEnabled}
          onChange={(enabled) => patch({ voiceAgentEnabled: enabled })}
          hint={
            "Turning this on replaces the separate LLM and TTS providers with " +
            "AssemblyAI’s own, on the key already configured above — so it needs " +
            "no extra credentials."
          }
        />

        <p className="settings-callout">
          <strong>The agent speaks {spokenLanguageList()}, and nothing else.</strong> It{" "}
          <em>understands</em> {UNDERSTOOD_LANGUAGE_COUNT} languages, so it will follow a caller
          speaking Arabic, Darija or French — but there is no Arabic voice, and it replies in the
          language of the voice you pick below whatever the caller speaks. For Arabic-speaking
          callers, leave this off and use the LLM and TTS providers instead.
        </p>

        <Field label="Voice" hint="Picks both the voice and the language the agent answers in.">
          <select
            value={form.voiceAgentVoice}
            onChange={(e) => patch({ voiceAgentVoice: e.target.value })}
          >
            {/* A voice set from the environment that this build does not know
                is still shown, so opening the dropdown cannot silently rewrite
                it to something the operator never chose. */}
            {!isKnownVoice(form.voiceAgentVoice) && (
              <option value={form.voiceAgentVoice}>
                {form.voiceAgentVoice === ""
                  ? "— no voice set —"
                  : `${form.voiceAgentVoice} — unknown voice`}
              </option>
            )}
            {VOICES.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voiceLabel(voice)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Greeting" hint="The first thing said after answering. Blank opens silently.">
          <textarea
            rows={2}
            value={form.voiceAgentGreeting}
            placeholder="Hello, thanks for calling. How can I help?"
            onChange={(e) => patch({ voiceAgentGreeting: e.target.value })}
          />
        </Field>

        <Field
          label="System prompt"
          hint="How the agent behaves on every call. Blank uses the NeuraCall house prompt."
        >
          <textarea
            rows={6}
            value={form.voiceAgentSystemPrompt}
            onChange={(e) => patch({ voiceAgentSystemPrompt: e.target.value })}
          />
        </Field>

        <Field
          label="Stored agent ID"
          hint={
            "Optional. Only needed to run the agent on your own LLM, which " +
            "AssemblyAI accepts only on a stored agent. Leave it blank and the " +
            "fields above configure the agent inline on each call."
          }
        >
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={form.voiceAgentId}
            placeholder="blank = configure inline"
            onChange={(e) => patch({ voiceAgentId: e.target.value })}
          />
        </Field>
      </section>

      <section className="settings-group">
        <h2>Per-phone voice agents</h2>
        <DeviceAgentsCard settings={settings} reload={reload} />
      </section>

      <section className={`settings-group${voiceAgentOn ? " settings-group-unused" : ""}`}>
        <h2>
          AI agent (LLM)
          {voiceAgentOn && <span className="settings-unused-tag">not used right now</span>}
        </h2>
        {voiceAgentOn && (
          <p className="settings-note">
            The Voice Agent does its own reasoning, so nothing here is read on a call. These
            settings are still saved, and take over again the moment you turn it off.
          </p>
        )}
        <Field label="Base URL">
          <input
            type="url"
            value={form.llmBaseUrl}
            placeholder="https://openrouter.ai/api/v1"
            onChange={(e) => patch({ llmBaseUrl: e.target.value })}
          />
        </Field>
        <Field label="Model">
          <input
            type="text"
            value={form.llmModel}
            onChange={(e) => patch({ llmModel: e.target.value })}
          />
        </Field>
        <KeyField
          label="API key"
          value={form.llmApiKey}
          stored={settings.llm.hasApiKey}
          clearing={form.llmClearKey}
          onChange={(value) => patch({ llmApiKey: value, llmClearKey: false })}
          onToggleClear={() => patch({ llmClearKey: !form.llmClearKey, llmApiKey: "" })}
        />
        <Field label="System prompt" hint="How the agent behaves on every call.">
          <textarea
            rows={6}
            value={form.llmSystemPrompt}
            onChange={(e) => patch({ llmSystemPrompt: e.target.value })}
          />
        </Field>
        <Field label="Greeting" hint="The first thing said after answering.">
          <textarea
            rows={2}
            value={form.llmGreeting}
            onChange={(e) => patch({ llmGreeting: e.target.value })}
          />
        </Field>
      </section>

      <section className={`settings-group${voiceAgentOn ? " settings-group-unused" : ""}`}>
        <h2>
          Voice (TTS)
          {voiceAgentOn && <span className="settings-unused-tag">not used right now</span>}
        </h2>
        {voiceAgentOn && (
          <p className="settings-note">
            The Voice Agent speaks with its own voice — set that in the section above. Nothing here
            is read on a call while it is on.
          </p>
        )}
        <Field
          label="Provider"
          hint="“auto” picks whichever provider is configured; “silent” speaks nothing."
        >
          <select
            value={form.ttsProvider}
            onChange={(e) => patch({ ttsProvider: e.target.value as TtsProvider })}
          >
            {TTS_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <KeyField
          label="API key"
          value={form.ttsApiKey}
          stored={settings.tts.hasApiKey}
          clearing={form.ttsClearKey}
          onChange={(value) => patch({ ttsApiKey: value, ttsClearKey: false })}
          onToggleClear={() => patch({ ttsClearKey: !form.ttsClearKey, ttsApiKey: "" })}
        />
        <Field label="Model">
          <input
            type="text"
            value={form.ttsModel}
            onChange={(e) => patch({ ttsModel: e.target.value })}
          />
        </Field>
        <Field label="Voice">
          <input
            type="text"
            value={form.ttsVoice}
            onChange={(e) => patch({ ttsVoice: e.target.value })}
          />
        </Field>
        <Field label="Base URL">
          <input
            type="url"
            value={form.ttsBaseUrl}
            onChange={(e) => patch({ ttsBaseUrl: e.target.value })}
          />
        </Field>
      </section>

      <section className="settings-group">
        <h2>Audio</h2>
        <Field
          label="Capture source"
          hint="scrcpy --audio-source. What works is per-phone — see docs/AUDIO-ABI.md."
        >
          <input
            type="text"
            list="capture-sources"
            value={form.captureSource}
            placeholder="mic"
            onChange={(e) => patch({ captureSource: e.target.value })}
          />
          <datalist id="capture-sources">
            {CAPTURE_SOURCES.map((source) => (
              <option key={source} value={source} />
            ))}
          </datalist>
        </Field>
        <p className="settings-note">
          <code>mic</code> records the phone’s microphone — <strong>your</strong> side of the call.
          To transcribe the far end the phone must allow <code>voice-call-downlink</code>{" "}
          (privileged, OEM-dependent), or the call has to be on speakerphone so <code>output</code>{" "}
          picks the caller up.
        </p>
        <Field
          label="Injection sink"
          hint="Where the agent’s voice goes back into the call. Blank turns injection off."
        >
          <input
            type="text"
            value={form.injectSink}
            placeholder="blank = injection off"
            onChange={(e) => patch({ injectSink: e.target.value })}
          />
        </Field>
      </section>

      <section className="settings-group">
        <h2>Autopilot</h2>
        <Toggle
          id={autopilotAutoStartId}
          label="Answer calls as soon as the app starts"
          checked={form.autopilotAutoStart}
          hint="On by default. While this is on, a machine running NeuraCall is a machine answering the phone — real inbound calls are picked up with no further confirmation. Turn it off for a console that watches without acting; you can still start answering by hand from the Calls tab."
          onChange={(autopilotAutoStart) => patch({ autopilotAutoStart })}
        />
        <Field label="Max call duration (ms)" hint="Hard stop, however the conversation is going.">
          <input
            type="number"
            min={1}
            value={form.maxCallMs}
            onChange={(e) => patch({ maxCallMs: e.target.value })}
          />
        </Field>
        <Field
          label="Stall timeout (ms)"
          hint="Silence after which the agent gives up on the caller."
        >
          <input
            type="number"
            min={1}
            value={form.stallMs}
            onChange={(e) => patch({ stallMs: e.target.value })}
          />
        </Field>
        <Field label="Default country code" hint="Prefixed to numbers dialled without one.">
          <input
            type="text"
            value={form.defaultCountryCode}
            placeholder="+1"
            onChange={(e) => patch({ defaultCountryCode: e.target.value })}
          />
        </Field>
        <Field label="Health port" hint="HTTP health endpoint. Blank leaves it off.">
          <input
            type="number"
            min={1}
            max={65535}
            value={form.healthPort}
            placeholder="off"
            onChange={(e) => patch({ healthPort: e.target.value })}
          />
        </Field>
      </section>

      <section className="settings-group">
        <h2>Connection test</h2>
        <button type="button" onClick={() => void runProbe()} disabled={probing}>
          {probing ? "Testing…" : "Test connection"}
        </button>
        <p className="settings-note">
          Tests the saved settings, not unsaved edits.
          {voiceAgentOn &&
            " The Voice Agent runs on the AssemblyAI key, so the LLM and TTS rows say nothing about whether a call will work."}
        </p>
        {probeError && <p className="settings-error">{probeError}</p>}
        {probe && (
          <ul className="probe-list">
            <ProbeRow label="AssemblyAI" result={probe.assemblyai} />
            <ProbeRow label="LLM" result={probe.llm} />
            <ProbeRow label="TTS" result={probe.tts} />
          </ul>
        )}
      </section>

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-start"
          onClick={() => void save()}
          disabled={saveState.kind === "pending"}
        >
          {saveState.kind === "pending" ? "Saving…" : "Save settings"}
        </button>
        {saveState.kind === "saved" && <span className="settings-ok">Saved.</span>}
        {saveState.kind === "error" && <span className="settings-error">{saveState.message}</span>}

        {confirmReset ? (
          <span className="settings-confirm">
            This erases every setting and deletes the stored API keys.
            <button type="button" className="btn btn-stop" onClick={() => void reset()}>
              Reset everything
            </button>
            <button type="button" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="settings-reset" onClick={() => setConfirmReset(true)}>
            Reset to defaults
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      {children}
      {hint && <span className="settings-hint">{hint}</span>}
    </label>
  );
}

/**
 * A boolean setting. The checkbox stays in the DOM and keeps its own focus and
 * keyboard behaviour — the track and knob are painted around it, not instead of
 * it, so `htmlFor` names a real control and Tab/Space still work.
 */
function Toggle(props: {
  id: string;
  label: string;
  checked: boolean;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  const { id, label, checked, hint, onChange } = props;
  return (
    <div className="settings-field">
      <label className="settings-toggle" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="settings-toggle-input"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="settings-toggle-track" aria-hidden="true">
          <span className="settings-toggle-knob" />
        </span>
        <span>{label}</span>
      </label>
      {hint && <span className="settings-hint">{hint}</span>}
    </div>
  );
}

function KeyField(props: {
  label: string;
  value: string;
  stored: boolean;
  clearing: boolean;
  onChange: (value: string) => void;
  onToggleClear: () => void;
}) {
  const { label, value, stored, clearing, onChange, onToggleClear } = props;
  return (
    <label className="settings-field">
      <span className="settings-label">
        {label}
        <span className={`pill ${stored ? "pill-on" : "pill-off"}`}>
          {stored ? "stored" : "not set"}
        </span>
      </span>
      <span className="settings-key-row">
        <input
          type="password"
          autoComplete="off"
          value={value}
          disabled={clearing}
          placeholder={stored ? "leave blank to keep the stored key" : "paste a key"}
          onChange={(e) => onChange(e.target.value)}
        />
        {(stored || clearing) && (
          <button type="button" onClick={onToggleClear}>
            {clearing ? "Keep it" : "Clear"}
          </button>
        )}
      </span>
      {clearing && (
        <span className="settings-hint settings-warn">The stored key is deleted on save.</span>
      )}
    </label>
  );
}

function ProbeRow({ label, result }: { label: string; result: ProbeResult }) {
  return (
    <li className={`probe-row ${result.ok ? "probe-ok" : "probe-fail"}`}>
      <span className="probe-name">{label}</span>
      <span className="probe-mark">{result.ok ? "✓" : "✕"}</span>
      <span className="probe-detail">{result.detail}</span>
    </li>
  );
}

// ------------------------------------------------------------------ per-device agents
// One AssemblyAI stored agent per attached phone. Saves go over their own IPC
// channels (voip-agents:save/delete) and set settings in the main process, so
// this card never touches the main form's `dirtyRef` — editing it must not mark
// the whole settings page as having unsaved changes.

type AgentForm = {
  name: string;
  voice: string;
  greeting: string;
  systemPrompt: string;
  keyterms: string;
  transcriptionMode: "" | TranscriptionMode;
  voiceFocus: "" | "near-field" | "far-field";
};

const EMPTY_AGENT_FORM: AgentForm = {
  name: "",
  voice: "",
  greeting: "",
  systemPrompt: "",
  keyterms: "",
  transcriptionMode: "",
  voiceFocus: "",
};

function deviceAgentForm(existing: DeviceAgentDraft): AgentForm {
  return {
    name: existing.name,
    voice: existing.voice,
    greeting: existing.greeting,
    systemPrompt: existing.systemPrompt,
    keyterms: existing.keyterms.join("\n"),
    transcriptionMode: existing.transcriptionMode ?? "",
    voiceFocus: existing.voiceFocus ?? "",
  };
}

type AgentSaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved"; agentId: string }
  | { kind: "error"; message: string };

function DeviceAgentsCard({
  settings,
  reload,
}: {
  settings: RedactedSettings;
  reload: (next: RedactedSettings) => void;
}) {
  const [devices, setDevices] = useState<NeuraCallDevice[]>([]);
  const [selected, setSelected] = useState("");
  const [form, setForm] = useState<AgentForm>(EMPTY_AGENT_FORM);
  const [saveState, setSaveState] = useState<AgentSaveState>({ kind: "idle" });

  useEffect(() => {
    const bridge = window.neuracall;
    if (!bridge) return;
    let cancelled = false;

    bridge
      .listDevices()
      .then((list) => {
        if (!cancelled) setDevices(list);
      })
      .catch(() => {});

    const off = bridge.onDevicesChange((updated) => {
      setDevices((prev) =>
        [...prev.filter((d) => d.id !== updated.id), updated].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      );
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Keep the selection on a real device: the first attached one by default,
  // and a new first-attached one when the current one goes away.
  useEffect(() => {
    if (devices.length === 0) {
      setSelected("");
      return;
    }
    if (devices.some((d) => d.id === selected)) return;
    const fallback = devices.find((d) => d.adbState === "device") ?? devices[0];
    setSelected(fallback?.id ?? "");
  }, [devices, selected]);

  // The stored entry is the form's source of truth whenever it changes, so a
  // save or a delete made elsewhere shows up without a reload button.
  useEffect(() => {
    const existing = selected === "" ? undefined : settings.voipAgents[selected];
    setForm(existing ? deviceAgentForm(existing) : EMPTY_AGENT_FORM);
  }, [selected, settings]);

  if (devices.length === 0) {
    return (
      <p className="empty">
        No phones detected. Connect a phone via ADB (USB or Wi-Fi) and it will appear here.
      </p>
    );
  }

  const patchForm = (changes: Partial<AgentForm>) => {
    setSaveState({ kind: "idle" });
    setForm((prev) => ({ ...prev, ...changes }));
  };

  const save = async () => {
    if (selected === "") return;
    const existing = settings.voipAgents[selected];
    const draft: DeviceAgentDraft = {
      agentId: existing?.agentId ?? "",
      name: form.name,
      voice: form.voice,
      greeting: form.greeting,
      systemPrompt: form.systemPrompt,
      keyterms: parseKeyterms(form.keyterms),
      transcriptionMode: form.transcriptionMode === "" ? null : form.transcriptionMode,
      voiceFocus: form.voiceFocus === "" ? null : form.voiceFocus,
      // Keep the knobs this card does not expose at the service defaults.
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

    setSaveState({ kind: "pending" });
    try {
      const result = await window.neuracall.saveVoipAgent(selected, draft);
      if (result.ok) {
        setSaveState({ kind: "saved", agentId: result.agentId ?? "" });
        reload(await window.neuracall.getSettings());
      } else {
        setSaveState({ kind: "error", message: result.error ?? "Save failed." });
      }
    } catch (err) {
      setSaveState({ kind: "error", message: String(err) });
    }
  };

  const remove = async () => {
    if (selected === "") return;
    setSaveState({ kind: "pending" });
    try {
      const result = await window.neuracall.deleteVoipAgent(selected);
      if (result.ok) {
        setSaveState({ kind: "idle" });
        reload(await window.neuracall.getSettings());
      } else {
        setSaveState({ kind: "error", message: result.error ?? "Delete failed." });
      }
    } catch (err) {
      setSaveState({ kind: "error", message: String(err) });
    }
  };

  const hasStored = selected !== "" && settings.voipAgents[selected] !== undefined;

  return (
    <div>
      <Field label="Device" hint="Which attached phone this agent answers for.">
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setSaveState({ kind: "idle" });
          }}
        >
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label ?? device.id}
              {device.adbState !== "device" ? ` — ${device.adbState}` : ""}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Agent name" hint="The stored agent's name; what CRM and logs show.">
        <input
          type="text"
          value={form.name}
          placeholder="Front desk EN"
          onChange={(e) => patchForm({ name: e.target.value })}
        />
      </Field>

      <Field label="Voice" hint="Picks both the voice and the language this phone's agent answers in.">
        <select
          value={form.voice}
          onChange={(e) => patchForm({ voice: e.target.value })}
        >
          {/* A voice set from settings that this build does not know is still
              shown, so opening the dropdown cannot silently rewrite it. */}
          {!isKnownVoice(form.voice) && (
            <option value={form.voice}>
              {form.voice === ""
                ? "— no voice set —"
                : `${form.voice} — unknown voice`}
            </option>
          )}
          {VOICES.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voiceLabel(voice)}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Greeting" hint="The first thing said after answering. Blank opens silently.">
        <textarea
          rows={2}
          value={form.greeting}
          placeholder="Hello, thanks for calling. How can I help?"
          onChange={(e) => patchForm({ greeting: e.target.value })}
        />
      </Field>

      <Field
        label="System prompt"
        hint="How this phone's agent behaves on every call. Blank uses the NeuraCall house prompt."
      >
        <textarea
          rows={6}
          value={form.systemPrompt}
          onChange={(e) => patchForm({ systemPrompt: e.target.value })}
        />
      </Field>

      <Field
        label="Key terms"
        hint="One per line or comma-separated. Names, products, anything the model keeps mishearing on this phone."
      >
        <textarea
          rows={4}
          value={form.keyterms}
          placeholder={"NeuraCall\nwarranty"}
          onChange={(e) => patchForm({ keyterms: e.target.value })}
        />
      </Field>

      <Field label="Transcription mode" hint="Latency against accuracy for this phone's calls.">
        <select
          value={form.transcriptionMode}
          onChange={(e) =>
            patchForm({ transcriptionMode: e.target.value as "" | TranscriptionMode })
          }
        >
          <option value="">— service default —</option>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Voice focus"
        hint="Picks the microphone field: near-field for the caller speaking close, far-field for the room."
      >
        <select
          value={form.voiceFocus}
          onChange={(e) =>
            patchForm({ voiceFocus: e.target.value as "" | "near-field" | "far-field" })
          }
        >
          <option value="">— service default —</option>
          <option value="near-field">near-field</option>
          <option value="far-field">far-field</option>
        </select>
      </Field>

      <div className="device-agents-actions">
        <button
          type="button"
          className="btn btn-start"
          onClick={() => void save()}
          disabled={saveState.kind === "pending"}
        >
          {saveState.kind === "pending" ? "Saving…" : "Save agent"}
        </button>
        {hasStored && (
          <button
            type="button"
            className="btn btn-stop"
            onClick={() => void remove()}
            disabled={saveState.kind === "pending"}
          >
            Delete agent
          </button>
        )}
      </div>

      {!hasStored && <p className="muted">No agent saved for this phone yet — Save creates one.</p>}
      {saveState.kind === "saved" && (
        <p className="settings-ok">Saved — agent {saveState.agentId}</p>
      )}
      {saveState.kind === "error" && <p className="settings-error">{saveState.message}</p>}
    </div>
  );
}
