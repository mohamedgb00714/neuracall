# Tasks

## Current Tasks

### Phase 2: Call audio recording — capture phone audio to disk alongside live STT [PENDING]

**ID:** `403c3502-20f8-490b-9555-bfe1d72df79a`
**Priority:** high | **Type:** coding

Record each answered call's audio to disk (e.g. WAV in the per-call audio directory) while the same stream is being fed to live realtime transcription, so there is a replayable artifact per call.

Scope:

- In the audio-pipeline (or a thin recorder wrapper), tee each admitted silent-free segment: one copy to the realtime client for live STT, one copy to a per-call WAV writer.
- Write 16-bit mono PCM at 16 kHz WAV (with a proper 44-byte RIFF header) into data/recordings/<deviceId>/<callId>.wav, flushing periodically and finalising the header on call end.
- Include call metadata (deviceId, channelId, local/remote party label, timestamps) alongside, e.g. data/recordings/<deviceId>/<callId>.json.
- Disk-safety: bound the max recording length, fail loudly if the target is unwritable, never buffer an unbounded amount in memory (stream to disk).

Done:

- A call that goes through the pipeline produces a playable WAV file whose audio matches what was transcribed live, plus its metadata JSON.
- Unit test: a synthetic mono 16k PCM buffer written through the recorder yields a valid WAV (RIFF/WAVE header + correct PCM sample count) and the metadata file.

Out of scope here: post-call transcript/summary generation (that is the optional pre-recorded path task f4c80243). This task is purely the raw-audio capture side.

---

### Phase 6: CRM — contact store + call-history linking in the desktop app [PENDING]

**ID:** `aa429a33-e531-4695-b9a8-76fa8d51b70e`
**Priority:** medium | **Type:** coding

Add a lightweight CRM to the NeuraCall desktop app so every call is tied to a known contact/customer and the context is queryable and reusable, not just a raw transcript.

Scope (first vertical slice, keep pragmatic):

- Contact store: a local SQLite-backed repository (contacts + orgs, phone numbers, tags, notes). Seeded from the device's contact list where possible (via ADB dump or manual import).
- Call linking: when a call is answered, match the remote number to a contact (exact or fuzzy/normalized match) and attach the contact to the call record alongside its transcript.
- Call history: persist per-call records (deviceId, channelId, direction, timestamps, contactId, transcript, audio path). Queryable by contact and by date.
- Dashboard: a Contacts/Calls view in the React renderer that lists contacts and their call history, with links through to the recorded audio + transcript.
- Data flow: all reads/writes go through the Electron main-process Service (IPC), never the renderer directly; the renderer only gets DTOs.

Done:

- A contact can be created, listed, and linked to a call (renderer view + IPC + store).
- Two calls from the same normalized number group under one contact in the history view.
- Unit tests for the store (contact create/find, call insert, group-by-contact query) using an in-memory/DB.

Out of scope for this task: two-way sync with Google/Outlook contacts, CRM as a separate web/mobile surface, pipelines into external CRMs (HubSpot, etc.), and automated follow-up/lead scoring — those are follow-ups.

---

### Phase 0: Project scaffolding — Node.js/TypeScript monorepo + config [IN_PROGRESS]

**ID:** `14f440c2-a9ba-4845-8d3b-3a0ab3a50d89`
**Priority:** high | **Type:** coding

Scaffold the NeuraCall backend as a TypeScript Node.js project. Set up: package.json, tsconfig, ESLint/Prettier, .env.example with ASSEMBLYAI_API_KEY + ASSEMBLYAI_REGION (us/eu), a scripts/ dir for ADB/scrcpy tooling, and a README. Use pnpm or npm workspaces to split concerns into: device-manager, audio-pipeline, aai-client, whatsapp, orchestrator, dashboard. Done: `npm run build` compiles, `npm run lint` passes, `.env.example` documents every env var used across the repo.

---

### Phase 0: Verify AssemblyAI live docs and pin SDK version [PENDING]

**ID:** `f10175ef-a233-485d-9ae6-b2eabfc70951`
**Priority:** high | **Type:** documentation

