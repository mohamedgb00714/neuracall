/**
 * Streaming WAV call recorder + a `tee` so one AudioChunk stream can feed the
 * realtime STT client and the recorder at the same time.
 *
 * Layout on disk (both files are created by the recorder):
 *
 *   <baseDir>/recordings/<deviceId>/<callId>.wav   16-bit mono PCM, RIFF/WAVE
 *   <baseDir>/recordings/<deviceId>/<callId>.json  RecordingMetadata sidecar
 *
 * `baseDir` is meant to be the app's `data/` directory. `data/` is already
 * listed in the repository .gitignore, so recordings (which are private call
 * audio) can never be committed by accident; keep it that way and never point
 * `baseDir` at a tracked directory. Files are created with mode 0600 and the
 * per-device directory with 0700 (ignored on Windows).
 *
 * Streaming model: audio is appended to the .wav through a raw file
 * descriptor as it arrives. A small bounded buffer (`flushBytes`, default
 * 64 KiB ≈ 2 s at 16 kHz) coalesces writes; it is flushed to the fd whenever
 * it fills up or `flushIntervalMs` has elapsed, and every flush also patches
 * the RIFF/data sizes in the header so the file on disk is a valid, playable
 * WAV of everything written so far even if the process dies mid-call.
 * Nothing is ever retained beyond that buffer, so memory use is flat for a
 * multi-hour call. `close()` writes the final sizes, fsyncs, and emits the
 * metadata JSON.
 *
 * Only the sync `node:fs` API is used (Node 20 compatible) so the recorder is
 * safe to drive from the Electron main process without an event-loop hop per
 * 100 ms chunk.
 */

import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fdatasyncSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import type { AudioChunk } from "./pipeline.js";

/** Sub-directory of `baseDir` that holds one folder per device. */
export const RECORDINGS_SUBDIR = "recordings";
/** Canonical PCM WAV header length. */
export const WAV_HEADER_BYTES = 44;
/** Largest `data` chunk a 32-bit RIFF size field can describe. */
const WAV_MAX_DATA_BYTES = 0xffffffff - 36;

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_MAX_SECONDS = 3 * 3600;
const DEFAULT_FLUSH_BYTES = 64 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const BYTES_PER_SAMPLE = 2; // Int16 mono

export type CallDirection = "inbound" | "outbound" | "unknown";

/** Free-form call facts the caller knows (or learns during the call). */
export interface CallRecorderMetadata {
  /** Who initiated the call. Default "unknown". */
  direction?: CallDirection;
  /** Label for our side of the call (agent name, the phone's own number, ...). */
  localParty?: string | null;
  /** Label for the other side (dialled / calling number, contact name, ...). */
  remoteParty?: string | null;
  /** Path of the transcript for this call, once one exists. */
  transcriptPath?: string | null;
}

export interface CallRecorderOptions {
  /** App data root; recordings land in `<baseDir>/recordings/<deviceId>/`. */
  baseDir: string;
  /** ADB serial or ip:port of the phone (sanitised for use as a folder name). */
  deviceId: string;
  /** Unique id of the call; becomes the file name (sanitised). */
  callId: string;
  /** Realtime STT channel the audio was streamed to. */
  channelId: string;
  /** Sample rate of the PCM handed to `write` (Int16 mono). Default 16000. */
  sampleRate?: number;
  /** Stop accepting audio after this many seconds. Default 3 h. */
  maxSeconds?: number;
  /** Initial metadata; can be completed later via `updateMetadata` / `close`. */
  metadata?: CallRecorderMetadata;
  /** Flush the in-memory buffer to the fd once it holds this many bytes. Default 64 KiB. */
  flushBytes?: number;
  /** Also flush when this much time has passed since the last flush. Default 1000 ms. */
  flushIntervalMs?: number;
  /** fdatasync on every periodic flush (durable against power loss, costs a syscall). Default false. */
  syncOnFlush?: boolean;
  /** Called once, synchronously, when the `maxSeconds` cap is hit. */
  onMaxDuration?: (recorder: CallRecorder) => void;
  /** Clock (ms since epoch) — injectable for tests. */
  now?: () => number;
}

/** What `close()` returns and what `<callId>.json` contains. */
export interface RecordingMetadata {
  version: 1;
  deviceId: string;
  callId: string;
  channelId: string;
  direction: CallDirection;
  localParty: string | null;
  remoteParty: string | null;
  /** ISO-8601 time the recorder was created. */
  startedAt: string;
  /** ISO-8601 time the recorder was closed. */
  endedAt: string;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  /** PCM bytes in the `data` chunk (the header is not counted). */
  bytes: number;
  durationSeconds: number;
  maxSeconds: number;
  /** True when the `maxSeconds` cap cut the recording short. */
  truncated: boolean;
  /** Absolute path of the .wav file. */
  wavPath: string;
  transcriptPath?: string;
  /** Set when an I/O failure interrupted the recording. */
  error?: string;
}

