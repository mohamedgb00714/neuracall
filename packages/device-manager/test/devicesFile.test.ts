import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICES_FILE_VERSION,
  DevicesFileError,
  emptyDevicesFile,
  findDevicesFile,
  formatDevicesFile,
  isValidEndpoint,
  knownEndpoints,
  loadDevicesFile,
  normalizeEndpoint,
  parseDevicesFile,
  removeDevice,
  saveDevicesFile,
  upsertDevices,
} from "../src/devicesFile.js";

const fixedNow = () => new Date("2026-08-31T12:00:00.000Z");

function tmpFile(name = "devices.json"): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-devices-"));
  return { dir, path: join(dir, name) };
}

test("normalizeEndpoint appends the default port and validates", () => {
  assert.equal(normalizeEndpoint("192.168.1.20"), "192.168.1.20:5555");
  assert.equal(normalizeEndpoint("  192.168.1.20:5556 "), "192.168.1.20:5556");
  assert.equal(normalizeEndpoint("phone.local", 7777), "phone.local:7777");
  assert.equal(normalizeEndpoint("[fe80::1]"), "[fe80::1]:5555");
  assert.equal(normalizeEndpoint("[fe80::1]:6000"), "[fe80::1]:6000");
  assert.throws(() => normalizeEndpoint(""), DevicesFileError);
  assert.throws(() => normalizeEndpoint("   "), /empty/);
  assert.throws(() => normalizeEndpoint(":5555"), /no host/);
  assert.throws(() => normalizeEndpoint("192.168.1.20:"), /invalid port/);
  assert.throws(() => normalizeEndpoint("192.168.1.20:99999"), /invalid port/);
  assert.throws(() => normalizeEndpoint("192.168.1.20:abc"), /invalid port/);
  assert.throws(() => normalizeEndpoint("fe80::1:5555"), /bracket IPv6/);
  assert.throws(() => normalizeEndpoint("192.168.1.20 :5555"), /whitespace/);
  assert.equal(isValidEndpoint("10.0.0.2:5555"), true);
  assert.equal(isValidEndpoint("nope:"), false);
});

