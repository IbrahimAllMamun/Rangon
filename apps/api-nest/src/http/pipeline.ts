import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';

import type { Env } from '../config/env';
import { csrfFailurePage, csrfRejection } from './csrf';
import type { RouteRegistry } from './routes';
import {
  acceptedHost,
  BAD_REQUEST_PAGE,
  isSecure,
  NOT_FOUND_PAGE,
  splitDomainPort,
  validateHost,
} from '../common/http';

/**
 * The Django API's middleware stack, in its order, as Fastify hooks.
 *
 *   RequestIDMiddleware -> CorsMiddleware -> SecurityMiddleware -> CommonMiddleware
 *   -> ... -> XFrameOptionsMiddleware
 *
 * The order is observable: a CORS preflight is answered before the host is
 * checked, an HTTP request is redirected to HTTPS before its host is checked
 * for anything else, and the security headers are on every response except
 * the preflight's.
 */

const CORS_ALLOW_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'origin',
  'user-agent',
  'x-requested-with',
  'x-request-id',
  'idempotency-key',
  'x-cart-token',
].join(', ');
const CORS_ALLOW_METHODS = 'DELETE, GET, OPTIONS, PATCH, POST, PUT';
const HSTS = 'max-age=31536000; includeSubDomains; preload';

/** `RequestIDMiddleware`: accept the client's id (64 characters at most) or mint one. */
export function genRequestId(request: IncomingMessage): string {
  const header = request.headers['x-request-id'];
  const incoming = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  // Python slices code points, not UTF-16 units.
  return incoming ? Array.from(incoming).slice(0, 64).join('') : randomUUID().replaceAll('-', '');
}

/**
 * Responses the middleware gives before any view runs (a preflight, a
 * redirect, a refused host) carry no view headers: DRF adds `Allow` only to
 * what a view returned.
 */
export function markShortCircuit(request: FastifyRequest): void {
  (request as FastifyRequest & { shortCircuit?: boolean }).shortCircuit = true;
}

function isShortCircuit(request: FastifyRequest): boolean {
  return Boolean((request as FastifyRequest & { shortCircuit?: boolean }).shortCircuit);
}

export function installPipeline(fastify: FastifyInstance, env: Env, routes: RouteRegistry): void {
  const allowCache = new Map<string, string | null>();

  fastify.addHook('onRequest', async (request, reply) => {
    // CorsMiddleware answers every preflight itself, on any path.
    if (
      request.method === 'OPTIONS' &&
      request.headers['access-control-request-method'] !== undefined
    ) {
      markShortCircuit(request);
      applyCors(request, reply, env, true);
      return reply
        .status(200)
        .header('x-request-id', request.id)
        .header('vary', 'origin')
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-length', '0')
        .send('');
    }

    // SecurityMiddleware: redirect to HTTPS (whose host lookup can itself refuse).
    if (env.sslRedirect && !isSecure(request, env)) {
      markShortCircuit(request);
      const host = acceptedHost(request, env);
      if (host === null) return badRequest(reply);
      return permanentRedirect(reply, `https://${host}${request.raw.url ?? request.url}`);
    }

    // CommonMiddleware: `request.get_host()` refuses a host not in ALLOWED_HOSTS.
    const [domain] = splitDomainPort(request.headers.host ?? '');
    if (!domain || !validateHost(domain, env.allowedHosts)) {
      markShortCircuit(request);
      return badRequest(reply);
    }

    // An empty `Content-Type` on a request with no body: Django has nothing
    // to parse and never looks at it, where Fastify would refuse the header.
    if (
      request.headers['content-type'] === '' &&
      (request.headers['content-length'] ?? '0') === '0' &&
      request.headers['transfer-encoding'] === undefined
    ) {
      delete request.headers['content-type'];
    }

    // CommonMiddleware again: APPEND_SLASH, for any method -- it runs before
    // the resolver knows whether the view takes the method. Nest registers
    // paths without their trailing slash and Fastify is told to ignore it,
    // so a path any route matches is one Django knows with the slash. Every
    // Django route ends in `/` except the product feeds, whose last segment
    // is a file name.
    const url = request.raw.url ?? request.url;
    const question = url.indexOf('?');
    const path = question === -1 ? url : url.slice(0, question);
    const matched = routes.match(path);
    if (matched.length) {
      const fileRoute = matched.some((route) => FILE_ROUTE.test(route.pattern));
      if (!fileRoute && !path.endsWith('/')) {
        markShortCircuit(request);
        return permanentRedirect(reply, `${path}/${question === -1 ? '' : url.slice(question)}`);
      }
      if (fileRoute && path.endsWith('/')) {
        markShortCircuit(request);
        return reply
          .status(404)
          .header('content-type', 'text/html; charset=utf-8')
          .send(NOT_FOUND_PAGE);
      }
      // `require_GET`: Fastify answers HEAD with the GET route; Django's
      // plain views refuse it. (Other methods reach no route at all and are
      // answered by the exception filter, with `plainViewRefusal`.)
      if (request.method === 'HEAD' && matched.some((route) => PLAIN_VIEWS.has(route.pattern))) {
        return plainViewRefusal(request, reply, env);
      }
    }
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    if (reply.getHeader('access-control-allow-origin') === undefined)
      applyCors(request, reply, env, false);

    const isApi = (request.routeOptions.url ?? '').startsWith('/api/v1/');
    const vary = isApi ? (env.production ? 'Cookie, origin' : 'Accept, Cookie, origin') : 'origin';
    if (reply.getHeader('vary') === undefined) reply.header('vary', vary);

    setDefault(reply, 'x-frame-options', 'DENY');
    setDefault(reply, 'x-content-type-options', 'nosniff');
    setDefault(reply, 'referrer-policy', env.referrerPolicy);
    setDefault(reply, 'cross-origin-opener-policy', 'same-origin');
    if (env.production && isSecure(request, env))
      setDefault(reply, 'strict-transport-security', HSTS);

    // DRF puts `Allow` on every response a view gives.
    if (isApi && !isShortCircuit(request) && reply.getHeader('allow') === undefined) {
      const allow = allowedMethods(fastify, request.routeOptions.url ?? '', allowCache);
      if (allow) reply.header('allow', allow);
    }
    return payload;
  });
}

