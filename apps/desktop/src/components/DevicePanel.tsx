import { useEffect, useState } from "react";
import type { NeuraCallDevice } from "../types";

type ChannelId = "cellular" | "whatsapp";

const CHANNELS: ChannelId[] = ["cellular", "whatsapp"];

interface SessionState {
  deviceId: string;
  channelId: ChannelId;
  running: boolean;
  busy: boolean;
}

/**
 * ADB-backed device pool. The device list is real: it comes from
 * DeviceManager via `listDevices` + `onDevicesChange`, so each row reflects an
 * actual adb-attached phone (USB or wireless). Start/Stop toggles a realtime
 * STT session for that device/channel through the IPC bridge.
 */
export function DevicePanel() {
  const [devices, setDevices] = useState<NeuraCallDevice[]>([]);
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());

  useEffect(() => {
    let cancelled = false;
    window.neuracall
      ?.listDevices()
      .then((list) => {
        if (!cancelled) setDevices(list);
      })
      .catch(() => {
        /* electron bridge not ready yet */
      });

    const off = window.neuracall?.onDevicesChange((updated) => {
      setDevices((prev) => {
        const next = prev.filter((d) => d.id !== updated.id);
        return [...next, updated];
      });
    });

    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const sessionKey = (deviceId: string, channelId: string) =>
    `${deviceId}/${channelId}`;

  const toggle = async (deviceId: string, channelId: ChannelId) => {
    const key = sessionKey(deviceId, channelId);
    const cur = sessions.get(key);
    if (cur?.busy) return;
    setSessions(new Map(sessions.set(key, { deviceId, channelId, running: cur?.running ?? false, busy: true })));
    try {
      if (cur?.running) {
        await window.neuracall.stopSession(deviceId, channelId);
        setSessions(new Map(sessions.set(key, { deviceId, channelId, running: false, busy: false })));
      } else {
        const res = await window.neuracall.startSession(deviceId, channelId);
        setSessions(new Map(sessions.set(key, { deviceId, channelId, running: res.ok, busy: false })));
      }
    } finally {
      setSessions((prev) => {
        const updated = new Map(prev);
        const s = updated.get(key);
        if (s) updated.set(key, { ...s, busy: false });
        return updated;
      });
    }
  };

  const online = devices.filter((d) => d.adbState === "device");
  const offline = devices.filter((d) => d.adbState !== "device");

  if (devices.length === 0) {
    return (
      <div className="device-panel">
        <h2>Devices</h2>
        <p className="empty">
          No phones detected. Connect a phone via ADB (USB or Wi-Fi) — it will
          appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="device-panel">
      <h2>Devices</h2>

      {online.map((device) => (
        <div className="device-card" key={device.id}>
          <div className="device-info">
            <span className="device-name">{device.label ?? device.id}</span>
            <span className={`dot ${device.phase === "offline" ? "dot-off" : "dot-on"}`} />
            <span className={`channel channel-${device.kind}`}>{device.kind}</span>
            <span className="device-phase">{device.phase}</span>
          </div>
          {CHANNELS.map((channelId) => {
            const key = sessionKey(device.id, channelId);
            const state = sessions.get(key);
            const running = state?.running ?? false;
            const busy = state?.busy ?? false;
            return (
              <div className="device-row" key={key}>
                <span className={`channel channel-${channelId}`}>{channelId}</span>
                <button
                  onClick={() => void toggle(device.id, channelId)}
                  disabled={busy}
                  className={running ? "btn btn-stop" : "btn btn-start"}
                >
                  {busy ? "…" : running ? "Stop" : "Listen"}
                </button>
              </div>
            );
          })}
        </div>
      ))}

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
