import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, loadEnv } from "../src/index.js";

/** Env var names used only by this file so they cannot collide with a real .env. */
const VARS = ["NEURACALL_TEST_A", "NEURACALL_TEST_B", "NEURACALL_TEST_C", "NEURACALL_TEST_D"];

function withTempEnvFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-config-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf8");
  const previous = new Map(VARS.map((v) => [v, process.env[v]] as const));
  try {
    for (const v of VARS) delete process.env[v];
    fn(path);
  } finally {
    for (const [v, val] of previous) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadEnv parses KEY=VALUE, strips quotes, skips comments and blanks", () => {
  withTempEnvFile(
    [
      "# comment",
      "",
      "NEURACALL_TEST_A=plain",
      'NEURACALL_TEST_B="double quoted"',
      "NEURACALL_TEST_C='single quoted'",
      "not-a-pair",
      "NEURACALL_TEST_D=with=equals",
    ].join("\n"),
    (path) => {
      loadEnv(path);
      assert.equal(process.env.NEURACALL_TEST_A, "plain");
      assert.equal(process.env.NEURACALL_TEST_B, "double quoted");
      assert.equal(process.env.NEURACALL_TEST_C, "single quoted");
      assert.equal(process.env.NEURACALL_TEST_D, "with=equals");
    },
  );
});

test("loadEnv never overrides an already-set variable", () => {
  withTempEnvFile("NEURACALL_TEST_A=from-file\n", (path) => {
    process.env.NEURACALL_TEST_A = "from-shell";
    loadEnv(path);
    assert.equal(process.env.NEURACALL_TEST_A, "from-shell");
  });
});

test("loadEnv is a no-op when the file does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-config-"));
  try {
    assert.doesNotThrow(() => loadEnv(join(dir, "missing.env")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig loads the file then validates (placeholder key still fails fast)", () => {
  const prevKey = process.env.ASSEMBLYAI_API_KEY;
  const prevRegion = process.env.ASSEMBLYAI_REGION;
  const dir = mkdtempSync(join(tmpdir(), "neuracall-config-"));
  const path = join(dir, ".env");
  try {
    delete process.env.ASSEMBLYAI_API_KEY;
    delete process.env.ASSEMBLYAI_REGION;

    writeFileSync(path, "ASSEMBLYAI_API_KEY=replace-me\nASSEMBLYAI_REGION=eu\n", "utf8");
    assert.throws(() => loadConfig(path), /ASSEMBLYAI_API_KEY/);
    // loadEnv does not override, so clear what the failed attempt set before retrying
    delete process.env.ASSEMBLYAI_API_KEY;

    writeFileSync(
      path,
      "ASSEMBLYAI_API_KEY=unit-test-not-a-real-key\nASSEMBLYAI_REGION=eu\n",
      "utf8",
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.assemblyai.region, "eu");
    assert.equal(cfg.assemblyai.tokenUrl, "https://streaming.eu.assemblyai.com/v3/token");
    assert.deepEqual(cfg, getConfig());
  } finally {
    if (prevKey === undefined) delete process.env.ASSEMBLYAI_API_KEY;
    else process.env.ASSEMBLYAI_API_KEY = prevKey;
    if (prevRegion === undefined) delete process.env.ASSEMBLYAI_REGION;
    else process.env.ASSEMBLYAI_REGION = prevRegion;
    rmSync(dir, { recursive: true, force: true });
  }
});
