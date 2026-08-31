# AssemblyAI integration decisions

Verified against the live documentation on **2026-08-31**. This file exists so
later work does not re-derive any of it, and so a wrong assumption is a
documented mistake rather than a rediscovered one.

Sources checked:

- <https://www.assemblyai.com/docs/speech-to-text/universal-streaming>
- <https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures>
- <https://www.assemblyai.com/docs/api-reference/transcripts/submit>
- <https://www.assemblyai.com/docs/streaming/updating-configuration-mid-stream>
- <https://www.assemblyai.com/docs/streaming/universal-3-5-pro/context-carryover>
- <https://www.assemblyai.com/docs/api-reference/specs/streaming.yaml> (AsyncAPI)
- npm registry metadata for the `assemblyai` package

---

## 1. `speech_model` vs `speech_models` — the trap this document exists for

**They are different parameters on different APIs, and both are correct.**

| API | Parameter | Type | Value we use |
| --- | --- | --- | --- |
| Realtime (v3 streaming WebSocket) | `speech_model` | **singular string** | `universal-3-5-pro` |
| Pre-recorded (`POST /v2/transcript`) | `speech_models` | **plural array** | `["universal-3-5-pro", "universal-2"]` |

Getting this backwards fails in the least helpful way possible: the realtime
socket accepts the connection and then behaves as though you never asked for
the model. **Always check `Begin.configuration.model` against the model you
requested** rather than assuming the query string took effect — `BeginMessage`
carries `configuration` for exactly this reason.

On the pre-recorded API the singular `speech_model` still exists in the schema
but is deprecated; `speech_models` replaced it. Diarization is `speaker_labels`
(boolean, requires `punctuate: true`); `speaker_options` / `speakers_expected`
give finer control.