export interface RecordingPaths {
  dir: string;
  wavPath: string;
  metadataPath: string;
}

/**
 * Reduce an arbitrary id (adb serial, `ip:port`, a call id with a timestamp)
 * to a single safe path segment. Throws on ids that have no usable characters
 * or that would resolve to `.`/`..`.
 */
export function safePathSegment(name: string, label = "name"): string {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  if (cleaned === "" || /^\.+$/.test(cleaned)) {
    throw new Error(`CallRecorder: ${label} "${name}" cannot be used as a file name`);
  }
  return cleaned;
}

/** Absolute locations of a recording's files for the given ids. Pure. */
export function recordingPaths(baseDir: string, deviceId: string, callId: string): RecordingPaths {
  const dir = resolve(baseDir, RECORDINGS_SUBDIR, safePathSegment(deviceId, "deviceId"));
  const stem = safePathSegment(callId, "callId");
  return {
    dir,
    wavPath: join(dir, `${stem}.wav`),
    metadataPath: join(dir, `${stem}.json`),
  };
}

/** Build the canonical 44-byte header for 16-bit mono PCM. */
export function wavHeaderMono16(sampleRate: number, dataBytes: number): Buffer {
  const blockAlign = BYTES_PER_SAMPLE;
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // channels
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export interface WavHeaderInfo {
  /** RIFF chunk size field (file bytes after the first 8). */
  riffBytes: number;
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  /** Size of the `data` chunk in bytes. */
  dataBytes: number;
  /** Byte offset of the first PCM sample. */
  dataOffset: number;
  /** PCM frames (samples per channel) the data chunk holds. */
  frames: number;
}

/**
 * Parse a RIFF/WAVE header (canonical 44-byte layout, or any chunk order as
 * long as `fmt ` precedes `data`). Throws on anything that is not a PCM WAV.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeaderInfo {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  const riffBytes = b.readUInt32LE(4);
  let fmt: Omit<WavHeaderInfo, "riffBytes" | "dataBytes" | "dataOffset" | "frames"> | null = null;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > b.length) throw new Error("truncated fmt chunk");
      fmt = {
        formatTag: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        byteRate: b.readUInt32LE(body + 8),
        blockAlign: b.readUInt16LE(body + 12),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("data chunk before fmt chunk");
      if (fmt.formatTag !== 1) throw new Error(`unsupported WAVE format tag ${fmt.formatTag}`);
      const frames = fmt.blockAlign > 0 ? Math.floor(size / fmt.blockAlign) : 0;
      return { riffBytes, ...fmt, dataBytes: size, dataOffset: body, frames };
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk found");
}

type RequiredMetadata = Required<CallRecorderMetadata>;

/**
 * Streaming Int16-mono WAV writer for one call. See the module comment for
 * the on-disk layout and flushing behaviour.
 *
 * Life-cycle:  `new` (creates the file, throws if it cannot) → `write()` ×N →
 * `close()` (finalises the header, writes the JSON, returns the metadata).
 * `write` returns `false` once the `maxSeconds` cap has been reached; the
 * chunk that crosses the cap is trimmed so the file holds exactly
 * `maxSeconds` of audio. `close()` is idempotent.
 */
export class CallRecorder {
  readonly deviceId: string;
  readonly callId: string;
  readonly channelId: string;
  readonly sampleRate: number;
  readonly maxSeconds: number;
  /** Byte budget for the data chunk implied by `maxSeconds` (whole samples). */
  readonly maxBytes: number;
  readonly dir: string;
  readonly wavPath: string;
  readonly metadataPath: string;

  private readonly flushBytes: number;
  private readonly flushIntervalMs: number;
  private readonly syncOnFlush: boolean;
  private readonly onMaxDuration: ((recorder: CallRecorder) => void) | undefined;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly meta: RequiredMetadata;

  private fd: number | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** A dangling odd byte waiting for its other half (input is Int16). */
  private carry: Buffer | null = null;
  private acceptedBytes = 0;
  private flushedBytes = 0;
  private lastFlushAt: number;
  private capReached = false;
  private closing = false;
  private failure: Error | null = null;
  private result: RecordingMetadata | null = null;

  constructor(opts: CallRecorderOptions) {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const maxSeconds = opts.maxSeconds ?? DEFAULT_MAX_SECONDS;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error(`CallRecorder: sampleRate must be a positive integer, got ${String(opts.sampleRate)}`);
    }
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
      throw new Error(`CallRecorder: maxSeconds must be > 0, got ${String(opts.maxSeconds)}`);
    }
    if (typeof opts.channelId !== "string" || opts.channelId === "") {
      throw new Error("CallRecorder: channelId is required");
    }
    if (typeof opts.baseDir !== "string" || opts.baseDir.trim() === "") {
      throw new Error("CallRecorder: baseDir is required");
    }

    this.deviceId = opts.deviceId;
    this.callId = opts.callId;
    this.channelId = opts.channelId;
    this.sampleRate = sampleRate;
    this.maxSeconds = maxSeconds;
    this.maxBytes = Math.min(Math.floor(maxSeconds * sampleRate) * BYTES_PER_SAMPLE, WAV_MAX_DATA_BYTES);
    this.flushBytes = Math.max(BYTES_PER_SAMPLE, opts.flushBytes ?? DEFAULT_FLUSH_BYTES);
    this.flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.syncOnFlush = opts.syncOnFlush ?? false;
    this.onMaxDuration = opts.onMaxDuration;
    this.now = opts.now ?? Date.now;
    this.startedAtMs = this.now();
    this.lastFlushAt = this.startedAtMs;
    this.meta = {
      direction: opts.metadata?.direction ?? "unknown",
      localParty: opts.metadata?.localParty ?? null,
      remoteParty: opts.metadata?.remoteParty ?? null,
      transcriptPath: opts.metadata?.transcriptPath ?? null,
    };

    const paths = recordingPaths(opts.baseDir, opts.deviceId, opts.callId);
    this.dir = paths.dir;
    this.wavPath = paths.wavPath;
    this.metadataPath = paths.metadataPath;

    // Fail loudly, up front, if the destination cannot take a recording:
    // baseDir (or a parent) not writable / not a directory, or the call id
    // colliding with an existing file. Nothing is left behind on failure.
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      accessSync(this.dir, fsConstants.W_OK);
    } catch (err) {
      throw wrap(`CallRecorder: recordings directory is not writable: ${this.dir}`, err);
    }
    try {
      this.fd = openSync(this.wavPath, "wx", 0o600);
    } catch (err) {
      throw wrap(`CallRecorder: cannot create ${this.wavPath}`, err);
    }
    try {
      writeFully(this.fd, wavHeaderMono16(this.sampleRate, 0), 0);
    } catch (err) {
      this.discardFd();
      throw wrap(`CallRecorder: cannot write WAV header to ${this.wavPath}`, err);
    }
  }

  /** PCM bytes accepted so far (buffered or on disk). */
  get bytes(): number {
    return this.acceptedBytes;
  }

  get durationSeconds(): number {
    return this.acceptedBytes / (this.sampleRate * BYTES_PER_SAMPLE);
  }

  /** True once the `maxSeconds` cap has stopped the recording. */
  get truncated(): boolean {
    return this.capReached;
  }

  get closed(): boolean {
    return this.result !== null || this.closing;
  }

  /** The I/O error that broke this recording, if any. */
  get error(): Error | null {
    return this.failure;
  }

  /**
   * Append Int16 LE mono PCM at `sampleRate`. Returns `true` when the whole
   * chunk was accepted, `false` when the `maxSeconds` cap dropped some or all
   * of it. Throws if the recorder is closed or a previous write failed.
   */
  write(pcm: Uint8Array): boolean {
    if (this.closed) throw new Error(`CallRecorder(${this.callId}): write after close`);
    if (this.failure) {
      throw wrap(`CallRecorder(${this.callId}): recording already failed`, this.failure);
    }
    if (this.capReached) return false;

    let buf = this.carry ? Buffer.concat([this.carry, Buffer.from(pcm)]) : Buffer.from(pcm);
    this.carry = null;
    if (buf.length % BYTES_PER_SAMPLE !== 0) {
      this.carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }

    const room = this.maxBytes - this.acceptedBytes; // always a whole number of samples
    let complete = true;
    if (buf.length > room) {
      buf = buf.subarray(0, room);
      complete = false;
    }
    if (buf.length > 0) {
      this.pending.push(buf);
      this.pendingBytes += buf.length;
      this.acceptedBytes += buf.length;
    }

    if (this.acceptedBytes >= this.maxBytes) {
      this.capReached = true;
      this.carry = null;
      this.flush();
      this.onMaxDuration?.(this);
      return complete;
    }

    if (this.pendingBytes >= this.flushBytes || this.now() - this.lastFlushAt >= this.flushIntervalMs) {
      this.flush();
    }
    return complete;
  }

  /**
   * Push buffered audio to the file and patch the header sizes so the file on
   * disk is a valid WAV of everything accepted so far. Called automatically;
   * public so a caller can force it (e.g. before a snapshot).
   */
  flush(): void {
    if (this.fd === null || this.failure) return;
    const chunks = this.pending;
    const n = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      let pos = WAV_HEADER_BYTES + this.flushedBytes;
      for (const chunk of chunks) {
        writeFully(this.fd, chunk, pos);
        pos += chunk.length;
      }
      this.flushedBytes += n;
      this.patchHeader();
      if (this.syncOnFlush) fdatasyncSync(this.fd);
    } catch (err) {
      this.failure = wrap(`CallRecorder(${this.callId}): write to ${this.wavPath} failed`, err);
      // Bytes that never reached the disk are not part of the recording.
      this.acceptedBytes = this.flushedBytes;
      throw this.failure;
    }
    this.lastFlushAt = this.now();
  }

  /** Merge call facts learned during the call. `undefined` leaves a field alone. */
  updateMetadata(patch: CallRecorderMetadata): void {
    if (patch.direction !== undefined) this.meta.direction = patch.direction;
    if (patch.localParty !== undefined) this.meta.localParty = patch.localParty;
    if (patch.remoteParty !== undefined) this.meta.remoteParty = patch.remoteParty;
    if (patch.transcriptPath !== undefined) this.meta.transcriptPath = patch.transcriptPath;
  }

  /**
   * Finalise the WAV (sizes + fsync), close the fd and write the metadata
   * JSON next to it. Idempotent: later calls return the same metadata.
   * Throws if the file could not be finalised or the JSON could not be
   * written — after writing whatever metadata it could.
   */
  close(patch?: CallRecorderMetadata): RecordingMetadata {
    if (this.result) return this.result;
    if (patch) this.updateMetadata(patch);
    this.closing = true;
    this.carry = null; // a dangling half-sample is not audio

    let closeError: Error | null = null;
    if (this.fd !== null) {
      try {
        this.flush();
        if (!this.failure) fsyncSync(this.fd);
      } catch (err) {
        closeError = err instanceof Error ? err : new Error(String(err));
      } finally {
        this.discardFd();
      }
    }

    const meta = this.buildMetadata();
    this.result = meta;
    writeFileSync(this.metadataPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    if (closeError) throw closeError;
    return meta;
  }

  /**
   * An objectMode Writable that accepts `AudioChunk`s (or raw Int16 bytes) —
   * what `AudioPipeline` emits — so the recorder can sit behind a `tee`.
   * A chunk whose `sampleRate` differs from the recorder's errors the stream
   * (silently resampling would produce a wrong-speed recording).
   * `end()` closes the recorder unless `closeOnFinish` is false.
   */
  createWritable(opts: { closeOnFinish?: boolean } = {}): Writable {
    const closeOnFinish = opts.closeOnFinish ?? true;
    return new Writable({
      objectMode: true,
      write: (chunk: AudioChunk | Uint8Array, _enc, cb) => {
        try {
          if (chunk instanceof Uint8Array) {
            this.write(chunk);
          } else {
            if (chunk.sampleRate !== this.sampleRate) {
              throw new Error(
                `CallRecorder(${this.callId}): chunk sample rate ${chunk.sampleRate} != recorder ${this.sampleRate}`,
              );
            }
            this.write(chunk.pcm);
          }
          cb();
        } catch (err) {
          cb(toError(err));
        }
      },
      final: (cb) => {
        try {
          if (closeOnFinish) this.close();
          cb();
        } catch (err) {
          cb(toError(err));
        }
      },
    });
  }

  private patchHeader(): void {
    if (this.fd === null) return;
    const sizes = Buffer.alloc(4);
    sizes.writeUInt32LE(36 + this.flushedBytes, 0);
    writeFully(this.fd, sizes, 4);
    sizes.writeUInt32LE(this.flushedBytes, 0);
    writeFully(this.fd, sizes, 40);
  }

  private discardFd(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Nothing sensible to do with a failed close; the data has been fsynced or already failed.
    }
    this.fd = null;
  }

  private buildMetadata(): RecordingMetadata {
    const bytes = this.flushedBytes;
    const meta: RecordingMetadata = {
      version: 1,
      deviceId: this.deviceId,
      callId: this.callId,
      channelId: this.channelId,
      direction: this.meta.direction,
      localParty: this.meta.localParty,
      remoteParty: this.meta.remoteParty,
      startedAt: new Date(this.startedAtMs).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      sampleRate: this.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      bytes,
      durationSeconds: bytes / (this.sampleRate * BYTES_PER_SAMPLE),
      maxSeconds: this.maxSeconds,
      truncated: this.capReached,
      wavPath: this.wavPath,
    };
    if (this.meta.transcriptPath) meta.transcriptPath = this.meta.transcriptPath;
    if (this.failure) meta.error = this.failure.message;
    return meta;
  }
}

