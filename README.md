# NeuraCall

Multi-device AI voice agent that wirelessly hijacks physical smartphones to handle real cellular and WhatsApp calls simultaneously.

NeuraCall does not use a VoIP provider. It drives real Android phones over `adb`, pulls their audio out with `scrcpy`, and streams it to AssemblyAI's realtime speech-to-text API. A desktop control centre (Electron + React) shows every attached phone, lets you place / answer / hang up calls, and displays live transcripts per phone and channel.

> **Project status: pre-alpha (Phase 0/1 scaffolding).** Today the repo gives you: device discovery, call control over adb, phone audio capture through scrcpy, and live transcription in the desktop app. The "agent" half (LLM replies, text-to-speech injected back into the call, WhatsApp call detection, recording, CRM) is not built yet. See [Status and roadmap](#status-and-roadmap) before assuming a feature exists.

---

## Table of contents

- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Commands](#commands)
- [Running the desktop app](#running-the-desktop-app)
- [Phone setup](#phone-setup)
- [scrcpy audio sources](#scrcpy-audio-sources)
- [Using the control centre](#using-the-control-centre)
- [Configuration reference](#configuration-reference)
- [Status and roadmap](#status-and-roadmap)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## How it works

### Data flow (one phone, one channel)

```
 Android phone ──USB / Wi-Fi──▶ adb ──▶ scrcpy (audio only, --audio-codec raw)
                                              │
                    WAV byte stream over a named pipe (mkfifo) on Linux/macOS,
                    or a temp .wav tailed every 100 ms on Windows
                                              │
                                              ▼
                              @neuracall/scrcpy-bridge  WavStreamReader
                              (parses the RIFF/fmt header, ignores the
                               placeholder sizes, yields raw PCM16 frames)
                                              │  48 kHz, stereo, PCM16 LE
                                              ▼
                              @neuracall/audio-pipeline  AudioPipeline
                              (downmix to mono, linear resample to 16 kHz,
                               slice into 100 ms chunks)
                                              │  16 kHz, mono, PCM16 LE
                                              ▼
                              @neuracall/aai-client  RealtimeStream
                              (binary frames over wss://…/v3/ws, API key in
                               the upgrade header, Terminate on close)
                                              │  Turn / SpeechStarted / … events
                                              ▼
                     Electron main process (Runtime) ──IPC──▶ React renderer
                                                          (live transcript view)
```

Everything phone-facing lives in the Electron **main** process. The renderer never sees the AssemblyAI key or spawns processes; it talks to the main process through a `contextBridge` API (`window.neuracall`) defined in `apps/desktop/electron/preload.mts`.

### Packages

| Package | What it does | Depends on |
|---|---|---|
| `@neuracall/config` (`packages/config`) | Tiny `.env` loader (`loadEnv`) and a fail-fast `getConfig()` that validates `ASSEMBLYAI_API_KEY`, resolves the region to REST / realtime hosts, and exposes optional LLM / TTS settings. | – |
| `@neuracall/aai-client` (`packages/aai-client`) | AssemblyAI **realtime v3** WebSocket client. `RealtimeStream` (connect, `sendAudio`, `UpdateConfiguration`, explicit `Terminate`), `RealtimeSessionManager` (N concurrent sessions keyed by `deviceId` + `channelId`, bounded to avoid close code 3009), `mintRealtimeToken` (short-lived tokens for browser / mobile clients), typed messages and close codes. | `config`, `ws` |
| `@neuracall/audio-pipeline` (`packages/audio-pipeline`) | Pure PCM helpers (`pcm16ToFloats`, `toMono`, `resample`, `floatToPcm16`), an energy-based `EnergyVad` (20 ms frames, start window + hangover), and the streaming `AudioPipeline` that turns any PCM16 input into fixed-size mono chunks at a target rate. No native code. | – |
| `@neuracall/device-manager` (`packages/device-manager`) | `DeviceManager` polls `adb devices` (default every 5 s), tracks USB vs Wi-Fi endpoints and an app-level phase (`online` / `incoming` / `in-call` / `busy` / `offline`). `AndroidCallController` answers / hangs up / dials / sends DTMF via `adb shell input keyevent` and intents, and reads call state from `dumpsys telephony.registry`. The adb runner is injectable, so tests run without hardware. | – |
| `@neuracall/scrcpy-bridge` (`packages/scrcpy-bridge`) | Spawns one audio-only `scrcpy` process per phone and streams its WAV output into a `PcmSink`. Also `detectAdb` / `detectScrcpy` / `detectRequiredTools`, which return per-OS install guides the UI shows when a tool is missing. | `audio-pipeline` |
| `@neuracall/desktop` (`apps/desktop`) | Electron 31 + Vite 5 + React 18 control centre. `electron/service/runtime.ts` wires the packages together; `electron/service/capture.ts` owns the scrcpy-to-STT leg; `electron/main.ts` registers IPC and loads `.env`; `src/` is the renderer. | all of the above |

### The desktop runtime in one paragraph

On launch `main.ts` looks for a `.env` (working directory, then `apps/desktop/.env`, then the repo root, then Electron's `userData` folder), builds the config, and creates a `Runtime`. The runtime starts `adb devices` polling and a 2 s telephony poll for every online phone, so the device list and call phase update on their own. Pressing **Listen** for a phone / channel opens a realtime STT session and, if `scrcpy` is on `PATH`, attaches a capture for that phone; every 100 ms chunk goes straight into the open session and each `Turn` comes back to the renderer over IPC. Quitting the app terminates every session (so billing stops) and kills every scrcpy process.

---

## Repository layout

```
neuracall/
├── package.json              # npm workspaces root; build / typecheck / test / dev:desktop / build:desktop
├── tsconfig.base.json        # strict TS, ES2022, NodeNext modules
├── .env.example              # every environment variable, placeholders only (committed)
├── .env                      # your real keys (git-ignored, never commit)
├── apps/
│   └── desktop/
│       ├── electron/         # main process: main.ts, preload.mts, service/{runtime,capture}.ts
│       ├── src/              # React renderer: App, DevicePanel, TranscriptView, ToolsNotice, StatusBar
│       ├── dist-electron/    # compiled main process (build output)
│       └── dist/             # built renderer (build output)
└── packages/
    ├── config/
    ├── aai-client/
    ├── audio-pipeline/
    ├── device-manager/
    └── scrcpy-bridge/
```

Every package is ESM (`"type": "module"`), compiles with `tsc` into `dist/`, and is consumed by siblings through that `dist/` (`main`/`exports` point at `dist/index.js`). **After changing a package, rebuild it before type-checking the desktop app**, otherwise the desktop sees stale declarations.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | **>= 20** (`engines` in `package.json`) | Electron 31 bundles Node 20.18 for the main process. Do not use APIs newer than Node 20 in `apps/desktop/electron/**` or in any package the main process imports. |
| npm | 10+ | The repo uses npm workspaces (`npm install` at the root installs everything). |
| `adb` | Android platform-tools | Device discovery and call control. Must be on `PATH`. |
| `scrcpy` | **>= 3.x** (verified with 3.3.4) | Audio capture. The `voice-call*` and `mic-*` audio sources need the 3.1+ line; older 1.x / 2.x builds from some distro repos will not work. |
| AssemblyAI account | – | An API key from <https://www.assemblyai.com/dashboard/api-keys>. |
| An Android phone | Android 11+ recommended | scrcpy audio forwarding requires Android 11 or newer. Developed against a realme RMX3624 on Android 13. |

### Installing adb and scrcpy

The same commands are shown inside the app when a tool is missing (`packages/scrcpy-bridge/src/detect.ts`).

**Linux**

```bash
# Debian / Ubuntu
sudo apt install adb scrcpy
# Fedora
sudo dnf install android-tools scrcpy
# Arch
sudo pacman -S android-tools scrcpy
# If your distro's scrcpy is older than 3.x:
snap install scrcpy            # or brew install scrcpy, or build from source per
                               # https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md
```

**macOS**

```bash
brew install scrcpy
brew install --cask android-platform-tools   # adb
```

**Windows**

```powershell
winget install Google.PlatformTools    # adb
winget install scrcpy.scrcpy           # scrcpy   (or: choco install adb scrcpy / scoop install adb scrcpy)
```

If the package managers fail, download platform-tools from <https://developer.android.com/tools/releases/platform-tools> and the scrcpy zip from its GitHub releases page, and add both folders to `PATH`.

Verify:

```bash
adb version
scrcpy --version      # must print 3.x
adb devices           # your phone should be listed as "device" (not "unauthorized")
```

---

## Setup

```bash
git clone <this repo> neuracall
cd neuracall
npm install                      # installs every workspace
cp .env.example .env             # then edit .env
npm run build                    # compiles all packages + the desktop app
```

Edit `.env` and set at least:

```dotenv
ASSEMBLYAI_API_KEY=<your key>    # raw key, no "Bearer" prefix
ASSEMBLYAI_REGION=us             # us | eu | edge (see Configuration reference)
```

`getConfig()` refuses to start the runtime if `ASSEMBLYAI_API_KEY` is empty or still contains `replace-me`. The desktop window still opens in that case and shows **"Config error — check .env"** in the status bar, and the adb / scrcpy checks still work, so you can fix the file and relaunch.

`.env` is git-ignored. Never commit it; `.env.example` is the committed, placeholder-only reference.

---

## Commands

All commands run from the repository root unless stated otherwise.

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces. |
| `npm run build` | `tsc` every package into `dist/`, then build the desktop main process (`dist-electron/`) and renderer (`dist/`). |
| `npm run typecheck` | `tsc --noEmit` in every workspace (desktop runs both the renderer and the Electron tsconfig). Rebuild changed packages first. |
| `npm test` | Runs `node --test` in every package that has tests. Each package first compiles `src/` + `test/` with `tsconfig.test.json` into `dist-test/` (the `pretest` script). |
| `npm run lint` | ESLint (flat config, `eslint.config.js`) across all packages and the desktop app. |
| `npm run format` | Prettier `--write` over `ts/tsx/js/json/md` files. |
| `npm run format:check` | Prettier `--check` — CI-friendly, no writes. |
| `npm run dev:desktop` | Starts the **Vite dev server only** (`http://localhost:5173`, strict port) for the React renderer. It does **not** launch Electron; see below. |
| `npm run build:desktop` | Builds only the desktop app (main + renderer). |

Per-workspace variants:

```bash
npm run build -w @neuracall/audio-pipeline
npm test -w @neuracall/scrcpy-bridge
npm run typecheck -w @neuracall/desktop
```

Tests use Node's built-in `node:test` runner; no test framework is installed. `packages/config` has no tests yet.

---

## Running the desktop app

> ### IMPORTANT: `ELECTRON_RUN_AS_NODE` must be unset
>
> VS Code's integrated terminal (and some other editor terminals) exports `ELECTRON_RUN_AS_NODE=1`. With that variable set, the `electron` binary behaves like a plain `node` executable: **no window opens** and the main process crashes as soon as it touches `app` (for example `Cannot read properties of undefined (reading 'whenReady')`). Always launch with the variable removed:
>
> ```bash
> cd apps/desktop
> env -u ELECTRON_RUN_AS_NODE npx electron .
> ```
>
> Check with `echo ${ELECTRON_RUN_AS_NODE:-unset}` if in doubt.

### Production-style launch (built renderer)

```bash
npm run build                       # or: npm run build:desktop (packages must already be built)
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE npx electron .
```

`main.ts` loads `dist/index.html` when `VITE_DEV_SERVER_URL` is not set.

### Development launch (hot-reloading renderer)

Terminal 1 — renderer dev server:

```bash
npm run dev:desktop                 # Vite on http://localhost:5173
```

Terminal 2 — compile the main process and start Electron pointing at Vite:

```bash
npm run build:main -w @neuracall/desktop        # main process is compiled by tsc, not by Vite
cd apps/desktop
VITE_DEV_SERVER_URL=http://localhost:5173 env -u ELECTRON_RUN_AS_NODE npx electron .
```

Renderer edits hot-reload. Edits under `apps/desktop/electron/**` or in a package require a rebuild and an Electron restart. There is no packaging / installer step yet (no electron-builder configuration).

---

## Phone setup

### 1. Enable USB debugging

1. **Settings → About phone** → tap **Build number** seven times to unlock Developer options.
2. **Settings → Developer options** → enable **USB debugging**.
3. Plug the phone in over USB and accept the **"Allow USB debugging?"** prompt (tick "Always allow from this computer").
4. `adb devices` must list the phone as `device`. `unauthorized` means the prompt was not accepted; `offline` usually means a bad cable / hub or a stale adb server (`adb kill-server && adb devices`).

On some OEM ROMs (realme / OPPO ColorOS, Xiaomi MIUI and others) `adb shell input keyevent` is blocked until an extra developer switch is enabled — look for **"USB debugging (Security settings)"** or **"Disable permission monitoring"** in Developer options. Without it, adb sees the phone but **Answer** / **Hang up** silently do nothing.

On Linux, if the phone shows up as `no permissions`, add a udev rule for your vendor id (`lsusb`) or run adb once with the right permissions; see the Android "Run apps on a hardware device" docs.

### 2. Wireless adb (optional)

NeuraCall treats any endpoint containing `:` as a Wi-Fi device (`kind: "wifi"`), so both connection styles work:

**Classic TCP/IP mode (any Android version, needs one USB handshake):**

`./scripts/adb-setup.sh` automates the whole handshake below (all plugged-in
phones at once) and persists the wireless endpoints to `devices.json`:

```bash
adb tcpip 5555                           # phone is plugged in over USB
adb shell ip route | grep -o 'src [0-9.]*'   # find the phone's Wi-Fi IP
adb connect 192.168.1.5:5555             # now unplug the cable
adb devices                              # 192.168.1.5:5555  device
```

After a phone reboot the endpoint drops; reconnect it with
`./scripts/adbtool.sh reconnect --all`.

**Wireless debugging (Android 11+, no cable):**

1. **Developer options → Wireless debugging** → enable it → **Pair device with pairing code**.
2. `adb pair <ip>:<pairing-port>` and enter the code.
3. `adb connect <ip>:<connect-port>` (the port shown on the main Wireless debugging screen).

Notes:

- Wireless endpoints drop when the phone reboots or changes network; reconnect with `adb connect` again. The app's `reconnectKnown()` path exists, but the desktop runtime does not persist known endpoints yet, so the **Reconnect** action currently only re-polls `adb devices`.
- Put the phone and the computer on the same **5 GHz** network where possible. On 2.4 GHz, scrcpy's audio stream is far more prone to jitter and dropouts, which show up as gaps or garbled transcripts.
- USB is the most reliable transport for audio; use it while developing.

---

## scrcpy audio sources

NeuraCall runs scrcpy audio-only for each phone, roughly:

```bash
scrcpy -s <endpoint> --no-video --no-window --no-playback \
       --audio-source mic --audio-codec raw --record-format wav --record <pipe-or-file>
```

`--audio-source` decides **which** audio you get. Values accepted by scrcpy 3.3.4 (`scrcpy --help`):

| Source | Captures | Notes |
|---|---|---|
| `mic` (**NeuraCall default**) | The phone's microphone | Your side of the room / whoever is talking near the phone. Works on every device that supports scrcpy audio. |
| `mic-unprocessed` | Microphone, raw | No OEM processing. |
| `mic-camcorder` | Microphone tuned for video | |
| `mic-voice-recognition` | Microphone tuned for speech recognition | Often a better STT input than plain `mic`. |
| `mic-voice-communication` | Microphone tuned for calls (AEC / AGC where available) | |
| `voice-call` | **The phone call itself** (both directions) | This is what a call agent ultimately needs. Availability is OEM- and ROM-dependent; many devices return silence or refuse the source. Test on your hardware. |
| `voice-call-uplink` | Call, uplink only (what the phone sends) | Same restrictions as `voice-call`. |
| `voice-call-downlink` | Call, downlink only (what the remote party says) | Same restrictions as `voice-call`. |
| `output` | Whole device audio output | scrcpy's own default; **disables playback on the phone** while capturing. |
| `playback` | Audio playback (apps can opt out) | Needs Android 13+. |
| `voice-performance` | Mic + device playback (karaoke style) | |

Where the source is chosen today:

- The desktop runtime defaults to `mic` (`RuntimeOptions.audioSource` in `apps/desktop/electron/service/runtime.ts`).
- `Runtime.startSession(deviceId, channelId, { source })` and the IPC call `session:start` accept a `source`, but the current UI does not expose a picker, so changing it means editing code. There is no environment variable for it yet.
- The scrcpy stream format is read from the WAV header at runtime (48 kHz stereo in practice); the pipeline resamples to 16 kHz mono regardless of what scrcpy reports.

---

## Using the control centre

- **Status bar** — AssemblyAI region and speech model from your `.env`, or the config error.
- **Tool notice** — on-launch check of `adb` and `scrcpy` with a per-OS install guide and a **Re-check** button.
- **Devices** — every adb-attached phone (USB or Wi-Fi) with its adb state and phase, updated automatically. Per phone:
  - **Call** — places a real outgoing call via `android.intent.action.CALL`. **The number rings immediately.**
  - **Answer** / **Hang up** — `KEYCODE_CALL` / `KEYCODE_ENDCALL` key events.
  - **Listen** / **Stop** per channel (`cellular`, `whatsapp`) — opens / terminates a realtime STT session for that phone + channel and starts / stops scrcpy capture. A **capturing** badge shows while scrcpy is running.
- **Live Transcripts** — rolling list of partial (dimmed) and final turns, keyed `device / channel`, plus a list of ended sessions with the reason.

Current limitations to be aware of:

- The `cellular` / `whatsapp` channels are **labels** for separate STT sessions. Nothing detects WhatsApp calls yet.
- There is **one scrcpy capture per phone**. If you press Listen on both channels of the same phone, the second session opens without audio (the capture stays attached to the first).
- The pipeline is configured with `emitSilence: true` in the desktop path, so audio streams continuously and AssemblyAI does its own endpointing; the local VAD is available in `@neuracall/audio-pipeline` but not gating this path.
- Nothing is spoken back to the phone; transcripts are display-only.

---

## Configuration reference

All variables are documented in `.env.example`. What the code actually reads:

| Variable | Required | Default | Used by |
|---|---|---|---|
| `ASSEMBLYAI_API_KEY` | **yes** | – | `getConfig()` fails fast if missing or `replace-me`. Sent as the `Authorization` header on the realtime WebSocket upgrade and to the token endpoint. Never reaches the renderer. |
| `ASSEMBLYAI_REGION` | no | `edge` | `us` → REST `api.assemblyai.com`, realtime `streaming.us.assemblyai.com`; `eu` → `api.eu.assemblyai.com` / `streaming.eu.assemblyai.com`; `edge` (or unset) → `api.assemblyai.com` / `streaming.assemblyai.com`. Any other value throws. |
| `ASSEMBLYAI_SPEECH_MODEL` | no | `universal-3-5-pro` | Realtime `speech_model` query parameter (singular string). |
| `LLM_API_KEY`, `LLM_MODEL` | no | – | Read into `config.llm`; **not used by any code path yet**. |
| `TTS_API_KEY`, `TTS_MODEL` | no | – | Read into `config.tts`; **not used yet**. |
| `WHATSAPP_TOKEN` | no | – | Listed in `.env.example`; **not read by any code yet**. |

Realtime session parameters are fixed in `Runtime.startSession`: `sample_rate=16000`, `speech_model` from config, `mode=balanced`, PCM16 little-endian. The session manager allows at most 10 concurrent sessions per app instance; AssemblyAI closes with code `3009` when its own limit is hit.

---

## Status and roadmap

Legend: **Done** = implemented and covered by tests in this repo; **Partial** = working end to end but with the listed gap; **Planned** = not started.

| Area | Status | Notes |
|---|---|---|
| Monorepo scaffold, strict TS, workspace build / typecheck / test | Done | No ESLint / Prettier configuration yet. |
| Config module: `.env` loading, fail-fast validation, region → hosts | Done | |
| AssemblyAI realtime v3 client: connect, audio, `UpdateConfiguration`, `Terminate`, close-code mapping | Done | Reconnect / backoff policy and 3007 chunk-size correction are not implemented. |
| Concurrent sessions keyed by `(deviceId, channelId)` | Done | Bounded in-process; no queue when the bound is hit (throws). |
| Temporary realtime token minting | Done | For browser / mobile clients; the desktop uses the server key directly. |
| Audio pipeline: PCM helpers, resampler, chunker, energy VAD | Done | Linear-interpolation resampler (adequate for speech, not audiophile). |
| Device manager: adb polling, USB / Wi-Fi endpoints, phases | Done | State lives in memory; no SQLite persistence. |
| Call control: answer / hang up / dial / DTMF / mute / call state | Done | Guards such as "refuse to answer if busy elsewhere" are not implemented. |
| scrcpy audio bridge: spawn, WAV stream parsing, FIFO / temp-file transport, tool detection | Partial | Under review; one transport test is being reworked at the time of writing. |
| Desktop control centre: devices, call buttons, Listen / Stop, live transcript, tool guides | Partial | No audio-source picker, no persistence, no packaging. |
| Wireless adb bootstrap script (`adb tcpip`, connect, persisted `devices.json`) | Done | `scripts/adb-setup.sh` + `adbtool.sh` (add/remove/list/reconnect) |
| Dual-stream call audio (remote party vs. local mic, labelled streams) | Planned | Depends on `voice-call*` availability per device. |
| Call audio recording to disk alongside live STT | Planned | |
| Agent brain (LLM replies) and TTS injected back into the call | Planned | `LLM_*` / `TTS_*` env vars are placeholders for this. |
| `agent_context` / `keyterms_prompt` biasing per turn | Planned | The client already supports `UpdateConfiguration`. |
| WhatsApp voice-call detection and routing | Planned | The `whatsapp` channel is currently only a label. |
| WhatsApp text messaging bridge | Planned | |
| Post-call pre-recorded transcripts and summaries | Planned | |
| CRM: contacts, call history, SQLite store | Planned | |

Task tracking for this project lives in `.autoplans/tasks.md`.

---

## Troubleshooting

**No window opens; the terminal shows a Node stack trace mentioning `app` or `whenReady`.**
`ELECTRON_RUN_AS_NODE` is set. Launch with `env -u ELECTRON_RUN_AS_NODE npx electron .` (see [Running the desktop app](#running-the-desktop-app)).

**Status bar says "Config error — check .env".**
`ASSEMBLYAI_API_KEY` is missing, blank, or still `replace-me`, or `ASSEMBLYAI_REGION` is not `us` / `eu` / `edge`. The app looks for `.env` in the current directory, `apps/desktop/`, the repo root, then Electron's user-data folder. Fix the file and relaunch; the exact message is in the terminal as `[neuracall] runtime not started: …`.

**"No phones detected" in the Devices panel.**
Run `adb devices` yourself. `unauthorized` → accept the prompt on the phone. Nothing listed → cable, USB mode (choose "File transfer" rather than "Charging only" on some phones), or `adb kill-server`. The panel refreshes every 5 s.

**Answer / Hang up / Call do nothing, but the phone is `device`.**
Your ROM blocks input injection over adb. Enable "USB debugging (Security settings)" / "Disable permission monitoring" in Developer options (name varies by OEM). Confirm with `adb shell input keyevent 6` while a call is ringing.

**Listen works but no transcript ever appears.**
Check the terminal for `[capture <id>]` lines. Common causes: scrcpy not on `PATH` (the session opens without audio and the log says so); the phone is older than Android 11; the chosen `--audio-source` is silent on your device (try `mic` first, then `mic-voice-recognition`, then `voice-call`); or the phone is muted / far from the speaker. Test scrcpy alone with `scrcpy -s <id> --no-video --audio-source=mic` and listen on the computer.

**scrcpy prints `ERROR` / `WARN` lines (they appear in the app log).**
Those lines are forwarded verbatim from scrcpy. `Audio capture failed` or `Could not configure audio` generally means the source is unsupported on this device / Android version; `device disconnected` means the adb transport dropped (see wireless notes).

**Choppy audio or garbled transcripts over Wi-Fi.**
Move the phone to a 5 GHz network or use USB. 2.4 GHz jitter is the most common cause. Also avoid running video mirroring at the same time.

**`Too many concurrent realtime sessions (3009)`.**
AssemblyAI's concurrency limit for your account was hit. Stop unused sessions; the manager caps at 10 per app instance but the account limit may be lower.

**`Audio chunk outside 50-1000ms or faster than real-time (3007)`.**
The session received audio too fast. This should not happen with the built-in capture (100 ms chunks); it can happen if you feed audio through `feedAudio` from a file without pacing it.

**Sessions keep billing after a crash.**
Every session sends `Terminate` on `Stop`, on window close, and on app quit. If the app is killed with `SIGKILL`, sessions end at AssemblyAI's inactivity timeout / 3-hour cap. Prefer closing the window.

**`npm run typecheck` fails in `apps/desktop` after editing a package.**
The desktop resolves packages through their built `dist/`. Run `npm run build -w @neuracall/<pkg>` (or `npm run build`) first.

**Windows.**
The bridge cannot use a named pipe there; it records to a temporary `.wav` under `%TEMP%` and tails it every 100 ms, deleting it on exit. Expect slightly higher latency. Some phones need the OEM USB driver before adb lists them.

---

## Security notes

- The AssemblyAI key is read in the Electron main process only. The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and gets a narrow IPC surface; transcripts and device state flow out, commands flow in, the key never crosses.
- Realtime sessions are always closed with `Terminate` (bounded wait for the server's `Termination`) so billing stops deterministically.
- `adb` is invoked with `execFile` (no shell) and every call is scoped with `-s <endpoint>`.
- Placing a call with **Call** dials a real number on a real SIM. Treat the desktop app like a phone.
- `.env` is git-ignored; only `.env.example` with placeholders is committed. Keep it that way.
