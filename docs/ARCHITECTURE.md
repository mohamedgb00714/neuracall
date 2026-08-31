# Architecture

How NeuraCall is put together: which package owns what, the path a single call
takes from ring to record, and where the process boundaries fall.

Two companion documents carry detail deliberately left out here:
[AUDIO-ABI.md](AUDIO-ABI.md) for the audio contract in both directions, and
[DECISIONS.md](DECISIONS.md) for everything verified about the AssemblyAI
protocol.

---

## 1. The package graph

Dependencies only point downward. Nothing below depends on anything above it,
which is what lets the whole call loop be exercised without hardware.

```
                       apps/desktop  (Electron main + React renderer)
                              │
        ┌─────────────┬───────┴────────┬──────────────────┐
        │             │                │                  │
   aai-client   device-manager   scrcpy-bridge         config
        │             │                │                  │
        │             │           audio-pipeline           │
        │             │                │                  │
        └─────────────┴────────┬───────┴──────────────────┘
                               │
                         orchestrator ◄──────── agent
                               │                  │
                               └────────┬─────────┘
                                        │
                                       e2e   (test-only: composes all of it)
```

`apps/desktop` currently depends on `config`, `aai-client`, `device-manager`
and `scrcpy-bridge` — **not** on `orchestrator` or `agent`. The full
answer-and-reply loop exists as a library and is covered end to end by
`packages/e2e`, but the desktop app has not been wired to it yet. That is the
single biggest gap between "the code can do it" and "the app does it".

| Package | Owns | Notably does **not** own |
| --- | --- | --- |
| `@neuracall/config` | `.env` loading, fail-fast validation of `ASSEMBLYAI_API_KEY`, region → REST/realtime/token endpoints in one place, the masked startup banner. | Anything provider-specific beyond AssemblyAI. |
| `@neuracall/audio-pipeline` | Pure PCM: downmix, linear resample, chunking, `EnergyVad`. `CallAudioSession` with its two labelled streams. `CallRecorder` (streaming WAV + JSON sidecar). `tee`. | Any process, socket or file descriptor it did not open itself. No native code. |
| `@neuracall/aai-client` | The realtime v3 WebSocket, hand-rolled on `ws`: `RealtimeStream` (connect, `sendAudio`, `UpdateConfiguration`, explicit `Terminate`), `RealtimeSessionManager` (bounded concurrency with a FIFO queue), close-code → retry policy with jittered backoff, temporary-token minting. | Audio conversion. It receives chunks already in the contract format. |
| `@neuracall/scrcpy-bridge` | One `scrcpy` process per phone, WAV-header parsing, the FIFO (Linux/macOS) and temp-file (Windows) transports, `adb`/`scrcpy` detection with per-OS install guides, and the ordered capture-source preference list. | Deciding *when* to capture. |
| `@neuracall/device-manager` | `adb devices` polling, USB vs Wi-Fi endpoints, device phase (`online`/`incoming`/`in-call`/`busy`/`offline`), `AndroidCallController` (answer, hang up, dial, DTMF, call state via `dumpsys telephony.registry`), `AdbCallChannelDetector` (cellular vs WhatsApp), `devices.json`. | Audio, in any form. |
| `@neuracall/orchestrator` | The call lifecycle. `CallStateMachine`, `Orchestrator`, `ScrcpyAudioCapture`, `CommandAudioInjector`, `MemoryCallRecordStore` / `JsonlCallRecordStore`. | The conversation. It calls a `CallAgent` interface. |
| `@neuracall/agent` | The brain: `LlmCallAgent`, `ConversationStore`, the `LlmClient` and `TtsClient` ports, `OpenAiCompatibleLlmClient`, and abort-driven barge-in. | Audio transport. It returns PCM and text; the orchestrator plays it. |
| `@neuracall/e2e` | Composing the real stack with fakes only at its outer edges (adb, the A2I socket, scrcpy, the LLM, TTS). | Anything shipped. Test-only, no `dist/`. |
| `@neuracall/desktop` | Electron main process runtime (device pool, session manager, per-device capture, call control), IPC, and the React control centre. | The AssemblyAI key ever reaching the renderer. |

Everything external — HTTP, child processes, clocks, the filesystem root, the
WebSocket factory — is injectable. That is not stylistic: it is what makes
`npm test` and `npm run test:e2e` run in CI with no device, no API key and no
spend.

---

## 2. The path of one call

