# The AssemblyAI Voice Agent path

NeuraCall has two ways to hold a conversation. This document is about the second
one, and about why it exists.

## Two pipelines

The **composed pipeline** is the original: AssemblyAI Universal-Streaming for
speech-to-text, an LLM behind `LLM_API_KEY`, and a separate TTS provider. Three
vendors, three credentials, three failure modes, and latency that is the sum of
all of them.

The **Voice Agent pipeline** replaces all three with one WebSocket to
`agents.assemblyai.com`. Audio goes in, the agent's speech comes back, and the
transcription, the language model and the synthesis all happen inside the
service. It needs exactly one credential — the AssemblyAI key that NeuraCall
already requires for transcription — and it works with no `LLM_API_KEY` and no
local TTS engine installed.

That last point is the reason it was built. Before it, a NeuraCall deployment
could transcribe a call but could not speak on one without an operator sourcing
two more API keys or installing `espeak-ng`. Now the default configuration can
answer a call out of the box.

The composed pipeline is still the right choice when the model matters — when
you want a specific frontier model, your own prompt-side tooling, or a TTS voice
the Voice Agent API does not offer. Neither is deprecated.

## The constraint that will bite you

**Input audio must be PCM16 mono at exactly 24 000 Hz.**

This is not a preference. An agent created with an input `sample_rate` of 16000
or 8000 accepts the connection, accepts `session.update`, and then fails the
instant the session starts with:

```json
{"type":"session.error","code":"internal_error","message":"Internal service error"}
```

followed by a WebSocket close 1011. Nothing in that message mentions audio, the
sample rate, or the agent's configuration. It reads exactly like a service
outage, and it is reproducible on demand: 8000 fails, 16000 fails, 24000
succeeds.

NeuraCall captures call audio at 16 kHz, which is the rate the composed pipeline
and the recording format use. So every byte crossing this boundary is resampled
— 16 kHz up to 24 kHz on the way in, 24 kHz back down to 16 kHz on the way out
to the injector. That is what `Pcm16Resampler` in `@neuracall/audio-pipeline`
exists for, and why it carries its fractional phase across chunks rather than
resampling each chunk independently: at 20 ms chunks, a per-chunk reset puts a
discontinuity into the stream fifty times a second, which is audible as a buzz.

## BYO LLM only works on a stored agent

A custom LLM cannot be configured on the wire. Sending an `llm` block in
`session.update` is rejected:

```json
{"code":"invalid_value",
 "message":"BYO LLM config is not allowed on session.update; define it on a stored agent via POST /v1/agents"}
```

So a custom model means creating a stored agent through
`POST /v1/agents` and connecting with its `agent_id`. Inline session
configuration is fine for everything else — system prompt, greeting, voice, turn
detection — but not for the model.

Note that the service's own default LLM needs no `llm` block at all, and that is
the path that works on an account without LLM Gateway model access.

## The voice lives in a different place on each transport

`POST /v1/agents` takes the voice at the top level, as an object:

```json
{ "name": "...", "system_prompt": "...", "voice": { "voice_id": "alba" } }
```

`session.update` takes it under `output`, as a bare string:

```json
{ "type": "session.update",
  "session": { "system_prompt": "...", "output": { "voice": "alba" } } }
```

Sending the first shape on the wire is rejected with
`{"code":"invalid_format","message":"Invalid message format for type
'session.update'"}` — which names no field, so it tells you nothing about which
of the six keys it disliked. Since the stored-agent shape is the one most people
meet first, writing it here is the obvious mistake, and it fails identically to
a dozen unrelated typos.

`VoiceAgentInlineConfig` therefore takes `voice` as a plain string at the top
level and `normalizeInlineConfig` moves it under `output`, so one spelling works
whichever transport is in use and the object form is a compile error.

Incidentally, omitting the voice entirely is valid: the service defaults to
`anna`, not to `alba`.

## Wire details worth writing down

The first frame after the socket opens **must** be `session.update`, and
`agent_id` and inline configuration are mutually exclusive within it. Audio may
only be sent after `session.ready`.

The agent's speech arrives as `reply.audio` with the base64 payload in a field
named **`data`** — not `audio`, which is the field name used when *sending*
audio. Getting this backwards produces a session that appears to work and is
silent.

`DELETE /v1/agents/{id}` returns **204 with an empty body**. Parsing that as
JSON throws.

A dropped connection can be recovered with `session.resume` for **30 seconds**,
after which the session is gone.

## Voices

Sixteen voices across six spoken languages, though the agent *recognises*
eighteen. English: `alba`, `eve`, `george`, `jane`, `jean`, `mary`, `michael`
(US) and `anna`, `charles`, `paul`, `vera` (UK). Then `giovanni` (Italian),
`lola` (Spanish), `juergen` (German), `rafael` (Portuguese), `estelle` (French).

There is no Arabic voice. For an Algerian deployment the agent will understand
Arabic and French input but can only answer in one of the six.

The voice is fixed once a session is established and cannot be changed
mid-conversation.

## What this still does not solve

The Voice Agent API closes two of the three gaps between "NeuraCall runs" and
"the caller hears an AI": it generates the reply, and it speaks it.

It does not close the third. Getting that audio into a live cellular or WhatsApp
call is a transport problem on the handset, not an API problem — `scrcpy` can
capture a call's audio but cannot inject into its uplink, and no `adb` command
can either. See [AUDIO-ABI.md](AUDIO-ABI.md) for the injection transports and
[RUNBOOK.md](RUNBOOK.md) for pairing a Bluetooth hands-free unit, which is the
supported route.
