/**
 * Streaming parser for a WAV byte stream as scrcpy writes it with
 * `--record-format=wav --audio-codec=raw` to a non-seekable target (a pipe).
 *
 * Because the target cannot be seeked, the RIFF and `data` chunk sizes are
 * placeholders (typically 0xFFFFFFFF) — so this reader treats everything after
 * the `data` chunk header as PCM until end of stream and never trusts those
 * two sizes. It also tolerates arbitrary bytes *before* the RIFF signature so
 * a stream that is accidentally prefixed with text (scrcpy's banner, adb's
 * "1 file pushed" line) still syncs.
 *
 * Deterministic and side-effect free: unit-testable with synthetic buffers.
 */

export interface WavFormat {
  /** WAVE format tag; 1 = PCM. */
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
}

const RIFF = Buffer.from("RIFF", "ascii");
const WAVE = Buffer.from("WAVE", "ascii");
const CHUNK_HEADER = 8;
/** A pre-`data` chunk larger than this is not a WAV we understand. */
const MAX_METADATA_CHUNK = 1024 * 1024;

type State = "sync" | "chunks" | "data" | "failed";

export interface WavPushResult {
  /** PCM byte frames yielded by this push (empty until the data chunk). */
  frames: Uint8Array[];
  /** Set on the push that completed the `fmt ` chunk. */
  format?: WavFormat;
}

export class WavStreamReader {
  private state: State = "sync";
  private buffer = Buffer.alloc(0);
  private fmt: WavFormat | null = null;
  private lastError: string | null = null;

  /** Parsed `fmt ` chunk, once seen. */
  get format(): WavFormat | null {
    return this.fmt;
  }

  /** True once PCM is flowing. */
  get streaming(): boolean {
    return this.state === "data";
  }

  /** Why parsing stopped, when the stream turned out not to be WAV. */
  get error(): string | null {
    return this.lastError;
  }

  /** Feed bytes; returns the PCM frames (and format, when first parsed). */
  push(chunk: Uint8Array): WavPushResult {
    const result: WavPushResult = { frames: [] };
    if (chunk.byteLength === 0 || this.state === "failed") return result;

    if (this.state === "data") {
      result.frames.push(Uint8Array.from(chunk));
      return result;
    }

    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);

    if (this.state === "sync") {
      const at = this.buffer.indexOf(RIFF);
      if (at === -1) {
        // Keep only a tail that could still hold a partial "RIFF".
        if (this.buffer.length > 3) this.buffer = this.buffer.subarray(this.buffer.length - 3);
        return result;
      }
      if (at > 0) this.buffer = this.buffer.subarray(at);
      if (this.buffer.length < 12) return result;
      if (!this.buffer.subarray(8, 12).equals(WAVE)) {
        // Not a WAV RIFF — drop this signature and keep searching.
        this.buffer = this.buffer.subarray(4);
        return this.push(new Uint8Array(0));
      }
      this.buffer = this.buffer.subarray(12);
      this.state = "chunks";
    }

    while (this.state === "chunks" && this.buffer.length >= CHUNK_HEADER) {
      const id = this.buffer.toString("ascii", 0, 4);
      const size = this.buffer.readUInt32LE(4);

      if (id === "data") {
        this.buffer = this.buffer.subarray(CHUNK_HEADER);
        if (!this.fmt) {
          this.fail("WAV data chunk before fmt chunk");
          return result;
        }
        this.state = "data";
        if (this.buffer.length > 0) {
          result.frames.push(Uint8Array.from(this.buffer));
          this.buffer = Buffer.alloc(0);
        }
        return result;
      }

      if (size > MAX_METADATA_CHUNK) {
        this.fail(`WAV chunk "${id}" too large (${size} bytes)`);
        return result;
      }
      const padded = size + (size & 1); // RIFF chunks are word-aligned
      if (this.buffer.length < CHUNK_HEADER + padded) break; // wait for the rest

      if (id === "fmt ") {
        const body = this.buffer.subarray(CHUNK_HEADER, CHUNK_HEADER + size);
        if (size < 16) {
          this.fail("WAV fmt chunk too short");
          return result;
        }
        this.fmt = {
          formatTag: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          blockAlign: body.readUInt16LE(12),
          bitsPerSample: body.readUInt16LE(14),
        };
        result.format = this.fmt;
      }
      this.buffer = this.buffer.subarray(CHUNK_HEADER + padded);
    }
    return result;
  }

  /** Bytes buffered waiting for more input. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.state = "sync";
    this.buffer = Buffer.alloc(0);
    this.fmt = null;
    this.lastError = null;
  }

  private fail(message: string): void {
    this.state = "failed";
    this.lastError = message;
    this.buffer = Buffer.alloc(0);
  }
}

/** Build a WAV header (for tests and for anyone writing PCM to disk). */
export function wavHeader(
  fmt: Pick<WavFormat, "channels" | "sampleRate" | "bitsPerSample">,
  dataBytes = 0xffffffff,
): Buffer {
  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(dataBytes === 0xffffffff ? 0xffffffff : 36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(fmt.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
