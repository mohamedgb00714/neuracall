export { DeviceManager } from "./deviceManager.js";
export type { DeviceManagerOptions } from "./deviceManager.js";
export { AndroidCallController, normalizeTel, telUri, parseCallState } from "./callController.js";
export {
  AdbCallChannelDetector,
  isWhatsAppPackage,
  hasIncomingCallUi,
  WHATSAPP_APP_ID,
  WHATSAPP_BUSINESS_APP_ID,
} from "./whatsAppDetector.js";
export type { CallChannelDetector, DetectedIncomingCall } from "./whatsAppDetector.js";
export { realRunner, defaultSpawner } from "./adb.js";
export type { CommandRunner, Spawner } from "./adb.js";
export * from "./types.js";
