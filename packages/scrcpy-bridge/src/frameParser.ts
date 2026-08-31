/**
 * Streaming parser for scrcpy's audio wire format.
 *
 * scrcpy sends audio in packets, each prefixed with a 12-byte frame header,
 * then the codec payload. With `--audio-codec=raw` the payload is uncompressed
 * PCM16 little-endian — exactly what the NeuraCall audio pipeline consumes.
 *
 * Header layout (scrcpy wire protocol, see scrcpy/doc/develop.md):
 *   byte 0     : media packet flag (MSB) | config flag (bit 6) | key frame (bit 5)
 *                the remaining 61 bits + bytes 1..7 form the PTS
 *   bytes 8..11: packet size (u32, little-endian)
 *   then `packet size` bytes of payload
 */

export const SCRCPY_FRAME_HEADER_SIZE = 12;

export interface ScrcpyAudioFrame {
  /** True if this is a media (audio) packet rather than a session packet. */
  media: boolean;
  /** True if this is a configuration packet (codec metadata). */
  config: boolean;
  /** Presentation timestamp from the device, in microseconds. */
  pts: number;
  /** Raw codec payload (PCM16 LE when codec is raw). */
  payload: Uint8Array;
}

/**
 * Accumulates bytes and yields complete scrcpy audio frames. Resets cleanly if
 * the stream is torn mid-frame. Parsing is deterministic and side-effect free,
 * so it is unit-testable with synthetic buffers.
 */
export class ScrcpyFrameReader {
  /** When true, bytes are passed through verbatim (no frame headers). */
  private passthrough = false;
  private buffer = Buffer.alloc(0);

  constructor(opts: { passthrough?: boolean } = {}) {
    this.passthrough = opts.passthrough ?? false;
  }

  /**
   * Feed the next chunk of bytes from scrcpy stdout. Returns any complete
   * frames parsed from this chunk (partial frames are buffered).
   */
  push(chunk: Uint8Array): ScrcpyAudioFrame[] {
    if (this.passthrough) {
      return chunk.byteLength > 0
        ? [{ media: true, config: false, pts: 0, payload: Uint8Array.from(chunk) }]
        : [];
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: ScrcpyAudioFrame[] = [];
    while (this.buffer.length >= SCRCPY_FRAME_HEADER_SIZE) {
      const size = this.buffer.readUInt32LE(8);
      if (this.buffer.length < SCRCPY_FRAME_HEADER_SIZE + size) {
        break; // wait for the rest of the packet
      }
      const header = this.buffer.subarray(0, SCRCPY_FRAME_HEADER_SIZE);
      const payload = this.buffer.subarray(
        SCRCPY_FRAME_HEADER_SIZE,
        SCRCPY_FRAME_HEADER_SIZE + size,
      );
      const b0 = header[0]!;
      const media = (b0 & 0x80) !== 0;
      const config = (b0 & 0x40) !== 0;
      const key = (b0 & 0x20) !== 0;
      // PTS = 61 bits: 5 low bits of b0 + 56 bits across b1..b7.
      const pts = readPts61(header);
      frames.push({
        media,
        config,
        pts,
        payload: Uint8Array.from(payload),
      });
      void key; // reserved / unused for raw audio
      this.buffer = this.buffer.subarray(SCRCPY_FRAME_HEADER_SIZE + size);
    }
    return frames;
  }

  /** Bytes buffered waiting for the rest of a frame. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Read scrcpy's 61-bit PTS from the 8 header bytes. Flags occupy the top bits
 * of byte 0 (0x80 media, 0x40 config, 0x20 key frame), so the PTS is the low
 * 5 bits of byte 0 plus bytes 1..7, big-endian.
 */
function readPts61(header: Buffer): number {
  let pts = 0;
  for (let i = 0; i < 8; i++) {
    const b = header[i]!;
    // Skip the flag bits only on byte 0.
    const value = i === 0 ? b & 0x1f : b;
    pts = pts * 256 + value;
  }
  return pts;
}
