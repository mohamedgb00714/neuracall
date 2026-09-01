/**
 * One `uiautomator dump` at a time, per device.
 *
 * `uiautomator` is effectively a singleton on the handset: start a second dump
 * while one is running and the device kills one of them. It surfaces as exit
 * code 137 (SIGKILL) with empty stdout and empty stderr — no message, nothing
 * naming the real cause.
 *
 * Three parts of NeuraCall drive it, and two of them run at the worst possible
 * moment. The detector polls while a calling app is on screen; the answerer
 * dumps to find the accept button *while the phone is ringing*, which is
 * exactly when the detector is busiest. Losing that race means the answerer
 * sees an empty dump, finds no accept button, and the call rings out — the
 * original bug, reintroduced by a race rather than by a wrong keycode.
 *
 * So every dump in this package goes through here. Calls queue per endpoint
 * rather than running concurrently, and a killed dump is retried once, because
 * a dump lost to a race is worth one more attempt and a dump lost to a genuine
 * failure is not worth blocking a ringing call for.
 *
 * Each caller keeps its own file on the device: sharing one path would let a
 * slow reader `cat` a file the next dump has already begun overwriting.
 */

import type { CommandRunner } from "./adb.js";

/** In-flight dump per endpoint; new work chains onto it. */
const queues = new Map<string, Promise<unknown>>();

/** Serialise `fn` against every other dump on the same endpoint. */
function enqueue<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(endpoint) ?? Promise.resolve();
  // Failures must not poison the chain: the next caller runs regardless.
  const run = previous.then(fn, fn);
  queues.set(
    endpoint,
    run.catch(() => undefined),
  );
  return run;
}

export interface UiDumpOptions {
  /**
   * Where the XML is written on the device. Give each caller its own path —
   * see the note about `cat` racing an overwrite.
   */
  path: string;
  /** Attempts before giving up. Default 2: one retry for a lost race. */
  attempts?: number;
}

/**
 * Dump the view hierarchy and return the XML, or "" when it cannot be read.
 *
 * Returns "" rather than throwing because every caller's honest answer to "the
 * screen could not be read" is the same as "the control is not there yet":
 * poll again. The dialer and the answerer both surface a useful error after
 * their own timeout, naming what they did see.
 */
export async function dumpUi(
  runner: CommandRunner,
  endpoint: string,
  opts: UiDumpOptions,
): Promise<string> {
  const attempts = Math.max(1, opts.attempts ?? 2);

  return enqueue(endpoint, async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await runner.runForDevice(endpoint, ["shell", "uiautomator", "dump", opts.path]);
        const xml = await runner.runForDevice(endpoint, ["shell", "cat", opts.path]);
        // uiautomator reports "ERROR: could not get idle state." on stdout with
        // a SUCCESS exit code when the screen will not settle — and a ringing
        // screen animates, so this is not a rare path. Treat it as the failure
        // it is, or the retry is wasted on a result already known to be junk.
        if (xml.trim() !== "" && !xml.trimStart().startsWith("ERROR")) return xml;
      } catch {
        // Fall through to the retry. The common cause is the SIGKILL above,
        // and the second attempt has the device to itself.
      }
    }
    return "";
  });
}

/** Test seam: forget the queues so one test's chain cannot outlive it. */
export function resetUiDumpQueues(): void {
  queues.clear();
}
