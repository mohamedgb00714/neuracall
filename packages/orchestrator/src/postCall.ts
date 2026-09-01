/**
 * Post-call analytics: a finished call's WAV becomes a speaker-labelled
 * transcript and a summary, attached to its own call record.
 *
 * Three properties shape everything here, and none is negotiable:
 *
 *  - **It is optional and it never touches a live call.** This runs after
 *    teardown, off the call loop entirely. Nothing it does can throw into the
 *    orchestrator: every failure is recorded on the result, reported through a
 *    callback, and resolved — never rejected. A call record that already exists
 *    must survive analytics failing.
 *  - **It queues.** A busy shift ends several calls within seconds of each
 *    other and each one wants to upload a whole recording. Default concurrency
 *    is 1, so one upload is in flight at a time and the desktop app's uplink
 *    stays usable.
 *  - **It refuses to spend money on nothing.** No `audioPath`, a file that is
 *    gone, or a recording too short to hold a conversation are skipped before
 *    the upload, with the reason recorded.
 *
 * Transcription and summarisation are the existing `@neuracall/aai-client`
 * clients (`PrerecordedClient`, `LlmGatewayClient`) behind two narrow
 * interfaces, so the tests run offline against fakes with no key and no spend.
 */

import { open, stat } from "node:fs/promises";
import { parseWavHeader } from "@neuracall/audio-pipeline";
import {
  utterancesToText,
  type PollOptions,
  type SummarizeOptions,
  type TranscribeOptions,
  type Transcript,
} from "@neuracall/aai-client";
import type {
  CallRecord,
  CallRecordStore,
  PostCallAnalysis,
  PostCallSkipReason,
  PostCallUtterance,
} from "./types.js";

/**
 * Recordings shorter than this are skipped. A misdial, a voicemail beep or a
 * call that dropped on answer produces a second or two of audio that costs a
 * full upload and transcribes to nothing.
 */
export const DEFAULT_MIN_DURATION_SEC = 3;

/** Default concurrency: one upload at a time. See the module comment. */
export const DEFAULT_POST_CALL_CONCURRENCY = 1;

/**
 * How much of the file is read to find the WAV header. The canonical layout
 * needs 44 bytes; the slack covers a writer that puts a `LIST`/`fact` chunk
 * before `data`.
 */
const WAV_HEADER_PROBE_BYTES = 4096;

/** What `process()` resolves to. Resolves on failure too — it never rejects. */
export interface PostCallResult extends PostCallAnalysis {
  callId: string;
  /**
   * Set when the analysis could not be written back to the store. The analysis
   * itself is still valid and is returned; it just did not persist.
   */
  persistError?: string;
}

/** The slice of `PrerecordedClient` this needs. */
export interface PostCallTranscriber {
  transcribe(opts: TranscribeOptions): Promise<Transcript>;
}

/** The slice of `LlmGatewayClient` this needs. */
export interface PostCallSummarizer {
  summarize(transcriptText: string, opts: SummarizeOptions): Promise<string>;
}

/**
 * The filesystem, injected so the skip rules are testable without a disk.
 * `stat` reports absence as `undefined` rather than throwing, because a missing
 * recording is an ordinary outcome here, not an error.
 */
export interface PostCallFs {
  stat(path: string): Promise<{ size: number } | undefined>;
  /** Read up to `length` bytes from offset 0. May return fewer. */
  readHead(path: string, length: number): Promise<Uint8Array>;
}

export interface PostCallOptions {
  transcriber: PostCallTranscriber;
  /** Where the analysis is written back. Normally the orchestrator's store. */
  store: CallRecordStore;
  /**
   * Summarisation is skipped entirely unless both this and `summaryModel` are
   * supplied. Omitting it is a supported configuration, not a degraded one.
   */
  summarizer?: PostCallSummarizer;
  /**
   * The LLM Gateway model id. **No default, deliberately** — gateway ids are
   * exact versioned strings that are retired faster than this package ships, so
   * a baked-in default rots into a 400 on a call that already cost an upload.
   * It comes from `AppConfig.llm.model`, where an operator can change it. When
   * it is absent the transcript is still produced; only the summary is skipped.
   */
  summaryModel?: string;
  /** Overrides the client's default call-summary instruction. */
  summaryPrompt?: string;
  summaryMaxTokens?: number;
  /** Default DEFAULT_MIN_DURATION_SEC. */
  minDurationSec?: number;
  /** Default DEFAULT_POST_CALL_CONCURRENCY. */
  concurrency?: number;
  /** Diarizer hint. A call has two parties, so this defaults to 2. */
  speakersExpected?: number;
  /** Mutually exclusive with languageDetection — the client enforces it. */
  languageCode?: string;
  languageDetection?: boolean;
  /** Domain terms to bias recognition (names, SKUs, account numbers). */
  keytermsPrompt?: string[];
  poll?: PollOptions;
  fs?: PostCallFs;
  now?: () => number;
  /** Aborts in-flight uploads and polls, e.g. on app shutdown. */
  signal?: AbortSignal;
  /** Called once per finished call, whatever the outcome. */
  onResult?: (result: PostCallResult) => void;
  /**
   * Called as well as `onResult` when something went wrong. `cause` is the
   * thrown value, which the result can only carry as a message string because
   * it has to survive JSON in the store.
   */
  onError?: (result: PostCallResult, cause: unknown) => void;
}