// ------------------------------------------------------------------- tee

export interface TeeOptions {
  /** Forward JS objects (AudioChunk) rather than bytes. Default true. */
  objectMode?: boolean;
  /** Call `end()` on every target when the tee ends. Default true. */
  endTargets?: boolean;
  /**
   * Invoked when a target throws from `write()` or emits "error". Use it to
   * drop the failing branch (`tee.remove(target)`) and keep the others
   * flowing. Without it, a failing target destroys the tee with its error.
   */
  onTargetError?: (err: Error, target: Writable, tee: TeeWritable) => void;
}

/**
 * A Writable that forwards every chunk to N target Writables, so a single
 * AudioPipeline output can feed both the realtime STT client and a
 * CallRecorder. Targets can be added and removed while streaming.
 *
 * Forwarding is fire-and-forget: the tee acknowledges a chunk as soon as it
 * has been handed to every target and does not wait for targets' backpressure
 * (the intended targets — the STT feeder and the recorder — are synchronous).
 * A target that is already ended or destroyed is skipped.
 */
export class TeeWritable extends Writable {
  private readonly targetList: Writable[] = [];
  private readonly errorHandlers = new Map<Writable, (err: Error) => void>();
  private readonly endTargets: boolean;
  private readonly onTargetError: TeeOptions["onTargetError"];

