import { useEffect, useState } from "react";
import { StatusBar } from "./components/StatusBar";
import { DevicePanel } from "./components/DevicePanel";
import { TranscriptView } from "./components/TranscriptView";
import { useLiveTranscript } from "./hooks/useLiveTranscript";

export interface ConfigInfo {
  region: string;
  speechModel: string;
  ready: boolean;
}

/**
 * NeuraCall desktop control center. Renders device state, live transcripts and
 * the AssemblyAI connection status. All data comes through the secure IPC
 * bridge (window.neuracall) — the API key never reaches this renderer.
 */
export function App() {
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const { turns, sessions } = useLiveTranscript();

  useEffect(() => {
    let cancelled = false;
    window.neuracall
      ?.getConfigInfo()
      .then((info) => {
        if (!cancelled) setConfig(info);
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
      <main className="layout">
        <aside className="sidebar">
          <DevicePanel />
        </aside>
        <section className="content">
          <TranscriptView turns={turns} sessions={sessions} />
        </section>
      </main>
    </div>
  );
}
