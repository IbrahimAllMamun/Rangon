import { passwordFingerprint, signToken, TokenError, verifyAccessToken } from '../../src/auth/jwt';

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