  constructor(targets: Iterable<Writable> = [], opts: TeeOptions = {}) {
    super({ objectMode: opts.objectMode ?? true });
    this.endTargets = opts.endTargets ?? true;
    this.onTargetError = opts.onTargetError;
    for (const t of targets) this.add(t);
  }

  /** Snapshot of the current targets. */
  get targets(): Writable[] {
    return [...this.targetList];
  }

  add(target: Writable): this {
    if (this.targetList.includes(target)) return this;
    const handler = (err: Error) => this.handleTargetError(err, target);
    target.on("error", handler);
    this.errorHandlers.set(target, handler);
    this.targetList.push(target);
    return this;
  }

  /** Stop forwarding to `target` (it is not ended). Returns whether it was attached. */
  remove(target: Writable): boolean {
    const i = this.targetList.indexOf(target);
    if (i === -1) return false;
    this.targetList.splice(i, 1);
    const handler = this.errorHandlers.get(target);
    if (handler) {
      target.off("error", handler);
      this.errorHandlers.delete(target);
    }
    return true;
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    for (const target of [...this.targetList]) {
      if (target.destroyed || target.writableEnded) continue;
      try {
        target.write(chunk);
      } catch (err) {
        this.handleTargetError(toError(err), target);
      }
    }
    cb();
  }

