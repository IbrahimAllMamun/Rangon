import type { FastifyRequest } from 'fastify';

import type { Env } from '../config/env';

/**
 * Request facts computed the way Django computes them: the host it will
 * accept, whether the request counts as secure, and the absolute URL DRF
 * builds pagination links from.
 */

const HOST_PATTERN = /^([a-z0-9.-]+|\[[a-f0-9]*:[a-f0-9.:]+\])(:[0-9]+)?$/;

/** `django.http.request.split_domain_port`. */
export function splitDomainPort(host: string): [string, string] {
  const lowered = host.toLowerCase();
  if (!HOST_PATTERN.test(lowered)) return ['', ''];
  if (lowered.endsWith(']')) return [lowered, ''];
  const colon = lowered.lastIndexOf(':');
  const domain = colon === -1 ? lowered : lowered.slice(0, colon);
  const port = colon === -1 ? '' : lowered.slice(colon + 1);
  return [domain.endsWith('.') ? domain.slice(0, -1) : domain, port];
}

/** `django.http.request.validate_host`. */
export function validateHost(domain: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((raw) => {
    if (raw === '*') return true;
    const pattern = raw.toLowerCase();
    if (!pattern) return false;
    return pattern.startsWith('.')
      ? domain.endsWith(pattern) || domain === pattern.slice(1)
      : domain === pattern;
  });
}

/** `HttpRequest.get_host()`, or null where Django raises `DisallowedHost`. */
export function acceptedHost(request: FastifyRequest, env: Env): string | null {
  const host = request.headers.host ?? '';
  const [domain] = splitDomainPort(host);
  return domain && validateHost(domain, env.allowedHosts) ? host : null;
}

/** `HttpRequest.is_secure()`, honouring `SECURE_PROXY_SSL_HEADER` in production. */
export function isSecure(request: FastifyRequest, env: Env): boolean {
  if (env.trustForwardedProto) {
    const header = request.headers['x-forwarded-proto'];
    const value = Array.isArray(header) ? header[0] : header;
    // Django compares the first comma-separated value, stripped.
    return (value ?? '').split(',')[0]?.trim() === 'https';
  }
  return request.protocol === 'https';
}

/** `request.build_absolute_uri()`: scheme, the accepted host, the path and the raw query. */
export function absoluteUri(request: FastifyRequest, env: Env): string {
  const scheme = isSecure(request, env) ? 'https' : 'http';
  const raw = request.raw.url ?? request.url;
  return `${scheme}://${request.headers.host ?? ''}${raw}`;
}

/** Django's built-in error pages (`django.views.defaults.ERROR_PAGE_TEMPLATE`). */
export function djangoErrorPage(title: string, details: string): string {
  return `
<!doctype html>
<html lang="en">
<head>
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1><p>${details}</p>
</body>
</html>
`;
}

export const NOT_FOUND_PAGE = djangoErrorPage(
  'Not Found',
  'The requested resource was not found on this server.',
);
export const BAD_REQUEST_PAGE = djangoErrorPage('Bad Request (400)', '');