```
  ring        AdbCallChannelDetector polls the phone. `dumpsys telephony.registry`
              is authoritative for cellular; otherwise, if WhatsApp is the
              resumed package AND the UI dump matches an incoming-call screen,
              the channel is "whatsapp".
                │
  detect        Orchestrator.poll() sees a device that is `device` + online and
                not already on a call, and starts handleIncomingCall().
                State: idle → incoming.
                │
  answer        CallController.answer() (a KEYCODE_CALL keyevent). The device
                phase becomes in-call.  State: incoming → answered.
                │
  STT first     The realtime session is opened BEFORE capture, so no far-end
                audio is ever produced with nowhere to go. A failure here aborts
                the call rather than leaving a phone answered into silence.
                │
  capture       ScrcpyAudioCapture walks the source preference list
                (voice-call-downlink → voice-call → output → mic) until one
                actually produces audio within startTimeoutMs. A denied
                privileged source does not always fail loudly — it can start and
                sit silent forever — so the deadline is the real defence.
                │
  pipeline      RemoteInStream: 48 kHz stereo s16le (whatever the WAV header
                really says) → 16 kHz mono → fixed 100 ms chunks (3200 bytes).
                A tee fans each chunk out to STT and, when recording is on, to
                the CallRecorder. A recorder that fails is dropped from the tee;
                it is not a reason to hang up on a caller.
                │
  STT           RealtimeStream sends chunks at capture pace — never faster than
                real time, or the server closes 3007. Partial turns drive the
                live UI; only final turns reach the agent.
                │
  agent         LlmCallAgent.onFinalTurn(). Every turn runs under an
                AbortController: a new turn aborts the previous one first, and a
                turn that finds itself superseded returns null instead of a
                stale reply. State: answered → talking on the first real media.
                │
  TTS           TtsClient.synthesize() → PCM. Today the only implementation is
                SilentTts, which returns the right *duration* of silence so
                pacing is realistic and nothing is heard.
                │
  inject        LocalOutStream converts to the injector's rate and channel count
                and writes. `agent_context` is pushed to AssemblyAI with the
                reply text even when there is no audio — that is what makes the
                caller's next short answer ("yes", an account number)
                transcribe correctly.
                │
  barge-in      A final caller turn arriving while localOut.isSpeaking cancels
                the utterance: the generation counter bumps, late TTS chunks are
                dropped, and the injector's queue is flushed.
                │
  hang up       Either the agent sets hangUp, or the 2 s call-state poll sees
                the far end gone, or an error fires. All three land in the same
                place.  State: → ended (terminal, reachable from anywhere).
                │
  teardown      One guarded path, every step independent so a failure cannot
                skip the ones after it: stop capture → close the audio session →
                finalise the recording → **close the realtime session with
                Terminate** → hang up → release the device → persist the record.
                │
  record        CallRecord (transcript, state history, outcome, audioPath) is
                upserted to the store repeatedly *during* the call, so a crash
                mid-call still leaves evidence of how far it got.
```

Two properties are load-bearing and worth stating on their own:

**`ended` is reachable from every state.** That is what lets teardown be
unconditional. Whatever went wrong — the phone refused the answer keyevent, the
caller gave up while ringing, the socket died — the cleanup runs.

**Teardown always sends `Terminate`.** AssemblyAI bills wall-clock connection
time up to a 3-hour cap, so a socket dropped without `Terminate` keeps billing.
This is the most cost-sensitive line in the system; see DECISIONS.md §5.

---

## 3. The two audio directions

They are not symmetric, and conflating them is the classic failure: feed the
wrong direction to STT and the agent transcribes itself, then answers its own
last sentence.

| Stream | Direction | Carries | Mechanism |
| --- | --- | --- | --- |
| `remoteIn` | far end → us | the caller | **Captured** with scrcpy, resampled, VAD-aware, fed to STT and the recorder |
| `localOut` | us → far end | the agent | **Injected** through an `AudioInjector` — scrcpy cannot do this |

Every chunk leaving `remoteIn` is tagged with `direction`, `deviceId`, `callId`
and `channelId`, so one sink can serve several concurrent calls and still route
correctly.

Capture is a discovery problem, not a configuration one. `--audio-source` maps
onto Android's `MediaRecorder.AudioSource` constants; the call-specific ones
need the privileged `CAPTURE_AUDIO_OUTPUT` permission, which scrcpy's
shell-run server holds on some builds and not others. Whether a source works is
a per-OEM, per-Android-version fact that can only be found by trying it — hence
the ordered fallback rather than a single hard-coded value.

