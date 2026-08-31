/**
 * Which Android apps place voice calls, and what channel each one is.
 *
 * NeuraCall started WhatsApp-only, but nothing about the detection actually
 * needs to be: a VoIP call of any kind puts the device into audio
 * `MODE_IN_COMMUNICATION` and names the owning package, which identifies the
 * app without scraping its UI. That one signal generalises to every calling
 * app on the phone, so the registry below is a *labelling* table rather than
 * the thing that makes detection work.
 *
 * The practical consequence: an app missing from this table is still detected.
 * It simply reports the generic `"voip"` channel instead of a friendly name,
 * and everything downstream — answering, capture, transcription, the call
 * record — behaves identically. Adding an entry here is a nicety, never a
 * prerequisite.
 */

import type { ChannelKind } from "./types.js";

export interface CallingApp {
  /** Channel reported for calls owned by these packages. */
  channel: ChannelKind;
  /** Human label for the UI. */
  label: string;
  /**
   * Exact package names. Matching is exact rather than by prefix: a
   * `startsWith("com.whatsapp")` test would also swallow an unrelated
   * `com.whatsapp.clone` or a third-party package that merely shares the
   * prefix, and mislabelling a call is worse than reporting it generically.
   */
  packages: readonly string[];
}

/**
 * Known calling apps. Business/lite variants are listed explicitly because
 * they are separate packages — WhatsApp Business (`com.whatsapp.w4b`) is the
 * one actually installed on the development handset, and treating it as a
 * different product from `com.whatsapp` would have missed every call on it.
 */
export const CALLING_APPS: readonly CallingApp[] = [
  {
    channel: "whatsapp",
    label: "WhatsApp",
    packages: ["com.whatsapp", "com.whatsapp.w4b"],
  },
  {
    channel: "telegram",
    label: "Telegram",
    packages: ["org.telegram.messenger", "org.telegram.messenger.web", "org.telegram.plus"],
  },
  { channel: "signal", label: "Signal", packages: ["org.thoughtcrime.securesms"] },
  {
    channel: "messenger",
    label: "Messenger",
    packages: ["com.facebook.orca", "com.facebook.mlite"],
  },
  { channel: "instagram", label: "Instagram", packages: ["com.instagram.android"] },
  { channel: "viber", label: "Viber", packages: ["com.viber.voip"] },
  { channel: "skype", label: "Skype", packages: ["com.skype.raider", "com.skype.m2"] },
  { channel: "teams", label: "Microsoft Teams", packages: ["com.microsoft.teams"] },
  { channel: "zoom", label: "Zoom", packages: ["us.zoom.videomeetings"] },
  {
    channel: "meet",
    label: "Google Meet",
    packages: ["com.google.android.apps.tachyon", "com.google.android.apps.meetings"],
  },
  { channel: "imo", label: "imo", packages: ["com.imo.android.imoim", "com.imo.android.imoimbeta"] },
  { channel: "botim", label: "BOTIM", packages: ["im.thebot.messenger"] },
  { channel: "discord", label: "Discord", packages: ["com.discord"] },
  { channel: "line", label: "LINE", packages: ["jp.naver.line.android"] },
  { channel: "wechat", label: "WeChat", packages: ["com.tencent.mm"] },
  {
    channel: "cellular",
    label: "Phone",
    packages: [
      "com.android.dialer",
      "com.google.android.dialer",
      "com.samsung.android.dialer",
      "com.android.server.telecom",
    ],
  },
];

/** Package → channel, built once. */
const BY_PACKAGE = new Map<string, CallingApp>(
  CALLING_APPS.flatMap((app) => app.packages.map((pkg) => [pkg, app] as const)),
);

/** Channel for a package, or null when it is not a known calling app. */
export function channelForPackage(pkg: string): ChannelKind | null {
  return BY_PACKAGE.get(pkg.trim())?.channel ?? null;
}

/** Friendly name for a package, or null when it is not a known calling app. */
export function labelForPackage(pkg: string): string | null {
  return BY_PACKAGE.get(pkg.trim())?.label ?? null;
}

/** Whether a package is a calling app we can name. */
export function isCallingApp(pkg: string): boolean {
  return BY_PACKAGE.has(pkg.trim());
}

/**
 * Channel for a package known to own an active VoIP call.
 *
 * Falls back to `"voip"` rather than null: the device being in
 * `MODE_IN_COMMUNICATION` is already proof that a call is happening, so an
 * unrecognised owner means "a call on an app we cannot name", not "no call".
 * Refusing to report it would drop real calls purely for lack of a table entry.
 */
export function callChannelForOwner(pkg: string): ChannelKind {
  return channelForPackage(pkg) ?? "voip";
}

/** Every channel the registry can report, plus the generic fallback. */
export function knownChannels(): ChannelKind[] {
  return [...new Set(CALLING_APPS.map((a) => a.channel)), "voip"];
}
