/** ADB-reported connection state. */
export type AdbState = "device" | "offline" | "unauthorized" | "connecting";

/** High-level NeuraCall device state. */
export type DevicePhase =
  | "unknown"
  | "online" // connected via adb, idle
  | "incoming" // a call is ringing
  | "in-call" // a call is active
  | "busy" // in use by another session
  | "offline";

/** A single Android device managed by NeuraCall. */
export interface Device {
  /** ADB endpoint: "serial" for USB, "ip:port" for wireless. */
  id: string;
  /** Which wire protocol this device uses. */
  kind: "usb" | "wifi";
  /** Raw ADB state. */
  adbState: AdbState;
  /** Our app-level phase. */
  phase: DevicePhase;
  /** Detected inbound channel (cellular vs WhatsApp), once known. */
  channel?: ChannelKind;
  /** Optional human label. */
  label?: string;
  /** Last time state changed (ms epoch). */
  updatedAt: number;
}

/** The kind of inbound call. */
export type ChannelKind = "cellular" | "whatsapp";

/** Telephony call state as reported by `dumpsys telephony.registry` (mCallState). */
export type CallState = "idle" | "ringing" | "offhook" | "unknown";

type AndroidKeyCode = number;

/** Android KEYCODE constants used for call control. */
export const KeyCodes = {
  KEYCODE_CALL: 5 as AndroidKeyCode, // dial/answer
  KEYCODE_ENDCALL: 6 as AndroidKeyCode, // end / reject
  KEYCODE_0: 7 as AndroidKeyCode,
  KEYCODE_1: 8 as AndroidKeyCode,
  KEYCODE_2: 9 as AndroidKeyCode,
  KEYCODE_3: 10 as AndroidKeyCode,
  KEYCODE_4: 11 as AndroidKeyCode,
  KEYCODE_5: 12 as AndroidKeyCode,
  KEYCODE_6: 13 as AndroidKeyCode,
  KEYCODE_7: 14 as AndroidKeyCode,
  KEYCODE_8: 15 as AndroidKeyCode,
  KEYCODE_9: 16 as AndroidKeyCode,
  KEYCODE_STAR: 17 as AndroidKeyCode,
  KEYCODE_POUND: 18 as AndroidKeyCode,
  KEYCODE_SWITCH_CAMERA: 27 as AndroidKeyCode,
  KEYCODE_MUTE: 91 as AndroidKeyCode,
} as const;

/** Operations the AndroidCallController can perform on a device. */
export interface CallController {
  /** Answer an incoming call (KEYCODE_CALL). */
  answer(): Promise<void>;
  /** Hang up / reject the current call (KEYCODE_ENDCALL). */
  hangUp(): Promise<void>;
  /** Hang up without throwing if the call was already ended. */
  safeHangUp(): Promise<void>;
  /** Place an outgoing call to a number (android.intent.action.CALL). */
  dial(number: string): Promise<void>;
  /** Open the dialer, optionally prefilled — no call is placed. */
  openDialer(number?: string): Promise<void>;
  /** Press keypad digits (DTMF / dialer field) as key events. */
  pressDigits(digits: string): Promise<void>;
  /** Current telephony call state of the device. */
  callState(): Promise<CallState>;
  /** Toggle the microphone mute. */
  toggleMute(): Promise<void>;
}
