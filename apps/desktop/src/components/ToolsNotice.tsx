import { useCallback, useEffect, useState } from "react";
import type { ToolName, ToolStatus } from "../types";

const TOOL_INFO: Record<ToolName, { title: string; purpose: string }> = {
  adb: { title: "adb (Android platform-tools)", purpose: "detect and control phones" },
  scrcpy: { title: "scrcpy", purpose: "capture phone call audio" },
};

const ORDER: ToolName[] = ["adb", "scrcpy"];

/**
 * On-launch check of the external binaries NeuraCall needs (adb, scrcpy).
 * Each missing tool gets a dismissible banner with the per-OS install guide;
 * when everything is present a one-line green status shows the versions.
 * "Re-check" re-runs detection so the banner clears once the tool is installed.
 */
export function ToolsNotice() {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<ToolName>>(new Set());

  const refresh = useCallback(() => {
    setError(null);
    window.neuracall
      .checkTools()
      .then((all) => setTools(ORDER.map((name) => all[name]).filter(Boolean)))
      .catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.neuracall
      .checkTools()
      .then((all) => {
        if (!cancelled) setTools(ORDER.map((name) => all[name]).filter(Boolean));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="tool-notice tool-error">Could not check required tools: {error}</div>
    );
  }
  if (!tools) return null; // still loading

  const installed = tools.filter((t) => t.installed);
  const missing = tools.filter((t) => !t.installed && !dismissed.has(t.tool));

  return (
    <>
      {installed.length > 0 && (
        <div className="tool-notice tool-ready">
          <span className="tool-dot" aria-hidden="true" />
          {installed
            .map((t) => `${t.tool}${t.version ? ` (${t.version})` : ""}`)
            .join(" · ")}{" "}
          ready
        </div>
      )}
      {missing.map((t) => {
        const info = TOOL_INFO[t.tool];
        return (
          <div className="tool-notice tool-missing" key={t.tool}>
            <div className="tool-header">
              <strong>
                {info.title} is required to {info.purpose}
              </strong>
              <div className="tool-actions">
                <button type="button" onClick={refresh}>
                  Re-check
                </button>
                <button
                  type="button"
                  onClick={() => setDismissed((prev) => new Set(prev).add(t.tool))}
                >
                  Dismiss
                </button>
              </div>
            </div>
            <p>
              The <code>{t.binary}</code> binary was not found on this machine. Install it,
              then click “Re-check”.
            </p>
            <pre className="tool-guide">{t.installGuide}</pre>
          </div>
        );
      })}
    </>
  );
}
