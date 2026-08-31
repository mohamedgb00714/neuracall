/**
 * Call-record persistence.
 *
 * Two implementations, both behind `CallRecordStore`:
 *
 *  - `MemoryCallRecordStore` — for tests and for running without a data dir.
 *  - `JsonlCallRecordStore`  — append-only JSON Lines on disk. Durable enough
 *    for a single-process desktop app, needs no native module, and survives a
 *    crash mid-call because every `save` is a whole record appended atomically
 *    rather than a mutation of existing bytes.
 *
 * The Phase 6 CRM task adds a SQLite-backed store behind the same interface
 * (contacts, joins, indexed queries); nothing in the orchestrator changes when
 * it lands. JSONL is the right shape for that migration too — replaying the
 * log into a table is trivial, and the last entry for a `callId` wins.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import type { CallRecord, CallRecordStore } from "./types.js";

/** Keeps records in a Map. Nothing survives the process. */
export class MemoryCallRecordStore implements CallRecordStore {
  private readonly records = new Map<string, CallRecord>();

  async save(record: CallRecord): Promise<void> {
    this.records.set(record.callId, clone(record));
  }

  async get(callId: string): Promise<CallRecord | undefined> {
    const found = this.records.get(callId);
    return found ? clone(found) : undefined;
  }

  async list(opts: { deviceId?: string; limit?: number } = {}): Promise<CallRecord[]> {
    return query([...this.records.values()], opts);
  }

  /** Synchronous view, for assertions in tests. */
  get all(): CallRecord[] {
    return [...this.records.values()].map(clone);
  }
}

/**
 * Append-only JSON Lines store. The file is read once on construction to
 * rebuild the index, then only appended to. A record saved several times as a
 * call progresses appears several times in the file; the last one wins.
 *
 * A malformed line (a half-written record from a hard kill) is skipped rather
 * than throwing, so one bad tail cannot make the whole call history
 * unreadable.
 */
export class JsonlCallRecordStore implements CallRecordStore {
  readonly path: string;
  private readonly records = new Map<string, CallRecord>();
  /** Lines that could not be parsed when the log was replayed. */
  readonly corruptLines: number;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let corrupt = 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const record = JSON.parse(trimmed) as CallRecord;
          if (typeof record.callId === "string") this.records.set(record.callId, record);
          else corrupt += 1;
        } catch {
          corrupt += 1; // truncated tail from an unclean shutdown
        }
      }
    }
    this.corruptLines = corrupt;
  }

  async save(record: CallRecord): Promise<void> {
    const copy = clone(record);
    this.records.set(copy.callId, copy);
    appendFileSync(this.path, `${JSON.stringify(copy)}\n`, { mode: 0o600 });
  }

  async get(callId: string): Promise<CallRecord | undefined> {
    const found = this.records.get(callId);
    return found ? clone(found) : undefined;
  }

  async list(opts: { deviceId?: string; limit?: number } = {}): Promise<CallRecord[]> {
    return query([...this.records.values()], opts);
  }
}

/** Newest first, optionally filtered by device and capped. */
function query(
  records: CallRecord[],
  opts: { deviceId?: string; limit?: number },
): CallRecord[] {
  let out = records;
  if (opts.deviceId !== undefined) out = out.filter((r) => r.deviceId === opts.deviceId);
  out = [...out].sort((a, b) => b.startedAt - a.startedAt);
  if (opts.limit !== undefined) out = out.slice(0, opts.limit);
  return out.map(clone);
}

/**
 * Deep-copy a record so callers cannot mutate what the store holds (and so a
 * record still being built by a live call is snapshotted, not aliased).
 */
function clone(record: CallRecord): CallRecord {
  const copy: CallRecord = {
    ...record,
    transcript: record.transcript.map((t) => ({ ...t })),
    states: record.states.map((s) => ({ ...s })),
  };
  // `postCall` is nested and arrived later than the fields above; a shallow
  // spread would hand every caller the same object and quietly break the
  // "hands out copies" guarantee for it alone.
  if (record.postCall) {
    copy.postCall = {
      ...record.postCall,
      ...(record.postCall.utterances
        ? { utterances: record.postCall.utterances.map((u) => ({ ...u })) }
        : {}),
    };
  }
  return copy;
}
