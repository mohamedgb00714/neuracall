# Call audio ABI

How NeuraCall gets the caller's voice off a phone and the agent's voice back
onto it, and which of those assumptions are guaranteed versus discovered at
runtime. Written for whoever has to debug a call where "the agent can't hear
anything" or "the caller can't hear the agent".

## The two directions

A call has two audio paths and they are not symmetric. NeuraCall models them as
two labelled streams on a `CallAudioSession`
(`@neuracall/audio-pipeline`, `src/dualStream.ts`):

| Label      | Direction    | Carries               | How it moves                                                                                                   |
| ---------- | ------------ | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `remoteIn` | far end → us | what the caller says  | **captured** off the phone with scrcpy, then resampled + VAD-gated and fed to AssemblyAI and the call recorder |
| `localOut` | us → far end | the agent's TTS voice | **injected** into the call through an `AudioInjector`                                                          |

Every chunk leaving `remoteIn` is a `CallAudioChunk` tagged with
`direction`, `deviceId`, `callId` and `channelId`, so one sink can serve
several concurrent calls and still route correctly. This labelling is the whole
point of the abstraction: feed the wrong direction to STT and the agent
transcribes itself, then answers its own last sentence.

## `remoteIn`: capture

### Format contract

- **Off the phone:** scrcpy with `--audio-codec=raw --record-format=wav` emits
  **48 kHz stereo signed 16-bit little-endian** PCM inside a WAV stream whose
  header carries placeholder sizes. `ScrcpyBridge` parses the header and calls
  `sink.format(fmt)` once with the real values before the first `push()`.
- **Into STT:** `RemoteInStream` resamples to **16 kHz mono PCM16** and emits
  fixed **100 ms** chunks (3200 bytes), which sits inside AssemblyAI's
  50–1000 ms window with room for the 3007 chunk-size correction to halve it.
- `RemoteInStream` does **not** assume the source rate. It starts on
  `SCRCPY_DEFAULT_FORMAT` (48 kHz stereo) and rebuilds its pipeline when
  `format()` reports something else, including mid-stream.
- Only 16-bit input is decodable. A source reporting anything else is
  **rejected** rather than adopted — decoding 24-bit as Int16 turns the rest of
  the call into noise, which is far worse than a loud failure. The rejection
  surfaces on `remoteIn.formatError` and through `onFormatError`.

### Which scrcpy source actually carries the caller

This is the least portable part of the system. `--audio-source` maps onto
Android's `MediaRecorder.AudioSource` constants, and the call-specific ones
require the privileged `CAPTURE_AUDIO_OUTPUT` permission. scrcpy's server runs
via `shell`, which holds that permission on some builds and not others.
**Whether a source works is a per-OEM, per-Android-version fact that can only
be discovered by trying it.**

So `remoteIn` has an ordered preference list
(`@neuracall/scrcpy-bridge`, `src/callAudio.ts`), best first:

1. **`voice-call-downlink`** — exactly the far end and nothing else. What we
   want. Privileged; often unavailable.
2. **`voice-call`** — both directions mixed. Works more often, but the agent
   hears itself, so turn-taking has to tolerate the echo (see below).
3. **`output`** — everything the device plays: the caller on speakerphone plus
   any notification sound.
4. **`mic`** — the phone's microphone. Picks up the far end only acoustically
   via speakerphone, along with the room. Noisy and echo-prone; last resort.

`CaptureSourceSelector` walks this list: `next()` gives the source to try,
`fail(reason)` advances after a capture failure. Passing an explicit override
pins a single source and disables fallback — for an operator who knows what
their hardware supports and would rather fail than silently degrade to room
audio.

### Echo: the duplex-source problem

`voice-call`, `mic` and `output` are **duplex** (`isDuplexSource()`): the
agent's own voice comes back in on `remoteIn`. Nothing downstream can tell that
audio apart from the caller's by content alone. When the active source is
duplex, one of these must be true or the agent will transcribe itself and
answer its own sentences:

- mute or gate `remoteIn` while `localOut.isSpeaking`, or
- rely on `agent_context` biasing plus barge-in detection to discard turns that
  match what the agent just said.

With `voice-call-downlink` the problem does not arise, which is why it is first.

## `localOut`: injection

Injection is the direction Android actively resists: there is no supported way
for an adb-shell process to write into the call uplink. **scrcpy cannot do
this** — it is a capture and control tool, and no `--audio-source` value plays
audio _into_ the phone. So `localOut` is deliberately behind an interface:

```ts
interface AudioInjector {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  write(pcm: Uint8Array): void;
  cancel?(): void; // barge-in: drop what is queued
  end?(): void;
}
```

`LocalOutStream` converts TTS PCM to exactly the injector's rate and channel
count before calling `write`, so injectors never resample. Known transports,
in rough order of fidelity:

- **Bluetooth HFP** — pair the host to the phone as a hands-free device; the
  phone treats the host as its headset, so the host's output _is_ the call
  uplink. Best quality, needs a working BlueZ/HFP stack.
- **On-device helper app** — an APK holding `MODIFY_AUDIO_SETTINGS` that plays
  into the call. Reliable but requires installing software on every phone.
- **Acoustic coupling** — a speaker next to the phone's mic. Always works,
  sounds like it.

Until Phase 5 wires a real one, `MemoryAudioInjector` stands in: calls run
end-to-end and the far end simply hears nothing. That is intentional — a
missing injector must not stop the transcription path from being exercised.

### Barge-in

`localOut.cancel()` bumps a generation counter and calls `injector.cancel?.()`.
TTS arrives in chunks over time, so audio for an utterance the caller has
already interrupted can still be in flight; passing the generation token to
`speak()` makes those late chunks drop instead of playing over the caller.
An injector that cannot flush its queue may omit `cancel()`, at the cost of the
agent talking over the caller until its buffer drains.

## Assumptions worth re-checking

These are the things most likely to be wrong on a phone that misbehaves:

1. scrcpy raw audio is 48 kHz stereo s16le. Verified on scrcpy 3.3.4; the
   pipeline no longer depends on it, but the defaults do.
2. `voice-call-*` sources may be silently denied rather than erroring — a
   capture that starts and produces only silence should be treated as a
   failure and fall back.
3. Capturing call audio is regulated in many jurisdictions and both parties may
   need to be informed. That is a deployment obligation, not a technical one,
   and this document does not discharge it.
