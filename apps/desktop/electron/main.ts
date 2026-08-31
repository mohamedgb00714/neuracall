import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv, getConfig } from "@neuracall/config";
import { Runtime } from "./service/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let runtime: Runtime | null = null;

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

function registerIpc() {
  ipcMain.handle("config:getInfo", () => {
    if (!runtime) return { ready: false, region: "unknown", speechModel: "" };
    return {
      ready: true,
      region: runtime.config.assemblyai.region,
      speechModel: runtime.config.assemblyai.speechModel,
    };
  });

  ipcMain.handle("session:start", async (_e, { deviceId, channelId }) => {
    if (!runtime) throw new Error("Runtime not initialised.");
    const stream = await runtime.startSession(deviceId, channelId);
    return { ok: Boolean(stream) };
  });

  ipcMain.handle("session:stop", async (_e, { deviceId, channelId }) => {
    if (!runtime) return { ok: false };
    await runtime.stopSession(deviceId, channelId);
    return { ok: true };
  });

  ipcMain.handle("session:feedAudio", (_e, { deviceId, channelId, chunk }) => {
    if (!runtime) return { ok: false };
    const buf = Buffer.from(chunk);
    const sent = runtime.feedAudio(deviceId, channelId, buf);
    return { ok: sent };
  });

  ipcMain.handle("devices:list", () => {
    if (!runtime) return [];
    return runtime.devicesList;
  });

  ipcMain.handle("devices:reconnect", async () => {
    if (!runtime) return { ok: false };
    await runtime.reconnectKnown();
    return { ok: true };
  });

  ipcMain.handle("system:shutdown", async () => {
    await runtime?.shutdown();
  });
}

app.whenReady().then(() => {
  loadEnv();
  runtime = new Runtime(getConfig());
  runtime.start(); // begin poll-based ADB discovery

  runtime.on("turn", (key, turn) => {
    mainWindow?.webContents.send("session:turn", { key, turn });
  });
  runtime.on("sessionEnd", (key, reason) => {
    mainWindow?.webContents.send("session:end", { key, reason });
  });
  runtime.on("error", (key, err) => {
    mainWindow?.webContents.send("session:error", { key, error: String(err) });
  });
  runtime.on("device", (device) => {
    mainWindow?.webContents.send("devices:update", device);
  });
  runtime.on("adb-state", (id, state) => {
    mainWindow?.webContents.send("devices:adb-state", { id, state });
  });
  runtime.on("phase", (id, phase) => {
    mainWindow?.webContents.send("devices:phase", { id, phase });
  });

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (e) => {
  // Always terminate realtime sessions on quit to stop billing.
  if (runtime) {
    e.preventDefault();
    await runtime.shutdown();
    app.exit(0);
  }
});
