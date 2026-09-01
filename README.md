# NeuraCall

An AI voice agent that answers calls on **real Android phones** instead of a
VoIP trunk. It drives the phones over `adb`, pulls call audio out with
`scrcpy`, streams it to AssemblyAI's realtime v3 API, hands each finished turn
to an LLM, and records the whole thing. One host can run several phones at
once, on cellular and on WhatsApp.

There is no SIP, no carrier integration and no number porting. The phone that
rings is the phone your customers already call.

---

## What actually works today

Be straight about this before you plan anything around it.

|                                                                                  | State                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover and drive phones over adb (USB + Wi-Fi), answer / hang up / dial / DTMF | **Works**                                                                                                                                                                                               |
| Detect an inbound call and tell cellular from WhatsApp                           | **Works** (adb telephony dump + foreground-app/UI heuristic)                                                                                                                                            |
| Capture the call audio with scrcpy, resample it, feed AssemblyAI realtime        | **Works** — subject to which `--audio-source` your phone allows                                                                                                                                         |
| Live transcript, per phone and per channel                                       | **Works** (desktop app)                                                                                                                                                                                 |
| Record the call to a WAV + JSON sidecar as it happens                            | **Works** (library; not wired into the desktop app)                                                                                                                                                     |
| Think: LLM reply per finished caller turn, with barge-in cancellation            | **Works** (library; OpenAI-compatible / OpenRouter by default)                                                                                                                                          |
| Speak: turn that reply into audio                                                | **Works** via the AssemblyAI Voice Agent — transcription, reply and voice over one socket on the key you already have. On the composed path, `TtsClient` still needs a provider or it stays `SilentTts` |
| **Make the caller hear it**                                                      | **Needs a transport you set up yourself** — see below                                                                                                                                                   |
| Desktop app running the full answer→reply loop                                   | **Works**, opt-in. Autopilot is off until an operator turns it on, and answers inbound calls only                                                                                                       |
| CRM / contacts / SQLite history                                                  | **Works.** Electron 37 bundles Node 22, so `node:sqlite` is there; the append-only JSONL store remains the fallback for any runtime without it                                                          |

### The limitation that matters

NeuraCall can listen, transcribe, think, speak and record. What it cannot do on
its own is make the person on the other end **hear** the agent, and that is not
a missing function call — it is an Android platform problem.

The distinction matters because the two halves fail identically from the
outside. Generating speech is solved: turn on the Voice Agent
([docs/VOICE-AGENT.md](docs/VOICE-AGENT.md)) and `node scripts/live-voice-agent.mjs`
will hold a full conversation against the real service, with no extra
credentials. Getting that audio into a live call is the part below.

`scrcpy` is a capture and control tool. No `--audio-source` value plays audio
_into_ a call, and there is no supported way for an adb-shell process to write
into the call uplink. So the agent's voice has to reach the phone by some
out-of-band transport:

- **Bluetooth HFP** — pair the host to the phone as a hands-free device; the
  host's HFP output _is_ the call uplink. Best quality, needs a working BlueZ
  stack and a one-time pairing per phone.
- **An on-device helper app** — an APK holding `MODIFY_AUDIO_SETTINGS` that
  plays into the call. Reliable, but you install software on every phone.
- **Acoustic coupling** — a speaker next to the phone's microphone. Always
  works, sounds like it, leaks room noise into the call.

The code side is ready for all three: `AudioInjector` is an interface, and
`CommandAudioInjector` already plays PCM to a named host audio sink (`pw-play`
/ `paplay` / `aplay`), which is what a Bluetooth HFP sink or a speaker looks
like. What is missing is the operator-side setup and the app wiring.

Read **[docs/AUDIO-ABI.md](docs/AUDIO-ABI.md)** before you argue with any of
this — it is the whole story, both directions, with the per-OEM caveats.

---

## Quickstart (about 5 minutes)

Node 20+, plus `adb` and `scrcpy` on `PATH`. An Android 11+ phone with USB
debugging on. An AssemblyAI API key.

```bash
git clone <this repo> neuracall && cd neuracall
npm install
cp .env.example .env          # then set ASSEMBLYAI_API_KEY
npm run build                 # every package must be built before anything imports it
```

Prove it works **without a phone, a key or a single cent of spend**:

```bash
npm test          # unit tests, every package
npm run test:e2e  # the whole call loop against fakes: ring → answer → STT → agent → record
```

