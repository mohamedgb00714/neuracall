/**
 * The production `AudioCapture`: far-end call audio via scrcpy.
 *
 * Which `--audio-source` actually carries the caller is a per-OEM,
 * per-Android-version fact (see docs/AUDIO-ABI.md), so this walks the
 * preference list from `@neuracall/scrcpy-bridge` until one works instead of
 * betting on a single source. A source counts as working once the WAV header
 * parses and the stream reports its format; a source that errors, exits, or
 * produces nothing within `startTimeoutMs` is abandoned and the next is tried.
 *
 * The timeout matters: a denied privileged source does not always fail loudly.
 * On some builds the capture starts and then sits silent forever, which without
 * a deadline would mean a call answered into permanent silence.
 */

import {
  CaptureSourceSelector,
  ScrcpyBridge,
  type ScrcpyAudioSource,
  type ScrcpySpawn,
} from "@neuracall/scrcpy-bridge";
import type { AudioCapture, CapturePcmSink, CaptureHandle } from "./types.js";

export interface ScrcpyAudioCaptureOptions {
  /** Pin one source and disable fallback (fails loudly instead of degrading). */
  audioSource?: ScrcpyAudioSource;
  /** Injectable spawner (tests). */
  spawn?: ScrcpySpawn;
  /** How long a source has to produce audio before it is abandoned. Default 5000 ms. */
  startTimeoutMs?: number;
  /** Reports which source won, and what was tried on the way. */
  onSourceSelected?: (info: {
    deviceId: string;
    source: ScrcpyAudioSource;
    attempts: ReadonlyMap<ScrcpyAudioSource, string>;
  }) => void;
  /** scrcpy diagnostics. */
  onLog?: (deviceId: string, message: string) => void;
}

export class ScrcpyAudioCapture implements AudioCapture {
  constructor(private readonly opts: ScrcpyAudioCaptureOptions = {}) {}

  async start(args: { deviceId: string; sink: CapturePcmSink }): Promise<CaptureHandle> {
    const { deviceId, sink } = args;
    const selector = new CaptureSourceSelector("remoteIn", this.opts.audioSource);
    const timeout = this.opts.startTimeoutMs ?? 5000;

    for (let source = selector.next(); source !== null; source = selector.next()) {
      const bridge = new ScrcpyBridge({
        endpoint: deviceId,
        audioSource: source,
        sink,
        ...(this.opts.spawn ? { spawn: this.opts.spawn } : {}),
      });

      const failure = await this.tryStart(bridge, deviceId, timeout);
      if (failure === null) {
        this.opts.onSourceSelected?.({ deviceId, source, attempts: selector.attempts });
        return { stop: () => bridge.stop() };
      }

      bridge.stop();
      selector.fail(failure);
    }

    const tried = [...selector.attempts]
      .map(([source, why]) => `${source} (${why})`)
      .join(", ");
    throw new Error(
      `No usable audio source for ${deviceId}. Tried: ${tried || "none"}. ` +
        `See docs/AUDIO-ABI.md — on a locked-down build only --audio-source=mic may work.`,
    );
  }

  /** Resolves null on success, or the reason this source did not work. */
  private tryStart(
    bridge: ScrcpyBridge,
    deviceId: string,
    timeoutMs: number,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (reason: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(reason);
      };

      const timer = setTimeout(() => done(`no audio within ${timeoutMs}ms`), timeoutMs);
      timer.unref?.();

      // The format arriving means a real WAV stream is flowing.
      bridge.once("format", () => done(null));
      bridge.on("error", (message: string) => done(message));
      bridge.once("exit", () => done("scrcpy exited before producing audio"));
      bridge.on("log", (message: string) => this.opts.onLog?.(deviceId, message));

      try {
        bridge.start();
      } catch (err) {
        done(err instanceof Error ? err.message : String(err));
      }
    });
  }
}
