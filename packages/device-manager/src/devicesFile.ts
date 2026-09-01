/**
 * devices.json — the list of wireless ADB endpoints NeuraCall should reconnect
 * to. It is written by `scripts/adb-setup.sh` (one-time USB → Wi-Fi handshake)
 * and edited by `scripts/adbtool.sh`; the desktop runtime reads it at startup
 * and hands the endpoints to DeviceManager as `knownEndpoints`.
 *
 * Shape (version 1):
 *
 *   {
 *     "version": 1,
 *     "devices": [
 *       { "endpoint": "192.168.1.20:5555", "serial": "ABC123", "label": "realme RMX3624",
 *         "addedAt": "2026-08-31T12:00:00.000Z" }
 *     ]
 *   }
 *
 * Everything here is synchronous and side-effect free apart from
 * loadDevicesFile / saveDevicesFile, so it can run inside a constructor.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Only version the parser understands. */
export const DEVICES_FILE_VERSION = 1 as const;

/** Conventional file name (repo root: `<repo>/devices.json`). */
export const DEVICES_FILE_NAME = "devices.json";

/** Port `adb tcpip` listens on by default; appended to bare hosts. */
export const DEFAULT_ADB_TCP_PORT = 5555;

/** One saved wireless device. */
export interface DevicesFileEntry {
  /** ADB wireless endpoint, always `host:port` (e.g. "192.168.1.20:5555"). */
  endpoint: string;
  /** Hardware serial (`ro.serialno`), used to match the USB and Wi-Fi identity. */
  serial?: string;
  /** Human label, e.g. "realme RMX3624". */
  label?: string;
  /** ISO-8601 timestamp of when the endpoint was first saved. */
  addedAt: string;
}

/** The parsed file. */
export interface DevicesFile {
  version: typeof DEVICES_FILE_VERSION;
  devices: DevicesFileEntry[];
}

/** What saveDevicesFile / upsertDevices accept: a bare endpoint or a partial entry. */
export type DevicesFileInput =
  string | { endpoint: string; serial?: string; label?: string; addedAt?: string };

/** Thrown for a malformed file or an invalid endpoint. */
export class DevicesFileError extends Error {
  override readonly name = "DevicesFileError";
  constructor(
    message: string,
    /** File the error relates to, when known. */
    readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
  }
}

export interface DevicesFileOptions {
  /** Clock used for `addedAt` of new entries. Default: `() => new Date()`. */
  now?: () => Date;
}

/** A fresh, empty file value. */
export function emptyDevicesFile(): DevicesFile {
  return { version: DEVICES_FILE_VERSION, devices: [] };
}

/**
 * Normalize an endpoint to `host:port`. A bare host gets the default port; an
 * IPv6 literal must be bracketed (`[fe80::1]:5555`). Throws DevicesFileError
 * when the value cannot be an adb endpoint.
 */
export function normalizeEndpoint(raw: string, defaultPort = DEFAULT_ADB_TCP_PORT): string {
  const value = raw.trim();
  if (!value) throw new DevicesFileError("endpoint is empty");
  if (/\s/.test(value)) throw new DevicesFileError(`endpoint "${value}" contains whitespace`);

  let host: string;
  let port: string | undefined;
  if (value.startsWith("[")) {
    // [ipv6]:port
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (!m || !m[1]) throw new DevicesFileError(`endpoint "${value}" is not a valid [ipv6]:port`);
    host = `[${m[1]}]`;
    port = m[2];
  } else {
    const colons = value.split(":").length - 1;
    if (colons > 1) {
      throw new DevicesFileError(
        `endpoint "${value}" has several ':' — bracket IPv6 literals as [addr]:port`,
      );
    }
    const idx = value.indexOf(":");
    host = idx === -1 ? value : value.slice(0, idx);
    port = idx === -1 ? undefined : value.slice(idx + 1);
  }

  if (!host || host === "[]") throw new DevicesFileError(`endpoint "${value}" has no host`);
  const portNum = port === undefined ? defaultPort : Number(port);
  if (!/^\d+$/.test(port ?? String(defaultPort)) || portNum < 1 || portNum > 65535) {
    throw new DevicesFileError(`endpoint "${value}" has an invalid port`);
  }
  return `${host}:${portNum}`;
}

/** True when `raw` normalizes without throwing. */
export function isValidEndpoint(raw: string): boolean {
  try {
    normalizeEndpoint(raw);
    return true;
  } catch {
    return false;
  }
}

/** Endpoints of a parsed file, in file order (already normalized). */
export function knownEndpoints(file: DevicesFile): string[] {
  return file.devices.map((d) => d.endpoint);
}

/**
 * Validate raw JSON text into a DevicesFile. Unknown keys are dropped,
 * endpoints are normalized, duplicate endpoints collapse onto the first entry
 * (keeping the earliest addedAt). Entries without addedAt get `now`.
 */
