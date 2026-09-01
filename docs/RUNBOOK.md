# Runbook

Everything needed to take a fresh machine to a phone that answers a call. Work
top to bottom the first time; after that, [Startup order](#4-startup-order) and
[Troubleshooting](#7-troubleshooting-by-symptom) are the parts you come back
to.

Before you plan a deployment around this, read the honest capability table in
the [README](../README.md) — the agent listens, transcribes, thinks and
records, but making the caller _hear_ it still needs an audio-injection
transport you set up yourself ([AUDIO-ABI.md](AUDIO-ABI.md)).

**Contents**

1. [Prerequisites](#1-prerequisites)
2. [Installing adb and scrcpy](#2-installing-adb-and-scrcpy)
3. [Phone prep](#3-phone-prep)
4. [Startup order](#4-startup-order)
5. [Verification](#5-verification)
6. [Production Wi-Fi](#6-production-wi-fi)
7. [Troubleshooting by symptom](#7-troubleshooting-by-symptom)
8. [Data handling](#8-data-handling)

---

## 1. Prerequisites

| Requirement    | Version                        | Why                                                                                                                                                                                                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js        | **>= 20** (`engines`)          | Electron 37 bundles Node 22.21 for the main process, so `node:sqlite` is available there and the contacts database is live. The repo itself still supports Node 20, so packages outside `apps/desktop/electron/**` must not rely on Node 22 APIs. |
| npm            | 10+                            | The repo is npm workspaces; `npm install` at the root installs everything.                                                                                                                                                                        |
| `adb`          | Android platform-tools         | Device discovery, call control, WhatsApp detection. Must be on `PATH` (or set `ADB=/path/to/adb` for the shell scripts).                                                                                                                          |
| `scrcpy`       | **>= 3.x** — verified on 3.3.4 | Audio capture. The `voice-call*` and `mic-*` sources need the 3.1+ line; older 1.x/2.x builds from distro repos will not work.                                                                                                                    |
| AssemblyAI key | –                              | <https://www.assemblyai.com/dashboard/api-keys>. Raw key, no `Bearer` prefix.                                                                                                                                                                     |
| Android phone  | 11+ recommended                | scrcpy audio forwarding needs Android 11+. Developed against a realme RMX3624 on Android 13.                                                                                                                                                      |

For **injection** (the agent's voice reaching the caller) you additionally need
one of: a working BlueZ/HFP stack and a phone paired to the host as a hands-free
device; an on-device helper APK; or a speaker beside the phone's microphone.
None of this is set up by the repo.

## 2. Installing adb and scrcpy

The app shows these same commands when a tool is missing — they come from
`packages/scrcpy-bridge/src/detect.ts`, so this table and the app cannot drift.

**Linux**

```bash
# adb
sudo apt install adb            # Debian/Ubuntu
sudo dnf install android-tools  # Fedora
sudo pacman -S android-tools    # Arch

# scrcpy
sudo apt install scrcpy         # Debian/Ubuntu
sudo dnf install scrcpy         # Fedora
sudo pacman -S scrcpy           # Arch
snap install scrcpy             # if your distro's package is older than 3.x
```

No sudo? Download the platform-tools zip
(<https://developer.android.com/tools/releases/platform-tools>), unzip it, and
add the folder to `PATH`; use Snap or a prebuilt binary for scrcpy.

**macOS** (Homebrew)

```bash
brew install --cask android-platform-tools
brew install scrcpy
```

**Windows** (pick one manager)

```powershell
winget install Google.PlatformTools ; winget install scrcpy.scrcpy
choco  install adb                  ; choco  install scrcpy
scoop  install adb                  ; scoop  install scrcpy
```

If those fail, download platform-tools and the scrcpy zip and add both folders
to `PATH`. Some phones also need the OEM USB driver before Windows shows them
to adb at all.

**Verify both, always:**

```bash
adb version && adb devices
scrcpy --version          # must report 3.x
```

## 3. Phone prep

Do this once per phone.

1. **Settings → About phone** → tap **Build number** seven times. Developer
   options appear.
2. **Settings → Developer options** → enable **USB debugging**.
3. Plug the phone in over USB. A dialog appears on the phone:
   **"Allow USB debugging?"** — accept it, and tick **"Always allow from this
   computer"**. Until you do, `adb devices` reports the phone as
   `unauthorized`, not `device`.
4. Confirm: `adb devices` lists the serial with state `device`.

**The OEM trap.** On realme / OPPO ColorOS, Xiaomi MIUI and several others,
`adb shell input keyevent` is silently blocked until an _extra_ developer
switch is on. Look for **"USB debugging (Security settings)"** or **"Disable
permission monitoring"** in Developer options; the name varies. Without it adb
sees the phone perfectly and **Answer / Hang up do nothing at all** — no error,
no log line. Test it deliberately: with a call ringing, run
`adb -s <serial> shell input keyevent 5`. If the call does not answer, that
switch is your problem.

On Linux, a phone showing as `no permissions` needs a udev rule for its vendor
id (find it with `lsusb`).

**Wireless debugging (Android 11+, no cable)** is an alternative to the
`adb tcpip` handshake in the next section:

1. **Developer options → Wireless debugging** → **Pair device with pairing
   code**.
2. `adb pair <ip>:<pairing-port>` and type the code.
3. `adb connect <ip>:<connect-port>` — note this is a _different_ port from the
   pairing one, shown on the main Wireless debugging screen.

**No screen lock.** Placing a call through a messaging app is UI automation, and
UI automation does nothing on a phone behind a keyguard: taps land on the lock
screen, `uiautomator dump` describes the lock screen, and the call is simply
never placed — with no error anywhere. NeuraCall wakes the phone and dismisses an
_insecure_ keyguard itself, but a PIN, pattern or password cannot be cleared by
adb without the credential, so it reports that instead of pretending. Remove the
screen lock on any handset NeuraCall drives.

### 3a. Bluetooth HFP — the injection transport

This is what lets the caller hear the agent. It is the one step that cannot be
scripted: Bluetooth pairing requires a confirmation tap on the handset.

The host pairs to the phone as a **hands-free unit** (the role a headset plays),
so the phone routes the call's audio to the host and accepts audio back — both
directions, which is exactly what a call needs and what scrcpy cannot give you.

Check the host can do it at all:

```bash
rfkill unblock bluetooth
bluetoothctl show | grep -E 'Powered|UUID: Handsfree'
```

You need `Powered: yes` and a **`UUID: Handsfree`** line. That UUID is the HF
role; without it the adapter can only be an audio _sink_ (A2DP), which carries
music from the phone but has no microphone path and so cannot carry a call.
On PipeWire this comes from the `libspa-0.2-bluetooth` package.

Then pair, from the host:

```bash
bluetoothctl
> agent on
> default-agent
> scan on          # note the phone's MAC, then: scan off
> pair <MAC>       # confirm the matching code ON THE PHONE
> trust <MAC>      # so it reconnects by itself after a reboot
> connect <MAC>
```

On the phone, in the paired device's settings, make sure **Phone calls** (or
"Call audio") is enabled for the host — some Android builds pair with media
only, which looks connected and still routes call audio to the earpiece.

With a call in progress the host should show a Bluetooth source and sink; point
`NEURACALL_INJECT_SINK` at the sink. If the sink only appears _during_ a call,
that is normal: the SCO link is set up per call, not held open.

## 4. Startup order

The order matters: the build has to finish before anything imports a package,
and the config has to be valid before the runtime will start.

```bash
# 1. Wireless adb handshake for every phone currently plugged in over USB.
#    Switches each to TCP/IP on :5555, finds its Wi-Fi IP, connects, verifies,
#    and writes devices.json at the repo root. Safe to re-run.
./scripts/adb-setup.sh
./scripts/adb-setup.sh --dry-run      # print the adb commands without running them

# 2. Verify. Every phone you expect must be state `device`.
adb devices

# 3. Configure.
cp .env.example .env
$EDITOR .env                          # set ASSEMBLYAI_API_KEY at minimum

# 4. Install and build. Packages are consumed through their built dist/,
#    so this is not optional and must be redone after changing one.
npm install
npm run build

# 5. Launch.
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE npx electron .
```

### The Electron launch gotcha

**This will catch you once, and the error message will not tell you why.**

VS Code's integrated terminal (and some other editor terminals) exports
`ELECTRON_RUN_AS_NODE=1`. With that set, the `electron` binary behaves as a
plain Node executable: `import "electron"` resolves to a path string instead of
the API, no window opens, and the main process dies on something like
`Cannot read properties of undefined (reading 'whenReady')`.

```bash
echo ${ELECTRON_RUN_AS_NODE:-unset}                # diagnose
cd apps/desktop && env -u ELECTRON_RUN_AS_NODE npx electron .   # fix
```

Always launch Electron through `env -u ELECTRON_RUN_AS_NODE`. Never `export`
the variable away globally — other tools rely on it.

### Development launch (hot-reloading renderer)

Terminal 1:

```bash
npm run dev:desktop                   # Vite on http://localhost:5173 — renderer ONLY
```

Terminal 2:

```bash
npm run build:main -w @neuracall/desktop     # the main process is compiled by tsc, not Vite
cd apps/desktop
VITE_DEV_SERVER_URL=http://localhost:5173 env -u ELECTRON_RUN_AS_NODE npx electron .
```

Renderer edits hot-reload. Edits under `apps/desktop/electron/**` or inside any
package need a rebuild and an Electron restart. There is no packaging or
installer step yet.

### Reconnecting later

Wireless endpoints do not survive a phone reboot or a network change.

```bash
./scripts/adbtool.sh list                 # known endpoints from devices.json
./scripts/adbtool.sh reconnect --all      # after a reboot or a Wi-Fi change
./scripts/adbtool.sh add 192.168.1.60     # add and connect
./scripts/adbtool.sh remove 192.168.1.60  # forget
```

## 5. Verification

Work through these in order. The first two cost nothing; the last two spend
real money and dial real numbers.

### 5a. Offline — no phone, no key, no spend

```bash
npm test           # unit tests in every package
npm run test:e2e   # the full call loop against fakes
npm run typecheck
npm run lint
```

`npm run test:e2e` is the honest smoke test of the _logic_: real
DeviceManager, AndroidCallController, AdbCallChannelDetector,
RealtimeSessionManager, RealtimeStream, CallAudioSession, AudioPipeline,
EnergyVad, CallRecorder, Orchestrator, CallStateMachine and LlmCallAgent, with
only adb, the AssemblyAI socket, scrcpy, the LLM and TTS faked. If this fails,
stop — nothing on real hardware will work either.

### 5b. `scripts/live-stt-smoke.mjs` — does the key and the protocol work?

Streams a real WAV fixture to the **real** AssemblyAI endpoint through our own
`RealtimeStream`. Proves auth, the URL and query params, the handshake and
`Terminate` against the live service. **This bills you** — a few seconds of
wall-clock session time.

```bash
# from the repo root (it reads ./.env), after npm run build
node scripts/live-stt-smoke.mjs packages/aai-client/test/fixtures/speech-16k-mono.wav
```

The fixture path is the single required argument, and it must be **16 kHz mono**
— the script refuses anything else rather than sending audio the server will
misread.

What a good run prints:

- the config banner (region, three endpoints, model, masked key),
- `[Begin] id=… model=universal-3-5-pro` — **check that model string**. The
  socket accepts the connection and silently ignores an unapplied model, so the
  echo in `Begin.configuration` is the only proof it took effect
  (DECISIONS.md §1),
- `[SpeechStarted]`, then `[partial]` and `[FINAL]` turns,
- `[Termination] audio=…s billed_session=…s` — the billed figure,
- `[close] code=1000`.

Audio is paced in real time by design; sending faster closes the socket
with 3007.

### 5c. `scripts/live-call-smoke.mjs` — does the phone-to-transcript path work?

The "is the main functionality actually working" script: real `ScrcpyBridge`,
real `CallAudioSession`/`AudioPipeline`, real `RealtimeStream`, real service.
Nothing stubbed. **Also bills you.**

```bash
node scripts/live-call-smoke.mjs                       # 20 s, --source=mic, first online device
node scripts/live-call-smoke.mjs 45                    # 45 s
node scripts/live-call-smoke.mjs 30 --source=voice-call-downlink
node scripts/live-call-smoke.mjs 30 --device=192.168.1.60:5555
```

Arguments, all optional and order-independent: a bare integer is the duration
in seconds (default 20); `--source=<scrcpy audio source>` (default `mic`);
`--device=<serial or ip:port>` (default: the first device adb reports as
online).

It preflights `adb` and `scrcpy` and exits 1 if either is missing, then exits 1
if no adb device is online. Talk into the phone while it runs.

**Read the last three lines.** `raw capture: 0 bytes` means scrcpy produced
nothing — a source problem, not an STT problem. Non-zero raw bytes with an
empty transcript means audio flowed but nothing intelligible reached the
server.

Note the default: `--source=mic` captures the phone's own microphone, i.e.
_your_ side of a call plus the room. To transcribe the far end you need either
a privileged source (`--source=voice-call-downlink`, frequently denied by the
OEM) or the call on speakerphone so the caller's voice reaches the mic. This
script pins whatever source you name; it does **not** walk the fallback chain
that `ScrcpyAudioCapture` uses.

### 5d. The desktop app

Launch it (section 4) and check, in order:

1. **Status bar** shows the AssemblyAI region and speech model — not
   "Config error".
2. **Tool notice** reports adb and scrcpy as found.
3. **Devices** lists every phone with state `device`.
4. **Answer / Hang up** actually work on a ringing call (the OEM trap in
   section 3).
5. **Listen** on a phone/channel opens a session, shows the _capturing_ badge,
   and produces partial then final turns as you speak.

Known app limitations worth knowing before you report a bug: the
`cellular`/`whatsapp` channels are labels for separate STT sessions; there is
**one scrcpy capture per phone**, so pressing Listen on a second channel of the
same phone opens a session with no audio; and there is no audio-source picker in
the UI. Whether anything is spoken back to the phone depends on section 3a —
the agent's voice is generated either way, but without an injection transport it
has nowhere to go.

### 5e. `scripts/live-voice-agent.mjs` — does the agent actually speak?

Answers the speech half of "the caller cannot hear the agent" without involving
a phone at all. It uses the product's own client against the real service, and
because the host usually has no local TTS, it has a throwaway agent _speak_ the
caller's line and streams that back in as if it were a caller.

```bash
node scripts/live-voice-agent.mjs            # add --keep-audio to save the reply
```

It creates two temporary agents and deletes both on the way out, including after
a failure. Every check should pass; a failure here is a key, entitlement or
network problem, not a phone problem.

Two numbers it reports are easy to confuse. The generation figure (~10 ms) is
the model plus synthesis, measured from the moment the service declares the turn
over. What a caller _perceives_ is that plus the end-of-turn silence window —
about 1.5 s on the defaults. Lowering the window trades that latency against
cutting off callers who pause mid-sentence.

## 5f. Packaging a release build

Everything above runs from a checkout. To produce something an operator can copy
onto a machine:

```bash
npm run build                       # every workspace package, first
npm run dist -w @neuracall/desktop  # -> apps/desktop/release/
```

That writes `NeuraCall-<version>-x86_64.AppImage` (~112 MB, most of it Electron).
AppImage needs no root and no package manager, which is what suits a box sitting
next to a rack of phones. Mark it executable and run it:

```bash
chmod +x NeuraCall-0.1.0-x86_64.AppImage
./NeuraCall-0.1.0-x86_64.AppImage
```

Three things about the packaged app differ from a checkout and are worth knowing
before you debug it:

- **It does not read the repo's `.env`.** `findEnvFile()` looks in the working
  directory, then beside the binary, then in the app's own user-data directory
  (`~/.config/NeuraCall/.env`). That last one is the packaged answer: put the
  key there, or set `ASSEMBLYAI_API_KEY` in the environment that launches it.
  Everything else is configured in the Settings tab and stored per user, so a
  release build carries no configuration and **no secret** of its own.
- **The AppImage needs FUSE.** Without it you get _"Cannot mount AppImage,
  please check your FUSE setup"_, which reads like a corrupt download and is
  not. Either install `libfuse2`, or run
  `./NeuraCall-...AppImage --appimage-extract` and launch `squashfs-root/neuracall`.
- **`adb` and `scrcpy` are still external.** They are not bundled — the app
  drives whatever is on `PATH`, and the Tool notice in the UI tells you when one
  is missing.

`.deb` is deliberately not built. It carries a mandatory Homepage field and this
project has no public URL, and inventing one that 404s or embedding a local path
into a distributable are both worse than leaving the target off.
`apps/desktop/electron-builder.yml` says exactly what to add when there is a
real homepage.

## 6. Production Wi-Fi

A rack of phones on adb over Wi-Fi is a network deployment, and it fails in
network ways.

- **Prefer 5 GHz.** On 2.4 GHz, scrcpy's audio stream jitters, and jitter shows
  up as gaps and garbled words in the transcript — which reads like an STT
  problem and is not one. Where audio quality matters most, use USB.
- **Give every phone a static IP or a DHCP reservation.** A wireless adb
  endpoint _is_ `ip:port`. When the lease moves, `devices.json` points at
  nothing and every reconnect fails. This is the single most common cause of a
  fleet that "worked yesterday".
- **`adb tcpip` does not survive a phone reboot.** The phone stops listening on
  :5555 and needs the USB handshake again (`./scripts/adb-setup.sh`), or the
  Android 11+ Wireless debugging pairing. Plan for reconnection as a routine
  event, not an incident: `./scripts/adbtool.sh reconnect --all` after any
  reboot or network change.
- **Use powered USB hubs** for phones that stay cabled. Several phones charging
  and streaming through an unpowered hub browns out, and the symptom is a
  device flapping between `device` and `offline` rather than anything obviously
  power-related.
- **Keep the host and the phones on the same subnet**, with client isolation
  off on the AP. Guest networks block device-to-device traffic and adb connect
  will simply time out.
- **Don't mirror video.** Capture is audio-only (`--no-video --no-window
--no-playback`) for a reason; running scrcpy's video mirroring at the same
  time competes for the same wireless budget.

## 7. Troubleshooting by symptom

Keyed by what you actually see, not by what is broken.

| Symptom                                                                                      | Likely cause                                                                                                                                                | Do this                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No window opens**; terminal shows a Node stack trace mentioning `app` or `whenReady`       | `ELECTRON_RUN_AS_NODE=1` is exported (VS Code terminal)                                                                                                     | `env -u ELECTRON_RUN_AS_NODE npx electron .` from `apps/desktop`. Check with `echo ${ELECTRON_RUN_AS_NODE:-unset}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Status bar: "Config error — check .env"**                                                  | `ASSEMBLYAI_API_KEY` missing, blank, or still `replace-me`; or `ASSEMBLYAI_REGION` is not `us`/`eu`/`edge`; or the key has a `Bearer ` prefix or whitespace | Exact message is on the terminal as `[neuracall] runtime not started: …`. The app looks for `.env` in the cwd, then `apps/desktop/`, then the repo root, then Electron's userData dir.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **`adb devices` lists nothing**                                                              | Cable, USB mode, or a stale adb server                                                                                                                      | Choose "File transfer" rather than "Charging only" on the phone. `adb kill-server && adb devices`. Try another cable — charge-only cables are common.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Device shows `unauthorized`**                                                              | The RSA prompt was never accepted                                                                                                                           | Unlock the phone, replug, accept **"Allow USB debugging?"**, tick "Always allow". If no prompt appears: Developer options → **Revoke USB debugging authorisations**, then replug.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Device shows `offline`**                                                                   | Stale transport, bad hub, or the phone rebooted after `adb tcpip`                                                                                           | `adb kill-server`; for wireless, `./scripts/adbtool.sh reconnect --all`; if it was a reboot, re-run `./scripts/adb-setup.sh` over USB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Device shows `no permissions`** (Linux)                                                    | Missing udev rule                                                                                                                                           | Add a rule for the vendor id from `lsusb`, then `sudo udevadm control --reload && adb kill-server`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Phone is `device` but Answer / Hang up / Call do nothing**                                 | The OEM blocks input injection over adb                                                                                                                     | Enable "USB debugging (Security settings)" / "Disable permission monitoring" in Developer options. Confirm with `adb -s <id> shell input keyevent 5` on a ringing call.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Capture is silent — `raw capture: 0 bytes`, or the _capturing_ badge is on with no audio** | The chosen `--audio-source` is unavailable or silently denied on this ROM                                                                                   | Walk the chain by hand, best first: `voice-call-downlink` → `voice-call` → `output` → `mic`. Test outside NeuraCall: `scrcpy -s <id> --no-video --audio-source=voice-call` and listen. A denied privileged source often _starts_ and then produces nothing forever rather than erroring — that is why `ScrcpyAudioCapture` has a start timeout. Also check scrcpy is 3.x and the phone is Android 11+.                                                                                                                                                                                                               |
| **Audio flows but the transcript stays empty**                                               | Usually one of three things                                                                                                                                 | (1) You are capturing the wrong side: `mic` picks up _your_ end, not the caller's — put the call on speakerphone or use a `voice-call*` source. (2) VAD is gating the silence out: `emitSilence` must stay **true**. AssemblyAI ends a turn from how much silence it received, so stripping pauses compresses the timeline into one unbroken utterance, turns never finalize, and the call goes quiet while transcription looks healthy. Both production paths set it to `true`, but the bare `AudioPipeline` default is `false` — so this bites anyone wiring their own pipeline. (3) Nobody was actually speaking. |
| **Choppy audio, dropped words**                                                              | Wireless jitter                                                                                                                                             | Move to 5 GHz or use USB; stop any video mirroring. See section 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Close 1008**                                                                               | Missing/invalid token, an account problem, or a new-session rate limit                                                                                      | **Do not retry in a loop** — it is a configuration error, and hammering turns a typo into a stream of rejected auth attempts. Check the key is the raw key with no `Bearer ` prefix and that the region matches the account. DECISIONS.md §4/§6.                                                                                                                                                                                                                                                                                                                                                                     |
| **Close 3007**                                                                               | A chunk outside the 50–1000 ms window, or audio sent faster than real time                                                                                  | The built-in capture sends 100 ms chunks paced by capture, so this means something is feeding a file without pacing it. The policy is to halve the chunk size and reconnect — never crash.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Close 3009**                                                                               | Too many concurrent sessions for the account                                                                                                                | The session manager bounds concurrency and queues FIFO rather than racing into a rejection, but your _account_ limit may be lower than the local bound. Stop unused sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Close 3008**                                                                               | The 3-hour session cap, or a temp token's max duration                                                                                                      | Expected on very long calls. Open a fresh session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **A session still seems to be billing after a crash**                                        | The socket was dropped without `Terminate`                                                                                                                  | Billing is **wall-clock connection time**, not audio duration. Normal exits always Terminate — Stop, window close, app quit, and every orchestrator teardown path. A `SIGKILL`ed process cannot, so the session runs to AssemblyAI's inactivity timeout or the 3-hour cap. Prefer closing the window; check the dashboard if you killed it hard.                                                                                                                                                                                                                                                                     |
| **The caller cannot hear the agent**                                                         | Either nothing is generating speech, or there is no transport carrying it to the call — two separate causes that look identical                             | Check which. Speech: with the Voice Agent on (Settings → Voice Agent) AssemblyAI supplies the reply _and_ the voice on the key you already have, so no LLM or TTS credential is needed; on the composed path a missing `LLM_API_KEY` or TTS provider leaves `SilentTts` in place. Transport: injection still needs Bluetooth HFP (section 3a), an on-device helper app, or acoustic coupling. `node scripts/live-voice-agent.mjs` proves the speech half without a phone. See [VOICE-AGENT.md](VOICE-AGENT.md) and [AUDIO-ABI.md](AUDIO-ABI.md).                                                                     |
| **The agent answers its own last sentence**                                                  | A duplex capture source (`voice-call`, `mic`, `output`) is feeding the agent's own voice back into STT                                                      | Move to `voice-call-downlink` if the phone allows it. Otherwise gate `remoteIn` while `localOut.isSpeaking`, or lean on `agent_context` biasing plus barge-in to discard turns that echo what the agent just said.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **`npm run typecheck` fails in `apps/desktop` after editing a package**                      | Consumers resolve packages through their built `dist/`                                                                                                      | `npm run build -w @neuracall/<pkg>` (or `npm run build`) first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **scrcpy `ERROR` / `WARN` lines in the app log**                                             | Forwarded verbatim from scrcpy                                                                                                                              | `Audio capture failed` / `Could not configure audio` → the source is unsupported here; try the next one. `device disconnected` → the adb transport dropped; see the wireless notes.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Windows: higher latency, temp files under `%TEMP%`**                                       | Expected                                                                                                                                                    | Windows has no `mkfifo`, so the bridge records to a temp `.wav` and tail-reads it every 100 ms, deleting it on exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 8. Data handling

**What is on disk.** Call recordings are written to
`<baseDir>/recordings/<deviceId>/<callId>.wav` with a `.json` metadata sidecar
beside each. `baseDir` is meant to be `data/`, which is listed in
`.gitignore` — so recordings cannot be committed by accident. Keep it that way
and never point `baseDir` at a tracked directory. Files are created with mode
`0600` and the per-device directory `0700` (ignored on Windows). Call records
(transcripts, state history, outcomes) go to a JSONL store wherever you point
it; treat that file as sensitive too, because it holds what people said.

**What is not on disk.** The AssemblyAI key exists only in the Electron main
process and in Node scripts. The startup banner masks it to its first four
characters; the optional LLM and TTS keys are never printed at all, only
whether they are configured. `.env` is git-ignored — only the placeholder-only
`.env.example` is committed. If a key ever appears in a log, a screenshot or a
committed file, rotate it rather than deleting the file.

**Your obligation as the operator.** Recording phone calls, and transcribing
them through a third-party service, is regulated in many jurisdictions. Rules
differ on whether one party or all parties must consent, on how long recordings
may be kept, and on where they may be processed — `ASSEMBLYAI_REGION` exists so
you can pin data residency to `us` or `eu` rather than accepting geo-routing.
Deciding what applies to you, informing the people on the call, and setting a
retention policy are your responsibility. This document is not legal advice and
nothing in this repository discharges that obligation.