`voice-call`, `output` and `mic` are **duplex**: the agent's own voice comes
back in on `remoteIn`, and nothing downstream can tell it from the caller's by
content. With a duplex source active you must either gate `remoteIn` while
`localOut.isSpeaking`, or rely on `agent_context` biasing plus barge-in to
discard turns that match what the agent just said.

Injection has no adb or scrcpy mechanism at all. It is always "play PCM to some
audio device on this host, and arrange for the phone to be listening to it" —
Bluetooth HFP, an on-device helper app, or acoustic coupling. Full treatment in
[AUDIO-ABI.md](AUDIO-ABI.md).

---

## 4. Process boundaries

### Electron main vs renderer

```
  ┌────────────────────── Electron MAIN process ────────────────────────┐
  │  .env → getConfig()          ASSEMBLYAI_API_KEY lives ONLY here     │
  │  Runtime:                                                           │
  │    RealtimeSessionManager  ──► wss://streaming.*.assemblyai.com     │
  │    DeviceManager           ──► execFile("adb", ...)                 │
  │    AndroidCallController   ──► adb shell keyevent / intents         │
  │    DeviceAudioCapture      ──► spawn("scrcpy", ...)                 │
  └────────────┬────────────────────────────────────┬───────────────────┘
               │ ipcMain.handle(...)                │ webContents.send(...)
               │  commands in                       │  events out
  ┌────────────┴────────────────────────────────────┴───────────────────┐
  │  PRELOAD  (contextIsolation: true, nodeIntegration: false)          │
  │  contextBridge exposes exactly `window.neuracall` — a fixed list of  │
  │  channels. No `require`, no Node, no arbitrary IPC.                 │
  └────────────┬────────────────────────────────────────────────────────┘
               │
  ┌────────────┴────────────────────────────────────────────────────────┐
  │  RENDERER  (React)                                                   │
  │  Device list, call buttons, Listen/Stop, live transcript.            │
  │  Receives: turns, session end/error, device + phase + call state,    │
  │            capture status and scrcpy log lines.                      │
  │  Sends:    start/stop session, dial/answer/hangup, reconnect, checks.│
  └──────────────────────────────────────────────────────────────────────┘
```

**Why the key never crosses.** The renderer is a browser context. Anything
handed to it is reachable from DevTools, from any dependency running in that
context, and from any page it is ever pointed at. So the main process exposes
*capabilities*, not credentials: "start a session for this device and channel"
crosses the bridge, the key that authorises it does not. The renderer cannot
open a socket to AssemblyAI even if it wanted to, because it has nothing to
authenticate with.

Two supporting details: the startup banner masks the key to its first four
characters (`maskApiKey`), and the optional LLM/TTS keys are never printed at
all — only whether they are configured. And IPC handlers wrap failures into
`{ ok, error }` data rather than letting an exception cross as an opaque IPC
error, so a bad `.env` produces a message in the status bar instead of a dead
window.

### Other boundaries

- **adb** — every invocation goes through `execFile` (no shell) and is scoped
  with `-s <endpoint>`. One short-lived process per command, so adb's state
  machine stays simple and no descriptor is left open.
- **scrcpy** — one long-lived child per phone, audio-only. Its stdout is
  unusable (banner and adb output land there), so audio is recorded to a real
  FIFO on Linux/macOS and tail-read from a temp `.wav` on Windows.
- **The audio player** (injection) — a short-lived child reading raw PCM from
  stdin. `cancel()` kills it and the next write starts a new one, because a
  player gives no way to flush its own buffer and killing it is cheaper than
  letting the agent talk over the caller.
- **AssemblyAI** — one WebSocket per `(deviceId, channelId)`. The session
  manager bounds concurrency and queues callers FIFO rather than racing them
  into a 3009 rejection.

---

## 5. Persistence

| What | Where | Format |
| --- | --- | --- |
| Wireless adb endpoints | `devices.json` at the repo root | versioned JSON, written atomically by `scripts/adb-setup.sh` and read by `devicesFile.ts` |
| Call records | wherever the store is pointed | `JsonlCallRecordStore` — append-only JSON Lines; the last entry for a `callId` wins, so a crash mid-call is survivable and replaying into SQLite later is trivial |
| Call audio | `<baseDir>/recordings/<deviceId>/<callId>.wav` + `.json` | 16-bit mono PCM RIFF/WAVE, header sizes patched on every flush so the file is playable even if the process dies |

`baseDir` is meant to be `data/`, which is git-ignored. Files are created 0600
and the per-device directory 0700. Never point `baseDir` at a tracked
directory.