export function parseDevicesFile(
  text: string,
  opts: DevicesFileOptions & { path?: string } = {},
): DevicesFile {
  const path = opts.path;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DevicesFileError(
      `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      path,
    );
  }
  if (!isRecord(raw)) throw new DevicesFileError("top level must be an object", path);
  if (raw.version !== DEVICES_FILE_VERSION) {
    throw new DevicesFileError(
      `unsupported version ${JSON.stringify(raw.version)} (expected ${DEVICES_FILE_VERSION})`,
      path,
    );
  }
  if (!Array.isArray(raw.devices)) throw new DevicesFileError('"devices" must be an array', path);

  const now = opts.now ?? (() => new Date());
  const entries: DevicesFileInput[] = raw.devices.map((item, i) => {
    if (!isRecord(item)) throw new DevicesFileError(`devices[${i}] must be an object`, path);
    if (typeof item.endpoint !== "string")
      throw new DevicesFileError(`devices[${i}].endpoint must be a string`, path);
    for (const key of ["serial", "label", "addedAt"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") {
        throw new DevicesFileError(`devices[${i}].${key} must be a string`, path);
      }
    }
    try {
      normalizeEndpoint(item.endpoint);
    } catch (err) {
      throw new DevicesFileError(
        `devices[${i}]: ${err instanceof Error ? err.message : String(err)}`,
        path,
      );
    }
    return {
      endpoint: item.endpoint,
      serial: item.serial as string | undefined,
      label: item.label as string | undefined,
      addedAt: item.addedAt as string | undefined,
    };
  });
  return upsertDevices(emptyDevicesFile(), entries, { now });
}

/**
 * Read + parse `path`. A missing file yields an empty DevicesFile (that is the
 * normal first-run state); a malformed one throws DevicesFileError.
 */
export function loadDevicesFile(path: string, opts: DevicesFileOptions = {}): DevicesFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return emptyDevicesFile();
    throw new DevicesFileError(
      `cannot read (${err instanceof Error ? err.message : String(err)})`,
      path,
    );
  }
  return parseDevicesFile(text, { ...opts, path });
}

/**
 * Pure merge: returns a new file with `inputs` added/updated. An input matching
 * an existing endpoint keeps that entry's addedAt (and serial/label unless the
 * input supplies new ones). New bare endpoints get `addedAt = now`.
 */
export function upsertDevices(
  file: DevicesFile,
  inputs: DevicesFileInput[],
  opts: DevicesFileOptions = {},
): DevicesFile {
  const now = opts.now ?? (() => new Date());
  const byEndpoint = new Map<string, DevicesFileEntry>();
  for (const existing of file.devices) {
    const endpoint = normalizeEndpoint(existing.endpoint);
    const prev = byEndpoint.get(endpoint);
    byEndpoint.set(endpoint, mergeEntry(prev, { ...existing, endpoint }, now));
  }
  for (const input of inputs) {
    const partial = typeof input === "string" ? { endpoint: input } : input;
    const endpoint = normalizeEndpoint(partial.endpoint);
    byEndpoint.set(endpoint, mergeEntry(byEndpoint.get(endpoint), { ...partial, endpoint }, now));
  }
  return { version: DEVICES_FILE_VERSION, devices: [...byEndpoint.values()] };
}

/** Pure removal by endpoint (normalized before comparing). Unknown endpoints are a no-op. */
export function removeDevice(file: DevicesFile, endpoint: string): DevicesFile {
  const target = normalizeEndpoint(endpoint);
  return {
    version: DEVICES_FILE_VERSION,
    devices: file.devices.filter((d) => normalizeEndpoint(d.endpoint) !== target),
  };
}

/**
 * Persist `endpoints` as the full contents of `path` (atomic: temp file +
 * rename; parent directory created). When a readable file already exists at
 * `path`, entries that are re-saved keep their original addedAt/serial/label
 * unless the input overrides them, so re-running a bootstrap is idempotent.
 * Returns what was written.
 */
export function saveDevicesFile(
  path: string,
  endpoints: DevicesFileInput[],
  opts: DevicesFileOptions = {},
): DevicesFile {
  let previous = emptyDevicesFile();
  if (existsSync(path)) {
    try {
      previous = loadDevicesFile(path, opts);
    } catch {
      // unreadable/malformed: overwrite it, nothing to preserve
    }
  }
  // Only the endpoints being saved survive, but they inherit prior metadata.
  const wanted = new Set(
    endpoints.map((e) => normalizeEndpoint(typeof e === "string" ? e : e.endpoint)),
  );
  const kept: DevicesFile = {
    version: DEVICES_FILE_VERSION,
    devices: previous.devices.filter((d) => wanted.has(normalizeEndpoint(d.endpoint))),
  };
  const next = upsertDevices(kept, endpoints, opts);
  writeDevicesFile(path, next);
  return next;
}

/** Serialize exactly as the shell tools do: 2-space JSON, trailing newline. */
export function formatDevicesFile(file: DevicesFile): string {
  const devices = file.devices.map((d) => {
    const out: Record<string, string> = { endpoint: d.endpoint };
    if (d.serial !== undefined) out.serial = d.serial;
    if (d.label !== undefined) out.label = d.label;
    out.addedAt = d.addedAt;
    return out;
  });
  return `${JSON.stringify({ version: file.version, devices }, null, 2)}\n`;
}

/** Atomically write a DevicesFile to `path` (mkdir -p, temp file, rename). */
export function writeDevicesFile(path: string, file: DevicesFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, formatDevicesFile(file), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file never got created
    }
    throw new DevicesFileError(
      `cannot write (${err instanceof Error ? err.message : String(err)})`,
      path,
    );
  }
}

/** First existing path among `candidates`, or null. */
export function findDevicesFile(candidates: string[]): string | null {
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ------------------------------------------------------------------ internals

function mergeEntry(
  prev: DevicesFileEntry | undefined,
  next: { endpoint: string; serial?: string; label?: string; addedAt?: string },
  now: () => Date,
): DevicesFileEntry {
  const entry: DevicesFileEntry = {
    endpoint: next.endpoint,
    addedAt: prev?.addedAt ?? next.addedAt ?? now().toISOString(),
  };
  const serial = nonEmpty(next.serial) ?? nonEmpty(prev?.serial);
  const label = nonEmpty(next.label) ?? nonEmpty(prev?.label);
  if (serial !== undefined) entry.serial = serial;
  if (label !== undefined) entry.label = label;
  return entry;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}
