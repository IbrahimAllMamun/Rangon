import { createReadStream } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { stat } from 'node:fs/promises';
import { posix } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { BAD_REQUEST_PAGE, djangoErrorPage, NOT_FOUND_PAGE } from '../common/http';
import { guessType } from '../common/mimetypes';
import { pyNormpath } from '../common/python';
import type { Env } from '../config/env';
import { csrfFailurePage, csrfRejection } from '../http/csrf';

/**
 * `core.media.serve_media`: an uploaded file from `MEDIA_ROOT`, at
 * `/media/<path>` (`config.urls`, mounted when `USE_S3` is off -- and this
 * API does not start with it on).
 *
 * A plain Django function view over `django.views.static.serve`, not a DRF
 * view: nothing is negotiated, nobody is authenticated and nothing is
 * throttled, so it is a Fastify route of its own rather than a controller
 * behind the guards. What follows from its being a function view is kept:
 * it answers any method with the file, an unsafe one only once
 * `CsrfViewMiddleware` has let it by, and its refusals are Django's HTML
 * pages.
 */

/**
 * `core.media.PRIVATE_PREFIXES`: uploads that are staff's business alone.
 * Receipts are reached through `GET /api/v1/expenses/<id>/attachment/`,
 * which checks who is asking (D91). Add a prefix here, there and in the
 * proxy's configuration when a new private upload appears.
 */
const PRIVATE_PREFIXES = ['expenses/'];

const SERVER_ERROR_PAGE = djangoErrorPage('Server Error (500)', '');

export { pyNormpath };

/** `core.media.is_private(path)`, for a path relative to `MEDIA_ROOT`. */
export function isPrivateMedia(path: string): boolean {
  const clean = pyNormpath(path).replace(/^\/+/, '');
  return PRIVATE_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

/**
 * `safe_join(root, path)`: the absolute path, or null where it would leave
 * the root -- Django's `SuspiciousFileOperation`, a 400.
 */
export function safeJoin(root: string, path: string): string | null {
  const base = pyNormpath(root);
  // `posixpath.join`: an absolute path replaces the base, and a base that ends in its slash adds none.
  const joined = path.startsWith('/') ? path : `${base}${base.endsWith('/') ? '' : '/'}${path}`;
  const final = pyNormpath(joined);
  if (!final.startsWith(`${base}/`) && final !== base && posix.dirname(base) !== base) return null;
  return final;
}

/**
 * The path as Django's resolver sees it: `PATH_INFO` percent-decoded by the
 * server, then read as UTF-8, a byte that is not UTF-8 put back as its
 * percent-escape (`repercent_broken_unicode`).
 */
export function decodePathInfo(raw: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const hex = raw[i] === '%' ? raw.slice(i + 1, i + 3) : '';
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      // Anything else is a byte of the request line as it came.
      bytes.push(...Buffer.from(raw[i] as string, 'latin1'));
    }
  }
  const strict = new TextDecoder('utf-8', { fatal: true });
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i] as number;
    const length = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
    let decoded: string | null = null;
    if (length && i + length <= bytes.length) {
      try {
        decoded = strict.decode(Uint8Array.from(bytes.slice(i, i + length)));
      } catch {
        decoded = null;
      }
    }
    if (decoded === null) {
      out += `%${lead.toString(16).toUpperCase().padStart(2, '0')}`;
      i += 1;
    } else {
      out += decoded;
      i += length;
    }
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Python's `\w`: any letter or number of any script, and the underscore.
const W = '[\\p{L}\\p{N}_]';
const TIME = '(?<hour>[0-9]{2}):(?<min>[0-9]{2}):(?<sec>[0-9]{2})';
const HTTP_DATES = [
  new RegExp(`^${W}{3}, (?<day>[0-9]{2}) (?<mon>${W}{3}) (?<year>[0-9]{4}) ${TIME} GMT$`, 'u'),
  new RegExp(`^${W}{6,9}, (?<day>[0-9]{2})-(?<mon>${W}{3})-(?<year>[0-9]{2}) ${TIME} GMT$`, 'u'),
  new RegExp(`^${W}{3} (?<mon>${W}{3}) (?<day>[ 0-9][0-9]) ${TIME} (?<year>[0-9]{4})$`, 'u'),
];

/**
 * `django.utils.http.parse_http_date`: seconds since the epoch, or null for
 * what it raises `ValueError` on -- no HTTP date, or one no calendar has.
 */
export function parseHttpDate(date: string, nowMs: number = Date.now()): number | null {
  const match = HTTP_DATES.map((pattern) => pattern.exec(date)).find(Boolean);
  if (!match?.groups) return null;
  let year = Number(match.groups.year);
  if (year < 100) {
    const current = new Date(nowMs).getUTCFullYear();
    const century = current - (current % 100);
    // Two digits more than fifty years ahead are read as the century before.
    year += year - (current % 100) > 50 ? century - 100 : century;
  }
  const month = MONTHS.indexOf((match.groups.mon as string).toLowerCase());
  // `int()` reads the day the asctime form pads with a space.
  const day = Number((match.groups.day as string).trim());
  const [hour, minute, second] = [match.groups.hour, match.groups.min, match.groups.sec].map(
    Number,
  );
  if (month === -1 || year < 1 || (hour as number) > 23 || (minute as number) > 59) return null;
  if ((second as number) > 59) return null;
  const moment = new Date(0);
  moment.setUTCFullYear(year, month, day);
  moment.setUTCHours(hour as number, minute as number, second as number, 0);
  // A day the month does not have rolls over in JavaScript; in Python it is refused.
  if (moment.getUTCMonth() !== month || moment.getUTCDate() !== day) return null;
  return Math.floor(moment.getTime() / 1000);
}