Before writing any A2I code, fetch the current live docs (llms.txt / llms-full.txt and the streaming + pre-recorded references) to confirm the exact parameter names and SDK API for the models we target. Verify: speech_model (realtime singular) vs speech_models (pre-recorded plural array), realtime token endpoint shape, PCM16 requirements, and that the `assemblyai` npm package current version exports the streaming transcriber API we plan to use. Record findings in a docs/DECISIONS.md so later tasks don't re-derive it. Done: DECISIONS.md lists verified model strings, param names, and the exact SDK major version pinned in package.json.

---

### Phase 0: Set up AssemblyAI API key + region config in env [PENDING]

**ID:** `9749a28b-3850-4762-8395-5cee532975ed`
**Priority:** high | **Type:** coding

Document and wire the ASSEMBLYAI_API_KEY and base-URL selection (US api.assemblyai.com vs EU api.eu.assemblyai.com) through a config module shared by all services. No key in source; only env. Add validation that fails fast at startup if the key/region is missing or misconfigured. Done: config module reads both vars, picks the right base URL for REST, realtime WS, and token minting, and logs a startup banner with region.

---

### Phase 1: Wireless ADB bootstrap script (one-time USB handshake + reconnect helpers) [IN_PROGRESS]

**ID:** `35589d9a-8d6a-4a72-9599-6a52d9af1c0f`
**Priority:** high | **Type:** coding

Write scripts/adb-setup.sh that: (1) detects connected USB devices, (2) runs `adb tcpip 5555`, (3) reads each device's Wi-Fi IP, (4) `adb connect <ip>:5555`, (5) verifies with `adb devices`, (6) saves the connected endpoint(s) to a devices.json the device-manager reads. Include a `adbtool reconnect --all` that re-runs connect for known IPs (they drop after phone reboot). Handle multiple phones. Done: with phones on the Wi-Fi, `./scripts/adb-setup.sh` lists them as wireless and writes/updates devices.json.

---

### Phase 1: Device manager service — enumerate, heartbeat, state tracking [COMPLETED]

**ID:** `e321d519-caee-48fd-a8a0-954a349088e6`
**Priority:** high | **Type:** coding

A device-manager Node service that: (1) reconciles the pool against `adb devices` on a poll or event loop, (2) tracks per-device state (online / offline / in-call / busy), (3) exposes a small HTTP or in-process API for other services to request a free device for a call and to mark a call started/ended, (4) writes state to a SQLite DB (better-sqlite3) so the dashboard can read it. Done: `adb devices` state is reflected in the DB and a unit test proves a device moves online->in-call->online through the API.

---

### Phase 1: Call control adapter — answer, hang up, dial via ADB keyevents [COMPLETED]

**ID:** `d752a3a6-3420-4719-ae35-273c1fa5003d`
**Priority:** high | **Type:** coding

Abstract call control behind an interface: ICallController with answer()/hangUp()/dial(number)/mute()/unmute()/currentState(). Implement AndroidCallController using `adb -s <endpoint> shell input keyevent` (5 = answer/call, 6 = end, plus for dialing open the dialer/keyevents for digits). Include guards: refuse to answer on a device that is in-call elsewhere; timeouts so keyevents don't hang. Done: a stub test (or a real device call) proves answer and hang-up drive the phone between ringing and idle states.

---

### Phase 1: scrcpy audio bridge — stream phone mic/call audio to a per-device virtual cable [WAITING_FOR_REVIEW]

**ID:** `054835f6-973c-4e23-aa03-cb4bc2ac8d3d`
**Priority:** high | **Type:** coding

For each device, launch `scrcpy -s <endpoint> --no-video --audio-source=mic` (and a second capture for call/speaker when feasible) and route the resulting ALSA/PulseAudio stream to a dedicated per-device virtual audio sink so the audio-pipeline can pull it. Provide scripts/audio-attach.sh and audio-detach.sh that set up/destroy the virtual cable and capture, and a test assertion that a tone played on the phone reaches the sink. Handle 2.4 vs 5 GHz jitter note in README. Done: running the attach script on one device yields an active audio sink whose level meters move when the phone plays sound.

