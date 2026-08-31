/**
 * Schema and migrations.
 *
 * The applied version lives in SQLite's own `user_version` pragma rather than
 * a bookkeeping table of ours, so a brand-new ":memory:" database and an
 * upgrade of a year-old file take exactly the same path: apply every migration
 * above the current version, in order, in one transaction. Never edit a
 * shipped migration — append another one.
 *
 * `node:sqlite` is used over better-sqlite3 because it ships with Node 22+ and
 * therefore has no native build step, which matters for an Electron app that
 * would otherwise need a rebuild per ABI.
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

/**
 * `node:sqlite` is resolved on demand instead of imported at module scope.
 *
 * It exists only on Node 22+, and Electron pins its own, older Node — Electron
 * 31 ships Node 20. A static import therefore throws
 * ERR_UNKNOWN_BUILTIN_MODULE while the module graph is still linking, which
 * takes the whole application down at startup before any code can report why.
 * Loading it lazily lets a caller ask `sqliteAvailable()` first and pick a
 * different CallRecordStore, so an old runtime degrades instead of crashing.
 */
interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

let sqlite: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  if (sqlite) return sqlite;
  const loaded = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  sqlite = loaded;
  return loaded;
}

/** Whether this runtime can back the CRM with SQLite. */
export function sqliteAvailable(): boolean {
  try {
    loadSqlite();
    return true;
  } catch {
    return false;
  }
}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE contacts (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    org          TEXT,
    notes        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE contact_phones (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    e164       TEXT NOT NULL,
    suffix     TEXT NOT NULL,
    raw        TEXT NOT NULL,
    UNIQUE (contact_id, e164)
  );
  CREATE INDEX idx_contact_phones_e164 ON contact_phones(e164);
  CREATE INDEX idx_contact_phones_suffix ON contact_phones(suffix);

  CREATE TABLE tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE contact_tags (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (contact_id, tag_id)
  );

  CREATE TABLE calls (
    call_id      TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    direction    TEXT NOT NULL,
    contact_id   TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    remote_party TEXT,
    state        TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    answered_at  INTEGER,
    ended_at     INTEGER,
    outcome      TEXT,
    transcript   TEXT NOT NULL DEFAULT '[]',
    states       TEXT NOT NULL DEFAULT '[]',
    error        TEXT,
    audio_path   TEXT
  );
  CREATE INDEX idx_calls_started_at ON calls(started_at);
  CREATE INDEX idx_calls_contact_id ON calls(contact_id);
  `,
];

/** The version a freshly migrated database reports. */
export const CRM_SCHEMA_VERSION = MIGRATIONS.length;

/** Open a database and bring it up to `CRM_SCHEMA_VERSION`. */
export function openCrmDatabase(path = ":memory:"): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}

/**
 * Apply outstanding migrations. Safe to call on an already-current database.
 * Returns the version the database is now at.
 */
export function migrate(db: DatabaseSync): number {
  // ON DELETE CASCADE / SET NULL are inert unless this is on, and it cannot be
  // changed inside a transaction.
  db.exec("PRAGMA foreign_keys = ON");

  const from = userVersion(db);
  if (from >= MIGRATIONS.length) return from;

  db.exec("BEGIN");
  try {
    for (let version = from; version < MIGRATIONS.length; version += 1) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) throw new Error(`crm: migration ${version} is missing`);
      db.exec(sql);
    }
    // PRAGMA does not accept bound parameters; the value is our own constant.
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return MIGRATIONS.length;
}

/** The schema version a database currently reports. 0 means empty. */
export function userVersion(db: DatabaseSync): number {
  const row: Record<string, unknown> | undefined = db.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "number" ? value : 0;
}