/** `HttpResponsePermanentRedirect`: 301, an empty HTML body, the target in Location. */
function permanentRedirect(reply: FastifyReply, location: string): FastifyReply {
  return reply
    .status(301)
    .header('location', location)
    .header('content-type', 'text/html; charset=utf-8')
    .send('');
}

function setDefault(reply: FastifyReply, name: string, value: string): void {
  if (reply.getHeader(name) === undefined) reply.header(name, value);
}

function badRequest(reply: FastifyReply): FastifyReply {
  return reply
    .status(400)
    .header('content-type', 'text/html; charset=utf-8')
    .send(BAD_REQUEST_PAGE);
}

/** corsheaders' `add_response_headers`: nothing unless the origin is allowed. */
function applyCors(
  request: FastifyRequest,
  reply: FastifyReply,
  env: Env,
  preflight: boolean,
): void {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return;
  }
  const allowed =
    env.corsAllowAllOrigins ||
    env.DJANGO_CORS_ALLOWED_ORIGINS.some((entry) => {
      try {
        const candidate = new URL(entry);
        return candidate.protocol === parsed.protocol && candidate.host === parsed.host;
      } catch {
        return false;
      }
    });
  if (!allowed) return;

  // CORS_ALLOW_CREDENTIALS = True, so the origin is echoed rather than `*`.
  reply.header('access-control-allow-origin', origin);
  reply.header('access-control-allow-credentials', 'true');
  if (preflight || request.method === 'OPTIONS') {
    reply.header('access-control-allow-headers', CORS_ALLOW_HEADERS);
    reply.header('access-control-allow-methods', CORS_ALLOW_METHODS);
    reply.header('access-control-max-age', '86400');
  }
}

const FILE_ROUTE = /\.[a-z0-9]+$/i;

/**
 * The plain Django views: function views under `require_GET`, not DRF
 * views, so CSRF-checked and answering nothing but GET.
 */
export const PLAIN_VIEWS = new Set(['/api/health', '/api/ready']);

/**
 * A plain view asked for anything but GET: an unsafe method meets
 * `CsrfViewMiddleware` first (403, Django's page), and whatever passes it
 * meets `require_GET` -- 405, an empty HTML body, `Allow: GET`.
 */
export function plainViewRefusal(
  request: FastifyRequest,
  reply: FastifyReply,
  env: Env,
): FastifyReply {
  markShortCircuit(request);
  const safe = ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(request.method);
  const rejection = safe ? null : csrfRejection(request, env);
  if (rejection) {
    return reply
      .status(403)
      .header('content-type', 'text/html; charset=utf-8')
      .send(csrfFailurePage(rejection));
  }
  return reply
    .status(405)
    .header('allow', 'GET')
    .header('content-type', 'text/html; charset=utf-8')
    .send('');
}

const DRF_METHOD_ORDER: HTTPMethods[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * DRF's `allowed_methods` for the view at this route pattern: its handlers in
 * `http_method_names` order, then HEAD (Django answers HEAD with GET) and
 * OPTIONS (every APIView has it). Null when no route has that pattern.
 */
export function allowedMethods(
  fastify: FastifyInstance,
  pattern: string,
  cache: Map<string, string | null>,
): string | null {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  const methods = DRF_METHOD_ORDER.filter((method) => fastify.hasRoute({ url: pattern, method }));
  const allow = methods.length
    ? [...methods, ...(methods.includes('GET') ? ['HEAD'] : []), 'OPTIONS'].join(', ')
    : null;
  cache.set(pattern, allow);
  return allow;
}
