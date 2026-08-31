import { useEffect, useRef, useState } from "react";
import type { SessionKey, TurnEvent } from "@neuracall/aai-client";

export interface LiveTurn {
  id: number;
  time: number;
  deviceId: string;
  channelId: string;
  turn: TurnEvent;
}

export interface SessionEndInfo {
  deviceId: string;
  channelId: string;
  reason: string;
}

/**
 * Subscribes to the live session event stream from the Electron main process
 * and keeps an append-only list of (final + partial) turns per device/channel.
 * Unsubscribes on unmount.
 */
export function useLiveTranscript() {
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [sessions, setSessions] = useState<SessionEndInfo[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    const offTurn = window.neuracall?.onTurn?.((msg) => {
      const live: LiveTurn = {
        id: ++idRef.current,
        time: Date.now(),
        deviceId: msg.key.deviceId,
        channelId: msg.key.channelId,
        turn: msg.turn,
      };
      setTurns((prev) => [...prev.slice(-499), live]);
    });

    const offEnd = window.neuracall?.onSessionEnd?.((msg) => {
      setSessions((prev) => [
        ...prev,
        {
          deviceId: msg.key.deviceId,
          channelId: msg.key.channelId,
          reason: msg.reason,
        },
      ]);
    });

    return () => {
      offTurn?.();
      offEnd?.();
    };
  }, []);

  return { turns, sessions };
}

export function keyLabel(key: SessionKey): string {
  return `${key.deviceId} / ${key.channelId}`;
}