/** The analysis before the clock has been read. */
type Attempt = {
  analysis: Omit<PostCallAnalysis, "at" | "durationMs">;
  cause?: unknown;
};

export class PostCallProcessor {
  private readonly transcriber: PostCallTranscriber;
  private readonly store: CallRecordStore;
  private readonly summarizer: PostCallSummarizer | undefined;
  private readonly summaryModel: string | undefined;
  private readonly opts: PostCallOptions;
  private readonly minDurationSec: number;
  private readonly concurrency: number;
  private readonly fs: PostCallFs;
  private readonly now: () => number;

  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;
  private readonly drains: Array<() => void> = [];

  constructor(opts: PostCallOptions) {
    this.opts = opts;
    this.transcriber = opts.transcriber;
    this.store = opts.store;
    this.summarizer = opts.summarizer;
    this.summaryModel = opts.summaryModel;
    this.minDurationSec = opts.minDurationSec ?? DEFAULT_MIN_DURATION_SEC;
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_POST_CALL_CONCURRENCY));
    this.fs = opts.fs ?? nodeFs;
    this.now = opts.now ?? Date.now;
  }

  /** Calls waiting for a slot. */
  get pending(): number {
    return this.queue.length;
  }

  /** Calls being processed right now. */
  get active(): number {
    return this.running;
  }

  /**
   * Queue a finished call for analysis. Resolves with the result once it has
   * run — including when it failed or was skipped. It never rejects.
   */
  process(record: CallRecord): Promise<PostCallResult> {
    return new Promise<PostCallResult>((resolve) => {
      this.queue.push(async () => {
        let result: PostCallResult;
        let cause: unknown;
        try {
          const outcome = await this.run(record);
          result = outcome.result;
          cause = outcome.cause;
        } catch (err) {
          // run() is written not to throw. This keeps the promise's contract
          // true even if some day it does.
          result = {
            callId: record.callId,
            status: "failed",
            error: describeError(err),
            at: this.now(),
            durationMs: 0,
          };
          cause = err;
        }
        this.report(result, cause);
        resolve(result);
      });
      this.pump();
    });
  }

  /** Resolves when the queue is empty and nothing is in flight. */
  drain(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drains.push(resolve);
    });
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = this.queue.shift();
      if (next === undefined) return;
      this.running += 1;
      void next().then(
        () => this.finished(),
        () => this.finished(),
      );
    }
  }

  private finished(): void {
    this.running -= 1;
    this.pump();
    if (this.queue.length === 0 && this.running === 0) {
      for (const resolve of this.drains.splice(0)) resolve();
    }
  }

  private async run(record: CallRecord): Promise<{ result: PostCallResult; cause?: unknown }> {
    const startedAt = this.now();
    const attempt = await this.analyse(record);
    const at = this.now();
    const analysis: PostCallAnalysis = { ...attempt.analysis, at, durationMs: at - startedAt };

    const persistError = await this.persist(record, analysis);
    const result: PostCallResult = { callId: record.callId, ...analysis };
    if (persistError !== undefined) result.persistError = persistError;
    return { result, cause: attempt.cause };
  }

  private async analyse(record: CallRecord): Promise<Attempt> {
    const audioPath = record.audioPath;
    if (audioPath === null || audioPath.trim() === "") return skipped("no-audio");

    let durationSec: number | undefined;
    let sizeBytes: number;
    try {
      const info = await this.fs.stat(audioPath);
      if (info === undefined) return skipped("audio-missing", audioPath);
      sizeBytes = info.size;
      durationSec = wavDurationSec(
        await this.fs.readHead(audioPath, WAV_HEADER_PROBE_BYTES),
        sizeBytes,
      );
    } catch (err) {
      return skipped("audio-unreadable", describeError(err));
    }
    // The orchestrator only ever writes RIFF/WAVE recordings, so a file whose
    // header will not parse is damaged — and uploading a damaged recording buys
    // a paid job that fails later with a worse message.
    if (durationSec === undefined) return skipped("audio-unreadable", "not a PCM WAV file");
    if (durationSec < this.minDurationSec) {
      return skipped(
        "too-short",
        `${durationSec.toFixed(2)}s recording, minimum is ${this.minDurationSec}s`,
      );
    }

    let transcript: Transcript;
    try {
      transcript = await this.transcriber.transcribe(this.transcribeOptions(audioPath));
    } catch (err) {
      return {
        analysis: { status: "failed", error: describeError(err), audioDurationSec: durationSec },
        cause: err,
      };
    }

    const analysis: Omit<PostCallAnalysis, "at" | "durationMs"> = {
      status: "completed",
      transcriptId: transcript.id,
      text: transcript.text ?? "",
      utterances: toUtterances(transcript),
      audioDurationSec: transcript.audio_duration ?? durationSec,
    };
    if (typeof transcript.language_code === "string") {
      analysis.languageCode = transcript.language_code;
    }

    return await this.summarise(analysis, transcript);
  }

  private transcribeOptions(audioPath: string): TranscribeOptions {
    const opts: TranscribeOptions = {
      audio: { path: audioPath },
      speakerLabels: true,
      speakersExpected: this.opts.speakersExpected ?? 2,
    };
    if (this.opts.languageCode !== undefined) opts.languageCode = this.opts.languageCode;
    if (this.opts.languageDetection !== undefined) {
      opts.languageDetection = this.opts.languageDetection;
    }
    if (this.opts.keytermsPrompt !== undefined) opts.keytermsPrompt = this.opts.keytermsPrompt;
    if (this.opts.poll !== undefined) opts.poll = this.opts.poll;
    if (this.opts.signal !== undefined) opts.signal = this.opts.signal;
    return opts;
  }

  private async summarise(
    analysis: Omit<PostCallAnalysis, "at" | "durationMs">,
    transcript: Transcript,
  ): Promise<Attempt> {
    const summarizer = this.summarizer;
    const model = this.summaryModel;
    if (summarizer === undefined || model === undefined || model === "") return { analysis };

    // Speaker-prefixed lines, so the model can tell the parties apart. The
    // client already flattens a diarized transcript this way.
    const prompt = utterancesToText(transcript);
    if (prompt.trim() === "") return { analysis };

    const opts: SummarizeOptions = { model };
    if (this.opts.summaryPrompt !== undefined) opts.systemPrompt = this.opts.summaryPrompt;
    if (this.opts.summaryMaxTokens !== undefined) opts.maxTokens = this.opts.summaryMaxTokens;
    if (this.opts.signal !== undefined) opts.signal = this.opts.signal;

    try {
      analysis.summary = await summarizer.summarize(prompt, opts);
      analysis.summaryModel = model;
      return { analysis };
    } catch (err) {
      // The transcript already cost an upload; a failed summary must not throw
      // it away, so this stays "completed" with the failure recorded beside it.
      analysis.summaryError = describeError(err);
      return { analysis, cause: err };
    }
  }

  /** Write the analysis onto the stored record. Returns why, if it failed. */
  private async persist(
    record: CallRecord,
    analysis: PostCallAnalysis,
  ): Promise<string | undefined> {
    try {
      // Re-read rather than saving the record passed in: that one is a snapshot
      // taken at teardown, and anything written since (a CRM enrichment, an
      // outcome correction) would be clobbered by writing it back verbatim.
      const latest = (await this.store.get(record.callId)) ?? record;
      await this.store.save({ ...latest, postCall: analysis });
      return undefined;
    } catch (err) {
      return describeError(err);
    }
  }

  private report(result: PostCallResult, cause: unknown): void {
    // A listener that throws must not take the queue down with it.
    try {
      this.opts.onResult?.(result);
    } catch {
      /* ignored */
    }
    if (!hasFailure(result)) return;
    try {
      this.opts.onError?.(result, cause);
    } catch {
      /* ignored */
    }
  }
}