Then plug a phone in and go live:

```bash
./scripts/adb-setup.sh        # USB handshake → wireless adb → devices.json
adb devices                   # must show your phone as `device`

cd apps/desktop
env -u ELECTRON_RUN_AS_NODE npx electron .
```

> The `env -u ELECTRON_RUN_AS_NODE` is not optional decoration. VS Code's
> terminal exports `ELECTRON_RUN_AS_NODE=1`, which makes the Electron binary
> behave as plain Node — no window opens and you get a confusing crash inside
> `import "electron"`. This bites everyone once.

Press **Listen** on a phone, talk into it, and the transcript appears.

For anything beyond this — install per platform, phone prep, the smoke tests,
production Wi-Fi, and what to do when it breaks — go to the runbook.

---

## Where to go next

| Document                                         | For                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[docs/RUNBOOK.md](docs/RUNBOOK.md)**           | Getting a real call answered on real hardware: install, phone prep, startup order, verification, troubleshooting by symptom, data handling. Start here.    |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | What each package owns, the path a call takes end to end, and where the process boundaries are.                                                            |
| **[docs/AUDIO-ABI.md](docs/AUDIO-ABI.md)**       | The two audio directions, the capture-source fallback chain, echo on duplex sources, and why injection is hard.                                            |
| **[docs/DECISIONS.md](docs/DECISIONS.md)**       | Verified AssemblyAI facts: `speech_model` vs `speech_models`, close codes, why `Terminate` is a billing decision, why we hand-rolled the WebSocket client. |
| **[scripts/README.md](scripts/README.md)**       | `adb-setup.sh` and `adbtool.sh` in detail.                                                                                                                 |
| `.env.example`                                   | Every environment variable, what reads it, and its default.                                                                                                |

---

## Repository layout

```
neuracall/
├── packages/
│   ├── config/          .env loading, fail-fast validation, region → endpoints
│   ├── aai-client/      AssemblyAI realtime v3 over raw ws: stream, session manager, backoff
│   ├── audio-pipeline/  PCM helpers, resampler, VAD, dual-stream call audio, WAV recorder
│   ├── scrcpy-bridge/   one scrcpy process per phone, WAV parsing, tool detection
│   ├── device-manager/  adb polling, device phases, call control, WhatsApp detection
│   ├── orchestrator/    the call lifecycle: answer → capture → STT → agent → teardown
│   ├── agent/           the brain: LLM + TTS ports, conversation state, barge-in
│   └── e2e/             the whole stack against fakes — no device, no key, no spend
├── apps/desktop/        Electron 37 + Vite + React control centre
├── scripts/             adb bootstrap, live smoke tests
└── docs/                the four documents above
```

Every package is ESM, compiles with `tsc` into `dist/`, and siblings consume
that `dist/`. **After changing a package, rebuild it** or the consumer sees
stale declarations.

## Commands

All from the repository root.

| Command                           | Does                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| `npm run build`                   | Compiles every package, then the desktop main process and renderer.      |
| `npm test`                        | `node --test` in every package that has tests (offline).                 |
| `npm run test:e2e`                | The mocked full-call suite in `packages/e2e` (offline).                  |
| `npm run typecheck`               | `tsc --noEmit` everywhere. Build changed packages first.                 |
| `npm run lint` / `npm run format` | ESLint flat config / Prettier.                                           |
| `npm run dev:desktop`             | Vite dev server for the renderer only — it does **not** launch Electron. |
| `npm run build:desktop`           | Desktop app only (packages must already be built).                       |

Per workspace: `npm test -w @neuracall/audio-pipeline`, and so on. Tests use
Node's built-in `node:test`; no test framework is installed.

## Security and legal, in one breath

The AssemblyAI key lives in the Electron main process only — the renderer runs
with `contextIsolation: true` and gets a narrow IPC surface, so transcripts and
device state flow out and commands flow in, but the key never crosses. `.env`
is git-ignored; `.env.example` holds placeholders only. Every realtime session
is closed with an explicit `Terminate`, because AssemblyAI bills wall-clock
connection time.

Recordings are call audio. They land under `data/` (git-ignored, files 0600,
directories 0700). **Recording calls is regulated in many jurisdictions and
often requires informing both parties.** That is your obligation as the
operator; nothing in this repo discharges it, and this is not legal advice.

Pressing **Call** in the desktop app dials a real number on a real SIM. Treat
the app like a phone.
