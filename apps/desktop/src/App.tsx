import { useEffect, useState } from "react";
import { StatusBar } from "./components/StatusBar";
import { DevicePanel } from "./components/DevicePanel";
import { TranscriptView } from "./components/TranscriptView";
import { ToolsNotice } from "./components/ToolsNotice";
import { AutopilotPanel } from "./components/AutopilotPanel";
import { SettingsPage } from "./components/SettingsPage";
import { useLiveTranscript } from "./hooks/useLiveTranscript";

type Tab = "calls" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "calls", label: "Calls" },
  { id: "settings", label: "Settings" },
];

export interface ConfigInfo {
  region: string;
  speechModel: string;
  ready: boolean;
  /** Set when the main process could not start the runtime (e.g. missing API key). */
  error: string | null;
}

/**
 * NeuraCall desktop control center. Renders device state, live transcripts and
 * the AssemblyAI connection status. All data comes through the secure IPC
 * bridge (window.neuracall) — the API key never reaches this renderer.
 */
export function App() {
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("calls");
  const { turns, sessions } = useLiveTranscript();

  useEffect(() => {
    let cancelled = false;
    window.neuracall
      ?.getConfigInfo()
      .then((info) => {
        if (cancelled) return;
        setConfig(info);
        if (!info.ready && info.error) setConfigError(info.error);
      })
      .catch((err) => {
        if (!cancelled) setConfigError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <StatusBar config={config} configError={configError} />
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* Both panels stay mounted: switching tabs must not drop the device
          subscriptions or throw away half-typed settings. */}
      <div className="tab-panel" hidden={tab !== "calls"}>
        <ToolsNotice />
        <main className="layout">
          <aside className="sidebar">
            <DevicePanel />
          </aside>
          <section className="content">
            <AutopilotPanel />
            <TranscriptView turns={turns} sessions={sessions} />
          </section>
        </main>
      </div>

      <div className="tab-panel" hidden={tab !== "settings"}>
        <SettingsPage />
      </div>
    </div>
  );
}