/** `urllib.parse.quote(text)`: everything but letters, digits and `_.-~/` percent-escaped. */
function pyQuote(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~/]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `content_disposition_header(False, filename)`: how `FileResponse` names what it sends. */
export function inlineDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex -- "ASCII" is the test Django makes
  return /^[\x00-\x7f]*$/.test(filename)
    ? `inline; filename="${filename.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : `inline; filename*=utf-8''${pyQuote(filename)}`;
}

function page(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.status(status).header('content-type', 'text/html; charset=utf-8').send(body);
}

async function serveMedia(request: FastifyRequest, reply: FastifyReply, env: Env) {
  // `CsrfViewMiddleware`, before the view: an unsafe method needs the token.
  if (!['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(request.method)) {
    const rejection = csrfRejection(request, env);
    if (rejection) return page(reply, 403, csrfFailurePage(rejection));
  }

  const url = (request.raw as MediaRequest).mediaUrl ?? request.raw.url ?? request.url;
  const question = url.indexOf('?');
  const path = decodePathInfo((question === -1 ? url : url.slice(0, question)).slice(7));
  if (isPrivateMedia(path)) return page(reply, 404, NOT_FOUND_PAGE);

  const full = safeJoin(env.MEDIA_ROOT, pyNormpath(path).replace(/^\/+/, ''));
  if (full === null) return page(reply, 400, BAD_REQUEST_PAGE);

  let file;
  try {
    file = await stat(full);
  } catch (error) {
    // `Path.is_dir()` and `.exists()` answer False for a name that is not
    // there, that runs through a file, that loops, or that holds a NUL.
    // Any other failure -- a name too long for the filesystem -- is raised,
    // and nothing catches it.
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const absent = ['ENOENT', 'ENOTDIR', 'ELOOP', 'EBADF', 'ERR_INVALID_ARG_VALUE'].includes(code);
    return absent ? page(reply, 404, NOT_FOUND_PAGE) : page(reply, 500, SERVER_ERROR_PAGE);
  }
  if (file.isDirectory()) return page(reply, 404, NOT_FOUND_PAGE);

  // `was_modified_since`: whole seconds, and anything unreadable means "yes".
  const modified = Math.floor(file.mtimeMs / 1000);
  const since = request.headers['if-modified-since'];
  const sinceSeconds = typeof since === 'string' ? parseHttpDate(since) : null;
  if (sinceSeconds !== null && modified <= sinceSeconds) {
    // `HttpResponseNotModified`: no body and no type; CommonMiddleware counts the nothing.
    return reply.status(304).header('content-length', '0').send();
  }

  const [type, encoding] = guessType(full);
  void reply
    .status(200)
    .header('content-type', type ?? 'application/octet-stream')
    .header('content-length', String(file.size))
    .header('content-disposition', inlineDisposition(posix.basename(full)))
    .header('last-modified', new Date(modified * 1000).toUTCString());
  if (encoding) void reply.header('content-encoding', encoding);
  if (request.method === 'HEAD') return reply.send();
  return reply.send(createReadStream(full));
}

type MediaRequest = IncomingMessage & { mediaUrl?: string };

/**
 * Fastify's `rewriteUrl`, for one case: a `/media/` path whose percent-escapes
 * are not UTF-8 (`%ff`). The router refuses such a URL before any route is
 * chosen (400, its own JSON); Django's resolver reads the bytes and finds no
 * such file. The path is handed to the router in a spelling it can read, and
 * the one that came is kept for the view.
 */
export function rewriteMediaUrl(request: IncomingMessage): string {
  const url = request.url ?? '/';
  if (!url.startsWith('/media/')) return url;
  const question = url.indexOf('?');
  const path = question === -1 ? url : url.slice(0, question);
  try {
    decodeURIComponent(path);
    return url;
  } catch {
    (request as MediaRequest).mediaUrl = url;
    return `/media/${encodeURIComponent(path.slice(7))}${question === -1 ? '' : url.slice(question)}`;
  }
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Mount `/media/`, as `config.urls` does beside the API. */
export function installMedia(fastify: FastifyInstance, env: Env): void {
  fastify.route({
    method: [...METHODS],
    url: '/media/*',
    handler: (request, reply) => serveMedia(request, reply, env),
  });
  // `^media/(?P<path>.*)$` needs its slash: without one CommonMiddleware's
  // APPEND_SLASH sends the client to `/media/`, whatever the method. (The
  // router ignores a trailing slash, so `/media/` itself arrives here too.)
  fastify.route({
    method: [...METHODS],
    url: '/media',
    handler: (request, reply) => {
      const url = request.raw.url ?? request.url;
      const question = url.indexOf('?');
      const path = question === -1 ? url : url.slice(0, question);
      if (path.endsWith('/')) return serveMedia(request, reply, env);
      return reply
        .status(301)
        .header('location', `${path}/${question === -1 ? '' : url.slice(question)}`)
        .header('content-type', 'text/html; charset=utf-8')
        .send('');
    },
  });
}