test("parseDevicesFile accepts the documented shape and normalizes it", () => {
  const file = parseDevicesFile(
    JSON.stringify({
      version: 1,
      devices: [
        {
          endpoint: "192.168.1.20:5555",
          serial: "ABC",
          label: "realme",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
        { endpoint: "192.168.1.21", extra: "ignored" },
      ],
    }),
    { now: fixedNow },
  );
  assert.equal(file.version, DEVICES_FILE_VERSION);
  assert.deepEqual(file.devices, [
    {
      endpoint: "192.168.1.20:5555",
      serial: "ABC",
      label: "realme",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    { endpoint: "192.168.1.21:5555", addedAt: "2026-08-31T12:00:00.000Z" },
  ]);
  assert.deepEqual(knownEndpoints(file), ["192.168.1.20:5555", "192.168.1.21:5555"]);
});

test("parseDevicesFile collapses duplicate endpoints onto the first entry", () => {
  const file = parseDevicesFile(
    JSON.stringify({
      version: 1,
      devices: [
        { endpoint: "10.0.0.5", addedAt: "2026-01-01T00:00:00.000Z" },
        { endpoint: "10.0.0.5:5555", serial: "S1", addedAt: "2026-02-02T00:00:00.000Z" },
      ],
    }),
  );
  assert.deepEqual(file.devices, [
    { endpoint: "10.0.0.5:5555", serial: "S1", addedAt: "2026-01-01T00:00:00.000Z" },
  ]);
});

test("parseDevicesFile rejects malformed input with a clear error", () => {
  assert.throws(() => parseDevicesFile("{not json"), /not valid JSON/);
  assert.throws(() => parseDevicesFile("[]"), /top level must be an object/);
  assert.throws(
    () => parseDevicesFile(JSON.stringify({ version: 2, devices: [] })),
    /unsupported version 2/,
  );
  assert.throws(
    () => parseDevicesFile(JSON.stringify({ version: 1 })),
    /"devices" must be an array/,
  );
  assert.throws(
    () => parseDevicesFile(JSON.stringify({ version: 1, devices: ["x"] })),
    /devices\[0\] must be an object/,
  );
  assert.throws(
    () => parseDevicesFile(JSON.stringify({ version: 1, devices: [{ endpoint: 5 }] })),
    /devices\[0\]\.endpoint must be a string/,
  );
  assert.throws(
    () => parseDevicesFile(JSON.stringify({ version: 1, devices: [{ endpoint: "a:b" }] })),
    /devices\[0\]: endpoint "a:b" has an invalid port/,
  );
  assert.throws(
    () => parseDevicesFile(JSON.stringify({ version: 1, devices: [{ endpoint: "a", label: 1 }] })),
    /devices\[0\]\.label must be a string/,
  );
  const err = (() => {
    try {
      parseDevicesFile("nope", { path: "/x/devices.json" });
    } catch (e) {
      return e as DevicesFileError;
    }
    return undefined;
  })();
  assert.ok(err instanceof DevicesFileError);
  assert.equal(err.name, "DevicesFileError");
  assert.equal(err.path, "/x/devices.json");
  assert.match(err.message, /^\/x\/devices\.json: not valid JSON/);
});

test("loadDevicesFile returns an empty file when the path does not exist", () => {
  const { dir, path } = tmpFile();
  try {
    assert.deepEqual(loadDevicesFile(path), emptyDevicesFile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDevicesFile throws DevicesFileError (with path) on a malformed file", () => {
  const { dir, path } = tmpFile();
  try {
    writeFileSync(path, "{ oops", "utf8");
    assert.throws(
      () => loadDevicesFile(path),
      (e: unknown) => e instanceof DevicesFileError && e.path === path,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveDevicesFile writes the documented JSON shape and creates the directory", () => {
  const { dir, path } = tmpFile(join("nested", "devices.json"));
  try {
    const written = saveDevicesFile(
      path,
      ["192.168.1.20", { endpoint: "192.168.1.21:5555", serial: "S2", label: "Pixel" }],
      { now: fixedNow },
    );
    assert.deepEqual(written, {
      version: 1,
      devices: [
        { endpoint: "192.168.1.20:5555", addedAt: "2026-08-31T12:00:00.000Z" },
        {
          endpoint: "192.168.1.21:5555",
          serial: "S2",
          label: "Pixel",
          addedAt: "2026-08-31T12:00:00.000Z",
        },
      ],
    });
    const text = readFileSync(path, "utf8");
    assert.equal(
      text,
      [
        "{",
        '  "version": 1,',
        '  "devices": [',
        "    {",
        '      "endpoint": "192.168.1.20:5555",',
        '      "addedAt": "2026-08-31T12:00:00.000Z"',
        "    },",
        "    {",
        '      "endpoint": "192.168.1.21:5555",',
        '      "serial": "S2",',
        '      "label": "Pixel",',
        '      "addedAt": "2026-08-31T12:00:00.000Z"',
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
    assert.equal(existsSync(`${path}.${process.pid}.tmp`), false, "temp file is renamed away");
    assert.deepEqual(loadDevicesFile(path), written, "round-trips through loadDevicesFile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveDevicesFile keeps addedAt/serial/label of re-saved endpoints and drops the rest", () => {
  const { dir, path } = tmpFile();
  try {
    saveDevicesFile(
      path,
      [
        { endpoint: "192.168.1.20:5555", serial: "S1", label: "old label" },
        { endpoint: "192.168.1.99:5555", serial: "GONE" },
      ],
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    const next = saveDevicesFile(
      path,
      ["192.168.1.20", { endpoint: "192.168.1.30:5555", label: "new phone" }],
      { now: fixedNow },
    );
    assert.deepEqual(next.devices, [
      {
        endpoint: "192.168.1.20:5555",
        serial: "S1",
        label: "old label",
        addedAt: "2026-01-01T00:00:00.000Z",
      },
      { endpoint: "192.168.1.30:5555", label: "new phone", addedAt: "2026-08-31T12:00:00.000Z" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveDevicesFile overwrites a malformed existing file instead of failing", () => {
  const { dir, path } = tmpFile();
  try {
    writeFileSync(path, "garbage", "utf8");
    const next = saveDevicesFile(path, ["10.1.1.1:5555"], { now: fixedNow });
    assert.equal(next.devices.length, 1);
    assert.deepEqual(loadDevicesFile(path), next);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveDevicesFile rejects an invalid endpoint before touching the file", () => {
  const { dir, path } = tmpFile();
  try {
    assert.throws(() => saveDevicesFile(path, ["bad:port"]), DevicesFileError);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertDevices merges by normalized endpoint and preserves order", () => {
  const base = upsertDevices(emptyDevicesFile(), ["10.0.0.1", "10.0.0.2:5555"], {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const next = upsertDevices(
    base,
    [{ endpoint: "10.0.0.1:5555", serial: "S1", label: " " }, "10.0.0.3"],
    {
      now: fixedNow,
    },
  );
  assert.deepEqual(next.devices, [
    { endpoint: "10.0.0.1:5555", serial: "S1", addedAt: "2026-01-01T00:00:00.000Z" },
    { endpoint: "10.0.0.2:5555", addedAt: "2026-01-01T00:00:00.000Z" },
    { endpoint: "10.0.0.3:5555", addedAt: "2026-08-31T12:00:00.000Z" },
  ]);
  // pure: the input is untouched
  assert.equal(base.devices.length, 2);
});

test("removeDevice drops the endpoint (normalized) and ignores unknown ones", () => {
  const base = upsertDevices(emptyDevicesFile(), ["10.0.0.1", "10.0.0.2"], { now: fixedNow });
  const next = removeDevice(base, "10.0.0.1");
  assert.deepEqual(knownEndpoints(next), ["10.0.0.2:5555"]);
  assert.deepEqual(knownEndpoints(removeDevice(next, "10.9.9.9:5555")), ["10.0.0.2:5555"]);
  assert.equal(base.devices.length, 2);
});

test("formatDevicesFile omits undefined serial/label and keeps key order", () => {
  const text = formatDevicesFile({
    version: 1,
    devices: [{ endpoint: "1.2.3.4:5555", label: "L", addedAt: "2026-08-31T12:00:00.000Z" }],
  });
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    devices: [{ endpoint: "1.2.3.4:5555", label: "L", addedAt: "2026-08-31T12:00:00.000Z" }],
  });
  assert.equal(Object.keys(JSON.parse(text).devices[0]).join(","), "endpoint,label,addedAt");
  assert.ok(text.endsWith("}\n"));
});

test("findDevicesFile returns the first existing candidate", () => {
  const { dir, path } = tmpFile();
  try {
    writeFileSync(path, formatDevicesFile(emptyDevicesFile()), "utf8");
    assert.equal(findDevicesFile([join(dir, "missing.json"), path]), path);
    assert.equal(findDevicesFile([join(dir, "missing.json")]), null);
    assert.equal(findDevicesFile([]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
