/**
 * Detect whether the external binaries NeuraCall depends on (`adb` for device
 * control, `scrcpy` for phone audio capture) are available on this machine,
 * and produce per-OS install instructions so the app can guide the user
 * instead of failing silently when a device cannot be driven or captured.
 *
 * Everything is injectable (lookPath / platform / versionFn) so the logic is
 * unit-testable without relying on the real host.
 */
import { execFileSync } from "node:child_process";

export type Platform = "linux" | "darwin" | "win32" | "other";

/** External tools NeuraCall can detect and guide the user to install. */
export type ToolName = "scrcpy" | "adb";

export const TOOL_NAMES: readonly ToolName[] = ["adb", "scrcpy"] as const;

/** Look up an executable on PATH. Returns the first match or null. */
export type LookPath = (binary: string) => string | null;

export interface ToolDetection {
  /** Which tool this result describes. */
  tool: ToolName;
  /** true when the binary is found on PATH. */
  installed: boolean;
  /** Resolved binary name for the platform (e.g. "adb" vs "adb.exe"). */
  binary: string;
  platform: Platform;
  /** Absolute path if found, else null. */
  path: string | null;
  /** Version string when installed (best-effort), else null. */
  version: string | null;
  /** Human-readable install guide for this platform, or null when installed. */
  installGuide: string | null;
}

/** Back-compat alias: scrcpy detection has the same shape as any tool. */
export type ScrcpyDetection = ToolDetection;
export type ScrcpyDetectionResult = ScrcpyDetection;
export type AdbDetection = ToolDetection;

/** Map a Node platform string to our narrower set. */
export function detectPlatform(platform: NodeJS.Platform = process.platform): Platform {
  switch (platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      return "other";
  }
}

/** Resolve a tool's binary name for a platform (".exe" suffix on Windows). */
export function binaryNameFor(tool: ToolName, platform: Platform): string {
  return platform === "win32" ? `${tool}.exe` : tool;
}

/** Resolve the scrcpy binary name for a platform. */
export function scrcpyBinaryName(platform: Platform): string {
  return binaryNameFor("scrcpy", platform);
}

/** Resolve the adb binary name for a platform. */
export function adbBinaryName(platform: Platform): string {
  return binaryNameFor("adb", platform);
}

/** Argument list that makes the tool print its version. */
export function versionArgsFor(tool: ToolName): string[] {
  return tool === "adb" ? ["version"] : ["--version"];
}

export interface InstallGuideOptions {
  /** Which tool the guide is for. Default "scrcpy". */
  tool?: ToolName;
  /** Whether the user can use sudo (affects the Linux hint). Default true. */
  sudo?: boolean;
}

/**
 * Build the platform install guide. Commands are the canonical, copy-pasteable
 * incantations per package manager; we prefer the most common default for each
 * platform.
 */
export function installGuideFor(platform: Platform, opts: InstallGuideOptions = {}): string {
  const tool = opts.tool ?? "scrcpy";
  return tool === "adb"
    ? adbInstallGuideFor(platform, opts)
    : scrcpyInstallGuideFor(platform, opts);
}

export function scrcpyInstallGuideFor(platform: Platform, opts: { sudo?: boolean } = {}): string {
  const sudo = opts.sudo ?? true;
  switch (platform) {
    case "linux": {
      const lines = ["Install scrcpy (ADB-screen mirroring + audio capture):"];
      lines.push("  Debian/Ubuntu:  sudo apt install scrcpy");
      lines.push("  Fedora:         sudo dnf install scrcpy");
      lines.push("  Arch:           sudo pacman -S scrcpy");
      lines.push("  Snap:           snap install scrcpy  (if not in your apt repos)");
      lines.push("  Brew (Linux):   brew install scrcpy");
      lines.push("");
      lines.push("Verify:  scrcpy --version");
      if (sudo === false) {
        lines.push("");
        lines.push("Note: without sudo, use Snap or download a prebuilt binary.");
      }
      return lines.join("\n");
    }
    case "darwin": {
      return [
        "Install scrcpy on macOS (requires Homebrew):",
        "  brew install scrcpy",
        "  brew install --cask android-platform-tools   (if adb is missing)",
        "",
        "Verify:  scrcpy --version",
      ].join("\n");
    }
    case "win32": {
      return [
        "Install scrcpy on Windows (pick one):",
        "  winget install scrcpy.scrcpy",
        "  choco install scrcpy",
        "  scoop install scrcpy",
        "",
        "If these fail, download the zip from the GitHub releases page and add",
        "the extracted folder (scrcpy-win64-vX.Y) to your PATH.",
        "",
        "Verify:  scrcpy --version",
      ].join("\n");
    }
    default: {
      return [
        "scrcpy is required for phone audio capture.",
        "Install it from https://github.com/Genymobile/scrcpy",
        "then ensure the `scrcpy` binary is on your PATH and restart the app.",
      ].join("\n");
    }
  }
}

