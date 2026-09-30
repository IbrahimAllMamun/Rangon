/**
 * Django's password handling, as `config/settings/base.py` configures it.
 *
 * Hashes are Django's own encodings, so an account created by either API signs
 * in on the other:
 *
 * - `argon2$argon2id$v=19$m=102400,t=2,p=8$<salt>$<hash>`: Django 5.1's
 *   `Argon2PasswordHasher`, the first entry in PASSWORD_HASHERS and so the one
 *   every new password gets. The salt is Django's -- 22 characters of
 *   `[a-zA-Z0-9]`, 128 bits -- not the library's 16 random bytes, which Django
 *   would count as too little entropy and rehash on the next sign-in.
 * - `pbkdf2_sha256$<iterations>$<salt>$<hash>`: verified, and upgraded to
 *   Argon2 on a correct sign-in, as `check_password`'s setter does.
 * - `bcrypt_sha256$...`: the third configured hasher. Not implemented: no
 *   version of this project ever wrote one, since Argon2 has been first in the
 *   list from the first migration. One would read as a wrong password, and is
 *   logged.
 *
 * The validators are AUTH_PASSWORD_VALIDATORS, in order, with Django's words.
 */
import { pbkdf2Sync, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { Logger } from '@nestjs/common';
import { hash as argon2Hash, parseOptions, verify as argon2Verify } from '@node-rs/argon2';

import type { ErrorDetail } from '../common/drf';
import { pyIsDigit, pyLen, pyStrip } from '../common/python';

const logger = new Logger('rangon.passwords');

// Django's Argon2PasswordHasher: argon2-cffi's defaults for type, version and
// hash length, and Django's own costs. `algorithm: 2` is Argon2id and
// `version: 1` is 0x13 (the library's const enums, which isolated modules
// cannot import).
const ARGON2 = {
  memoryCost: 102400,
  timeCost: 2,
  parallelism: 8,
  outputLen: 32,
  algorithm: 2,
  version: 1,
} as const;
const PBKDF2_ITERATIONS = 870000;
const SALT_ENTROPY = 128;
const RANDOM_STRING_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** `get_random_string(n)`: n characters of `[a-zA-Z0-9]`, from the CSPRNG. */
function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++)
    out += RANDOM_STRING_CHARS[randomInt(RANDOM_STRING_CHARS.length)];
  return out;
}

/** `BasePasswordHasher.salt()`: enough characters for 128 bits -- 22. */
function salt(): string {
  return randomString(Math.ceil(SALT_ENTROPY / Math.log2(RANDOM_STRING_CHARS.length)));
}

/** `must_update_salt`: fewer bits than the hasher's entropy. */
function mustUpdateSalt(saltLength: number): boolean {
  return saltLength * Math.log2(RANDOM_STRING_CHARS.length) < SALT_ENTROPY;
}

/** `make_password(password)` with the preferred (Argon2) hasher. */
export async function makePassword(password: string): Promise<string> {
  const options = { ...ARGON2, salt: Buffer.from(salt(), 'latin1') };
  const encoded = await argon2Hash(password, options as Parameters<typeof argon2Hash>[1]);
  return `argon2${encoded}`;
}

export interface Verification {
  correct: boolean;
  /** `must_update`: a correct password should be rehashed with today's hasher. */
  mustUpdate: boolean;
}

/** `verify_password(password, encoded)`. */
export async function verifyPassword(
  password: string,
  encoded: string | null,
): Promise<Verification> {
  const algorithm = encoded && !encoded.startsWith('!') ? identifyHasher(encoded) : null;
  if (algorithm === 'argon2') {
    const phc = (encoded as string).slice('argon2'.length);
    return { correct: await argon2Verify(phc, password), mustUpdate: argon2MustUpdate(phc) };
  }
  if (algorithm === 'pbkdf2_sha256') {
    // A different hasher is always updated (`hasher_changed`).
    return { correct: pbkdf2Verify(password, encoded as string), mustUpdate: true };
  }
  if (algorithm === 'bcrypt_sha256') {
    logger.warn('A bcrypt_sha256 password hash was presented; it is not supported here.');
  }
  // An unusable password, or a hasher that is not configured: run the
  // preferred hasher once anyway, so the answer takes as long as a real one.
  await makePassword(randomString(40));
  return { correct: false, mustUpdate: false };
}

/** `identify_hasher`: the algorithm prefix, or null for Django's unsalted ancients (not configured). */
function identifyHasher(encoded: string): string | null {
  if (
    (encoded.length === 32 && !encoded.includes('$')) ||
    (encoded.length === 37 && encoded.startsWith('md5$$'))
  ) {
    return null;
  }
  if (encoded.length === 46 && encoded.startsWith('sha1$$')) return null;
  return encoded.split('$', 1)[0] ?? null;
}

/** `Argon2PasswordHasher.must_update`: different parameters, or a salt below 128 bits. */
function argon2MustUpdate(phc: string): boolean {
  const current = parseOptions(phc);
  const saltB64 = phc.split('$')[4] ?? '';
  const saltLength = Buffer.from(saltB64, 'base64').length;
  return (
    (current.algorithm as number) !== ARGON2.algorithm ||
    (current.version as number) !== ARGON2.version ||
    current.memoryCost !== ARGON2.memoryCost ||
    current.timeCost !== ARGON2.timeCost ||
    current.parallelism !== ARGON2.parallelism ||
    current.outputLen !== ARGON2.outputLen ||
    mustUpdateSalt(saltLength)
  );
}

