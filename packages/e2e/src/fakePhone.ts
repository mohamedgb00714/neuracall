/**
 * A fake Android phone behind the adb `CommandRunner` interface.
 *
 * This is the outermost edge of the system on the control side: everything
 * above it in an end-to-end test — `DeviceManager`, `AndroidCallController`,
 * `AdbCallChannelDetector` — is the real implementation, parsing real adb
 * output shapes. The phone is a small state machine that responds to the
 * keyevents the controller actually sends, so "answer" and "hang up" move it
 * between ringing, offhook and idle exactly as a handset would.
 *
 * Modelling the phone rather than canning a list of responses is what makes
 * the test meaningful: a controller that sends the wrong keycode, or the
 * orchestrator answering twice, shows up as the phone being in the wrong
 * state — not as a mismatched string.
 */

import type { CommandRunner } from "@neuracall/device-manager";

/** What `dumpsys telephony.registry` reports. */
export type PhoneCallState = "idle" | "ringing" | "offhook";

/** Which app is in the foreground, for WhatsApp detection. */
export type Foreground = "dialer" | "whatsapp" | "home";

export interface FakePhoneOptions {
  /** adb endpoint (serial or ip:port). */
  endpoint: string;
  /** Reported by `adb devices`. Default "device". */
  adbState?: string;
}

export class FakePhone {
  readonly endpoint: string;
  adbState: string;
  callState: PhoneCallState = "idle";
  foreground: Foreground = "home";
  /** True while a WhatsApp incoming-call screen is showing. */
  whatsAppRinging = false;

  /** Every adb argv this phone received, in order. */
  readonly commands: string[][] = [];
  answeredCount = 0;
  hungUpCount = 0;

  constructor(opts: FakePhoneOptions) {
    this.endpoint = opts.endpoint;
    this.adbState = opts.adbState ?? "device";
  }

  /** An inbound cellular call starts ringing. */
  ringCellular(): void {
    this.callState = "ringing";
    this.foreground = "dialer";
  }

  /** An inbound WhatsApp call starts ringing (telephony stays idle). */
  ringWhatsApp(): void {
    this.callState = "idle";
    this.foreground = "whatsapp";
    this.whatsAppRinging = true;
  }

  /** The far end puts the phone down. */
  remoteHangUp(): void {
    this.callState = "idle";
    this.whatsAppRinging = false;
    this.foreground = "home";
  }

  /** Handle one `adb -s <endpoint> ...` invocation. */
  handle(args: string[]): string {
    this.commands.push([...args]);
    const joined = args.join(" ");

    if (joined.startsWith("shell dumpsys telephony.registry")) {
      return `mCallState=${CALL_STATE_CODE[this.callState]} telephonyRegistry`;
    }

    if (joined.startsWith("shell dumpsys activity activities")) {
      return `  mResumedActivity: ActivityRecord{abc u0 ${PACKAGE[this.foreground]}/.Main t1}`;
    }

    if (joined.startsWith("shell uiautomator dump")) {
      return "UI hierchary dumped to: /sdcard/neuracall_window.xml";
    }

    if (joined.startsWith("shell cat /sdcard/neuracall_window.xml")) {
      return this.whatsAppRinging
        ? '<?xml version="1.0"?><node text="Incoming voice call" resource-id="com.whatsapp:id/incoming_call_wrapper"/>'
        : '<?xml version="1.0"?><node text="Chats" resource-id="com.whatsapp:id/chats_list"/>';
    }

    if (joined.startsWith("shell input keyevent")) {
      const code = Number(args.at(-1));
      if (code === 5) {
        // KEYCODE_CALL — answers a ringing call.
        this.answeredCount += 1;
        this.callState = "offhook";
        this.whatsAppRinging = false;
        return "";
      }
      if (code === 6) {
        // KEYCODE_ENDCALL.
        this.hungUpCount += 1;
        this.remoteHangUp();
        return "";
      }
      return "";
    }

    return "";
  }
}

const CALL_STATE_CODE: Record<PhoneCallState, number> = {
  idle: 0,
  ringing: 1,
  offhook: 2,
};

const PACKAGE: Record<Foreground, string> = {
  dialer: "com.android.dialer",
  whatsapp: "com.whatsapp",
  home: "com.android.launcher",
};

/**
 * A `CommandRunner` backed by a pool of `FakePhone`s. This is what the real
 * `DeviceManager` and `AndroidCallController` talk to instead of the `adb`
 * binary.
 */
export class FakeAdb implements CommandRunner {
  readonly phones = new Map<string, FakePhone>();
  /** Set to make every adb call fail, simulating the daemon being down. */
  offline = false;

  constructor(phones: FakePhone[] = []) {
    for (const phone of phones) this.phones.set(phone.endpoint, phone);
  }

  add(phone: FakePhone): FakePhone {
    this.phones.set(phone.endpoint, phone);
    return phone;
  }

  get(endpoint: string): FakePhone {
    const phone = this.phones.get(endpoint);
    if (!phone) throw new Error(`no fake phone at ${endpoint}`);
    return phone;
  }

  /** Host-level adb commands (`adb devices`, `adb connect`). */
  async run(args: string[]): Promise<string> {
    if (this.offline) throw new Error("adb: cannot connect to daemon");
    if (args[0] === "devices") {
      const lines = ["List of devices attached"];
      for (const phone of this.phones.values()) {
        lines.push(`${phone.endpoint}\t${phone.adbState}`);
      }
      return lines.join("\n");
    }
    return "";
  }

  /** Device-scoped commands (`adb -s <endpoint> ...`). */
  async runForDevice(endpoint: string, args: string[]): Promise<string> {
    if (this.offline) throw new Error("adb: device offline");
    return this.get(endpoint).handle(args);
  }
}