> **Correction (2026-08-31, from AssemblyAI's own integration guide):** omitting
> `speech_models` does **not** default to the current flagship. The server
> applies `["universal-3-pro", "universal-2"]` — note *3-pro*, not *3-5-pro*. So
> the pre-recorded path **must set `speech_models` explicitly** to
> `["universal-3-5-pro", "universal-2"]` or it silently runs a older model. The
> API reference page reads as though 3.5 is the default; it is not. Treat this
> as the pre-recorded twin of the realtime `Begin.configuration.model` check.

Two more limits corrected from the same source: on realtime, `prompt` and
`agent_context` cap at roughly **1500** characters (not 1750), and
`end_of_turn_confidence` is **binary** on U3.5 Pro (`1.0` at end of turn, `0.0`
otherwise) — it is not a graded score, so no threshold logic should be built on
it. `format_turns` and `end_of_turn_confidence_threshold` are ignored by U3.5
Pro entirely; they belong to the older `universal-streaming-*` models.

## 2. Verified realtime model strings

- `universal-3-5-pro` — what NeuraCall uses. The features the agent loop depends
  on are Pro-only: `agent_context`, `prompt`, `mode`, `interruption_delay`,
  `continuous_partials`, `language_codes`, and the `SpeechStarted` message.
- `universal-2` — pre-recorded fallback in the `speech_models` array.

The default lives in one place, `DEFAULT_SPEECH_MODEL` in `@neuracall/config`,
overridable with `ASSEMBLYAI_SPEECH_MODEL`.

## 3. Audio contract

- **Encoding:** mono 16-bit PCM by default (`pcm_s16le`). Also accepted:
  `pcm_mulaw`, `opus`, `ogg_opus`, `aac`. AAC is self-describing (ADTS headers
  carry the rate); for PCM, `sample_rate` must match the source.
- **Sample rate:** `sample_rate=16000`, matching what the audio pipeline emits.
- **Chunk duration: 50–1000 ms.** Outside that range the server closes with
  **3007**. NeuraCall sends 100 ms chunks (3200 bytes at 16 kHz mono PCM16) —
  deliberately mid-range so the 3007 correction can halve the chunk size and
  still be legal.
- **Never send audio faster than real time**, and never let more than 5 minutes
  buffer server-side. Both also close with 3007. This is why the pipeline is
  driven by capture timing rather than a tight loop.

## 4. WebSocket close codes

Mapped to typed errors in `packages/aai-client/src/types.ts`
(`RealtimeCloseCode`) with a reconnect policy per code.

| Code | Meaning | NeuraCall's response |
| --- | --- | --- |
| 1000 | Normal — follows `Termination` | Expected; no reconnect |
| 1006 | Abnormal (no close frame) — network drop | Reconnect with backoff |
| 1008 | Missing/invalid token, account issue, new-session rate limit | Do **not** retry blindly; surface a config error |
| 1011 | Server error while establishing the connection | Reconnect with backoff |
| 3005 | Session cancelled — catch-all server error | Reconnect with backoff |
| 3006 | Invalid message type / malformed JSON / inactivity timeout | Bug or idle session; do not hammer |
| 3007 | Chunk outside 50–1000 ms, or audio sent too fast | Halve the chunk size and reconnect — never crash |
| 3008 | 3-hour cap (or the temp token's `max_session_duration_seconds`) | Expected on very long calls; open a fresh session |
| 3009 | Too many concurrent sessions | Queue rather than fail — see §6 |
| 410 | The V2 streaming endpoint is retired | Never use V2 |

## 5. `Terminate` is mandatory, and it is a billing decision

The session bills on **wall-clock connection time**, not audio duration, up to a
**3-hour cap**. Dropping the socket without sending `{"type":"Terminate"}`
leaves it open and billable. `Termination` reports
`session_duration_seconds` — the billed figure.

Everything in NeuraCall is arranged around this: `RealtimeStream.close()`
sends `Terminate` and waits (bounded) for `Termination`;
`RealtimeSessionManager.close()`/`closeAll()` always terminate; and the
orchestrator routes **every** exit path — normal hangup, agent error, socket
drop, a phone that never answered — through one guarded `teardown()` so no
failure can skip the close.

## 6. Auth and endpoints

- **Server-side:** the raw API key in the `Authorization` header on upgrade.
  **No `Bearer ` prefix** — `@neuracall/config` rejects a key with one at
  startup, because the failure mode otherwise is an opaque 1008 mid-call.
- **Token minting:** `POST /v3/token` served by the **realtime host**, not the
  REST host. Temp tokens go in the `?token=` query string; the API key is never
  put in a URL.
- **Regions:** `us` → `api.assemblyai.com` / `streaming.us.assemblyai.com`;
  `eu` → `api.eu.assemblyai.com` / `streaming.eu.assemblyai.com`; `edge`
  (default) → US REST plus geo-routed `streaming.assemblyai.com`. Derived in
  one place, `endpointsForRegion()`.
- **Concurrency:** exceeding the concurrent-session limit closes with 3009, so
  `RealtimeSessionManager` bounds sessions and **queues** callers in FIFO order
  instead of racing them into a rejection.

## 7. Mid-stream configuration

`UpdateConfiguration` is a **delta** — send only the fields being changed.
The ones that matter to the agent loop:

- `agent_context` (Pro only, max 1750 chars) — the agent's last spoken reply,
  pushed after each agent turn. This is the accuracy win on short caller
  replies ("yes", an account number) that have little context of their own.
- `keyterms_prompt` — **replaces** the current list (max 100 terms, ≤50 chars
  each; `[]` clears it). It is not additive.
- `prompt`, `mode`, `min_turn_silence`, `max_turn_silence`, `vad_threshold`,
  `interruption_delay`, `continuous_partials`.

## 8. SDK decision: raw `ws`, not the `assemblyai` package

**Verified:** `assemblyai@4.37.0` (current `latest` on npm as of 2026-08-31)
does export a v3 streaming client — `StreamingTranscriber`, alongside the
deprecated `RealtimeTranscriber` — and its bundled types reference `v3/ws`,
`speech_model`, and `universal-3-5-pro`. The SDK would work.

**NeuraCall nonetheless talks to `/v3/ws` directly over `ws@^8.18.0`**
(pinned in `packages/aai-client/package.json`). The reasons, in order of weight:

1. **Termination and close-code handling are the most cost-sensitive code in
   the system.** A session dropped without `Terminate` bills for hours. We want
   that logic — and the per-close-code reconnect policy in §4 — to be ours,
   explicit, and unit-tested, not delegated to a dependency's internals.
2. **Testability.** `RealtimeStream` takes an injectable `WebSocketFactory`, so
   the entire protocol — every message type, every close code, a 4-way
   concurrent-session stress test — is exercised offline against `mockA2I`
   with no network, no key and no spend. That is what makes the whole call loop
   testable in CI.
3. **Protocol surface moves faster than SDK releases.** `agent_context`,
   `keyterms_prompt` and `mode` are exactly the parameters we tune; sending
   query params and `UpdateConfiguration` deltas ourselves means a new field is
   available immediately.

**Validated against the real service on 2026-08-31.** AssemblyAI's own guidance
warns that hand-rolled integrations usually fail at exactly WebSocket lifecycle
and session termination, so this decision was smoke-tested rather than assumed:
`scripts/live-stt-smoke.mjs` streamed a real fixture to
`streaming.us.assemblyai.com` and got `Begin` (with `configuration.model`
echoing `universal-3-5-pro`), `SpeechStarted`, partial and final `Turn`s, a
correct transcript, then `Terminate` → `Termination` → close 1000 with billing
stopped. `scripts/live-call-smoke.mjs` does the same with real scrcpy phone
audio. Re-run both after any change to `RealtimeStream`.

**The cost of this decision:** we own protocol drift. The mitigation is that
`packages/aai-client/src/types.ts` mirrors the AsyncAPI spec field for field
with the source URL on every block, and this file records what was verified and
when. **If AssemblyAI changes the v3 protocol, this is the code that breaks** —
re-verify against §1–§7 before assuming a bug is ours.

Should we later prefer the SDK, pin `assemblyai@^4.37.0`; the migration is
`RealtimeStream` only, since nothing above it touches the wire format.

## 9. Deprecated — do not use

- **V2 streaming** (`/v2/realtime/ws`): retired; closes with 410.
- **`RealtimeTranscriber`** in the SDK: superseded by `StreamingTranscriber`.
- **`auto_chapters` / `summarization`** on the pre-recorded API: replaced by
  transcribing first and POSTing the transcript text to the LLM Gateway.
- **`speech_model` (singular) on the pre-recorded API**: use `speech_models`.
- **`language_code` (singular)** on realtime: use `language_codes`.
