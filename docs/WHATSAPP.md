# WhatsApp calls

How NeuraCall knows a WhatsApp call is happening on a phone, why the detector
looks in four different places to find out, and what it still cannot do
(spoiler: it cannot _place_ one). Everything here is implemented in
`packages/device-manager/src/whatsAppDetector.ts` and covered by
`packages/device-manager/test/whatsAppDetector.test.ts`.

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
| 2   | Audio mode         | `dumpsys audio`                                      | `MODE_IN_COMMUNICATION` owned by a WhatsApp package = a WhatsApp call **is up**.                                                   |
| 3   | Foreground package | `dumpsys activity activities`, then `dumpsys window` | Is WhatsApp the app on screen? Also decides whether step 4 is worth its cost.                                                      |
| 4   | On-screen text     | `uiautomator dump` + `cat`                           | Distinguishes **ringing** from already-connected. Only a ringing call may be auto-answered.                                        |

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

### Why the audio mode carries the weight

The UI scrape (step 4) matches strings like `Incoming voice call`, `Accept`,
`Decline`, `is calling`. That is fragile twice over: it breaks on a phone set
to French, Arabic or anything else, and it breaks again whenever WhatsApp
reshuffles its call screen. It is kept only because it is the one signal that
can tell _ringing_ from _connected_.

`dumpsys audio` depends on neither. A live WhatsApp call puts the device in
`MODE_IN_COMMUNICATION` with the calling package as mode owner, in English, on
every locale and every layout:

```
Mode dump:
- Current mode = MODE_IN_COMMUNICATION
- Mode owner: pid=6543 uid=10235 package=com.whatsapp.w4b
```

`isVoipCallActive(dump)` and `parseAudioModeOwner(dump)` read exactly that
(`parseAudioModeState()` returns both in one pass). Two details worth knowing:

- **`MODE_IN_COMMUNICATION` only.** `MODE_IN_CALL` is the telephony stack's own
  mode; that is signal 1's business, and treating it as VoIP would mislabel
  every ordinary phone call as WhatsApp.
- **The mode gates the owner, not the reverse.** `dumpsys audio` keeps a
  `setMode(...)` history, so an idle phone still names `com.whatsapp.w4b` as
  the last app to have held the mode. A call is only reported when the _current_
  mode is `MODE_IN_COMMUNICATION`.

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
device and detection falls back to the audio mode alone — which still catches
a connected call, but not a ringing one.

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
| Detect an inbound WhatsApp call, ringing      | **Works** — foreground package + call-screen text                                                                            |
| Detect a WhatsApp call already in progress    | **Works** — `dumpsys audio` mode owner                                                                                       |
| Tell WhatsApp from cellular                   | **Works** — telephony registry is checked first and wins                                                                     |
| Tell WhatsApp Business from consumer WhatsApp | **Works** — reported as `ownerPackage`                                                                                       |
| Answer an inbound WhatsApp call               | **Works** — `KEYCODE_CALL`, the same key press as cellular; WhatsApp registers its calls with telecom, so the key reaches it |
| Hang up                                       | **Works** — `KEYCODE_ENDCALL`                                                                                                |
| **Place an outbound WhatsApp call**           | **Not implemented** — see below                                                                                              |

### Placing a call is not implemented, and it is not a missing function call

WhatsApp publishes no intent for starting a call. `https://wa.me/<number>` and
`whatsapp://send?phone=` open a _chat_, not a call; there is no documented,
supported URI that dials. The two routes that exist in practice are both
awkward:

1. **The contacts data row.** Query the contact for its WhatsApp voice-call
   row and `am start` an `ACTION_VIEW` on that row's URI. Requires that
   WhatsApp holds `READ_CONTACTS`, that the number is saved as a contact, and
   that WhatsApp has finished syncing it — none of which held on the test
   device (see above). It also breaks whenever WhatsApp changes its MIME types.
2. **UI automation.** Drive the app with `input tap` / `uiautomator` through
   search → contact → call button. Locale-dependent, layout-dependent, and
   exactly the kind of scraping this detector is trying to move _away_ from.

Neither is in the codebase. An operator who needs outbound WhatsApp today has
to, in order:

1. Grant WhatsApp `READ_CONTACTS`
   (`adb shell pm grant com.whatsapp.w4b android.permission.READ_CONTACTS`)
   and let the app resync — the rows appear only after a sync.
2. Save every callee as a device contact, in the international format WhatsApp
   matched them by.
3. Verify by hand that a call-capable data row exists, e.g.
   `adb shell content query --uri content://com.android.contacts/data --where "mimetype LIKE '%whatsapp%'"`.
4. Accept that step 3 has to be re-verified after every WhatsApp update, and
   that a phone whose user revokes the permission goes silently back to broken.

Until that is automated and tested against more than one device, treat NeuraCall
as **inbound-only for WhatsApp**. Cellular outbound is a different story and
does work — `AndroidCallController.dial()` uses
`android.intent.action.CALL`, which is a real, public intent.

## Checking a device by hand

```bash
# 1. is it there, and which build?
adb -s <serial> shell pm list packages | grep whatsapp

# 2. during a live call — the locale-independent signal
adb -s <serial> shell dumpsys audio | grep -iE 'mode owner|current mode|setMode'

# 3. during a ringing call — foreground app
adb -s <serial> shell dumpsys window | grep -iE 'mFocusedApp'

# 4. permissions, if you are chasing the outbound route
adb -s <serial> shell dumpsys package com.whatsapp.w4b | grep -i READ_CONTACTS
```

Step 2 during a call that the phone is _not_ on will print the historical
`setMode` lines; read `Current mode`, not the log.