---

### Phase 2: Audio pipeline — pull PCM from each sink, resample to 16 kHz mono PCM16 [COMPLETED]

**ID:** `72df25a5-a7bf-43c6-8867-b39693dd861d`
**Priority:** high | **Type:** coding

An audio-pipeline service that, per active device, captures the stream from the per-device virtual sink, resamples to 16 kHz single-channel signed 16-bit little-endian PCM (audio-pipeline must not assume the sink rate), and yields fixed ~50–100 ms chunks (~800 samples). Use a suitable Node audio capture + soxr/wasapi/ALSA source. Chunk boundaries must be stable for AssemblyAI. Done: a unit test feeds a synthetic sine at 48 kHz in and asserts the output is 16 kHz mono PCM16 with the expected chunk size and duration, with no dropped/aligned-sample errors.

---

### Phase 2: Dual-stream handling — remote party vs local mic/call audio [PENDING]

**ID:** `ef829ced-344e-41fe-ab05-d5497872a973`
**Priority:** high | **Type:** coding

Design the audio layout for a real phone call: we need the remote (caller) audio for STT and usually our own agent voice injected to the phone. Resolve and implement how scrcpy/audio capture exposes the two directions (mic-source vs device output) and how the pipeline labels each stream so the orchestrator can send the remote-party PCM to AssemblyAI and mix the agent's TTS reply back into the phone's input. Document the ABI assumptions. Done: each in-call device exposes two clearly-labelled streams (remoteIn, localOut) through the pipeline API, and a test verifies labels and that remoteIn feeding an echo yields the expected captured text path.

---

### Phase 2: VAD/activity gating in the pipeline (only send speech to A2I) [COMPLETED]

**ID:** `6f297b6c-126b-40e7-824c-3afe00c4b241`
**Priority:** medium | **Type:** coding

Add lightweight voice-activity detection in the audio-pipeline so we only send meaningful speech chunks to AssemblyAI (saves API volume/charges and reduces false positives). Implement a simple energy- or zero-crossing-based gate with configurable threshold, plus optional silence-frame suppression. Escalate real decision logic to the orchestrator. Done: with silence input the pipeline emits no speech frames; with speech it emits frames; a unit test covers both plus a trailing-silence case.

---

### Phase 3: aai-client — realtime STT wrapper (U3.5 Pro) with token minting + lifecycle [PENDING]

**ID:** `48f65544-d468-484f-8fd1-406484778e5d`
**Priority:** critical | **Type:** coding

Wrap the current AssemblyAI Node SDK (verified against live docs in Phase 0) in an aai-client service exposing: mintRealtimeToken(deviceId) (server mints a short-lived temp token), openStream({deviceId, speechModel:'universal-3-5-pro', mode:'balanced'}), feedPcm(chunk), finalTurn() event stream, close({terminate:true}) that always sends Terminate, and robust reconnect. Wire sample_rate=16000 PCM16. Keep the API key server-side only. Done: unit/integration test with a recorded audio fixture transcribes into a final Turn via the SDK's streaming client, and a close() test proves Terminate is sent (no dangling billable session).

---

### Phase 3: Dual-session STT — run concurrent streams per device (one per simultaneous call) [PENDING]

**ID:** `cb2ed508-97d6-4070-9b73-6d821672e589`
**Priority:** critical | **Type:** coding

Because NeuraCall handles real cellular AND WhatsApp calls simultaneously, multiple realtime STT sessions may be active per device or across devices at once. Design the aai-client to manage N concurrent streams keyed by (deviceId, channelId), isolates their event routing, and bounds total concurrent sessions against AssemblyAI limits (3009 too-many-sessions) with a queue. Done: a stress test opens 4 concurrent streams and routes each final Turn to its own (deviceId, channelId) handler without cross-talk.

---

### Phase 3: Handle realtime events — Turn, SpeechStarted, SpeakerRevision, Termination, close codes [PENDING]

**ID:** `3bdcb0c9-4abf-4424-8722-5704a96b8318`
**Priority:** high | **Type:** coding

