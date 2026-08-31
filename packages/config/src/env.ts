import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader (no external dep). Parses KEY=VALUE lines, skips
 * comments and blank lines, and does NOT override already-set variables.
 * Call before getConfig() so process.env is populated.
 */
export function loadEnv(path = resolve(process.cwd(), ".env")): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return; // no .env file — rely on the real environment
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Never override an already-set environment variable
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
