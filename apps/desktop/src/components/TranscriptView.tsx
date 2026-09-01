import type { LiveTurn, SessionEndInfo } from "../hooks/useLiveTranscript";

/**
 * Live rolling transcript of every active session. Final turns are solid,
 * partial turns are dimmed and italicised so the user can see speech as it is
 * recognised before it is committed.
 */
export function TranscriptView({
  turns,
  sessions,
}: {
  turns: LiveTurn[];
  sessions: SessionEndInfo[];
}) {
  return (
    <div className="transcript">
      <h2>Live Transcripts</h2>

      {turns.length === 0 && sessions.length === 0 ? (
        <p className="empty">No sessions yet. Start listening on a device to see live captions.</p>
      ) : (
        <div className="transcript-list">
          {turns.map((t) => (
            <div key={t.id} className={`turn-row ${t.turn.final ? "turn-final" : "turn-partial"}`}>
              <span className="turn-key">
                {t.deviceId} / {t.channelId}
              </span>
              <span className="turn-time">{new Date(t.time).toLocaleTimeString()}</span>
              <span className="turn-text">{t.turn.transcript}</span>
              {t.turn.speakerLabel && <span className="turn-speaker">{t.turn.speakerLabel}</span>}
            </div>
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="session-end-list">
          <h3>Ended sessions</h3>
          {sessions.slice(-10).map((s, i) => (
            <p key={i} className="session-end">
              <strong>
                {s.deviceId}/{s.channelId}
              </strong>{" "}
              — {s.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
