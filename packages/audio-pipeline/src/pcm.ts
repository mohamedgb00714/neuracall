/**
 * Pure PCM helpers. Everything here is deterministic and side-effect free so
 * it can be unit-tested without hardware or native code.
 *
 * Sample format throughout: 16-bit signed little-endian PCM (Int16). This is
 * the format the NeuraCall audio pipeline emits and what AssemblyAI realtime
 * expects (after your configured sample rate + mono).
 */

export interface PcmFormat {
  sampleRate: number;
  channels: 1 | 2;
  bitsPerSample: 16;
}

/** Interleave a set of channel Float32Arrays into a single Int16 PCM buffer. */
export function floatToPcm16(samples: Float32Array[]): Buffer {
  const channels = samples.length;
  const frames = samples[0]!.length;
  const out = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = samples[c]![f]!;
      const s = clamp16(Math.round(v * 32767));
      out.writeInt16LE(s, (f * channels + c) * 2);
    }
  }
  return out;
}

/** Decode a stereo Int16 PCM buffer into two Float32Arrays ([-1, 1]). */
export function pcm16ToFloats(buf: Buffer, channels: 1 | 2): Float32Array[] {
  const bytesPerSample = 2;
  const frames = Math.floor(buf.length / (bytesPerSample * channels));
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const s = buf.readInt16LE((f * channels + c) * bytesPerSample);
      out[c]![f] = s / 32768;
    }
  }
  return out;
}

/** Downmix N channels to mono by averaging. */
export function toMono(channels: Float32Array[]): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const mono = new Float32Array(frames);
  const n = channels.length || 1;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (const ch of channels) sum += ch[f] ?? 0;
    mono[f] = sum / n;
  }
  return mono;
}

/** Linear-interpolation resampler. Good enough for speech; honors 1x identity. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const outLength = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

/** Normalise a stereo Int16 stream to mono Float32 at a target sample rate. */
export function normalize(
  buf: Buffer,
  sourceChannels: 1 | 2,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  const channels = pcm16ToFloats(buf, sourceChannels);
  const mono = sourceChannels === 1 ? channels[0]! : toMono(channels);
  return resample(mono, sourceRate, targetRate);
}

/** Split a Float32 mono stream into fixed-size sample-count chunks. */
export function chunkFrames(mono: Float32Array, chunkSamples: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < mono.length; i += chunkSamples) {
    out.push(mono.subarray(i, i + chunkSamples));
  }
  return out;
}

function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

/** Are two PCM byte buffers byte-for-byte equal? */
export function pcmEquals(a: Buffer, b: Buffer): boolean {
  return a.equals(b);
}
