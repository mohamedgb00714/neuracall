import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AssemblyAIRegion,
  ProbeResult,
  RedactedSettings,
  SettingsPatch,
  SettingsProbe,
  TranscriptionMode,
  TtsProvider,
} from "../types";

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

const MAX_KEYTERMS = 100;

/** Form state. Numbers are held as strings so a half-typed value is not NaN. */
interface Form {
  region: AssemblyAIRegion;
  speechModel: string;
  mode: TranscriptionMode;
  keyterms: string;
  llmApiKey: string;
  llmClearKey: boolean;
  llmModel: string;
  llmBaseUrl: string;
  llmSystemPrompt: string;
  llmGreeting: string;
  ttsProvider: TtsProvider;
  ttsApiKey: string;
  ttsClearKey: boolean;
  ttsModel: string;
  ttsVoice: string;
  ttsBaseUrl: string;
  captureSource: string;
  injectSink: string;
  maxCallMs: string;
  stallMs: string;
  defaultCountryCode: string;
  healthPort: string;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

function toForm(s: RedactedSettings): Form {
  return {
    region: s.assemblyai.region,
    speechModel: s.assemblyai.speechModel,
    mode: s.assemblyai.mode,
    keyterms: s.assemblyai.keyterms.join("\n"),
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

    const body: SettingsPatch = {
      assemblyai: {
        region: form.region,
        speechModel: form.speechModel.trim(),
        mode: form.mode,
        keyterms: terms.slice(0, MAX_KEYTERMS),
      },
      llm: {
        // Trimmed, so a stray pasted newline cannot become part of the key —
        // and whitespace-only input falls back to "" (leave the stored key).
        apiKey: form.llmClearKey ? null : form.llmApiKey.trim(),
        model: form.llmModel.trim(),
        baseUrl: form.llmBaseUrl.trim(),
        systemPrompt: form.llmSystemPrompt,
        greeting: form.llmGreeting,
      },
      tts: {
        provider: form.ttsProvider,
        apiKey: form.ttsClearKey ? null : form.ttsApiKey.trim(),
        model: form.ttsModel.trim(),
        voice: form.ttsVoice.trim(),
        baseUrl: form.ttsBaseUrl.trim(),
      },
      audio: {
        captureSource: form.captureSource.trim(),
        injectSink: form.injectSink.trim(),
      },
      autopilot: {
        maxCallMs,
        stallMs,
        defaultCountryCode: form.defaultCountryCode.trim(),
        healthPort,
      },
    };

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
        <h2>AI agent (LLM)</h2>
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

      <section className="settings-group">
        <h2>Voice (TTS)</h2>
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
          <code>mic</code> records the phone’s microphone — <strong>your</strong> side of the
          call. To transcribe the far end the phone must allow{" "}
          <code>voice-call-downlink</code> (privileged, OEM-dependent), or the call has to be on
          speakerphone so <code>output</code> picks the caller up.
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
        <p className="settings-note">Tests the saved settings, not unsaved edits.</p>
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
