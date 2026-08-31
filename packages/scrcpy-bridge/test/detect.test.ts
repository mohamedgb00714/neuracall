import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectScrcpy,
  detectAdb,
  detectTool,
  detectRequiredTools,
  detectPlatform,
  scrcpyBinaryName,
  adbBinaryName,
  binaryNameFor,
  installGuideFor,
  adbInstallGuideFor,
  versionArgsFor,
  defaultLookPath,
} from "../src/detect.js";

test("detectPlatform maps node platforms", () => {
  assert.equal(detectPlatform("linux"), "linux");
  assert.equal(detectPlatform("darwin"), "darwin");
  assert.equal(detectPlatform("win32"), "win32");
  assert.equal(detectPlatform("freebsd"), "other");
});

test("scrcpyBinaryName uses .exe on Windows", () => {
  assert.equal(scrcpyBinaryName("win32"), "scrcpy.exe");
  assert.equal(scrcpyBinaryName("linux"), "scrcpy");
  assert.equal(scrcpyBinaryName("darwin"), "scrcpy");
});

test("adbBinaryName uses .exe on Windows", () => {
  assert.equal(adbBinaryName("win32"), "adb.exe");
  assert.equal(adbBinaryName("linux"), "adb");
  assert.equal(binaryNameFor("adb", "darwin"), "adb");
});

test("versionArgsFor: scrcpy --version, adb version", () => {
  assert.deepEqual(versionArgsFor("scrcpy"), ["--version"]);
  assert.deepEqual(versionArgsFor("adb"), ["version"]);
});

test("reports installed=true with path/version when binary is found", () => {
  const result = detectScrcpy({
    platform: "linux",
    lookPath: () => "/usr/bin/scrcpy",
    versionFn: () => "scrcpy 2.4",
  });
  assert.equal(result.tool, "scrcpy");
  assert.equal(result.installed, true);
  assert.equal(result.binary, "scrcpy");
  assert.equal(result.path, "/usr/bin/scrcpy");
  assert.equal(result.version, "scrcpy 2.4");
  assert.equal(result.installGuide, null);
});

test("reports installed=false with a guide when binary is missing", () => {
  const result = detectScrcpy({
    platform: "win32",
    lookPath: () => null,
  });
  assert.equal(result.installed, false);
  assert.equal(result.binary, "scrcpy.exe");
  assert.equal(result.path, null);
  assert.ok(result.installGuide!.includes("winget"));
});

test("a throwing versionFn degrades to version=null, still installed", () => {
  const result = detectTool("scrcpy", {
    platform: "linux",
    lookPath: () => "/usr/bin/scrcpy",
    versionFn: () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.version, null);
});

test("linux guide mentions apt/dnf/pacman/snap", () => {
  const guide = installGuideFor("linux");
  assert.match(guide, /apt install scrcpy/);
  assert.match(guide, /dnf install scrcpy/);
  assert.match(guide, /pacman -S scrcpy/);
  assert.match(guide, /snap install scrcpy/);
});

test("darwin guide uses brew", () => {
  const guide = installGuideFor("darwin");
  assert.match(guide, /brew install scrcpy/);
});

test("win32 guide prefers winget and names choco/scoop", () => {
  const guide = installGuideFor("win32");
  assert.match(guide, /winget install scrcpy.scrcpy/);
  assert.match(guide, /choco install scrcpy/);
  assert.match(guide, /scoop install scrcpy/);
});

test("unknown platform guide points at the project", () => {
  const guide = installGuideFor("other");
  assert.match(guide, /Genymobile\/scrcpy/);
});

test("adb detection: installed=true carries adb version", () => {
  const result = detectAdb({
    platform: "linux",
    lookPath: (binary) => (binary === "adb" ? "/usr/bin/adb" : null),
    versionFn: () => "Android Debug Bridge version 1.0.41",
  });
  assert.equal(result.tool, "adb");
  assert.equal(result.installed, true);
  assert.equal(result.binary, "adb");
  assert.equal(result.path, "/usr/bin/adb");
  assert.match(result.version!, /1\.0\.41/);
  assert.equal(result.installGuide, null);
});

test("adb detection: missing binary yields an adb guide, not a scrcpy one", () => {
  const result = detectAdb({ platform: "linux", lookPath: () => null });
  assert.equal(result.installed, false);
  assert.equal(result.binary, "adb");
  assert.match(result.installGuide!, /apt install adb/);
  assert.match(result.installGuide!, /USB debugging/);
  assert.doesNotMatch(result.installGuide!, /apt install scrcpy/);
});

test("adb guides per platform", () => {
  assert.match(adbInstallGuideFor("linux"), /dnf install android-tools/);
  assert.match(adbInstallGuideFor("linux"), /pacman -S android-tools/);
  assert.match(adbInstallGuideFor("linux"), /platform-tools/);
  assert.match(adbInstallGuideFor("darwin"), /brew install --cask android-platform-tools/);
  assert.match(adbInstallGuideFor("win32"), /winget install Google.PlatformTools/);
  assert.match(adbInstallGuideFor("win32"), /choco install adb/);
  assert.match(adbInstallGuideFor("win32"), /scoop install adb/);
  assert.match(adbInstallGuideFor("other"), /developer.android.com/);
  // installGuideFor routes by tool
  assert.equal(installGuideFor("win32", { tool: "adb" }), adbInstallGuideFor("win32"));
});

test("detectRequiredTools reports both tools independently", () => {
  const all = detectRequiredTools({
    platform: "darwin",
    lookPath: (binary) => (binary === "adb" ? "/opt/homebrew/bin/adb" : null),
    versionFn: () => "v",
  });
  assert.equal(all.adb.installed, true);
  assert.equal(all.scrcpy.installed, false);
  assert.match(all.scrcpy.installGuide!, /brew install scrcpy/);
});

test("defaultLookPath returns null for a binary that does not exist", () => {
  // Environment-independent: this name will never be on anyone's PATH.
  assert.equal(defaultLookPath("neuracall-definitely-not-a-real-binary-xyz"), null);
  const look = detectScrcpy({
    platform: "linux",
    lookPath: () => null,
  });
  assert.equal(look.installed, false);
});
