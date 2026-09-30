import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Inject, Injectable } from '@nestjs/common';

import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { decodeToken, passwordFingerprint, signToken, TokenError, verifyClaims } from '../auth/jwt';

/**
 * SimpleJWT's refresh tokens and its `token_blacklist` app, over the same
 * tables, so a session opened on either API can be refreshed or ended on the
 * other and `end_sessions` sees every one.
 *
 * SIMPLE_JWT: access 30 minutes, refresh 14 days, rotated and blacklisted
 * after rotation, with the `hash_password` claim (CHECK_REVOKE_TOKEN).
 */
const ACCESS_LIFETIME = 30 * 60;
const REFRESH_LIFETIME = 14 * 24 * 60 * 60;

export interface TokenUser {
  id: string;
  /** The stored hash, for the `hash_password` claim. */
  password: string;
}

export interface TokenPair {
  access: string;
  refresh: string;
}

/** `aware_utcnow()` in seconds, to the microsecond. */
function nowSeconds(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `LoginSerializer.tokens_for(user)`: `RefreshToken.for_user` -- which also
   * writes the `OutstandingToken` row -- and the access token derived from it.
   */
  async issue(user: TokenUser, q: Queryable = this.db): Promise<TokenPair> {
    const now = nowSeconds();
    const issuedAt = Math.floor(now);
    const common = { user_id: user.id, hash_password: passwordFingerprint(user.password) };
    // Claim order is SimpleJWT's: the constructor's, then `for_user`'s.
    const refreshJti = randomUUID().replaceAll('-', '');
    const refreshExp = Math.floor(now + REFRESH_LIFETIME);
    const refresh = signToken(
      { token_type: 'refresh', exp: refreshExp, iat: issuedAt, jti: refreshJti, ...common },
      this.env.jwtSigningKey,
    );
    // `refresh.access_token`: expiry counted from the refresh token's own
    // instant, and every claim but type, exp and jti copied across.
    const access = signToken(
      {
        token_type: 'access',
        exp: Math.floor(now + ACCESS_LIFETIME),
        iat: issuedAt,
        jti: randomUUID().replaceAll('-', ''),
        ...common,
      },
      this.env.jwtSigningKey,
    );
    await q.query(
      `INSERT INTO token_blacklist_outstandingtoken (user_id, jti, token, created_at, expires_at)
       VALUES ($1::uuid, $2, $3, to_timestamp($4), to_timestamp($5))`,
      [user.id, refreshJti, refresh, now, refreshExp],
    );
    return { access, refresh };
  }

  /**
   * `RefreshToken(token)`: decode, refuse a blacklisted token, then SimpleJWT's
   * own checks -- in that order, as `BlacklistMixin.verify` runs them.
   */
  async verifyRefresh(token: unknown): Promise<Record<string, unknown>> {
    const payload = decodeToken(token, this.env.jwtSigningKey);
    if (typeof payload.jti === 'string' && (await this.isBlacklisted(payload.jti))) {
      throw new TokenError('Token is blacklisted');
    }
    verifyClaims(payload, 'refresh');
    return payload;
  }

  private async isBlacklisted(jti: string): Promise<boolean> {
    const row = await this.db.one(
      `SELECT 1 AS found FROM token_blacklist_blacklistedtoken b
         JOIN token_blacklist_outstandingtoken o ON o.id = b.token_id
        WHERE o.jti = $1 LIMIT 1`,
      [jti],
    );
    return row !== null;
  }

  /**
   * `refresh.blacklist()`: make sure the token is outstanding, then blacklist it.
   *
   * Answers false when another request blacklisted the same token first.
   * Django's `get_or_create` lets two concurrent refreshes of one token both
   * pass, each minting a fresh pair; here only the first does, and the second
   * is refused like any spent token (a documented difference).
   */
  async blacklist(
    token: string,
    payload: Record<string, unknown>,
    q: Queryable = this.db,
  ): Promise<boolean> {
    const jti = String(payload.jti);
    await q.query(
      `INSERT INTO token_blacklist_outstandingtoken (jti, token, expires_at)
       VALUES ($1, $2, to_timestamp($3))
       ON CONFLICT (jti) DO NOTHING`,
      [jti, token, Number(payload.exp)],
    );
    const inserted = await q.query(
      `INSERT INTO token_blacklist_blacklistedtoken (token_id, blacklisted_at)
       SELECT id, clock_timestamp() FROM token_blacklist_outstandingtoken WHERE jti = $1
       ON CONFLICT (token_id) DO NOTHING
       RETURNING id`,
      [jti],
    );
    return inserted.length > 0;
  }

  /**
   * `accounts.services.end_sessions`: blacklist every refresh token the user
   * still holds. Answers how many were open -- expired ones included, as
   * Django counts them.
   */
  async endSessions(userId: string, q: Queryable): Promise<number> {
    const row = await q.one<{ ended: string }>(
      `WITH open AS (
         SELECT o.id FROM token_blacklist_outstandingtoken o
           LEFT JOIN token_blacklist_blacklistedtoken b ON b.token_id = o.id
          WHERE o.user_id = $1::uuid AND b.id IS NULL
       ), blacklisted AS (
         INSERT INTO token_blacklist_blacklistedtoken (token_id, blacklisted_at)
         SELECT id, clock_timestamp() FROM open
         ON CONFLICT (token_id) DO NOTHING
       )
       SELECT count(*) AS ended FROM open`,
      [userId],
    );
    return Number(row?.ended ?? 0);
  }
}
