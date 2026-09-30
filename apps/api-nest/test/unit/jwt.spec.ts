import { TokensService } from '../../src/accounts/tokens.service';
import {
  decodeToken,
  passwordFingerprint,
  signToken,
  TokenError,
  verifyAccessToken,
  verifyClaims,
} from '../../src/auth/jwt';
import type { Env } from '../../src/config/env';
import type { Database } from '../../src/database/database.service';

const KEY = 'test-signing-key';
const NOW = 1_800_000_000;
const valid = { token_type: 'access', exp: NOW + 60, iat: NOW, jti: 'abc', user_id: 'u1' };

describe('SimpleJWT-compatible access tokens', () => {
  it('accepts what it signs', () => {
    expect(verifyAccessToken(signToken(valid, KEY), KEY, NOW)).toMatchObject({ user_id: 'u1' });
  });

  it.each([
    ['expired', { ...valid, exp: NOW }],
    ['issued in the future', { ...valid, iat: NOW + 10 }],
    ['not yet valid', { ...valid, nbf: NOW + 10 }],
    ['a refresh token', { ...valid, token_type: 'refresh' }],
    ['without jti', { token_type: 'access', exp: NOW + 60 }],
    ['without exp', { token_type: 'access', jti: 'x' }],
    ['with a non-string jti', { ...valid, jti: 7 }],
  ])('refuses one %s', (_label, payload) => {
    expect(() => verifyAccessToken(signToken(payload, KEY), KEY, NOW)).toThrow(TokenError);
  });

  it('refuses another key and a tampered payload', () => {
    const token = signToken(valid, KEY);
    expect(() => verifyAccessToken(token, 'other-key', NOW)).toThrow(TokenError);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...valid, user_id: 'admin' })).toString(
      'base64url',
    );
    expect(() => verifyAccessToken(`${header}.${forged}.${signature}`, KEY, NOW)).toThrow(
      TokenError,
    );
  });

  it('refuses alg none', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(valid)).toString('base64url');
    expect(() => verifyAccessToken(`${header}.${body}.`, KEY, NOW)).toThrow(TokenError);
  });

  it('fingerprints the stored hash as SimpleJWT does: MD5, upper-case hex', () => {
    expect(passwordFingerprint('abc')).toBe('900150983CD24FB0D6963F7D28E17F72');
  });
});

describe('TokensService.issue', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stamps and dates tokens by the wall clock, not the process clock', async () => {
    const wall = 1_800_000_000_500;
    jest.spyOn(Date, 'now').mockReturnValue(wall);
    // A process clock an hour behind, as after the host slept.
    jest.spyOn(performance, 'now').mockReturnValue(wall - performance.timeOrigin - 3_600_000);
    const writes: unknown[][] = [];
    const db = {
      query: (_text: string, values?: unknown[]) => {
        writes.push(values ?? []);
        return Promise.resolve([]);
      },
      one: () => Promise.resolve(null),
    };
    const tokens = new TokensService(
      db as unknown as Database,
      {
        jwtSigningKey: KEY,
      } as unknown as Env,
    );
    const pair = await tokens.issue({ id: 'u1', password: 'argon2$hash' });

    const refresh = decodeToken(pair.refresh, KEY, 1_800_000_000);
    verifyClaims(refresh, 'refresh');
    const access = verifyAccessToken(pair.access, KEY, 1_800_000_000);
    expect(refresh).toMatchObject({ iat: 1_800_000_000, exp: 1_800_000_000 + 14 * 24 * 3600 });
    expect(access).toMatchObject({ iat: 1_800_000_000, exp: 1_800_000_000 + 30 * 60 });
    // `created_at`, the outstanding-token row's own stamp.
    expect(writes[0]?.[3]).toBe(1_800_000_000.5);
  });
});