  override _final(cb: (error?: Error | null) => void): void {
    if (this.endTargets) {
      for (const target of [...this.targetList]) {
        if (target.destroyed || target.writableEnded) continue;
        try {
          target.end();
        } catch (err) {
          this.handleTargetError(toError(err), target);
        }
      }
    }
    cb();
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    for (const target of [...this.targetList]) this.remove(target);
    cb(err);
  }

  private handleTargetError(err: Error, target: Writable): void {
    if (this.onTargetError) {
      this.onTargetError(err, target, this);
      return;
    }
    this.destroy(err);
  }
}

/** Convenience: `tee([sttSink, recorder.createWritable()])`. */
export function tee(targets: Iterable<Writable>, opts?: TeeOptions): TeeWritable {
  return new TeeWritable(targets, opts);
}

// --------------------------------------------------------------- helpers

/** Positional write that loops until every byte is on the fd. */
function writeFully(fd: number, buf: Buffer, position: number): void {
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset, position + offset);
    if (n <= 0) throw new Error("fs.writeSync wrote 0 bytes");
    offset += n;
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Prefix an error message while keeping the original as `cause`. */
function wrap(message: string, cause: unknown): Error {
  const inner = toError(cause);
  const code = (inner as NodeJS.ErrnoException).code;
  const err = new Error(`${message}: ${inner.message}`, { cause: inner }) as NodeJS.ErrnoException;
  if (code) err.code = code;
  return err;
}
