/**
 * Access tokens, compatible both ways with the Django API's SimpleJWT.
 *
 * A token either API issues is accepted by the other: HS256 over the same
 * signing key (`JWT_SIGNING_KEY`, else `DJANGO_SECRET_KEY`), the same claims,
 * and the same refusals. The checks below are SimpleJWT 5.3's
 * `Token.__init__`/`verify` and PyJWT 2's `_validate_claims`, in their order.
 *
 * Written on `node:crypto` rather than a JWT library because it is one
 * algorithm and the refusals have to be SimpleJWT's exactly, not a library's
 * idea of them.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessClaims {
  token_type: string;
  exp: number;
  iat?: number;
  jti: string;
  user_id?: string;
  /** `get_md5_hash_password(user.password)` at issue time (CHECK_REVOKE_TOKEN). */
  hash_password?: string;
  [claim: string]: unknown;
}

export class TokenError extends Error {}

function base64UrlDecode(segment: string): Buffer {
  // PyJWT pads and decodes url-safe base64; a character outside that alphabet
  // is a DecodeError, which Buffer would otherwise skip silently.
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new TokenError('Token is invalid or expired');
  return Buffer.from(segment, 'base64url');
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TokenError('Token is invalid or expired');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TokenError('Token is invalid or expired');
  }
  return value as Record<string, unknown>;
}

/** Python `int(value)` on a JSON claim, as PyJWT applies it; null where it raises. */
function claimInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value);
  return null;
}

/**
 * Decode and verify an access token, or throw `TokenError`.
 *
 * `now` is seconds since the epoch, with a fraction, as Python's `timestamp()`.
 */
export function verifyAccessToken(
  token: string,
  key: string,
  now = Date.now() / 1000,
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Token is invalid or expired');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = parseJsonObject(base64UrlDecode(encodedHeader));
  // `algorithms=["HS256"]`: any other `alg`, `none` included, is refused.
  if (header.alg !== 'HS256') throw new TokenError('Token is invalid or expired');

  const expected = createHmac('sha256', key).update(`${encodedHeader}.${encodedPayload}`).digest();
  const signature = base64UrlDecode(encodedSignature);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new TokenError('Token is invalid or expired');
  }

  const payload = parseJsonObject(base64UrlDecode(encodedPayload));

  // PyJWT: iat, nbf, exp -- each only if present, leeway 0.
  if ('iat' in payload) {
    const iat = claimInt(payload.iat);
    if (iat === null || iat > now) throw new TokenError('Token is invalid or expired');
  }
  if ('nbf' in payload) {
    const nbf = claimInt(payload.nbf);
    if (nbf === null || nbf > now) throw new TokenError('Token is invalid or expired');
  }
  if ('exp' in payload) {
    const exp = claimInt(payload.exp);
    if (exp === null || exp <= now) throw new TokenError('Token is invalid or expired');
  }
  // PyJWT 2.10+: `jti` and `sub`, when present, must be strings.
  if ('jti' in payload && typeof payload.jti !== 'string') {
    throw new TokenError('Token is invalid or expired');
  }
  if ('sub' in payload && typeof payload.sub !== 'string') {
    throw new TokenError('Token is invalid or expired');
  }

  // SimpleJWT `Token.verify()`: exp is required here even though the spec
  // makes it optional, then jti, then the token type.
  if (!('exp' in payload)) throw new TokenError("Token has no 'exp' claim");
  if (!('jti' in payload)) throw new TokenError('Token has no id');
  if (!('token_type' in payload)) throw new TokenError('Token has no type');
  if (payload.token_type !== 'access') throw new TokenError('Token has wrong type');

  return payload as AccessClaims;
}

/** HS256-sign a payload the way PyJWT does (header `{"alg":"HS256","typ":"JWT"}`). */
export function signToken(payload: Record<string, unknown>, key: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** SimpleJWT `get_md5_hash_password`: the stored hash's MD5, upper-case hex. */
export function passwordFingerprint(storedPasswordHash: string): string {
  return createHash('md5').update(storedPasswordHash, 'utf8').digest('hex').toUpperCase();
}