const ADB_PHONE_SETUP = [
  "",
  'Then on each phone: Settings → About phone → tap "Build number" 7 times,',
  'Settings → Developer options → enable "USB debugging", plug it in (or',
  '`adb connect <ip>:5555` for Wi-Fi) and accept the "Allow USB debugging" prompt.',
];

export function adbInstallGuideFor(platform: Platform, opts: { sudo?: boolean } = {}): string {
  const sudo = opts.sudo ?? true;
  switch (platform) {
    case "linux": {
      const lines = ["Install adb (Android platform-tools; needed to see and control phones):"];
      lines.push("  Debian/Ubuntu:  sudo apt install adb");
      lines.push("  Fedora:         sudo dnf install android-tools");
      lines.push("  Arch:           sudo pacman -S android-tools");
      lines.push(
        "  Any distro:     download platform-tools from",
        "                  https://developer.android.com/tools/releases/platform-tools",
        "                  unzip it and add the folder to your PATH",
      );
      lines.push("");
      lines.push("Verify:  adb version   then   adb devices");
      if (sudo === false) {
        lines.push("");
        lines.push("Note: without sudo, use the platform-tools zip (no install needed).");
      }
      lines.push(...ADB_PHONE_SETUP);
      return lines.join("\n");
    }
    case "darwin": {
      return [
        "Install adb on macOS (requires Homebrew):",
        "  brew install --cask android-platform-tools",
        "",
        "Verify:  adb version   then   adb devices",
        ...ADB_PHONE_SETUP,
      ].join("\n");
    }
    case "win32": {
      return [
        "Install adb on Windows (pick one):",
        "  winget install Google.PlatformTools",
        "  choco install adb",
        "  scoop install adb",
        "",
        "If these fail, download platform-tools from",
        "https://developer.android.com/tools/releases/platform-tools, unzip it",
        "and add the platform-tools folder to your PATH. Some phones also need",
        "the OEM USB driver installed before Windows shows them to adb.",
        "",
        "Verify:  adb version   then   adb devices",
        ...ADB_PHONE_SETUP,
      ].join("\n");
    }
    default: {
      return [
        "adb (Android platform-tools) is required to detect and control phones.",
        "Download it from https://developer.android.com/tools/releases/platform-tools",
        "then ensure the `adb` binary is on your PATH and restart the app.",
        ...ADB_PHONE_SETUP,
      ].join("\n");
    }
  }
}

/** Real PATH lookup used in production. */
export const defaultLookPath: LookPath = (binary) => {
  try {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "where" : "which";
    const out = execFileSync(cmd, [binary], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    return out || null;
  } catch {
    return null;
  }
};

/** Real version probe used in production: first line of the tool's version output. */
export function defaultVersionFn(tool: ToolName): (binary: string) => string | null {
  return (binary) => {
    try {
      return (
        execFileSync(binary, versionArgsFor(tool), {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        })
          .toString()
          .trim()
          .split(/\r?\n/)[0] || null
      );
    } catch {
      return null;
    }
  };
}

export interface DetectOptions {
  lookPath?: LookPath;
  platform?: NodeJS.Platform;
  versionFn?: (binary: string) => string | null;
}

/**
 * Detect a tool's availability and prepare an install guide. `version` is the
 * first line of the tool's version output when the binary exists (best-effort).
 */
export function detectTool(tool: ToolName, opts: DetectOptions = {}): ToolDetection {
  const platform = detectPlatform(opts.platform);
  const binary = binaryNameFor(tool, platform);
  const lookPath = opts.lookPath ?? defaultLookPath;

  const path = lookPath(binary);
  if (!path) {
    return {
      tool,
      installed: false,
      binary,
      platform,
      path: null,
      version: null,
      installGuide: installGuideFor(platform, { tool }),
    };
  }

  const versionFn = opts.versionFn ?? defaultVersionFn(tool);
  let version: string | null = null;
  try {
    version = versionFn(binary);
  } catch {
    version = null;
  }

  return {
    tool,
    installed: true,
    binary,
    platform,
    path,
    version,
    installGuide: null,
  };
}

/** Detect scrcpy (phone audio capture). */
export function detectScrcpy(opts: DetectOptions = {}): ScrcpyDetection {
  return detectTool("scrcpy", opts);
}

/** Detect adb (device discovery + call control). */
export function detectAdb(opts: DetectOptions = {}): AdbDetection {
  return detectTool("adb", opts);
}

/** Detect every required tool at once, keyed by tool name. */
export function detectRequiredTools(opts: DetectOptions = {}): Record<ToolName, ToolDetection> {
  return {
    adb: detectAdb(opts),
    scrcpy: detectScrcpy(opts),
  };
}
