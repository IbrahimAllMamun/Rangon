/**
 * Django's `CsrfViewMiddleware`, for the only views here it guards: the
 * plain (non-DRF) health checks. DRF views are `csrf_exempt`, so the API
 * proper never meets it. An unsafe method on a plain view is checked before
 * the view runs -- the `Origin` header, then over HTTPS the `Referer`, then the
 * `csrftoken` cookie against the token sent with the request -- and a refusal
 * is Django's own 403 page (`django.views.csrf.csrf_failure` with DEBUG off),
 * which explains a missing cookie or a missing Referer and nothing else.
 */
import type { FastifyRequest } from 'fastify';

import { acceptedHost, isSecure } from '../common/http';
import { parseQsl } from '../common/python';
import type { Env } from '../config/env';
import { RawBody } from './request-body';

export type CsrfRejection = 'generic' | 'cookie' | 'referer';

const PAGE_HEAD =
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta http-equiv="content-type" content="text/html; charset=utf-8">\n  <meta name="robots" content="NONE,NOARCHIVE">\n  <title>403 Forbidden</title>\n  <style>\n    html * { padding:0; margin:0; }\n    body * { padding:10px 20px; }\n    body * * { padding:0; }\n    body { font-family: sans-serif; background:#eee; color:#000; }\n    body>div { border-bottom:1px solid #ddd; }\n    h1 { font-weight:normal; margin-bottom:.4em; }\n    h1 span { font-size:60%; color:#666; font-weight:normal; }\n    #info { background:#f6f6f6; }\n    #info ul { margin: 0.5em 4em; }\n    #info p, #summary p { padding-top:10px; }\n    #summary { background: #ffc; }\n    #explanation { background:#eee; border-bottom: 0px none; }\n  </style>\n</head>\n<body>\n<div id="summary">\n  <h1>Forbidden <span>(403)</span></h1>\n  <p>CSRF verification failed. Request aborted.</p>';
const PAGE_TAIL =
  '</div>\n\n<div id="explanation">\n  <p><small>More information is available with DEBUG=True.</small></p>\n</div>\n\n</body>\n</html>\n';
const EXPLANATIONS: Record<CsrfRejection, string> = {
  generic: '\n\n\n',
  cookie:
    '\n\n\n  <p>You are seeing this message because this site requires a CSRF cookie when submitting forms. This cookie is required for security reasons, to ensure that your browser is not being hijacked by third parties.</p>\n  <p>If you have configured your browser to disable cookies, please re-enable them, at least for this site, or for “same-origin” requests.</p>\n\n',
  referer:
    '\n\n  <p>You are seeing this message because this HTTPS site requires a “Referer header” to be sent by your web browser, but none was sent. This header is required for security reasons, to ensure that your browser is not being hijacked by third parties.</p>\n  <p>If you have configured your browser to disable “Referer” headers, please re-enable them, at least for this site, or for HTTPS connections, or for “same-origin” requests.</p>\n  <p>If you are using the &lt;meta name=&quot;referrer&quot; content=&quot;no-referrer&quot;&gt; tag or including the “Referrer-Policy: no-referrer” header, please remove them. The CSRF protection requires the “Referer” header to do strict referer checking. If you’re concerned about privacy, use alternatives like &lt;a rel=&quot;noreferrer&quot; …&gt; for links to third-party sites.</p>\n\n\n',
};

/** `csrf_failure(request, reason)`: the page for this kind of refusal. */
export function csrfFailurePage(rejection: CsrfRejection): string {
  return PAGE_HEAD + EXPLANATIONS[rejection] + PAGE_TAIL;
}

const CSRF_SECRET_LENGTH = 32;
const CSRF_TOKEN_LENGTH = 64;
const CSRF_ALLOWED_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** `_check_token_format`: 32 or 64 letters and digits. */
function wellFormed(token: string): boolean {
  return (
    (token.length === CSRF_SECRET_LENGTH || token.length === CSRF_TOKEN_LENGTH) &&
    /^[a-zA-Z0-9]*$/.test(token)
  );
}

/** `_unmask_cipher_token`: the secret a 64-character masked token carries. */
export function unmask(token: string): string {
  const mask = token.slice(0, CSRF_SECRET_LENGTH);
  const cipher = token.slice(CSRF_SECRET_LENGTH);
  let secret = '';
  for (let i = 0; i < cipher.length; i++) {
    const x = CSRF_ALLOWED_CHARS.indexOf(cipher[i] as string);
    const y = CSRF_ALLOWED_CHARS.indexOf(mask[i] as string);
    secret += CSRF_ALLOWED_CHARS[(x - y + 62) % 62];
  }
  return secret;
}

/** `django.http.parse_cookie`: `;`-separated, stripped, the last of a name winning. */
export function parseCookie(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const chunk of header.split(';')) {
    const at = chunk.indexOf('=');
    const key = (at === -1 ? '' : chunk.slice(0, at)).trim();
    let value = (at === -1 ? chunk : chunk.slice(at + 1)).trim();
    if (!key && !value) continue;
    // `http.cookies._unquote`: a quoted value loses its quotes and escapes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\([0-3][0-7][0-7])/g, (_, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        )
        .replace(/\\(.)/g, '$1');
    }
    cookies.set(key, value);
  }
  return cookies;
}

