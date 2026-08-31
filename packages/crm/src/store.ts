/**
 * The contact store.
 *
 * `CrmStore` is two things at once:
 *
 *  - a CRM — contacts, phone numbers, tags, and the calls linked to them;
 *  - a `CallRecordStore`, exactly the interface the orchestrator already
 *    persists through, so it drops straight in where `JsonlCallRecordStore`
 *    sits today and the orchestrator does not change a line.
 *
 * Every CRM method is synchronous because `node:sqlite` is; only the three
 * `CallRecordStore` methods are async, and they are thin wrappers whose
 * promises are already settled. Nothing here touches the network, spawns a
 * process or reads a clock it was not given, so the whole thing runs in a test
 * against ":memory:".
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CallRecord, CallRecordStore, TranscriptEntry } from "@neuracall/orchestrator";
import { normalizePhone, type PhoneOptions } from "./phone.js";
import { migrate, openCrmDatabase } from "./schema.js";
import type {
  Contact,
  ContactCallGroup,
  ContactPhone,
  CreateContactInput,
  CrmCall,
  CrmStoreOptions,
  ListContactsOptions,
  RecentCallsOptions,
} from "./types.js";

type Row = Record<string, unknown>;

const CALL_COLUMNS =
  "call_id, device_id, channel_id, direction, contact_id, remote_party, state, " +
  "started_at, answered_at, ended_at, outcome, transcript, states, error, audio_path";

export class CrmStore implements CallRecordStore {
  readonly db: DatabaseSync;
  private readonly phoneOptions: PhoneOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly autoLinkOnSave: boolean;

  constructor(options: CrmStoreOptions = {}) {
    if (options.db !== undefined) {
      this.db = options.db;
      migrate(this.db);
    } else {
      this.db = openCrmDatabase(options.path ?? ":memory:");
    }
    this.phoneOptions = {};
    if (options.defaultCountryCode !== undefined) {
      this.phoneOptions.defaultCountryCode = options.defaultCountryCode;
    }
    if (options.significantDigits !== undefined) {
      this.phoneOptions.significantDigits = options.significantDigits;
    }
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.autoLinkOnSave = options.autoLinkOnSave ?? true;
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- contacts

  createContact(input: CreateContactInput): Contact {
    const id = input.id ?? this.newId();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO contacts (id, display_name, org, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.displayName, input.org ?? null, input.notes ?? null, at, at);

    for (const phone of input.phones ?? []) this.addPhone(id, phone);
    for (const tag of input.tags ?? []) this.addTag(id, tag);

    const contact = this.getContact(id);
    if (contact === undefined) throw new Error(`crm: contact ${id} disappeared after insert`);
    return contact;
  }

  getContact(id: string): Contact | undefined {
    const row: Row | undefined = this.db
      .prepare(
        "SELECT id, display_name, org, notes, created_at, updated_at FROM contacts WHERE id = ?",
      )
      .get(id);
    if (row === undefined) return undefined;
    return this.hydrate([row])[0];
  }

  listContacts(opts: ListContactsOptions = {}): Contact[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.search !== undefined && opts.search !== "") {
      // instr() rather than LIKE so a "%" or "_" in a name is not a wildcard.
      where.push(
        "(instr(lower(c.display_name), lower(?)) > 0 OR instr(lower(ifnull(c.org, '')), lower(?)) > 0)",
      );
      params.push(opts.search, opts.search);
    }
    if (opts.tag !== undefined) {
      where.push(
        "EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id" +
          " WHERE ct.contact_id = c.id AND t.name = ?)",
      );
      params.push(opts.tag);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows: Row[] = this.db
      .prepare(
        `SELECT c.id, c.display_name, c.org, c.notes, c.created_at, c.updated_at
         FROM contacts c ${clause}
         ORDER BY c.display_name COLLATE NOCASE ASC, c.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit ?? -1, opts.offset ?? 0);
    return this.hydrate(rows);
  }

  /**
   * Attach a number to a contact. Returns null when the string holds no digits
   * ("unknown", "private") — dropping it beats throwing, because these come
   * from caller ID and from imported address books that nobody validated.
   */
  addPhone(contactId: string, raw: string): ContactPhone | null {
    const phone = normalizePhone(raw, this.phoneOptions);
    if (phone === null) return null;
    this.db
      .prepare(
        `INSERT INTO contact_phones (contact_id, e164, suffix, raw) VALUES (?, ?, ?, ?)
         ON CONFLICT(contact_id, e164) DO UPDATE SET suffix = excluded.suffix, raw = excluded.raw`,
      )
      .run(contactId, phone.key, phone.suffix, phone.raw);
    this.touch(contactId);
    return { e164: phone.key, suffix: phone.suffix, raw: phone.raw };
  }

  removePhone(contactId: string, raw: string): boolean {
    const phone = normalizePhone(raw, this.phoneOptions);
    if (phone === null) return false;
    const result = this.db
      .prepare("DELETE FROM contact_phones WHERE contact_id = ? AND e164 = ?")
      .run(contactId, phone.key);
    if (result.changes > 0) this.touch(contactId);
    return result.changes > 0;
  }

  addTag(contactId: string, name: string): void {
    this.db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
    this.db
      .prepare(
        `INSERT INTO contact_tags (contact_id, tag_id)
         SELECT ?, id FROM tags WHERE name = ?
         ON CONFLICT DO NOTHING`,
      )
      .run(contactId, name);
    this.touch(contactId);
  }

  removeTag(contactId: string, name: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM contact_tags
         WHERE contact_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)`,
      )
      .run(contactId, name);
    if (result.changes > 0) this.touch(contactId);
    return result.changes > 0;
  }

  // ------------------------------------------------------------ phone lookup

  /**
   * Every contact reachable on this number: the exact-key matches when there
   * are any, otherwise the suffix matches. The two are never mixed — a number
   * that matched exactly is not diluted with guesses.
   */
  findContactsByPhone(raw: string): Contact[] {
    return this.matchContacts(raw).contacts;
  }

  /**
   * The one contact this number belongs to, or undefined.
   *
   * An exact key matched by several contacts is a shared line (a household, a
   * switchboard); the oldest contact wins, deterministically. Several contacts
   * sharing only a digit *suffix* is a guess, and guessing wrong attributes a
   * call to a stranger, so that case returns undefined instead.
   */
  findContactByPhone(raw: string): Contact | undefined {
    const { contacts, exact } = this.matchContacts(raw);
    if (contacts.length === 0) return undefined;
    if (exact || contacts.length === 1) return contacts[0];
    return undefined;
  }

  private matchContacts(raw: string): { contacts: Contact[]; exact: boolean } {
    const phone = normalizePhone(raw, this.phoneOptions);
    if (phone === null) return { contacts: [], exact: false };

    const exact = this.contactsWhere("p.e164 = ?", phone.key);
    if (exact.length > 0) return { contacts: exact, exact: true };
    return { contacts: this.contactsWhere("p.suffix = ?", phone.suffix), exact: false };
  }

  private contactsWhere(clause: string, param: string): Contact[] {
    const rows: Row[] = this.db
      .prepare(
        `SELECT DISTINCT c.id, c.display_name, c.org, c.notes, c.created_at, c.updated_at
         FROM contacts c JOIN contact_phones p ON p.contact_id = c.id
         WHERE ${clause}
         ORDER BY c.created_at ASC, c.id ASC`,
      )
      .all(param);
    return this.hydrate(rows);
  }

  // ------------------------------------------------------------------- calls

  /**
   * Write a call. Idempotent by `callId`: the orchestrator saves the same
   * record repeatedly as a call progresses, so this must overwrite rather than
   * append.
   *
   * Passing no `contactId` leaves an existing link alone. That matters because
   * the orchestrator re-saves a record it knows nothing about the CRM for, and
   * a naive overwrite would silently unlink every call mid-conversation.
   */
  upsertCall(record: CallRecord, contactId?: string | null): CrmCall {
    this.db
      .prepare(
        `INSERT INTO calls (${CALL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET
           device_id    = excluded.device_id,
           channel_id   = excluded.channel_id,
           direction    = excluded.direction,
           contact_id   = COALESCE(excluded.contact_id, calls.contact_id),
           remote_party = excluded.remote_party,
           state        = excluded.state,
           started_at   = excluded.started_at,
           answered_at  = excluded.answered_at,
           ended_at     = excluded.ended_at,
           outcome      = excluded.outcome,
           transcript   = excluded.transcript,
           states       = excluded.states,
           error        = excluded.error,
           audio_path   = excluded.audio_path`,
      )
      .run(
        record.callId,
        record.deviceId,
        record.channelId,
        record.direction,
        contactId ?? null,
        record.remoteParty,
        record.state,
        record.startedAt,
        record.answeredAt,
        record.endedAt,
        record.outcome,
        JSON.stringify(record.transcript),
        JSON.stringify(record.states),
        record.error ?? null,
        record.audioPath,
      );

    const stored = this.getCall(record.callId);
    if (stored === undefined)
      throw new Error(`crm: call ${record.callId} disappeared after upsert`);
    return stored;
  }

  getCall(callId: string): CrmCall | undefined {
    const row: Row | undefined = this.db
      .prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE call_id = ?`)
      .get(callId);
    return row === undefined ? undefined : toCall(row);
  }

  /** Point a call at a contact, or pass null to unlink it. */
  linkCallToContact(callId: string, contactId: string | null): boolean {
    const result = this.db
      .prepare("UPDATE calls SET contact_id = ? WHERE call_id = ?")
      .run(contactId, callId);
    return result.changes > 0;
  }

  /**
   * Link a call to whichever contact already owns its `remoteParty`. Creates
   * nothing: an unknown number stays unknown until a human names it. An
   * already-linked call is left alone, so a manual correction is never undone
   * by a later re-save.
   *
   * Returns the contact id it linked to (or the one already linked).
   */
  autoLinkCall(callId: string): string | undefined {
    const row: Row | undefined = this.db
      .prepare("SELECT contact_id, remote_party FROM calls WHERE call_id = ?")
      .get(callId);
    if (row === undefined) return undefined;

    const existing = textOrNull(row, "contact_id");
    if (existing !== null) return existing;

    const remote = textOrNull(row, "remote_party");
    if (remote === null) return undefined;

    const contact = this.findContactByPhone(remote);
    if (contact === undefined) return undefined;

    this.linkCallToContact(callId, contact.id);
    return contact.id;
  }

  callsForContact(contactId: string, opts: { limit?: number } = {}): CrmCall[] {
    return this.recentCalls({ contactId, ...opts });
  }

  /** Newest first, optionally narrowed to one device or contact. */
  recentCalls(opts: RecentCallsOptions = {}): CrmCall[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.deviceId !== undefined) {
      where.push("device_id = ?");
      params.push(opts.deviceId);
    }
    if (opts.contactId !== undefined) {
      where.push("contact_id = ?");
      params.push(opts.contactId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows: Row[] = this.db
      .prepare(
        `SELECT ${CALL_COLUMNS} FROM calls ${clause}
         ORDER BY started_at DESC, call_id ASC
         LIMIT ?`,
      )
      // SQLite reads a negative LIMIT as "no limit".
      .all(...params, opts.limit ?? -1);
    return rows.map(toCall);
  }

  /**
   * Call history rolled up per contact, busiest-most-recent first. Calls that
   * never matched a contact all land in a single group with `contact: null`
   * rather than one group per unknown number — the UI shows it as "unknown".
   */
  groupByContact(opts: { limit?: number; includeUnlinked?: boolean } = {}): ContactCallGroup[] {
    const clause = (opts.includeUnlinked ?? true) ? "" : "WHERE contact_id IS NOT NULL";
    const rows: Row[] = this.db
      .prepare(
        `SELECT contact_id,
                COUNT(*)        AS call_count,
                MIN(started_at) AS first_at,
                MAX(started_at) AS last_at
         FROM calls ${clause}
         GROUP BY contact_id
         ORDER BY last_at DESC
         LIMIT ?`,
      )
      .all(opts.limit ?? -1);

    return rows.map((row) => {
      const contactId = textOrNull(row, "contact_id");
      return {
        contact: contactId === null ? null : (this.getContact(contactId) ?? null),
        callCount: intOf(row, "call_count"),
        firstCallAt: intOf(row, "first_at"),
        lastCallAt: intOf(row, "last_at"),
      };
    });
  }

  // -------------------------------------------------------- CallRecordStore

  async save(record: CallRecord): Promise<void> {
    this.upsertCall(record);
    if (this.autoLinkOnSave) this.autoLinkCall(record.callId);
  }

  async get(callId: string): Promise<CallRecord | undefined> {
    return this.getCall(callId);
  }

  async list(opts: { deviceId?: string; limit?: number } = {}): Promise<CallRecord[]> {
    return this.recentCalls(opts);
  }

  // ----------------------------------------------------------------- private

  private touch(contactId: string): void {
    this.db.prepare("UPDATE contacts SET updated_at = ? WHERE id = ?").run(this.now(), contactId);
  }

  /**
   * Turn contact rows into `Contact`s, fetching their phones and tags in one
   * query each rather than one per contact.
   */
  private hydrate(rows: Row[]): Contact[] {
    if (rows.length === 0) return [];
    const contacts = rows.map<Contact>((row) => ({
      id: textOf(row, "id"),
      displayName: textOf(row, "display_name"),
      org: textOrNull(row, "org"),
      notes: textOrNull(row, "notes"),
      createdAt: intOf(row, "created_at"),
      updatedAt: intOf(row, "updated_at"),
      phones: [],
      tags: [],
    }));

    const byId = new Map(contacts.map((c) => [c.id, c]));
    const ids = [...byId.keys()];
    const placeholders = ids.map(() => "?").join(", ");

    const phoneRows: Row[] = this.db
      .prepare(
        `SELECT contact_id, e164, suffix, raw FROM contact_phones
         WHERE contact_id IN (${placeholders}) ORDER BY id ASC`,
      )
      .all(...ids);
    for (const row of phoneRows) {
      byId.get(textOf(row, "contact_id"))?.phones.push({
        e164: textOf(row, "e164"),
        suffix: textOf(row, "suffix"),
        raw: textOf(row, "raw"),
      });
    }

    const tagRows: Row[] = this.db
      .prepare(
        `SELECT ct.contact_id, t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
         WHERE ct.contact_id IN (${placeholders}) ORDER BY t.name ASC`,
      )
      .all(...ids);
    for (const row of tagRows) {
      byId.get(textOf(row, "contact_id"))?.tags.push(textOf(row, "name"));
    }

    return contacts;
  }
}

