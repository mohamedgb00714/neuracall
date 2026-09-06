# WhatsApp calls

How NeuraCall knows a WhatsApp call is happening on a phone, why the detector
looks in four different places to find out, and how it places a call it is not
receiving. Everything here is implemented in
`packages/device-manager/src/whatsAppDetector.ts` (detection),
`packages/device-manager/src/voipDialer.ts` (outbound dialling) and covered by
`packages/device-manager/test/whatsAppDetector.test.ts` and
`packages/device-manager/test/voipDialer.test.ts`.

## Supported packages

| Package            | App                   | Notes                                                                                                                              |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `com.whatsapp`     | WhatsApp (consumer)   | `WHATSAPP_APP_ID`                                                                                                                  |
| `com.whatsapp.w4b` | **WhatsApp Business** | `WHATSAPP_BUSINESS_APP_ID`. This is what the realme RMX3624 test device carries, and it is the build most businesses actually run. |

`isWhatsAppPackage()` accepts either, plus anything else under the
`com.whatsapp.` namespace, so a future variant does not need a code change. The
trailing dot is deliberate: a plain `startsWith("com.whatsapp")` would also
swallow unrelated apps such as `com.whatsappstatus.saver`, and a
status-saver in the foreground is not an inbound call.

## Detection: the order of signals

`AdbCallChannelDetector.detect(endpoint)` asks the phone, most trustworthy
signal first, and stops at the first answer. Everything is plain `adb shell`;
no scrcpy session and no APK on the device.

| #   | Signal             | Command                                              | What it settles                                                                                                                    |
| --- | ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Telephony registry | `dumpsys telephony.registry`                         | Authoritative for **cellular**. `mCallState` 1 = ringing, 2 = off-hook. WhatsApp calls never appear here — they are not telephony. |
| 2   | Audio mode         | `dumpsys audio` + `ps -A`                            | `MODE_IN_COMMUNICATION` owned by a WhatsApp package = a WhatsApp call **is up**. On OEMs whose mode stays `NORMAL` all call (realme RMX3624), the transition to watch is `mModeOwnerPid` 0 → <pid> → 0, resolved to a package via `ps -A -o PID,NAME`. |
| 3   | Foreground package | `dumpsys activity activities`, then `dumpsys window` | Is WhatsApp the app on screen? Also decides whether step 4 is worth its cost.                                                      |
| 4   | On-screen text     | `uiautomator dump`, or OCR on a `screencap`          | Distinguishes **ringing** from already-connected. Only a ringing call may be auto-answered. The XML tree does not always see the overlay — see below.                                        |

The result keeps the contract the orchestrator already depends on —
`present` and `channel` mean exactly what they meant before — and adds two
optional fields alongside it:

```ts
{ present: true, channel: "whatsapp", stage: "in-progress", ownerPackage: "com.whatsapp.w4b" }
```

- `stage`: `"ringing"` (safe to answer) or `"in-progress"` (already connected —
  answering again would be a no-op at best).
- `ownerPackage`: which WhatsApp build the call belongs to, when a signal named
  one. Absent for cellular, which has no owning app.

Callers that ignore both behave exactly as they did — with one consequence worth
stating: a call that is _already connected_ now sets `present: true` where it
used to report nothing, and `DeviceManager.detectIncomingCall()` will move such
a device to phase `incoming`. An orchestrator that auto-answers should branch on
`stage === "ringing"` rather than on `present` alone.

### Why the audio mode carries the weight — and its owner pid is the real signal

The UI scrape (step 4) matches strings like `Incoming voice call`, `Accept`,
`Decline`, `is calling` plus French, Spanish, Italian, German, Portuguese and
Arabic equivalents (`Appel vocal entrant`, `RÉPONDRE` / `REFUSER`, `Llamada
entrante`, `مكالمة واردة`, …) — the test handset's UI is French. That is
fragile three ways over: it breaks on a language the list does not cover, it
breaks again whenever WhatsApp reshuffles its call screen, and on some OEMs the
overlay is not in the accessibility tree at all. It is kept only because it is
the one signal that can tell _ringing_ from _connected_.

