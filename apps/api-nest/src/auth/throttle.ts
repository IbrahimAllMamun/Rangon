import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { RateLimited } from '../common/errors';
import { ENV, Env } from '../config/env';
import { RedisService } from '../redis/redis.service';

/**
 * DRF's throttles as `config/settings/base.py` configures them, keyed the way
 * `core.throttling` keys them: on an address the caller cannot choose.
 *
 * Every request passes three: `anon` (anonymous only, by address), `user`
 * (the user, else the address) and the view's scope if it names one. All
 * three are evaluated even when one refuses -- DRF records the request in
 * every bucket that allows it -- and the 429 names the longest wait.
 *
 * Each bucket is DRF's sliding window: the timestamps of recent requests,
 * newest first, trimmed to the window on every check. Kept in Redis and
 * updated in one Lua script, so two concurrent requests cannot both take the
 * last slot. Buckets are this API's own: a client spreading requests over
 * both APIs has two budgets (docs/architecture/nest-port.md).
 */

const SCOPE = 'rangon:throttle-scope';
const SKIP = 'rangon:skip-throttle';

/** A plain Django view (not DRF), which no throttle class ever sees: the health checks. */
export const SkipThrottle = () => SetMetadata(SKIP, true);

type Scope = 'search' | 'auth' | 'checkout' | 'pos';

/** `throttle_scope = "search"` on a DRF view. */
export const ThrottleScope = (scope: Scope) => SetMetadata(SCOPE, scope);

const ONLY_SCOPED = 'rangon:throttle-only-scoped';

/**
 * `throttle_classes = [ScopedRateThrottle]` with a scope: that bucket alone,
 * the anon and user ones not counted (`PasswordChangeView`).
 */
export const OnlyScopedThrottle = (scope: Scope) =>
  applyDecorators(SetMetadata(SCOPE, scope), SetMetadata(ONLY_SCOPED, true));

const DURATIONS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `SimpleRateThrottle.parse_rate`: "60/min" is 60 requests per 60 seconds. */
export function parseRate(rate: string): { requests: number; seconds: number } {
  const [count, period] = rate.split('/');
  const seconds = DURATIONS[(period ?? '')[0] ?? ''];
  if (!count || seconds === undefined) throw new Error(`Bad throttle rate: ${rate}`);
  return { requests: Number(count), seconds };
}

/** `core.ip.client_ip`: the n-th X-Forwarded-For entry from the right, else the socket peer. */
export function clientIp(request: FastifyRequest, trustedHops: number): string {
  const remote = request.raw.socket.remoteAddress ?? '';
  if (trustedHops <= 0) return remote;
  const header = request.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header.join(',') : (header ?? '');
  const entries = forwarded
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Fewer hops than configured: the request did not come the way we were
  // told it would, so the socket is the only thing worth believing.
  if (entries.length < trustedHops) return remote;
  return Array.from(entries[entries.length - trustedHops] as string)
    .slice(0, 45)
    .join('');
}

/**
 * Trim, check, record. Returns [allowed, history length, oldest timestamp].
 * The list is newest first, as DRF keeps it; the key expires a window after
 * the last recorded request, as `cache.set(key, history, duration)` does.
 */
const SLIDING_WINDOW = `
local now = tonumber(ARGV[1])
local duration = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
while true do
  local last = redis.call('LINDEX', KEYS[1], -1)
  if not last or tonumber(last) > now - duration then break end
  redis.call('RPOP', KEYS[1])
end
local length = redis.call('LLEN', KEYS[1])
local oldest = redis.call('LINDEX', KEYS[1], -1) or '0'
if length >= limit then
  return {0, length, oldest}
end
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], duration)
return {1, length + 1, oldest}
`;

interface Bucket {
  scope: string;
  ident: string;
  rate: string;
}

/** What a view says about its throttles: `throttle_scope`, `throttle_classes`, or none at all. */
export interface ThrottleMeta {
  /** A plain Django view: no throttle class ever sees it. */
  skip: boolean;
  /** `throttle_classes = [ScopedRateThrottle]`: the scope's bucket alone. */
  onlyScoped: boolean;
  scope: string | undefined;
}

/** A handler's throttle metadata, the handler's own before its controller's. */
export function throttleMeta(
  reflector: Reflector,
  targets: Parameters<Reflector['getAllAndOverride']>[1],
): ThrottleMeta {
  return {
    skip: Boolean(reflector.getAllAndOverride<boolean>(SKIP, targets)),
    onlyScoped: Boolean(reflector.getAllAndOverride<boolean>(ONLY_SCOPED, targets)),
    scope: reflector.getAllAndOverride<string>(SCOPE, targets),
  };
}

/**
 * `APIView.check_throttles`: every bucket the view names, counted and
 * checked. Called by the guard for a request a handler will take, and by the
 * exception filter for one whose method the view does not serve -- DRF
 * throttles before it looks for the handler, so a 405 spends a request too.
 */
@Injectable()
export class Throttles {
  private readonly rates: Record<string, string>;

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.rates = {
      anon: env.DJANGO_THROTTLE_ANON,
      user: '600/min',
      auth: '10/min',
      checkout: '20/hour',
      search: '120/min',
      pos: '1200/min',
    };
  }

  async check(request: FastifyRequest, meta: ThrottleMeta): Promise<void> {
    if (meta.skip) return;
    const { onlyScoped, scope } = meta;
    // config.settings.parity empties DEFAULT_THROTTLE_CLASSES. A view that
    // names its own throttle classes keeps them there too.
    if (this.env.throttlingDisabled && !onlyScoped) return;
    const ident = clientIp(request, this.env.DJANGO_TRUSTED_PROXY_HOPS);
    const user = request.user;

    const buckets: Bucket[] = [];
    // AnonRateThrottle: anonymous requests only.
    if (!user && !onlyScoped)
      buckets.push({ scope: 'anon', ident, rate: this.rates.anon as string });
    // UserRateThrottle: the user, else the address.
    if (!onlyScoped)
      buckets.push({
        scope: 'user',
        ident: user ? user.id : ident,
        rate: this.rates.user as string,
      });
    // ScopedRateThrottle: only on a view that names a scope.
    if (scope)
      buckets.push({ scope, ident: user ? user.id : ident, rate: this.rates[scope] as string });

    const waits: (number | null)[] = [];
    await this.redis.ensureConnected();
    const now = Date.now() / 1000;
    for (const bucket of buckets) {
      const { requests, seconds } = parseRate(bucket.rate);
      const [allowed, length, oldest] = (await this.redis.client.eval(
        SLIDING_WINDOW,
        1,
        `rangon:nest:throttle_${bucket.scope}_${bucket.ident}`,
        String(now),
        String(seconds),
        String(requests),
      )) as [number, number, string];
      if (!allowed) {
        // `SimpleRateThrottle.wait()`.
        const remaining = length ? seconds - (now - Number(oldest)) : seconds;
        const available = requests - length + 1;
        waits.push(available <= 0 ? null : remaining / available);
      }
    }
    if (!waits.length) return;

    const known = waits.filter((wait): wait is number => wait !== null);
    if (!known.length) throw new RateLimited('Request was throttled.');
    const seconds = Math.ceil(Math.max(...known));
    throw new RateLimited(
      `Request was throttled. Expected available in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
    );
  }
}

@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly throttles: Throttles,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.throttles.check(
      context.switchToHttp().getRequest<FastifyRequest>(),
      throttleMeta(this.reflector, [context.getHandler(), context.getClass()]),
    );
    return true;
  }
}
