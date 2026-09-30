/**
 * `core.phone`: Bangladeshi mobile numbers, stored one way -- `8801XXXXXXXXX`.
 *
 * Python's `\d` and `\D` are Unicode-aware, so a number typed in Bengali
 * digits keeps them where the pattern allows any digit, exactly as the Django
 * API stores it.
 */
import { ValidationError } from './errors';
import { pyStrip } from './python';

const COUNTRY_CODE = '880';
const SUBSCRIBER = /^1[3-9]\p{Nd}{8}$/u;
const PREFIXES = ['00' + COUNTRY_CODE, COUNTRY_CODE, '0'];

export const INVALID_PHONE_MESSAGE = 'Enter a Bangladeshi mobile number, for example 01712345678.';

/** `_strip_prefixes`: the digits, with every stacked country or trunk prefix removed. */
function stripPrefixes(raw: string): string {
  let digits = raw.replace(/\P{Nd}/gu, '');
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

/** `canonical(raw)`: `8801XXXXXXXXX`, or null for anything that is not a mobile (blank included). */
export function canonicalPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const subscriber = stripPrefixes(raw);
  return SUBSCRIBER.test(subscriber) ? `${COUNTRY_CODE}${subscriber}` : null;
}

/** `normalize(raw)`: canonical, null when blank, and a refusal otherwise. */
export function normalizePhone(raw: string | null | undefined, field = 'phone'): string | null {
  if (raw === null || raw === undefined || !pyStrip(raw)) return null;
  const number = canonicalPhone(raw);
  if (number === null) {
    throw new ValidationError(INVALID_PHONE_MESSAGE, {
      details: { [field]: [INVALID_PHONE_MESSAGE] },
    });
  }
  return number;
}

/** `normalize_if_mobile(raw)`: canonical when a mobile, else kept as typed (stripped). */
export function normalizeIfMobile(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  return canonicalPhone(raw) ?? pyStrip(raw);
}
