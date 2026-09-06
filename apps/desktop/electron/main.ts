import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadEnv, getConfig, logStartupBanner } from "@neuracall/config";
import { detectRequiredTools } from "@neuracall/scrcpy-bridge";
import { VoiceAgentAdminClient } from "@neuracall/aai-client";
import type { CreateContactInput, CrmStore } from "@neuracall/crm";
import { Runtime } from "./service/runtime.js";
import {
  SettingsStore,
  buildAppConfig,
  parseSettingsPatch,
  probeSettings,
  type NeuraCallSettings,
} from "./service/settings.js";
import { storedAgentDefinition } from "./service/voipAgents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let runtime: Runtime | null = null;
let settings: SettingsStore | null = null;
/** Why the runtime could not start (e.g. missing ASSEMBLYAI_API_KEY). */
let runtimeError: string | null = null;
/**
 * The one setting the UI cannot supply: required before the runtime will start
 * and validated by @neuracall/config. Kept so the settings probe can still
 * report on it when the runtime itself never came up.
 */
let assemblyAiKey = "";

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
async function attempt(
  fn: () => Promise<unknown> | unknown,
): Promise<{ ok: boolean; error?: string }> {
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

/** The settings store works even when the runtime failed to start — that is
 *  usually the moment the operator needs it. */
function requireSettings(): SettingsStore {
  if (!settings) throw new Error("Settings store not initialised.");
  return settings;
}

/** The AssemblyAI REST admin client, bound to the app's key and region. */
function voipAgentsClient(current: NeuraCallSettings): VoiceAgentAdminClient {
  return new VoiceAgentAdminClient(buildAppConfig(assemblyAiKey, current));
}

/**
 * The contact database, or null when there is none.
 *
 * Electron pins Node 20, which has no `node:sqlite`; the runtime then records
 * calls to JSONL and there is no CRM at all. Every handler below answers with
 * an empty result instead of throwing, so the Contacts view can explain that
 * rather than surface an IPC failure.
 */
function crmStore(): CrmStore | null {
  if (!runtime) return null;
  try {
    return runtime.autopilot.crm;
  } catch {
    return null;
  }
}

/** How much history one query hands the renderer. */
const CRM_CALL_LIMIT = 200;

/** The renderer is untrusted input like any other: nothing reaches SQL unchecked. */
function parseContactInput(input: unknown): CreateContactInput {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const displayName = typeof raw["displayName"] === "string" ? raw["displayName"].trim() : "";
  if (displayName === "") throw new Error("A contact needs a name.");
  const org = typeof raw["org"] === "string" ? raw["org"].trim() : "";
  const notes = typeof raw["notes"] === "string" ? raw["notes"].trim() : "";
  return {
    displayName,
    phones: stringList(raw["phones"]),
    tags: stringList(raw["tags"]),
    ...(org !== "" ? { org } : {}),
    ...(notes !== "" ? { notes } : {}),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
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

  ipcMain.handle("devices:reconnect", () => attempt(() => requireRuntime().reconnectKnown()));

  // ---- external tool checks (work even when the runtime failed to start)
  ipcMain.handle("tools:check", () => runtime?.toolStatus() ?? detectRequiredTools());
  ipcMain.handle("scrcpy:check", () => (runtime?.toolStatus() ?? detectRequiredTools()).scrcpy);
  ipcMain.handle("adb:check", () => (runtime?.toolStatus() ?? detectRequiredTools()).adb);

  // ---- call control
  ipcMain.handle("call:dial", (_e, { deviceId, number }) =>
    attempt(() => requireRuntime().dial(deviceId, number)),
  );
  ipcMain.handle("call:dialWhatsApp", (_e, { deviceId, number, cc }) =>
    attempt(() => requireRuntime().dialWhatsApp(deviceId, number, cc)),
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
      return {
        ok: false,
        state: "unknown",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("capture:status", () => runtime?.captureStatus() ?? []);

  // ---- autopilot (autonomous answering)
  // This makes the app pick up real inbound calls. It now starts with the app
  // by default (autopilot.autoStart), so these handlers are the manual override
  // rather than the only way in — a machine running NeuraCall is a machine
  // answering the phone unless the operator turns that off.
  ipcMain.handle("autopilot:enable", () => {
    try {
      return { ok: true, status: requireRuntime().enableAutopilot() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("autopilot:disable", () => {
    try {
      return { ok: true, status: requireRuntime().disableAutopilot() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("autopilot:status", () => {
    if (!runtime) return null;
    return runtime.autopilotStatus();
  });

  ipcMain.handle("autopilot:activeCalls", () => runtime?.autopilot.activeCalls ?? []);

  ipcMain.handle("autopilot:endCall", (_e, { callId }) =>
    attempt(() => requireRuntime().autopilot.endCall(callId)),
  );

  // ---- CRM (contacts + call history)
  // Read-only queries plus one insert; the renderer only ever sees the DTOs
  // these return, never a handle to the database.
  ipcMain.handle("crm:available", () => crmStore() !== null);

  ipcMain.handle("crm:contacts", () => {
    const crm = crmStore();
    if (!crm) return [];
    // One roll-up for every count, rather than a query per contact.
    const groups = new Map(
      crm
        .groupByContact({ includeUnlinked: false })
        .flatMap((group) => (group.contact ? [[group.contact.id, group] as const] : [])),
    );
    return crm.listContacts().map((contact) => {
      const group = groups.get(contact.id);
      return {
        ...contact,
        callCount: group?.callCount ?? 0,
        lastCallAt: group?.lastCallAt ?? null,
      };
    });
  });

  ipcMain.handle("crm:calls", (_e, { contactId }: { contactId: unknown }) => {
    if (typeof contactId !== "string") return [];
    return crmStore()?.callsForContact(contactId, { limit: CRM_CALL_LIMIT }) ?? [];
  });

  ipcMain.handle("crm:recent", () => crmStore()?.recentCalls({ limit: CRM_CALL_LIMIT }) ?? []);

  ipcMain.handle("crm:createContact", (_e, input: unknown) => {
    const crm = crmStore();
    if (!crm) return { ok: false, error: "No contact database on this runtime." };
    try {
      return { ok: true, contact: crm.createContact(parseContactInput(input)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- settings (usable even when the runtime failed to start)
  ipcMain.handle("settings:get", () => requireSettings().redacted());

  ipcMain.handle("settings:save", async (_e, patch: unknown) => {
    try {
      const store = requireSettings();
      // Checked before anything is written: refusing the save outright is
      // clearer than persisting settings that silently will not take effect.
      runtime?.assertReloadable();
      const saved = store.save(patch);
      await runtime?.reloadSettings(saved);
      const redacted = store.redacted();
      send("settings:changed", redacted);
      return { ok: true, settings: redacted };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("settings:reset", async () => {
    const store = requireSettings();
    runtime?.assertReloadable();
    const defaults = store.reset();
    await runtime?.reloadSettings(defaults);
    const redacted = store.redacted();
    send("settings:changed", redacted);
    return redacted;
  });

  ipcMain.handle("settings:probe", () => {
    const store = requireSettings();
    return probeSettings(
      runtime?.config ?? buildAppConfig(assemblyAiKey, store.current),
      store.current,
    );
  });

  // ---- per-device voice agents (create/update/delete stored agents)
  // The stored agent is created/updated on the AssemblyAI REST API first, then
  // its uuid is persisted in settings so the device carries it on every call.
  ipcMain.handle("voip-agents:save", async (_e, { serial, config }) => {
    try {
      const store = requireSettings();
      if (typeof serial !== "string" || serial.trim() === "") {
        throw new Error("voip-agents:save needs a non-empty device serial.");
      }
      const validated = parseSettingsPatch({
        voipAgents: { [serial]: config },
      }).voipAgents?.[serial];
      if (!validated) {
        throw new Error("Invalid device agent configuration.");
      }
      const admin = voipAgentsClient(store.current);
      const definition = storedAgentDefinition(validated, serial);
      let agentId: string;
      if (validated.agentId !== "") {
        await admin.updateAgent(validated.agentId, definition);
        agentId = validated.agentId;
      } else {
        agentId = (await admin.createAgent(definition)).id;
      }
      const saved = store.save({ voipAgents: { [serial]: { ...validated, agentId } } });
      await runtime?.reloadSettings(saved);
      send("settings:changed", store.redacted());
      return { ok: true, agentId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("voip-agents:delete", async (_e, { serial }) => {
    try {
      const store = requireSettings();
      if (typeof serial !== "string" || serial.trim() === "") {
        throw new Error("voip-agents:delete needs a non-empty device serial.");
      }
      const existing = store.current.voipAgents[serial];
      if (!existing) return { ok: true };
      // A stored agent is deleted remotely too, so it stops existing anywhere —
      // an orphaned agent would keep billing/matching long after the device it
      // served has moved on.
      if (existing.agentId !== "") {
        await voipAgentsClient(store.current).deleteAgent(existing.agentId);
      }
      const saved = store.save({ voipAgents: { [serial]: null } });
      await runtime?.reloadSettings(saved);
      send("settings:changed", store.redacted());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("system:shutdown", async () => {
    await runtime?.shutdown();
  });
}

function wireRuntimeEvents(rt: Runtime) {
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
  rt.on("autopilot-call", (record) => send("autopilot:call", record));
  rt.on("autopilot-state", (callId, state, reason) =>
    send("autopilot:state", { callId, state, reason }),
  );
  rt.on("autopilot-transcript", (callId, entry) => send("autopilot:transcript", { callId, entry }));
  rt.on("autopilot-error", (message, callId) => {
    send("autopilot:error", { message, callId });
    console.warn(`[autopilot${callId ? ` ${callId}` : ""}] ${message}`);
  });
}

app.whenReady().then(() => {
  const envFile = findEnvFile();
  if (envFile) loadEnv(envFile);

  // Settings first: the runtime is built from them, and they must exist even
  // if it never starts, since fixing them is how the operator recovers.
  settings = new SettingsStore({ file: join(app.getPath("userData"), "settings.json") });
  settings.load();
  for (const problem of settings.problems) console.warn(`[neuracall] ${problem}`);

  // A bad/missing .env must not prevent the window from opening — the UI
  // reports the config error and the tool checks still work.
  try {
    // Only the AssemblyAI key comes from the environment; region, model, LLM,
    // TTS, audio and the autopilot limits all come from the settings file so
    // they can be changed without editing .env.
    assemblyAiKey = getConfig().assemblyai.apiKey;
    runtime = new Runtime(buildAppConfig(assemblyAiKey, settings.current), {
      dataDir: resolve(app.getPath("userData"), "data"),
      settings: settings.current,
    });
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
