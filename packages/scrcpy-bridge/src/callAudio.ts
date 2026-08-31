/**
 * Which scrcpy audio source carries which direction of a phone call.
 *
 * This is the messiest part of the whole audio path, because Android does not
 * give every app the same access to call audio. `--audio-source` maps onto
 * Android `MediaRecorder.AudioSource` constants, and the call-specific ones
 * (`voice-call`, `voice-call-uplink`, `voice-call-downlink`) require the
 * privileged `CAPTURE_AUDIO_OUTPUT` permission. scrcpy's server runs via
 * `shell`, which holds it on some builds and not others — availability is a
 * per-OEM, per-Android-version fact we can only discover by trying.
 *
 * So rather than hard-code one source, each direction has an ordered
 * preference list: try the cleanest source first, fall back until one starts.
 * `ScrcpyBridge` reports a failed source via its "error" event, which is the
 * signal to advance to the next candidate.
 *
 * See docs/AUDIO-ABI.md for the full rationale, the quality trade-offs of each
 * fallback, and what an operator should do when only `mic` works.
 */

import type { ScrcpyAudioSource } from "./bridge.js";

/** Which side of the call a capture is meant to pick up. */
export type CallAudioDirection = "remoteIn" | "localOut";

/**
 * Sources that can carry the far-end (caller) voice, best first.
 *
 *  1. `voice-call-downlink` — exactly the far end, nothing else. Privileged.
 *  2. `voice-call`          — both directions mixed. Usable (the agent's own
 *                             voice is echoed back into STT, which turn-taking
 *                             must tolerate), but far better than nothing.
 *  3. `output`              — everything the device plays. Captures the caller
 *                             on speakerphone plus any notification sound.
 *  4. `mic`                 — the phone's microphone. Only picks up the far end
 *                             acoustically, via speakerphone; noisy, echo-prone,
 *                             and picks up the room. Last resort.
 */
export const REMOTE_IN_SOURCES: readonly ScrcpyAudioSource[] = [
  "voice-call-downlink",
  "voice-call",
  "output",
  "mic",
] as const;

/**
 * Sources that carry our own side of the call, best first. NeuraCall only
 * captures this direction for diagnostics and for recording both sides — the
 * agent's speech is *injected*, not captured (see `AudioInjector`).
 */
export const LOCAL_OUT_SOURCES: readonly ScrcpyAudioSource[] = [
  "voice-call-uplink",
  "voice-call",
  "mic",
] as const;

/** The ordered candidate sources for a direction. */
export function captureSourcesFor(direction: CallAudioDirection): readonly ScrcpyAudioSource[] {
  return direction === "remoteIn" ? REMOTE_IN_SOURCES : LOCAL_OUT_SOURCES;
}

/**
 * True when a source needs `CAPTURE_AUDIO_OUTPUT`, i.e. may fail on a locked
 * down OEM build and require falling back.
 */
export function isPrivilegedSource(source: ScrcpyAudioSource): boolean {
  return source.startsWith("voice-call") || source === "output" || source === "playback";
}

/**
 * True when a source picks up both directions, so the agent hears itself.
 * Callers feeding STT should enable echo tolerance (or mute during playback)
 * when this is the active source.
 */
export function isDuplexSource(source: ScrcpyAudioSource): boolean {
  return source === "voice-call" || source === "mic" || source === "output";
}

/**
 * Walks a direction's preference list as sources fail.
 *
 * Usage: `next()` for the source to try; on a capture failure call `fail()` and
 * `next()` again, until it returns null and there is nothing left to try.
 * An explicit `override` pins one source and disables fallback — for an
 * operator who knows what their phone supports and wants a hard failure rather
 * than silently degrading to room audio.
 */
export class CaptureSourceSelector {
  readonly direction: CallAudioDirection;
  private readonly candidates: ScrcpyAudioSource[];
  private index = 0;
  private readonly failures = new Map<ScrcpyAudioSource, string>();

  constructor(direction: CallAudioDirection, override?: ScrcpyAudioSource) {
    this.direction = direction;
    this.candidates = override ? [override] : [...captureSourcesFor(direction)];
  }

  /** The source to try now, or null once every candidate has failed. */
  next(): ScrcpyAudioSource | null {
    return this.candidates[this.index] ?? null;
  }

  /** True when this selector is pinned to a single source (no fallback). */
  get pinned(): boolean {
    return this.candidates.length === 1;
  }

  /** Sources still untried after the current one. */
  get remaining(): ScrcpyAudioSource[] {
    return this.candidates.slice(this.index + 1);
  }

  /** Why each already-tried source was abandoned. */
  get attempts(): ReadonlyMap<ScrcpyAudioSource, string> {
    return this.failures;
  }

  /** Record that the current source did not work and advance. */
  fail(reason: string): ScrcpyAudioSource | null {
    const current = this.candidates[this.index];
    if (current) this.failures.set(current, reason);
    this.index += 1;
    return this.next();
  }

  /** Start over from the best candidate (e.g. after the phone reconnects). */
  reset(): void {
    this.index = 0;
    this.failures.clear();
  }
}
