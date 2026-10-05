/**
 * `django.core.signing.dumps` and `loads`: a JSON value, signed and stamped
 * with the second it was signed in, as Django's `TimestampSigner` writes it:
 *
 *     base64url(json) : base62(timestamp) : base64url(hmac-sha256)
 *
 * The key is SHA-256 of the salt, the word "signer" and `SECRET_KEY`, so a
 * token signed for one purpose never verifies for another. Either API reads
 * what the other signed.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** `signing.BadSignature`. */
export class BadSignature extends Error {}
/** `signing.SignatureExpired`. */
export class SignatureExpired extends BadSignature {}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SEP = ':';

function b62Encode(value: number): string {
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  let rest = Math.abs(value);
  let encoded = '';
  while (rest > 0) {
    encoded = BASE62[rest % 62] + encoded;
    rest = Math.floor(rest / 62);
  }
  return sign + encoded;
}

/** `b62_decode`: a digit outside the alphabet is Python's `ValueError`, uncaught. */
function b62Decode(text: string): number {
  if (text === '0') return 0;
  let sign = 1;
  let digits = text;
  if (digits[0] === '-') {
    digits = digits.slice(1);
    sign = -1;
  }
  let decoded = 0;
  for (const digit of digits) {
    const index = BASE62.indexOf(digit);
    if (index === -1) throw new Error('substring not found');
    decoded = decoded * 62 + index;
  }
  return sign * decoded;
}

/** `Signer.signature`: `base64_hmac(salt + "signer", value, key, algorithm="sha256")`. */
function signature(value: string, key: string, salt: string): string {
  const derived = createHash('sha256').update(`${salt}signer${key}`, 'utf8').digest();
  return createHmac('sha256', derived).update(value, 'utf8').digest('base64url');
}

/** `json.dumps(obj, separators=(",", ":"))`: compact, and ASCII only. */
function compactJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export interface SigningOptions {
  /** `settings.SECRET_KEY`. */
  key: string;
  salt: string;
  /** `time.time()`; the clock, unless a test sets it. */
  now?: number;
}

/** `signing.dumps(obj, salt=salt)`. */
export function signingDumps(value: unknown, options: SigningOptions): string {
  const data = Buffer.from(compactJson(value), 'latin1').toString('base64url');
  const stamped = `${data}${SEP}${b62Encode(Math.floor(options.now ?? Date.now() / 1000))}`;
  return `${stamped}${SEP}${signature(stamped, options.key, options.salt)}`;
}

/**
 * `signing.loads(token, salt=salt, max_age=max_age)`: the value, or
 * `BadSignature` for a token nothing here signed, or `SignatureExpired` for
 * one older than `maxAge` seconds.
 */
export function signingLoads(
  token: string,
  options: SigningOptions & { maxAge?: number },
): unknown {
  if (!token.includes(SEP)) throw new BadSignature(`No "${SEP}" found in value`);
  const cut = token.lastIndexOf(SEP);
  const stamped = token.slice(0, cut);
  const given = Buffer.from(token.slice(cut + 1), 'utf8');
  const expected = Buffer.from(signature(stamped, options.key, options.salt), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new BadSignature(`Signature "${token.slice(cut + 1)}" does not match`);

  // `value, timestamp = result.rsplit(sep, 1)`: one part is Python's `ValueError`.
  const at = stamped.lastIndexOf(SEP);
  if (at === -1) throw new Error('not enough values to unpack (expected 2, got 1)');
  const timestamp = b62Decode(stamped.slice(at + 1));
  if (options.maxAge !== undefined) {
    const age = (options.now ?? Date.now() / 1000) - timestamp;
    if (age > options.maxAge)
      throw new SignatureExpired(`Signature age ${age} > ${options.maxAge} seconds`);
  }
  // Only what this key signed gets this far; no compressed value is ever signed here.
  const data = Buffer.from(stamped.slice(0, at), 'base64url').toString('latin1');
  return JSON.parse(data) as unknown;
}
