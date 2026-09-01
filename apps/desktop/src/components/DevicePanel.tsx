import { useEffect, useState } from "react";
import type { CaptureInfo, NeuraCallDevice, OkResult } from "../types";

type ChannelId = "cellular" | "whatsapp";

const CHANNELS: ChannelId[] = ["cellular", "whatsapp"];

interface SessionState {
  deviceId: string;
  channelId: ChannelId;
  running: boolean;
  busy: boolean;
  error: string | null;
}

interface CallUi {
  number: string;
  busy: boolean;
  error: string | null;
  info: string | null;
}

const EMPTY_CALL: CallUi = { number: "", busy: false, error: null, info: null };

/**
 * ADB-backed device pool. The device list is real: it comes from
 * DeviceManager via `listDevices` + `onDevicesChange`, so each row reflects an
 * actual adb-attached phone (USB or wireless). Per device: place / answer /
 * hang up a call, and Listen/Stop toggles a realtime STT session (with scrcpy
 * audio capture) for that device/channel through the IPC bridge.
 */
export function DevicePanel() {
  const [devices, setDevices] = useState<NeuraCallDevice[]>([]);
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());
  const [calls, setCalls] = useState<Map<string, CallUi>>(new Map());
  const [captures, setCaptures] = useState<Map<string, CaptureInfo>>(new Map());

  useEffect(() => {
    const bridge = window.neuracall;
    if (!bridge) return; // electron bridge not ready yet
    let cancelled = false;

    bridge
      .listDevices()
      .then((list) => {
        if (!cancelled) setDevices(list);
      })
      .catch(() => {});
    bridge
      .captureStatus()
      .then((list) => {
        if (!cancelled) setCaptures(new Map(list.map((c) => [c.endpoint, c])));
      })
      .catch(() => {});

    const offDevices = bridge.onDevicesChange((updated) => {
      setDevices((prev) =>
        [...prev.filter((d) => d.id !== updated.id), updated].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      );
    });
    const offCapture = bridge.onCapture((msg) => {
      setCaptures((prev) => {
        const next = new Map(prev);
        if (msg.state === "exited") next.delete(msg.endpoint);
        else next.set(msg.endpoint, msg);
        return next;
      });
    });

    return () => {
      cancelled = true;
      offDevices();
      offCapture();
    };
  }, []);

  const sessionKey = (deviceId: string, channelId: string) => `${deviceId}/${channelId}`;

  const patchSession = (
    base: { deviceId: string; channelId: ChannelId },
    patch: Partial<SessionState>,
  ) => {
    const key = sessionKey(base.deviceId, base.channelId);
    setSessions((prev) => {
      const next = new Map(prev);
      const cur = next.get(key) ?? { ...base, running: false, busy: false, error: null };
      next.set(key, { ...cur, ...patch });
      return next;
    });
  };

  const toggle = async (deviceId: string, channelId: ChannelId) => {
    const base = { deviceId, channelId };
    const cur = sessions.get(sessionKey(deviceId, channelId));
    if (cur?.busy) return;
    patchSession(base, { busy: true, error: null });
    try {
      if (cur?.running) {
        const res = await window.neuracall.stopSession(deviceId, channelId);
        patchSession(base, { running: !res.ok, error: res.error ?? null });
      } else {
        const res = await window.neuracall.startSession(deviceId, channelId);
        patchSession(base, {
          running: res.ok,
          error: res.ok ? null : (res.error ?? "Could not start session"),
        });
      }
    } catch (err) {
      patchSession(base, { error: String(err) });
    } finally {
      patchSession(base, { busy: false });
    }
  };

  const callUi = (id: string): CallUi => calls.get(id) ?? EMPTY_CALL;
  const patchCall = (id: string, patch: Partial<CallUi>) =>
    setCalls((prev) => {
      const next = new Map(prev);
      next.set(id, { ...(next.get(id) ?? EMPTY_CALL), ...patch });
      return next;
    });

  const runCall = async (id: string, doneLabel: string, action: () => Promise<OkResult>) => {
    patchCall(id, { busy: true, error: null, info: null });
    try {
      const res = await action();
      patchCall(id, {
        busy: false,
        info: res.ok ? doneLabel : null,
        error: res.ok ? null : (res.error ?? `${doneLabel} failed`),
      });
    } catch (err) {
      patchCall(id, { busy: false, error: String(err) });
    }
  };

  const dial = (id: string) => {
    const number = callUi(id).number.trim();
    if (!number) {
      patchCall(id, { error: "Enter a number to call" });
      return;
    }
    void runCall(id, `Calling ${number}…`, () => window.neuracall.dialNumber(id, number));
  };
  const answer = (id: string) =>
    void runCall(id, "Answered", () => window.neuracall.answerCall(id));
  const hangUp = (id: string) => void runCall(id, "Hung up", () => window.neuracall.hangUpCall(id));

  const online = devices.filter((d) => d.adbState === "device");
  const offline = devices.filter((d) => d.adbState !== "device");

  if (devices.length === 0) {
    return (
      <div className="device-panel">
        <h2>Devices</h2>
        <p className="empty">
          No phones detected. Connect a phone via ADB (USB or Wi-Fi) — it will appear here
          automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="device-panel">
      <h2>Devices</h2>

      {online.map((device) => {
        const ui = callUi(device.id);
        const capture = captures.get(device.id);
        return (
          <div className="device-card" key={device.id}>
            <div className="device-info">
              <span className="device-name">{device.label ?? device.id}</span>
              <span className={`dot ${device.phase === "offline" ? "dot-off" : "dot-on"}`} />
              <span className={`channel channel-${device.kind}`}>{device.kind}</span>
              <span className={`device-phase phase-${device.phase}`}>{device.phase}</span>
              {capture && (
                <span className="capture-badge" title={`scrcpy audio source: ${capture.source}`}>
                  ● capturing
                </span>
              )}
            </div>

            <div className="call-row">
              <input
                className="call-input"
                type="tel"
                placeholder="Number to call"
                value={ui.number}
                disabled={ui.busy}
                onChange={(e) => patchCall(device.id, { number: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") dial(device.id);
                }}
              />
              <button
                className="btn btn-start"
                onClick={() => dial(device.id)}
                disabled={ui.busy}
                title="Place a call from this phone"
              >
                Call
              </button>
            </div>
            <div className="call-row">
              <button
                className="btn btn-answer"
                onClick={() => answer(device.id)}
                disabled={ui.busy}
                title="Answer the ringing call"
              >
                Answer
              </button>
              <button
                className="btn btn-stop"
                onClick={() => hangUp(device.id)}
                disabled={ui.busy}
                title="Hang up / reject the current call"
              >
                Hang up
              </button>
              <span className={`device-phase phase-${device.phase}`}>{device.phase}</span>
            </div>
            {ui.error && <p className="call-msg call-err">{ui.error}</p>}
            {ui.info && !ui.error && <p className="call-msg">{ui.info}</p>}

            {CHANNELS.map((channelId) => {
              const key = sessionKey(device.id, channelId);
              const state = sessions.get(key);
              const running = state?.running ?? false;
              const busy = state?.busy ?? false;
              return (
                <div key={key}>
                  <div className="device-row">
                    <span className={`channel channel-${channelId}`}>{channelId}</span>
                    <button
                      onClick={() => void toggle(device.id, channelId)}
                      disabled={busy}
                      className={running ? "btn btn-stop" : "btn btn-start"}
                      title="Start/stop live transcription of this channel"
                    >
                      {busy ? "…" : running ? "Stop" : "Listen"}
                    </button>
                  </div>
                  {state?.error && <p className="call-msg call-err">{state.error}</p>}
                </div>
              );
            })}
          </div>
        );
      })}

      {offline.length > 0 && (
        <div className="device-offline">
          <h3>Offline</h3>
          {offline.map((d) => (
            <p key={d.id} className="session-end">
              {d.id} — {d.adbState}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
