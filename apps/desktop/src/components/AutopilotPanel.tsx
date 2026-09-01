import { useCallback, useEffect, useState } from "react";
import type { AutopilotStatus, CallRecord, TranscriptEntry } from "../types";

/** Calls keyed by id, newest first, with their transcripts kept live. */
type CallMap = Map<string, CallRecord>;

function sortedCalls(calls: CallMap): CallRecord[] {
  return [...calls.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Autonomous answering: the on/off switch, an honest report of what is not
 * configured, and the live call board.
 *
 * The switch is deliberately explicit. Turning it on makes the app answer real
 * inbound calls on real phones without asking again, so it never engages by
 * itself and the button says what it will do.
 */
export function AutopilotPanel() {
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  const [calls, setCalls] = useState<CallMap>(() => new Map());
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const next = await window.neuracall?.autopilotStatus();
    setStatus(next ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.neuracall
      ?.autopilotStatus()
      .then((next) => {
        if (!cancelled) setStatus(next ?? null);
      })
      .catch(() => undefined);

    const offCall = window.neuracall?.onAutopilotCall((record) => {
      setCalls((prev) => {
        const next = new Map(prev);
        // A record arrives repeatedly as the call progresses; the latest wins.
        next.set(record.callId, record);
        return next;
      });
      void refresh();
    });

    const offTranscript = window.neuracall?.onAutopilotTranscript(({ callId, entry }) => {
      setCalls((prev) => {
        const existing = prev.get(callId);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(callId, { ...existing, transcript: [...existing.transcript, entry] });
        return next;
      });
    });

    const offState = window.neuracall?.onAutopilotState(({ callId, state }) => {
      setCalls((prev) => {
        const existing = prev.get(callId);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(callId, { ...existing, state });
        return next;
      });
      void refresh();
    });

    const offError = window.neuracall?.onAutopilotError(({ message }) => {
      // Keep only the most recent few: an unbounded log would grow all session.
      setErrors((prev) => [message, ...prev].slice(0, 5));
    });

    return () => {
      cancelled = true;
      offCall?.();
      offTranscript?.();
      offState?.();
      offError?.();
    };
  }, [refresh]);

  // A live call's duration has to come from state, not Date.now() during
  // render: reading the clock while rendering is impure, and the number would
  // freeze until some unrelated re-render happened to move it.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const toggle = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    try {
      const result = status.enabled
        ? await window.neuracall?.disableAutopilot()
        : await window.neuracall?.enableAutopilot();
      if (result?.status) setStatus(result.status);
      else if (result?.error) setErrors((prev) => [result.error!, ...prev].slice(0, 5));
    } finally {
      setBusy(false);
    }
  }, [status]);

  if (!status) {
    return (
      <section className="autopilot">
        <h2>Autopilot</h2>
        <p className="muted">Unavailable — the runtime did not start.</p>
      </section>
    );
  }

  const live = sortedCalls(calls).filter((c) => c.state !== "ended");
  const finished = sortedCalls(calls).filter((c) => c.state === "ended");

  return (
    <section className="autopilot">
      <header className="autopilot-head">
        <h2>Autopilot</h2>
        <span className={`pill ${status.enabled ? "pill-on" : "pill-off"}`}>
          {status.enabled ? "answering calls" : "off"}
        </span>
        {/* Which pipeline is live decides whether the LLM and TTS settings mean
            anything, so it is stated here rather than inferred from silence. */}
        <span className="pill">{status.voiceAgent ? "voice agent" : "LLM + TTS"}</span>
        <button type="button" onClick={() => void toggle()} disabled={busy}>
          {status.enabled ? "Stop answering" : "Start answering calls"}
        </button>
      </header>

      <p className="muted">
        {status.voiceAgent
          ? "AssemblyAI Voice Agent — one socket does speech, reasoning and voice. The LLM and TTS settings are not used."
          : "AssemblyAI speech-to-text → LLM → TTS."}
      </p>

      <p className="muted">
        {status.handled} call{status.handled === 1 ? "" : "s"} handled · {status.activeCalls} active
      </p>

      {status.degraded.length > 0 && (
        <ul className="degraded">
          {status.degraded.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <ul className="autopilot-errors">
          {errors.map((message, i) => (
            <li key={`${message}-${i}`}>{message}</li>
          ))}
        </ul>
      )}

      <CallList title="Live calls" calls={live} empty="No call in progress." now={now} live />
      <CallList
        title="Recent calls"
        calls={finished.slice(0, 10)}
        empty="No completed calls yet."
        now={now}
      />
    </section>
  );
}

function CallList(props: {
  title: string;
  calls: CallRecord[];
  empty: string;
  now: number;
  live?: boolean;
}) {
  const { title, calls, empty, now, live } = props;
  return (
    <div className="call-list">
      <h3>{title}</h3>
      {calls.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        calls.map((call) => (
          <CallCard key={call.callId} call={call} now={now} live={live ?? false} />
        ))
      )}
    </div>
  );
}

function CallCard({ call, now, live }: { call: CallRecord; now: number; live: boolean }) {
  const duration = Math.max(0, Math.round(((call.endedAt ?? now) - call.startedAt) / 1000));

  return (
    <article className="call-card">
      <header>
        <strong>{call.remoteParty ?? call.deviceId}</strong>
        <span className="tag">{call.channelId}</span>
        <span className={`tag state-${call.state}`}>{call.state}</span>
        {call.outcome && <span className="tag">{call.outcome}</span>}
        <span className="muted">{duration}s</span>
        {live && (
          <button
            type="button"
            onClick={() => void window.neuracall?.endAutopilotCall(call.callId)}
          >
            Hang up
          </button>
        )}
      </header>
      {call.error && <p className="call-error">{call.error}</p>}
      <ol className="call-transcript">
        {call.transcript.slice(-8).map((entry: TranscriptEntry, i) => (
          <li key={`${entry.at}-${i}`} className={`turn turn-${entry.speaker}`}>
            <span className="who">{entry.speaker === "caller" ? "Caller" : "Agent"}</span>
            <span className="what">{entry.text}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}
