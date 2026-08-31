/**
 * Phone-number normalization.
 *
 * Caller ID arrives in whatever shape the network, the dialler or an imported
 * address book felt like: "+1 (555) 010-9999", "555-010-9999", "5550109999",
 * "0033612345678", "15550109999@s.whatsapp.net". All of those have to collide
 * onto one contact or the CRM is useless, so every number is reduced to a
 * single match key before it is stored or looked up.
 *
 * This is deliberately *not* libphonenumber: no metadata table, no per-country
 * length rules, no runtime dependency. It gets the common cases right and is
 * explicit about the case it can get wrong (see `suffix`).
 */

/** How the raw digits are turned into a match key. */
export interface PhoneOptions {
  /**
   * Country calling code for numbers typed without one, digits only and
   * without the "+" ("1", "33", "212"). Without it a national number cannot
   * be promoted to E.164 and only the suffix fallback can link it.
   */
  defaultCountryCode?: string;
  /** How many trailing digits the suffix fallback compares. */
  significantDigits?: number;
}

/**
 * Seven is the length of a subscriber number in the NANP and a reasonable
 * floor elsewhere. Shorter and unrelated numbers start colliding; longer and a
 * national number stops matching its own E.164 form in short-number countries.
 */
export const DEFAULT_SIGNIFICANT_DIGITS = 7;

export interface NormalizedPhone {
  /**
   * The canonical match key: "+" followed by digits when a country code is
   * known or was typed, otherwise the bare digits. The "+" is not invented —
   * a key without it is an admission that we do not know the country.
   */
  key: string;
  /**
   * The last `significantDigits` digits, used as a fallback match key.
   *
   * This exists because a call can arrive with no country code at all (a
   * national-format caller ID, or a dialler that strips the prefix), and
   * refusing to link it would leave the operator staring at a bare number for
   * a contact they already have. It is a heuristic and it *will* produce false
   * positives: "+1 555 010 9999" and "+44 20 7010 9999" share "0109999", and
   * two subscribers in different countries can share a suffix outright. That
   * is why `CrmStore` only falls back to it when there is no exact key match
   * and the suffix resolves to exactly one contact — a wrong link is worse
   * than no link.
   */
  suffix: string;
  /** Exactly what was handed to us, trimmed. Kept so the UI can show it back. */
  raw: string;
}

/**
 * Reduce a phone number to its match keys. Returns null when there is nothing
 * numeric to work with ("unknown", "private", ""), which is common for
 * withheld caller ID.
 */
export function normalizePhone(raw: string, opts: PhoneOptions = {}): NormalizedPhone | null {
  const significant = Math.max(1, opts.significantDigits ?? DEFAULT_SIGNIFICANT_DIGITS);
  const trimmed = raw.trim();

  // WhatsApp identifies parties by JID ("15550109999@s.whatsapp.net"); the
  // part before the "@" is the number in international form without the "+".
  const isJid = trimmed.includes("@");
  const local = trimmed.split("@")[0] ?? "";
  const digits = local.replace(/\D/g, "");
  if (digits.length === 0) return null;

  const countryCode = (opts.defaultCountryCode ?? "").replace(/\D/g, "");

  let e164Digits: string;
  if (local.startsWith("+") || isJid) {
    e164Digits = digits;
  } else if (digits.startsWith("00") && digits.length > 2) {
    // "00" is the international access prefix everywhere outside the NANP.
    e164Digits = digits.slice(2);
  } else if (countryCode !== "") {
    e164Digits = withCountryCode(digits, countryCode, significant);
  } else {
    e164Digits = digits;
  }

  const known = local.startsWith("+") || isJid || digits.startsWith("00") || countryCode !== "";
  return {
    key: known ? `+${e164Digits}` : e164Digits,
    suffix: e164Digits.slice(Math.max(0, e164Digits.length - significant)),
    raw: trimmed,
  };
}

/** True when two numbers share an exact key. */
export function samePhoneKey(a: string, b: string, opts: PhoneOptions = {}): boolean {
  const left = normalizePhone(a, opts);
  const right = normalizePhone(b, opts);
  return left !== null && right !== null && left.key === right.key;
}

function withCountryCode(digits: string, countryCode: string, significant: number): string {
  // A single leading zero is the national trunk prefix in most of the world
  // and is never part of the E.164 number.
  const national = digits.length > 1 && digits.startsWith("0") ? digits.slice(1) : digits;

  // "1 555 010 9999" typed without a "+" must land on the same key as
  // "+1 555 010 9999", so a leading country code counts as already present —
  // but only when what follows is still long enough to be a whole national
  // number. Without that guard a local number that merely happens to start
  // with the country code's digits (say "1234567" in the NANP) would lose its
  // first digit. The guard is not free either: a 10-digit NANP number
  // beginning with "1" is indistinguishable from a country code plus a short
  // national number, and this will treat it as the latter.
  if (national.startsWith(countryCode) && national.length - countryCode.length >= significant) {
    return national;
  }
  return countryCode + national;
}
