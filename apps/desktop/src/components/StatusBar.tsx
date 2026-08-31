import type { ConfigInfo } from "../App";

export function StatusBar({
  config,
  configError,
}: {
  config: ConfigInfo | null;
  configError: string | null;
}) {
  return (
    <header className="statusbar">
      <span className="brand">NeuraCall</span>

      {configError ? (
        <span className="pill pill-error" title={configError}>
          Config error — check .env
        </span>
      ) : config?.ready ? (
        <span className="pill pill-ok">AssemblyAI connected</span>
      ) : (
        <span className="pill pill-unknown">Connecting…</span>
      )}

      {config && (
        <span className="pill">
          region: <code>{config.region}</code>
        </span>
      )}
      {config && (
        <span className="pill">
          model: <code>{config.speechModel}</code>
        </span>
      )}
    </header>
  );
}
