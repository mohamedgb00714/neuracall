import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A minimal, injectable runner for the `adb` CLI so the device manager can be
 * unit-tested without real hardware. AdbClient calls these methods; in tests
 * they are replaced with a stub.
 */
export interface CommandRunner {
  /** Run an adb command with a target, no global -s. Returns trimmed stdout. */
  run(args: string[]): Promise<string>;
  /** Run an adb command scoped to a specific device endpoint. */
  runForDevice(endpoint: string, args: string[]): Promise<string>;
}

/** Spawn a child process and collect stdout; throw on non-zero exit. */
export interface Spawner {
  (cmd: string, args: string[]): Promise<string>;
}

/**
 * Real CommandRunner backed by child_process. Every invocation gets a fresh
 * spawn so ADB's state machine stays simple and we never leave a fd open.
 */
export function realRunner(spawn: Spawner): CommandRunner {
  return {
    async run(args: string[]): Promise<string> {
      return spawn("adb", args);
    },
    async runForDevice(endpoint: string, args: string[]): Promise<string> {
      return spawn("adb", ["-s", endpoint, ...args]);
    },
  };
}

/** Default spawner: real `adb` binary via execFile (no shell). */
export const defaultSpawner: Spawner = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};