/**
 * The enum-ish columns (`direction`, `state`, `outcome`, `channel_id`) are
 * asserted rather than validated: nothing but this module writes them, and the
 * only writer is a typed `CallRecord`.
 */
function toCall(row: Row): CrmCall {
  const call: CrmCall = {
    callId: textOf(row, "call_id"),
    deviceId: textOf(row, "device_id"),
    channelId: textOf(row, "channel_id") as CallRecord["channelId"],
    direction: textOf(row, "direction") as CallRecord["direction"],
    state: textOf(row, "state") as CallRecord["state"],
    outcome: textOrNull(row, "outcome") as CallRecord["outcome"],
    remoteParty: textOrNull(row, "remote_party"),
    startedAt: intOf(row, "started_at"),
    answeredAt: intOrNull(row, "answered_at"),
    endedAt: intOrNull(row, "ended_at"),
    transcript: parseJson<TranscriptEntry[]>(row["transcript"], []),
    audioPath: textOrNull(row, "audio_path"),
    states: parseJson<CallRecord["states"]>(row["states"], []),
    contactId: textOrNull(row, "contact_id"),
  };
  // `error` is optional on CallRecord, so an absent one must be an absent
  // property — not a property set to undefined, which no longer deep-equals
  // the record that went in.
  const error = textOrNull(row, "error");
  if (error !== null) call.error = error;
  return call;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function textOf(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`crm: column "${column}" is not text`);
  return value;
}

function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function intOf(row: Row, column: string): number {
  const value = intOrNull(row, column);
  if (value === null) throw new Error(`crm: column "${column}" is not a number`);
  return value;
}

function intOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (typeof value === "number") return value;
  // SQLite hands back a bigint for anything that does not fit a double; ms
  // timestamps never do, but COUNT/MIN/MAX can be typed that way.
  if (typeof value === "bigint") return Number(value);
  return null;
}