Implement the full realtime event contract: emit SpeechStarted, route Turn (partial vs final via end_of_turn) to the orchestrator, apply SpeakerRevision (match turn_order, replace speaker labels on final words), honor Termination, and map WebSocket close codes (1008 auth, 3005 cancelled, 3006 invalid msg, 3007 chunk size/rate, 3008 session expired, 3009 too many sessions) to typed errors with reconnect/backoff policy. Done: unit tests stub each message type and assert correct downstream routing and that 3007 triggers chunk-size correction rather than a crash.

---

### Phase 3: Turn-taking biasing — agent_context + keyterms_prompt via UpdateConfiguration [PENDING]

**ID:** `5c52e33d-63f3-457c-8189-444f184f2867`
**Priority:** high | **Type:** coding

Integrate agent_context to bias the next user turn with the agent's last spoken reply (accuracy win for short replies/account numbers), and keyterms_prompt for names/SKUs. Push updates mid-session with UpdateConfiguration after each agent turn, per-device. Done: an integration test verifies an UpdateConfiguration with agent_context is sent and (with real A2I) improves transcription of a follow-up short utterance.

---

### Phase 3: Optional pre-recorded path — post-call transcripts via /v2/transcript + LLM Gateway summaries [PENDING]

**ID:** `f4c80243-8724-42c3-81ea-ded19e0b1dd3`
**Priority:** medium | **Type:** coding

For post-call analytics, capture the per-call remote audio to file and optionally submit to the pre-recorded API (speech_models:['universal-3-5-pro','universal-2'], speaker_labels) then run LLM Gateway for a summary/chapters (transcribe first, POST transcript text to llm-gateway; no deprecated auto_chapters/summarization). Keep the key proxied server-side. Done: a captured call file produces a completed transcript with speaker_labels and a Gateway summary in the dashboard record.

---

### Phase 4: WhatsApp voice-call detection + routing (per device via ADB/UIAutomator) [PENDING]

**ID:** `2e9f4efa-58a0-4c25-aa9c-8f08dcc5a0a1`
**Priority:** high | **Type:** coding

NeuraCall receives WhatsApp voice calls on the hijacked phones. Detect an incoming WhatsApp call via adb (dumpsys/UIAutomator text or scrcpy visual) and route it like a cellular call: grab the stream, feed remote audio to STT, and inject agent audio back. Provide scripts/warn/detect call state. Distinguish WhatsApp vs cellular so the orchestrator can label the channel. Done: with a real incoming WhatsApp call the device-manager reports channel='whatsapp' and state='incoming' before auto-answer proceeds.

---

### Phase 4: WhatsApp text-message inbound/outbound via WhatsApp Web/desktop bridge [PENDING]

**ID:** `3150e78e-215d-453e-a16d-e6bd9b28d369`
**Priority:** low | **Type:** coding

Layer on the WhatsApp Cloud API or a WhatsApp Web/DOM bridge so the same agent line also answers/sends text messages, sharing the conversation state with voice calls on the same number when practical. Scope: inbound text -> orchestrator -> AI reply -> outbound text. Keep it optional/pluggable. Done: a text inbound mocked end-to-end produces an outbound AI reply through the orchestrator, and a state flag marks it as text vs voice channel.

---

### Phase 5: Orchestrator — per-call state machines (idle->incoming->answered->talking->ended) [PENDING]

**ID:** `38ba36b1-6f4d-48df-ac02-fb6c9a421510`
**Priority:** critical | **Type:** coding

Central orchestrator that owns the lifecycle of each call: acquires a free device, waits for inbound (cellular or WhatsApp), on detection answers via the call controller, opens the A2I stream, routes final Turns to the agent, injects agent replies, then hangs up and closes the stream (always Terminate) on end. Maintain a per-call state machine and persist call records (device, channel, timestamps, transcript, outcome) to the DB. Done: an end-to-end integration test runs a full mocked call cycle and asserts the state machine passes through all states and cleanly closes the A2I session at the end.

---

### Phase 5: AI agent brain — final-turn intake, LLM reply, barge-in handling, per-channel context [PENDING]

