import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadEnv, getConfig, logStartupBanner } from "@neuracall/config";
import { detectRequiredTools } from "@neuracall/scrcpy-bridge";
import { Runtime } from "./service/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let runtime: Runtime | null = null;
/** Why the runtime could not start (e.g. missing ASSEMBLYAI_API_KEY). */
let runtimeError: string | null = null;

/**
 * Locate the .env to load: the working directory first, then the repo root
 * (this file lives in apps/desktop/dist-electron), then the user-data dir so a
 * packaged app can be configured without a checkout.
 */
function findEnvFile(): string | null {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(__dirname, "..", ".env"),
    resolve(__dirname, "..", "..", "..", ".env"),
    join(app.getPath("userData"), ".env"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl && process.env.NODE_ENV !== "production") {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }
}

/** Wrap an IPC action so failures reach the renderer as data, not as opaque IPC errors. */
async function attempt(fn: () => Promise<unknown> | unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function requireRuntime(): Runtime {
  if (!runtime) throw new Error(runtimeError ?? "Runtime not initialised.");
  return runtime;
}

function registerIpc() {
  ipcMain.handle("config:getInfo", () => {
    if (!runtime) {
      return { ready: false, region: "unknown", speechModel: "", error: runtimeError };
    }
    return {
      ready: true,
      region: runtime.config.assemblyai.region,
      speechModel: runtime.config.assemblyai.speechModel,
      error: null,
    };
  });

  ipcMain.handle("session:start", async (_e, { deviceId, channelId, source }) => {
    try {
      const stream = await requireRuntime().startSession(deviceId, channelId, { source });
      return { ok: Boolean(stream) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("session:stop", (_e, { deviceId, channelId }) =>
    attempt(() => requireRuntime().stopSession(deviceId, channelId)),
  );

  ipcMain.handle("session:feedAudio", (_e, { deviceId, channelId, chunk }) => {
    if (!runtime) return { ok: false };
    const buf = Buffer.from(chunk);
    const sent = runtime.feedAudio(deviceId, channelId, buf);
    return { ok: sent };
  });

  ipcMain.handle("devices:list", () => runtime?.devicesList ?? []);

  ipcMain.handle("devices:reconnect", () =>
    attempt(() => requireRuntime().reconnectKnown()),
  );

  // ---- external tool checks (work even when the runtime failed to start)
  ipcMain.handle("tools:check", () => runtime?.toolStatus() ?? detectRequiredTools());
  ipcMain.handle("scrcpy:check", () => (runtime?.toolStatus() ?? detectRequiredTools()).scrcpy);
  ipcMain.handle("adb:check", () => (runtime?.toolStatus() ?? detectRequiredTools()).adb);

  // ---- call control
  ipcMain.handle("call:dial", (_e, { deviceId, number }) =>
    attempt(() => requireRuntime().dial(deviceId, number)),
  );
  ipcMain.handle("call:openDialer", (_e, { deviceId, number }) =>
    attempt(() => requireRuntime().openDialer(deviceId, number)),
  );
  ipcMain.handle("call:answer", (_e, { deviceId }) =>
    attempt(() => requireRuntime().answerCall(deviceId)),
  );
  ipcMain.handle("call:hangup", (_e, { deviceId }) =>
    attempt(() => requireRuntime().hangUp(deviceId)),
  );
  ipcMain.handle("call:state", async (_e, { deviceId }) => {
    try {
      return { ok: true, state: await requireRuntime().callState(deviceId) };
    } catch (err) {
      return { ok: false, state: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("capture:status", () => runtime?.captureStatus() ?? []);

  ipcMain.handle("system:shutdown", async () => {
    await runtime?.shutdown();
  });
}

function wireRuntimeEvents(rt: Runtime) {
  const send = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  rt.on("turn", (key, turn) => send("session:turn", { key, turn }));
  rt.on("sessionEnd", (key, reason) => send("session:end", { key, reason }));
  rt.on("error", (key, err) => send("session:error", { key, error: String(err) }));
  rt.on("device", (device) => send("devices:update", device));
  rt.on("adb-state", (id, state) => send("devices:adb-state", { id, state }));
  rt.on("phase", (id, phase) => send("devices:phase", { id, phase }));
  rt.on("call-state", (id, state) => send("call:state-change", { id, state }));
  rt.on("capture", (update) => send("capture:update", update));
  rt.on("capture-log", (id, line, isError) => {
    send("capture:log", { id, line, isError });
    if (isError) console.warn(`[capture ${id}] ${line}`);
  });
}

app.whenReady().then(() => {
  const envFile = findEnvFile();
  if (envFile) loadEnv(envFile);

  // A bad/missing .env must not prevent the window from opening — the UI
  // reports the config error and the tool checks still work.
  try {
    runtime = new Runtime(getConfig());
    logStartupBanner(runtime.config); // region + endpoints, key masked
    runtime.start(); // begin poll-based ADB discovery + call-state polling
    wireRuntimeEvents(runtime);
  } catch (err) {
    runtimeError = err instanceof Error ? err.message : String(err);
    console.error(`[neuracall] runtime not started: ${runtimeError}`);
  }

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (e) => {
  // Always terminate realtime sessions + scrcpy processes on quit to stop billing.
  if (runtime && !quitting) {
    quitting = true;
    e.preventDefault();
    void runtime.shutdown().finally(() => app.exit(0));
  }
});
