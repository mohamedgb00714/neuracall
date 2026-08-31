/**
 * WhatsApp text credentials, read from the environment the same way the rest
 * of NeuraCall reads its config.
 *
 * Text is optional: an install that only answers voice calls has none of these
 * set, and must still start. So a fully unset environment returns null rather
 * than throwing — but a *partly* set one throws, because half a configuration
 * is a deployment mistake that would otherwise surface much later as a webhook
 * that silently accepts nothing.
 */

import { loadEnv } from "@neuracall/config";

/** Placeholder value used throughout .env.example; treated as "not set". */
const PLACEHOLDER = "replace-me";

export interface WhatsAppTextConfig {
  accessToken: string;
  phoneNumberId: string;
  /** Required to accept inbound webhooks; without it they fail closed. */
  appSecret?: string;
  verifyToken?: string;
  apiVersion?: string;
}

/**
 * Read WhatsApp text config from `env`. Returns null when the feature is not
 * configured at all.
 *
 * @param env Environment to read from. Tests pass an explicit object so they
 *            never touch the real environment.
 */
export function getWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppTextConfig | null {
  const accessToken = optional(env, "WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = optional(env, "WHATSAPP_PHONE_NUMBER_ID");
  const appSecret = optional(env, "WHATSAPP_APP_SECRET");
  const verifyToken = optional(env, "WHATSAPP_VERIFY_TOKEN");
  const apiVersion = optional(env, "WHATSAPP_API_VERSION");

  // apiVersion alone is not evidence of intent to enable text.
  if (!accessToken && !phoneNumberId && !appSecret && !verifyToken) return null;
  if (!accessToken) return missing("WHATSAPP_ACCESS_TOKEN");
  if (!phoneNumberId) return missing("WHATSAPP_PHONE_NUMBER_ID");

  return {
    accessToken,
    phoneNumberId,
    ...(appSecret !== undefined ? { appSecret } : {}),
    ...(verifyToken !== undefined ? { verifyToken } : {}),
    ...(apiVersion !== undefined ? { apiVersion } : {}),
  };
}

/** Load .env (if present) and return the WhatsApp text config in one call. */
export function loadWhatsAppConfig(envFile?: string): WhatsAppTextConfig | null {
  loadEnv(envFile);
  return getWhatsAppConfig();
}

/**
 * A summary safe to log or show in the UI. The token is a bearer credential
 * for the whole WhatsApp presence, so only its last four characters leave
 * this module.
 */
export function describeWhatsAppConfig(config: WhatsAppTextConfig): string {
  const last4 = config.accessToken.slice(-4);
  const inbound = config.appSecret ? "signed inbound" : "inbound disabled (no app secret)";
  return `phone_number_id=${config.phoneNumberId} token=****${last4} ${inbound}`;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const value = raw.trim();
  if (value === "" || value.includes(PLACEHOLDER)) return undefined;
  return value;
}

function missing(what: string): never {
  throw new Error(
    `WhatsApp text is partly configured: ${what} is missing. ` +
      `Set every WHATSAPP_* variable, or none of them to disable text.`,
  );
}
