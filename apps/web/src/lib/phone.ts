/**
 * Bangladeshi mobile numbers, spelled one way.
 *
 * The mirror of `core/phone.py`. The backend is authoritative — it normalises
 * again on the way in and refuses what it cannot read — but the rules live here
 * too so the customer is corrected in the field they are typing in rather than
 * by a round trip.
 *
 * Three shapes, and it is worth keeping them straight:
 *
 * - *subscriber*  `1712345678`      ten digits, what the input box holds
 * - *canonical*   `8801712345678`   what the API sends and stores
 * - *display*     `+880 1712-345678` what a human reads
 */

/** Bangladesh, without the `+`. */
export const COUNTRY_CODE = "880";

/** What the fixed prefix beside the input reads. */
export const DIAL_PREFIX = `+${COUNTRY_CODE}`;

/** A subscriber number is ten digits, and the box holds exactly that many. */
export const SUBSCRIBER_LENGTH = 10;

/**
 * Ten digits beginning `1`, with an operator digit of 3-9: 013/017
 * Grameenphone, 014/019 Banglalink, 015 Teletalk, 016 Airtel, 018 Robi. 011
 * (Citycell) was withdrawn and 010/012 were never issued.
 */
const SUBSCRIBER_RE = /^1[3-9]\d{8}$/;

/** Longest first: each spelling is the next one down with something in front. */
const PREFIXES = [`00${COUNTRY_CODE}`, COUNTRY_CODE, "0"];

export const INVALID_MESSAGE = "Enter a Bangladeshi mobile number, for example 01712345678.";

/**
 * The digits of `raw` with every leading country or trunk prefix removed.
 *
 * Repeated rather than stripped once, because the spellings stack: somebody who
 * types the country code and then pastes the local form produces
 * `88001712345678`, and `00880…` is `00` in front of the country code in front
 * of the subscriber. It also runs on every keystroke, so `880` typed from the
 * left must collapse to nothing and let the next digit start the number.
 * Nothing this can destroy is meaningful — no Bangladeshi subscriber number
 * begins `0` or `8`.
 */
function stripPrefixes(raw: string | null | undefined): string {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  let previous: string | null = null;
  while (digits !== previous) {
    previous = digits;
    for (const prefix of PREFIXES) {
      if (digits.startsWith(prefix)) {
        digits = digits.slice(prefix.length);
        break;
      }
    }
  }
  return digits;
}

/**
 * The ten-digit `1XXXXXXXXX` part of `raw`, or "" if it is not one.
 *
 * Accepts every spelling somebody might paste in: spaces, dashes, brackets, a
 * leading `+`, `00` international access, the country code with or without it,
 * and the national trunk `0`.
 */
export function toSubscriber(raw: string | null | undefined): string {
  const digits = stripPrefixes(raw);
  return SUBSCRIBER_RE.test(digits) ? digits : "";
}

/** `8801XXXXXXXXX` for anything that is a Bangladeshi mobile, otherwise "". */
export function toCanonical(raw: string | null | undefined): string {
  const subscriber = toSubscriber(raw);
  return subscriber ? `${COUNTRY_CODE}${subscriber}` : "";
}

export function isValidPhone(raw: string | null | undefined): boolean {
  return toSubscriber(raw) !== "";
}

/**
 * What belongs in the input box as somebody types.
 *
 * Keeps only digits and drops the prefixes the fixed `+880` already supplies,
 * so pasting `+880 1712-345678`, `01712345678` or `8801712345678` all leave
 * `1712345678` in the box. Deliberately tolerant of a partial number: this runs
 * on every keystroke, and a half-typed number is not an error yet.
 */
export function toInputValue(raw: string | null | undefined): string {
  return stripPrefixes(raw).slice(0, SUBSCRIBER_LENGTH);
}

/**
 * `+880 1712-345678` for a number we recognise, otherwise the value unchanged.
 *
 * Tolerant on purpose: address snapshots frozen onto historical orders keep
 * whatever spelling they were given, and an order already placed is never
 * rewritten.
 */
export function formatPhone(stored: string | null | undefined): string {
  if (!stored) return "";
  const subscriber = toSubscriber(stored);
  if (!subscriber) return String(stored).trim();
  return `${DIAL_PREFIX} ${subscriber.slice(0, 4)}-${subscriber.slice(4)}`;
}

/**
 * The digits of a *partial* number, for searching.
 *
 * A cashier types what the customer says: the whole number, the local
 * `0`-prefixed form, or only the last few digits. Each is a substring of the
 * stored canonical number once the prefixes nobody says aloud come off.
 * Returns "" when nothing identifying is left — `880` is a country, not a
 * customer.
 */
export function searchDigits(raw: string | null | undefined): string {
  return stripPrefixes(raw);
}
