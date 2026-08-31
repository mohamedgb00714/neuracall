/**
 * The text-to-speech port.
 *
 * Only the interface lives here. The concrete provider (and the injection
 * transport that actually gets the audio onto the call) is Phase 5's TTS task;
 * this exists so the agent can be built and tested against it now.
 *
 * `SilentTts` is the default so a call still runs end to end without a TTS
 * provider configured: the agent thinks, replies, biases the next turn and
 * appears in the transcript — the far end simply hears nothing. That is much
 * more useful than refusing to answer the phone.
 */

/** Synthesised speech, ready for `LocalOutStream.speak`. */
export interface SynthesizedSpeech {
  /** Int16 LE PCM. */
  pcm: Uint8Array;
  sampleRate: number;
  channels: 1 | 2;
}

export interface TtsRequest {
  text: string;
  /** Aborts synthesis when the caller interrupts. */
  signal?: AbortSignal;
}

export interface TtsClient {
  synthesize(request: TtsRequest): Promise<SynthesizedSpeech>;
}

/**
 * Produces the right *duration* of silence for the text, so timing-dependent
 * behaviour — barge-in windows, turn pacing — behaves as it would with real
 * speech instead of completing instantly.
 */
export class SilentTts implements TtsClient {
  constructor(
    private readonly opts: { sampleRate?: number; wordsPerMinute?: number } = {},
  ) {}

  async synthesize(request: TtsRequest): Promise<SynthesizedSpeech> {
    const sampleRate = this.opts.sampleRate ?? 16000;
    const wpm = this.opts.wordsPerMinute ?? 150;
    const words = request.text.trim() === "" ? 0 : request.text.trim().split(/\s+/).length;
    const seconds = (words / wpm) * 60;
    const samples = Math.max(0, Math.round(seconds * sampleRate));
    return { pcm: new Uint8Array(samples * 2), sampleRate, channels: 1 };
  }
}