/** True when anything about this result went wrong, partially or entirely. */
export function hasFailure(result: PostCallResult): boolean {
  return (
    result.status === "failed" ||
    result.error !== undefined ||
    result.summaryError !== undefined ||
    result.persistError !== undefined
  );
}

/**
 * Duration of a PCM WAV from its header, or undefined when the bytes are not
 * one. `fileSize` is a second opinion on the data chunk: a recording whose
 * process died mid-call still has zeroed size fields with the samples on disk,
 * so the larger of the two is the honest answer.
 */
export function wavDurationSec(head: Uint8Array, fileSize: number): number | undefined {
  let info;
  try {
    info = parseWavHeader(head);
  } catch {
    return undefined;
  }
  if (info.byteRate <= 0) return undefined;
  const dataBytes = Math.max(info.dataBytes, fileSize - info.dataOffset);
  return dataBytes > 0 ? dataBytes / info.byteRate : 0;
}

function toUtterances(transcript: Transcript): PostCallUtterance[] {
  const utterances = transcript.utterances;
  if (utterances === undefined || utterances === null) return [];
  return utterances.map((u) => ({
    speaker: u.speaker,
    text: u.text,
    start: u.start,
    end: u.end,
    confidence: u.confidence,
  }));
}

function skipped(reason: PostCallSkipReason, detail?: string): Attempt {
  const analysis: Omit<PostCallAnalysis, "at" | "durationMs"> = {
    status: "skipped",
    skipReason: reason,
  };
  if (detail !== undefined) analysis.skipDetail = detail;
  return { analysis };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

const nodeFs: PostCallFs = {
  async stat(path: string): Promise<{ size: number } | undefined> {
    try {
      const info = await stat(path);
      return info.isFile() ? { size: info.size } : undefined;
    } catch {
      // Gone, or unreadable in a way that is indistinguishable from gone.
      return undefined;
    }
  },
  async readHead(path: string, length: number): Promise<Uint8Array> {
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};