/** `PBKDF2PasswordHasher.verify`: re-encode with the stored salt and iterations, compare. */
function pbkdf2Verify(password: string, encoded: string): boolean {
  const [, iterations, saltText, hash] = encoded.split('$', 4) as [string, string, string, string];
  if (!/^\d+$/.test(iterations ?? '') || saltText === undefined || hash === undefined) return false;
  const derived = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    Buffer.from(saltText, 'utf8'),
    Number(iterations),
    32,
    'sha256',
  );
  const expected = Buffer.from(
    `pbkdf2_sha256$${Number(iterations)}$${saltText}$${derived.toString('base64')}`,
  );
  const given = Buffer.from(encoded);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Exposed for tests: `PBKDF2PasswordHasher().encode(password, salt, iterations)`. */
export function pbkdf2Encode(
  password: string,
  saltText: string,
  iterations = PBKDF2_ITERATIONS,
): string {
  const derived = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    Buffer.from(saltText, 'utf8'),
    iterations,
    32,
    'sha256',
  );
  return `pbkdf2_sha256$${iterations}$${saltText}$${derived.toString('base64')}`;
}

// --- AUTH_PASSWORD_VALIDATORS ------------------------------------------------

/** The attributes `UserAttributeSimilarityValidator` compares, with their verbose names. */
export interface PasswordUser {
  firstName: string;
  lastName: string;
  email: string;
}

const SIMILARITY_ATTRIBUTES: readonly [keyof PasswordUser, string][] = [
  // `username` comes first in Django's list; this user model has none.
  ['firstName', 'first name'],
  ['lastName', 'last name'],
  ['email', 'email'],
];
const MAX_SIMILARITY = 0.7;
const MIN_LENGTH = 10;

let commonPasswords: Set<string> | null = null;

/**
 * Django's `common-passwords.txt.gz` (20,000 passwords, Royce Williams's
 * list as Django ships it, BSD licence). Read once, on first use.
 */
function common(): Set<string> {
  if (!commonPasswords) {
    const file = join(__dirname, '..', '..', 'assets', 'common-passwords.txt.gz');
    const lines = gunzipSync(readFileSync(file)).toString('utf8').split('\n');
    commonPasswords = new Set(lines.map((line) => pyStrip(line)));
  }
  return commonPasswords;
}

/** `SequenceMatcher(a=a, b=b).quick_ratio()`: shared characters as a multiset. */
export function quickRatio(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const available = new Map<string, number>();
  for (const char of right) available.set(char, (available.get(char) ?? 0) + 1);
  let matches = 0;
  for (const char of left) {
    const count = available.get(char) ?? 0;
    available.set(char, count - 1);
    if (count > 0) matches += 1;
  }
  const length = left.length + right.length;
  return length ? (2 * matches) / length : 1;
}

/** `exceeds_maximum_length_ratio`: a value so much shorter it cannot be similar. */
function exceedsMaximumLengthRatio(password: string, value: string): boolean {
  const passwordLength = pyLen(password);
  const valueLength = pyLen(value);
  return passwordLength >= 10 * valueLength && valueLength < (MAX_SIMILARITY / 2) * passwordLength;
}

function similarity(password: string, user: PasswordUser | null): ErrorDetail | null {
  if (!user) return null;
  const lowered = password.toLowerCase();
  for (const [attribute, verboseName] of SIMILARITY_ATTRIBUTES) {
    const value = user[attribute];
    if (!value) continue;
    const valueLower = value.toLowerCase();
    // `re.split(r"\W+", value) + [value]`: Python's `\w` is letters, digits
    // (any script) and underscore.
    const parts = [...valueLower.split(/[^\p{L}\p{N}_]+/u), valueLower];
    for (const part of parts) {
      if (exceedsMaximumLengthRatio(lowered, part)) continue;
      if (quickRatio(lowered, part) >= MAX_SIMILARITY) {
        return {
          message: `The password is too similar to the ${verboseName}.`,
          code: 'password_too_similar',
        };
      }
    }
  }
  return null;
}

/**
 * `validate_password(password, user)`: every validator's refusal, in order,
 * or none. `user` is null where Django passes none (registration).
 */
export function validatePassword(password: string, user: PasswordUser | null): ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  const similar = similarity(password, user);
  if (similar) errors.push(similar);
  if (pyLen(password) < MIN_LENGTH) {
    errors.push({
      message: `This password is too short. It must contain at least ${MIN_LENGTH} characters.`,
      code: 'password_too_short',
    });
  }
  if (common().has(pyStrip(password.toLowerCase()))) {
    errors.push({ message: 'This password is too common.', code: 'password_too_common' });
  }
  if (pyIsDigit(password)) {
    errors.push({
      message: 'This password is entirely numeric.',
      code: 'password_entirely_numeric',
    });
  }
  return errors;
}