**ID:** `8815d807-b2fe-40a7-ae49-f85b8a05aa2e`
**Priority:** high | **Type:** coding

The agent logic: on each final Turn, feed it plus keep the per-call conversation context (voice and text share it). Send to the configured LLM (OpenRouter/Anthropic) for a reply, inject as TTS into the phone. Handle barge-in: if a new user final turn arrives while the agent is speaking, interrupt the current reply and respond to the user. Maintain per-(device,channel) context windows. Done: an integration test has user 'final', agent reply, then user interrupts mid-reply, and asserts the agent switches to the new user input and the prior reply is cancelled.

---

### Phase 5: TTS + audio injection into the phone (agent voice plays back on the call) [PENDING]

**ID:** `0d64c17e-b083-4744-9da2-ca3c0ffc3b85`
**Priority:** high | **Type:** coding

Stand up the TTS pipeline (provider of choice, e.g. ElevenLabs/OpenAI/Play.ht) to turn agent replies into PCM, then inject that audio back into the phone call through the per-device virtual cable so the caller hears the agent. Ensure resampling to the phone's input rate and no pops/gaps (write to an OS buffer, not sleep-timed). Done: an integration/device test proves that a TTS reply routed into the injected stream is audible on the receiving party's end of a real call, with the VAD/agent_context-biased STT loop closed end-to-end.

---

### Phase 6: Test harness + QA suite (component + end-to-end stubs) [PENDING]

**ID:** `8637c1d6-4745-472b-924b-3da55d3a4b1f`
**Priority:** high | **Type:** testing

Stand up the automated test layer: unit tests for every service (device-manager, audio-pipeline resample/VAD, aai-client event handling, orchestrator state machine, agent barge-in), plus integration tests that stub A2I/TTS/ADB with recorded fixtures so the whole call loop is testable offline. Define `npm test` (unit) and `npm run test:e2e` (integration with stubs). Done: CI or `npm test` runs green, and `test:e2e` passes a full mocked-call scenario.

---

### Phase 6: Resilience — reconnect/backoff, capacity queue, watchdog, observability [PENDING]

**ID:** `44712cc2-6de8-4e69-9de6-b9f0adc9ebf2`
**Priority:** high | **Type:** coding

Production resilience: (1) A2I stream reconnect with exponential backoff for 5xx/WS drops, respect 429 Retry-After, bounded retries; (2) a session queue so requests exceed concurrency limits wait instead of failing (3009); (3) a watchdog that tears down and restarts hung calls/sessions (and always Terminates stray A2I sessions to avoid the 3-hour billable cap); (4) structured logging + counters (calls handled, transcript turns, errors) into a metrics/health endpoint for the dashboard. Done: fault-injection tests prove reconnect, queueing, and watchdog teardown behave, and /health exposes the counters.

---

### Phase 6: Dashboard — live device/call/transcript view + call history [PENDING]

**ID:** `47fad924-c3f6-43e8-8a2a-fcaac540cf0f`
**Priority:** medium | **Type:** coding

A simple web dashboard (reads the SQLite DB/metrics API) showing: device pool status, current/active calls with live partial transcripts, per-call history (transcript, summary, outcome), and aggregate stats. No API key exposed to the browser — the dashboard reads from the server API only. Done: dashboard renders live per-device state and a full call record after a completed test call.

---

### Phase 6: Documentation — runbook, config reference, multi-device/5GHz Wi-Fi notes [PENDING]

**ID:** `cccb4640-09fc-4c78-8a12-5ae845c97a6c`
**Priority:** medium | **Type:** documentation

Write README + docs/: architecture overview, runbook (startup order: adb-setup -> audio-attach -> services -> dashboard), .env reference, AssemblyAI gotchas we hit (Bearer vs raw key, speech_models vs speech_model, Terminate-required, WebSocket close codes), and the 5 GHz/static-IP/powered-USB production notes from the wireless plan. Done: a fresh developer can bootstrap NeuraCall and run a test call following only the docs.

---

---

_Last updated: 2026-08-31T13:58:35.073Z_
_Managed by autoplans.dev_