/** `urllib.parse.urlsplit`'s scheme and netloc, or null where it raises. */
function splitUrl(url: string): { scheme: string; netloc: string } | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(url);
  const scheme = match ? (match[1] as string).toLowerCase() : '';
  const rest = match ? (match[2] as string) : url;
  if (!rest.startsWith('//')) return { scheme, netloc: '' };
  const netloc = rest.slice(2).split(/[/?#]/)[0] as string;
  // An unbalanced IPv6 bracket is Python's "Invalid IPv6 URL".
  if (netloc.includes('[') !== netloc.includes(']')) return null;
  return { scheme, netloc };
}

/** `django.utils.http.is_same_domain`. */
function isSameDomain(host: string, pattern: string): boolean {
  if (!pattern) return false;
  const lower = pattern.toLowerCase();
  return (
    (lower.startsWith('.') && (host.endsWith(lower) || host === lower.slice(1))) || lower === host
  );
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * `CsrfViewMiddleware.process_view` for an unsafe method on a plain view:
 * why Django refuses it, or null when it passes on to the view.
 */
export function csrfRejection(request: FastifyRequest, env: Env): CsrfRejection | null {
  const trusted = env.DJANGO_CSRF_TRUSTED_ORIGINS;
  const origin = header(request, 'origin');
  if (origin !== undefined) {
    const host = acceptedHost(request, env);
    const good = host === null ? null : `${isSecure(request, env) ? 'https' : 'http'}://${host}`;
    const exact = trusted.filter((entry) => !entry.includes('*'));
    let verified = origin === good || exact.includes(origin);
    if (!verified) {
      const parsed = splitUrl(origin);
      verified =
        parsed !== null &&
        trusted
          .filter((entry) => entry.includes('*'))
          .map((entry) => splitUrl(entry))
          .some(
            (entry) =>
              entry !== null &&
              entry.scheme === parsed.scheme &&
              isSameDomain(parsed.netloc, entry.netloc.replace(/^\*+/, '')),
          );
    }
    if (!verified) return 'generic';
  } else if (isSecure(request, env)) {
    const referer = header(request, 'referer');
    if (referer === undefined) return 'referer';
    const parsed = splitUrl(referer);
    if (parsed === null || parsed.scheme === '' || parsed.netloc === '') return 'generic';
    if (parsed.scheme !== 'https') return 'generic';
    const trustedHosts = trusted.map((entry) =>
      (splitUrl(entry)?.netloc ?? '').replace(/^\*+/, ''),
    );
    if (!trustedHosts.some((host) => isSameDomain(parsed.netloc, host))) {
      const host = acceptedHost(request, env);
      if (host === null || !isSameDomain(parsed.netloc, host)) return 'generic';
    }
  }

  const cookie = parseCookie(header(request, 'cookie') ?? '').get('csrftoken');
  if (cookie === undefined) return 'cookie';
  if (!wellFormed(cookie)) return 'generic';
  const secret = cookie.length === CSRF_TOKEN_LENGTH ? unmask(cookie) : cookie;

  let token = '';
  if (request.method === 'POST' && request.body instanceof RawBody) {
    const type = (request.body.contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === 'application/x-www-form-urlencoded') {
      const fields = parseQsl(request.body.bytes.toString('utf8')).filter(
        ([name]) => name === 'csrfmiddlewaretoken',
      );
      token = fields.length ? (fields[fields.length - 1]?.[1] ?? '') : '';
    }
  }
  if (token === '') {
    const sent = header(request, 'x-csrftoken');
    if (sent === undefined) return 'generic';
    token = sent;
  }
  if (!wellFormed(token)) return 'generic';
  const candidate = token.length === CSRF_TOKEN_LENGTH ? unmask(token) : token;
  return candidate === secret ? null : 'generic';
}
