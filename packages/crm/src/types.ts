/**
 * The CRM's own shapes. Call records stay exactly the orchestrator's
 * `CallRecord` — `CrmCall` only adds the contact link — so a record written by
 * the orchestrator and read back through the CRM is the same object it was.
 */

import type { CallRecord } from "@neuracall/orchestrator";
import type { DatabaseSync } from "node:sqlite";

/** One phone number belonging to a contact. */
export interface ContactPhone {
  /** The normalized match key ("+15550109999"). */
  e164: string;
  /** The trailing digits used by the suffix fallback. */
  suffix: string;
  /** What the number looked like when it was added. */
  raw: string;
}

/** A person or company, with every number we know reaches them. */
export interface Contact {
  id: string;
  displayName: string;
  org: string | null;
  notes: string | null;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch. Bumped whenever a phone or tag changes. */
  updatedAt: number;
  phones: ContactPhone[];
  tags: string[];
}

export interface CreateContactInput {
  displayName: string;
  org?: string;
  notes?: string;
  /** Raw numbers; each is normalized on the way in. Unparseable ones are dropped. */
  phones?: string[];
  tags?: string[];
  /** Supply an id to make an import idempotent; otherwise one is generated. */
  id?: string;
}

/** A call record plus the contact it belongs to, if it has been linked. */
export interface CrmCall extends CallRecord {
  contactId: string | null;
}

/** One row of the `groupByContact` roll-up. */
export interface ContactCallGroup {
  /** Null for the bucket of calls that never matched a contact. */
  contact: Contact | null;
  callCount: number;
  /** ms since epoch of the earliest call in the group. */
  firstCallAt: number;
  /** ms since epoch of the latest call in the group. */
  lastCallAt: number;
}

export interface ListContactsOptions {
  /** Case-insensitive substring of the display name or org. */
  search?: string;
  /** Only contacts carrying this tag. */
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface RecentCallsOptions {
  deviceId?: string;
  contactId?: string;
  limit?: number;
}

export interface CrmStoreOptions {
  /** Database file. Defaults to ":memory:", which is what tests want. */
  path?: string;
  /** An already-open handle, when the caller owns the connection lifetime. */
  db?: DatabaseSync;
  /** Country calling code assumed for numbers stored or looked up without one. */
  defaultCountryCode?: string;
  /** Trailing digits the suffix fallback compares. Defaults to 7. */
  significantDigits?: number;
  /** Injected so tests get stable timestamps. */
  now?: () => number;
  /** Injected so tests get stable contact ids. */
  newId?: () => string;
  /**
   * Try to match `remoteParty` to an existing contact on every `save`.
   * Defaults to true; it never creates a contact, so the worst case is a
   * lookup that finds nothing.
   */
  autoLinkOnSave?: boolean;
}