`dumpsys audio` was supposed to be the locale-independent anchor. A live
WhatsApp call puts the device in `MODE_IN_COMMUNICATION` with the calling
package as mode owner, in English, on every locale and every layout:

```
Mode dump:
- Current mode = MODE_IN_COMMUNICATION
- Mode owner: pid=6543 uid=10235 package=com.whatsapp.w4b
```

That held on an earlier build. **It does not hold on the realme RMX3624 this
project tests against:** the audio mode stays `NORMAL` for the entire call, and
the _only_ thing in `dumpsys audio` that changes is the pid:

    mModeOwnerPid: 0 -> <pid> -> 0

So `mode=MODE_IN_COMMUNICATION` is a per-OEM feature, not a constant, and
detection of a call already in progress is driven by `mModeOwnerPid` instead,
resolved to a package with `adb shell ps -A -o PID,NAME` (on this handset the
pid is `com.whatsapp.w4b`). Two other candidate signals were checked on the
realme and are dead ends: `dumpsys telecom` keeps an **empty** call list
through a WhatsApp call — the call never enters Telecom, and the audio-route
state machine stays Quiescent — and logcat emits no relevant Telecom /
AudioService / setMode lines.

The overlay is not readable by the XML tree either: `uiautomator dump` returns
the focused window (the launcher) even mid-call, byte-identical every second.
The overlay is only visible to the screen — `screencap` captures it and OCR
(tesseract) reads it (live frames read "Appel vocal entrant" and "WhatsApp
Business One"). Treat the accessibility tree as per-OEM unreliable and OCR on a
screencap as the portable way to read overlay content.

`isVoipCallActive(dump)` and `parseAudioModeOwner(dump)` read both the current
mode and the owner pid (`parseAudioModeState()` returns all of it in one pass).
Three details worth knowing:

- **`MODE_IN_COMMUNICATION` only.** `MODE_IN_CALL` is the telephony stack's own
  mode; that is signal 1's business, and treating it as VoIP would mislabel
  every ordinary phone call as WhatsApp.
- **A non-zero owner pid counts the same as the mode.** `isVoipCallActive()`
  treats a pid that is neither empty nor `0` as a VoIP call in its own right —
  that is the entire signal on the realme. An owner that cannot be named either
  way still counts as a call: it reports the generic `voip` channel rather than
  being dropped.
- **History is not current.** The `setMode(...)` event log names every app that
  ever held the mode, so an idle phone can still show `com.whatsapp.w4b` there.
  A current-mode field always wins; the log is walked only when no parseable
  current mode exists.

The field names vary (`Audio mode:`, `- Current mode =`, a bare
`setMode(MODE_IN_COMMUNICATION) from package=…` log line), so the parser tries
each known spelling and, in the log's case, takes the most recent entry. An
unrecognisable dump yields `"unknown"` / `""` — never a guess.

## The OEM variation that hid every WhatsApp call

There is no single dumpsys field that names the foreground package across OEMs
and Android versions. This is not a theoretical worry.

On the **realme RMX3624 (Android 13)** this was developed against,
`dumpsys activity activities` contains **no `mResumedActivity` line at all**.
The original parser looked for that one field, found nothing, returned `""`,
and so WhatsApp was never the foreground app — the detector reported "no call"
through an entire ringing WhatsApp Business call, silently and with no error to
show for it.

What that device does report, from a different service (`dumpsys window`):

```
mCurrentFocus=Window{3939374 u0 NotificationShade}-[Surface(name=*Title#12082)/@0x3906209]
mFocusedApp=ActivityRecord{1b1b769 u0 com.whatsapp.w4b/com.whatsapp.Conversation} t546 d0}
```

Note that `mCurrentFocus` says `NotificationShade` — the call arrived as a
heads-up notification — while `mFocusedApp` correctly names
`com.whatsapp.w4b`. Trusting the wrong one of those two lines is its own bug.

`parseForegroundPackage()` now tries each known field in turn —
`mResumedActivity`, `topResumedActivity`, `ResumedActivity`, `mFocusedApp`,
`mCurrentFocus` — and takes the first that yields a dotted package name.
`dumpsys window` is only queried when the activities dump gave nothing,
because it is a second round-trip.

**If you add a new phone model, check this first.** One command tells you
whether the phone is one of the odd ones:

```bash
adb -s <serial> shell dumpsys activity activities | grep -iE 'resumedactivity'
adb -s <serial> shell dumpsys window | grep -iE 'mFocusedApp|mCurrentFocus'
```

If neither prints a `pkg/activity` pair, the foreground signal is dead on that
device and detection falls back to the audio-mode / owner-pid signal alone —
which still catches a connected call, but not a ringing one.

## READ_CONTACTS on WhatsApp Business

On the same device, WhatsApp Business had:

```
android.permission.READ_CONTACTS: granted=false
```

Consequence: the app had written **no contact-integration rows**. WhatsApp
normally injects a "Voice call" / "Video call" data row
(`vnd.android.cursor.item/vnd.com.whatsapp.voip.call`) into each matching
contact, and the usual trick for placing a WhatsApp call from a script is to
find that row's `_id` and fire an intent at it. With the permission denied
there is nothing to find — the rows do not exist, so that route is simply
unavailable on this phone.

It does not affect **inbound** detection at all: none of the four signals above
touch the contacts provider.

## What NeuraCall can and cannot do with WhatsApp

|                                               | State                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Detect an inbound WhatsApp call, ringing      | **Works** — foreground package + call-screen text (where the OEM's tree exposes the overlay; see below)                         |
| Detect a WhatsApp call already in progress    | **Works** — `dumpsys audio` mode owner, and `mModeOwnerPid` → package on OEMs whose mode stays `NORMAL`                          |
| Tell WhatsApp from cellular                   | **Works** — telephony registry is checked first and wins                                                                         |
| Tell WhatsApp Business from consumer WhatsApp | **Works** — reported as `ownerPackage`                                                                                           |
| Answer an inbound WhatsApp call               | **Works** — tap the accept control on the ringing screen (`VoipAnswerer`); `KEYCODE_CALL` is telephony's answer gesture and WhatsApp ignores it |
| Hang up                                       | **Works** — `KEYCODE_ENDCALL`                                                                                                    |
| **Place an outbound WhatsApp call**           | **Works** — open the conversation by deep link, press the voice-call button (`VoipDialer`). Verified on the realme: end-to-end placement detected as `whatsapp/in-progress`. See below. |

### OCR fallback for answering (when uiautomator is blind)

The ringing overlay is not always the focused window: mid-call `uiautomator dump`
can come back pointing at the underlying app — on the realme it returns the
launcher's tree, byte-identical every second — and a dump with no accept control
cannot be answered by the XML matcher. When the per-poll dump has no button,
answering falls back to the screencap OCR route, one level down:

- `screencap` the ringing screen and run tesseract in TSV mode — `fra` + `eng`,
  `TESSDATA_PREFIX` → `~/.tessdata`.
- Read the accept control as the word bbox of an accept label from the same
  multi-language vocabulary the dump matcher uses (`RÉPONDRE`, `Répondre`,
  `Accept`, `Accepter`, …), decline and quick-reply wording vetoed first exactly
  as in the XML matcher, and tap the bbox centre.
- Engage only as a **fallback per poll**: the dump is tried first, and OCR never
  runs ahead of it, so a healthy tree never pays the OCR cost.

Two boundaries matter. OCR only labels and taps — it never decides presence or
stage. Those stay with the pid/mode detector
(`packages/device-manager/src/whatsAppDetector.ts`) as the source of truth for
whether a call is up and ringing. And the route depends on tesseract being
installed with `eng` + `fra` resolvable; `scripts/check-ocr-env.mjs` verifies the
binary and the tessdata before the fallback is relied on.

The screencap → TSV → word-bbox step lives in
`packages/device-manager/src/ocrStageDetector.ts`, wired into `VoipAnswerer`
through its `ocrFallback` option (`packages/device-manager/src/voipAnswerer.ts`).

### Placing a call: the dial path

WhatsApp publishes no public intent for starting a call, so on-device routes
were evaluated in this order and the implementation chose the one that could be
verified without dialling a live number:

| Route                                        | Evidence on the realme RMX3624                                                              | Verdict                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| Contacts data row (`content://…` row with mime `vnd.android.cursor.item/vnd.com.whatsapp.w4b.voip.call`, handled by `CallContactLandingActivity`) | `dumpsys package com.whatsapp.w4b` lists the intent filter, but `content query … mimetype LIKE '%whatsapp%'` returns **no rows** — the app has no `READ_CONTACTS` sync, so there is nothing to fire the intent at | Unavailable on this device |
| `https://wa.me/<n>?call=true` / `whatsapp://call?phone=` | No `whatsapp://call` authority exists in the intent-filter table, and the `call`-style authorities (`calluser`, `calling`, `call-phone-number`) are resolved **at runtime** by Meta's deep-link router — which cannot be exercised without ringing a real person | Not verifiable without a live dial |
| Deep link to the conversation + tap the call button | `whatsapp://send?phone=<n>` resolves **unambiguously** to `com.whatsapp.w4b/com.whatsapp.TextAndDirectChatDeepLink` (`pm resolve-activity`), and the voice-call button is found by accessibility description in the opened chat | **Chosen** |

The chosen dialer is `VoipDialer` (`packages/device-manager/src/voipDialer.ts`).
The deep link deliberately uses the `whatsapp://send` scheme instead of
`https://wa.me`: on this handset `pm resolve-activity -a android.intent.action.VIEW -d "https://wa.me/<n>"`
returns the system `ResolverActivity` (Chrome is installed and shares the
handler), so `am start` would pop an "Open with" chooser and the call-button
poll would time out. `whatsapp://` is scheme-only WhatsApp, so no chooser can
appear. The exact command the dialer produces is asserted by unit test:

```bash
adb -s <serial> shell am start -a android.intent.action.VIEW -d "whatsapp://send?phone=<digits>"
# then, once the conversation is on screen (polled, up to 12 s):
adb -s <serial> shell input tap <x> <y>       # x,y = centre of the voice-call button
```

`<digits>` is the international form without `+` (a national number is promoted
using the configured country code — `deepLinkDigits`). The button is located by
its **accessibility description** (`Appel vocal` / `Voice call` / `Llamada de
voz` / `مكالمة صوتية` / …), never by fixed coordinates, and the video button is
excluded first so `Appel vidéo` cannot be mistaken for `Appel vocal`. An
unmatched locale fails loudly with the labels it did see rather than tapping
something arbitrary.

The desktop runtime wires this in as `Runtime.dialWhatsApp(deviceId, number, cc?)`
(`apps/desktop/electron/service/runtime.ts` — `cc` overrides the settings
country code): a `VoipDialer` opens the chat by deep link, taps the voice
button, and the device is moved to phase `in-call` the moment the dial is
issued, so STT gating (`canOpenStt`) and the call-state poll treat the outbound
WhatsApp call exactly like a cellular one. The exact `am start` argv and the
`in-call` transition are that dial path's contract, asserted in
`apps/desktop/test/dialWhatsApp.test.ts`.

**How it was verified.** (1) The intent-filter evidence above was read live
from `dumpsys package com.whatsapp.w4b` and `pm resolve-activity` on the
realme. (2) `buildDialCommand` — the pure function that returns the exact
`am start` argv — is covered by `packages/device-manager/test/voipDialer.test.ts`:
`{ args: ["shell","am","start","-a","android.intent.action.VIEW","-d","whatsapp://send?phone=213541685472"] }`,
with the tap asserted against a real chat-screen dump from this handset.
(3) `scripts/place-call.mjs --to=<n> --dry-run` prints the produced link and
exits without dialling. (4) An earlier end-to-end run (commit `2cb949a`) placed
a real call through this same UI-tap flow and the product's own detector saw it
as `whatsapp/in-progress` — which is also the proof for the orchestrator seam
below.

The one step that has **not** been exercised by this change is a live round trip
on a LINE-NEVER test number (a number that provably belongs to no real person,
so the call cannot reach anyone). Dialling a number that could route to a real
contact was deliberately skipped — before shipping, run
`node scripts/place-call.mjs --to=<line-never-number>` against a device and
confirm the call connects, the orchestrator admits it as channel `whatsapp`,
and the hang-up returns the phone to idle.

### Orchestrator seam: a dialled call is admitted as channel `whatsapp`

Outbound uses the **same detector and lifecycle** as inbound, so no change in
`packages/orchestrator/src/orchestrator.ts` was needed. `AdbCallChannelDetector`
names the owner of the audio mode via `mModeOwnerPid` → `ps -A -o PID,NAME`;
on this device an active WhatsApp Business call owns the mode with
`com.whatsapp.w4b`, and `callChannelForOwner("com.whatsapp.w4b")` is `"whatsapp"`
(`packages/device-manager/src/callingApps.ts`). The seam a future outbound-dial
entry point (e.g. an IPC "call this number" handler) must use:

1. `new VoipDialer(runner).call(deviceId, "whatsapp", number)` — the far end
   starts ringing.
2. `orchestrator.handleIncomingCall(deviceId, "whatsapp")` — or simply let the
   running `watch()` loop do it: its `poll()` calls `detector.detect(deviceId)`
   and, on `present && channel`, fires `handleIncomingCall(deviceId, channel)`
   (`orchestrator.ts:244`). The dialled call is already `whatsapp` there.

One honest caveat: `handleIncomingCall` runs the inbound `runCall` pipeline,
which **auto-answers** (`orchestrator.ts:359` `answer()`). For an outbound call
there is no accept button to tap, so `answerVoip` would poll and fail. Anything
that routes _outbound_ dials through this seam must skip the answer step for
the outbound direction (a new flag or a dedicated outbound call path, kept out
of `orchestrator.ts` per this task's constraint) — otherwise the dial starts
but the call is torn down as `failed` ~15 s later. The channel assignment
itself needs no change.

## Checking a device by hand

```bash
# 1. is it there, and which build?
adb -s <serial> shell pm list packages | grep whatsapp

# 2. during a live call — the locale-independent signal
#    MODE_IN_COMMUNICATION on most phones; on the realme the mode stays NORMAL
#    and the only change is mModeOwnerPid (0 -> <pid> -> 0):
adb -s <serial> shell dumpsys audio | grep -iE 'mode owner|current mode|setMode|mModeOwnerPid'
adb -s <serial> shell ps -A -o PID,NAME | grep -E 'whatsapp'

# 3. during a ringing call — foreground app
adb -s <serial> shell dumpsys window | grep -iE 'mFocusedApp'

# 4. permissions, if you are chasing the outbound route
adb -s <serial> shell dumpsys package com.whatsapp.w4b | grep -i READ_CONTACTS
```

Step 2 during a call that the phone is _not_ on will print the historical
`setMode` lines; read `Current mode` — or, on the realme-class OEMs, `0` under
`mModeOwnerPid` — not the log.

## Phone QA harness (Realme RMX3624 / Android 13 / French UI)

The ad-hoc live scripts behind the findings above are now a permanent harness in
`scripts/`, with detection semantics unchanged:

| Script                          | What it does                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scripts/live-capture.mjs`      | Per-tick detection poll under a real call: verdict (present/channel/stage/ownerPkg), audio mode + `mModeOwnerPid` → package, a screencap, a uiautomator XML dump, and the telecom/logcat change tapes per tick, plus a `timeline.txt` and a final call-state summary. |
| `scripts/inject-loopback-test.mjs` | Plays a 440 Hz tone on the host speaker and compares phone-mic energy (captured via scrcpy) across baseline / injection / post windows. |
| `scripts/qa-run-all.mjs`        | Runs the detection poll then the loopback on one serial and prints a combined PASS / INCONCLUSIVE report.                     |

One CLI contract across the three:

- `--device=SERIAL` (default: the first device adb reports online), duration as
  `--seconds` / `--duration`, and `--json=PATH` to also write a
  machine-readable summary. The same JSON object is always printed as the last
  stdout line.
- Exit codes: `0` = PASS, `1` = INCONCLUSIVE (ran, but no call seen / no clear
  coupling — the honest verdict on this bench), `2` = HARD ERROR (no device,
  adb unusable, transport did not start).
- `--help` on any of the three prints the one-screen usage.

### Detection run procedure

1. Start the harness first and give it a wide enough window:
   `node scripts/live-capture.mjs --device=<serial> --seconds=30`. It prints
   `CALL NOW`.
2. From a second handset, place a **real WhatsApp Business call** to the test
   phone (inbound, so no READ_CONTACTS/outbound caveat applies).
3. Expect, at some tick N within the window: `present=true`,
   `channel=whatsapp`, `stage=in-progress`, and `ownerPkg=com.whatsapp.w4b`.
   The audio mode reads `NORMAL` (internal and external — the realme never
   enters `MODE_IN_COMMUNICATION`) and `mModeOwnerPid` is non-zero the whole
   call, resolved via `ps -A -o PID,NAME`. Exit `0` = PASS.
4. Loop ends with no call seen → exit `1` INCONCLUSIVE (retry; the window may
   have missed the caller). Exit `2` = the device/adb leg failed, fix the
   environment first.

Known-good reference — the **2026-09-05T18-37-06-907Z** capture run:

```
t+009 state=idle present=true channel=whatsapp stage=in-progress ownerPkg=com.whatsapp.w4b |
      modeInt=NORMAL modeExt=NORMAL owner="" pid=2446(com.whatsapp.w4b) focus=?
```

Detection went `present=false` for ticks 0–8 and flipped to `present=true` at
t+009; that exact shape (false…false → true once the call connects, mode stays
NORMAL, pid goes 0 → 2446) is the regression signature.

### OCR-dict frame check

`uiautomator dump` on this OEM is per-OEM unreliable: the tree stays the
launcher's byte-identical dump even mid-call. The overlay is only visible to the
screen, so the check is OCR on a screencap, not the XML:

- Read the t+NNN_ui.xml from the capture: if it is still the launcher tree while
  the call is up, that is expected on the realme — do not read it as "no call".
- OCR the t+NNN_screen.png (tesseract). Known-good French labels from the
  **2026-09-05T18-25-22-761Z** capture frames: `Appel vocal entrant`, `Refuser`,
  `Balayer vers le haut pour accepter`, and the callee line `WhatsApp Business
  One`. Any of `Appel vocal entrant` (ringing) / the swipe-up hint / the RÉPONDRE
  or REFUSER controls reading back is a pass for the ringing screen.

### Injection loopback procedure + expected outcome

1. Put the test handset near the host speaker (this bench's layout: phone a few
   centimetres from the speaker grille).
2. `node scripts/inject-loopback-test.mjs --device=<serial> --duration=4`.
3. It warms the scrcpy mic link for ~2 s of silence, injects a 440 Hz tone
   through the same transport the agent's voice uses (aplay/ffplay), then
   compares RMS across baseline / injection / post windows and prints the ratio
   and tone byte count.

Expected outcome: the **transport runs** — frames arrive from the mic and the
summary shows non-zero `baselineRms`/`injectionRms`. A `> 2x` rise during the
tone is `0` PASS. The coupling ratio is environment-dependent (speaker volume,
phone-to-speaker distance, OEM mic gains), so a low ratio is a legitimate
`1` INCONCLUSIVE — **not a failure** (on this bench it reports ~1.1x
persistently; `postRms` staying at the same floor as the tone is the tell that
the room, not the tone, dominates the measurements). Only exit `2` (no frames at
all, scrcpy did not start) is a real regression.

### dumpsys-telecom / logcat dead-ends — do not gate on them

On the realme a WhatsApp call never enters Telecom: `dumpsys telecom` shows an
empty `mCalls` list with the audio-route machine stuck at
`QuiescentEarpieceRoute` for the whole call, and logcat emits no Telecom /
AudioService / `setMode` lines (see the `t+NNN_telecom.txt` / `t+NNN_logcat.txt`
tapes in the 18-37 capture — they exist precisely to show the vacuum). The
live-capture harness still dumps both per tick so a change on a new OEM is not
silently missed, but the assertion to watch for this device is the
`mModeOwnerPid` pivot in `dumpsys audio`, not anything in Telecom.
