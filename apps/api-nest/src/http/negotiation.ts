/**
 * DRF's `DefaultContentNegotiation.select_renderer`, which `APIView.initial`
 * runs before it authenticates, checks a permission, throttles or looks for
 * the method's handler. So on every DRF view:
 *
 * - `?format=` naming a format none of the view's renderers has is a 404
 *   (`filter_renderers` raises `Http404`); a blank one is no format at all;
 * - an `Accept` header none of the renderers satisfies is a 406, which
 *   `core.handlers` has no code for and answers as `SERVER_ERROR`,
 *   "Unexpected error.".
 *
 * The media types are read as `rest_framework.utils.mediatypes` reads them:
 * Django's `parse_header_parameters`, a `*` on either side matching anything,
 * the most specific type the client named tried first, and `q` ignored.
 *
 * The plain Django views (the health checks) negotiate nothing.
 */
import type { FastifyRequest } from 'fastify';

import { BusinessError, NotFound } from '../common/errors';
import { pyStrip } from '../common/python';
import { QueryDict } from '../common/query-dict';
import type { Env } from '../config/env';

export interface Renderer {
  format: string;
  mediaType: string;
}

export const JSON_RENDERER: Renderer = { format: 'json', mediaType: 'application/json' };
/**
 * `BrowsableAPIRenderer`, which every settings module but production's adds.
 * This API has no HTML pages: a request that negotiates it is answered in
 * JSON (docs/architecture/nest-port.md, "Deliberate differences").
 */
export const BROWSABLE_RENDERER: Renderer = { format: 'api', mediaType: 'text/html' };

/** `exceptions.NotAcceptable`, as `core.handlers` answers what it has no code for. */
export class NotAcceptable extends BusinessError {
  static override code = 'SERVER_ERROR';
  static override statusCode = 406;
  static override defaultMessage = 'Unexpected error.';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** `request.accepted_renderer`: set once the request's format is negotiated. */
    acceptedRenderer?: Renderer;
  }
}

/** Route prefix (`/api/v1/reports/`) to the `renderer_classes` its views declare. */
const VIEW_RENDERERS = new Map<string, readonly Renderer[]>();

/** `renderer_classes = [...]` on the views served under `/api/v1/<base>/`. */
export function declareRenderers(base: string, renderers: readonly Renderer[]): void {
  VIEW_RENDERERS.set(`/api/v1/${base}/`, renderers);
}

/** A view's renderers: its own, else `DEFAULT_RENDERER_CLASSES`. */
export function renderersFor(pattern: string, env: Env): readonly Renderer[] {
  const path = pattern.endsWith('/') ? pattern : `${pattern}/`;
  let found: readonly Renderer[] | null = null;
  let length = 0;
  for (const [prefix, renderers] of VIEW_RENDERERS) {
    if (path.startsWith(prefix) && prefix.length > length) {
      found = renderers;
      length = prefix.length;
    }
  }
  return found ?? (env.production ? [JSON_RENDERER] : [JSON_RENDERER, BROWSABLE_RENDERER]);
}

interface MediaType {
  mainType: string;
  subType: string;
  /** The parameters' names, as the keys of Python's dict: each once. */
  params: string[];
}

/** Python's `str.count(needle, 0, end)`. */
function count(text: string, needle: string, end: number): number {
  let found = 0;
  let from = 0;
  const head = text.slice(0, end);
  for (;;) {
    const at = head.indexOf(needle, from);
    if (at === -1) return found;
    found += 1;
    from = at + needle.length;
  }
}

/** `django.utils.http._parseparam`: the parts between semicolons, quoted ones kept whole. */
function parseParam(line: string): string[] {
  const parts: string[] = [];
  let rest = `;${line}`;
  while (rest.startsWith(';')) {
    rest = rest.slice(1);
    let end = rest.indexOf(';');
    while (end > 0 && (count(rest, '"', end) - count(rest, '\\"', end)) % 2) {
      end = rest.indexOf(';', end + 1);
    }
    if (end < 0) end = rest.length;
    parts.push(pyStrip(rest.slice(0, end)));
    rest = rest.slice(end);
  }
  return parts;
}

/** `_MediaType(text)`: `parse_header_parameters`, then the type split at its slash. */
export function parseMediaType(text: string): MediaType {
  const [head = '', ...rest] = parseParam(text);
  const fullType = head.toLowerCase();
  const slash = fullType.indexOf('/');
  const params: string[] = [];
  for (const part of rest) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    let name = pyStrip(part.slice(0, equals)).toLowerCase();
    if (name.endsWith('*')) name = name.slice(0, -1);
    if (!params.includes(name)) params.push(name);
  }
  return {
    mainType: slash === -1 ? fullType : fullType.slice(0, slash),
    subType: slash === -1 ? '' : fullType.slice(slash + 1),
    params,
  };
}

/** `_MediaType.precedence`: 0 for anything, 3 for a type with parameters of its own. */
function precedence(media: MediaType): number {
  if (media.mainType === '*') return 0;
  if (media.subType === '*') return 1;
  if (!media.params.length || (media.params.length === 1 && media.params[0] === 'q')) return 2;
  return 3;
}

/** `media_type_matches(renderer.media_type, accepted)`: a renderer's type has no parameters. */
function satisfies(renderer: Renderer, accepted: MediaType): boolean {
  const offered = parseMediaType(renderer.mediaType);
  if (offered.subType !== '*' && accepted.subType !== '*' && accepted.subType !== offered.subType) {
    return false;
  }
  return (
    offered.mainType === '*' || accepted.mainType === '*' || accepted.mainType === offered.mainType
  );
}

/**
 * `select_renderer(request, renderers)`: the renderer for a `format` and an
 * `Accept` header, or the refusal. `accept` is undefined when the request
 * sent no such header, which is `*` + `/` + `*`; an empty one accepts nothing.
 */
export function selectRenderer(
  renderers: readonly Renderer[],
  format: string | undefined,
  accept: string | undefined,
): Renderer {
  let candidates = renderers;
  if (format) {
    candidates = renderers.filter((renderer) => renderer.format === format);
    if (!candidates.length) throw new NotFound();
  }
  const byPrecedence: MediaType[][] = [[], [], [], []];
  for (const token of (accept ?? '*/*').split(',')) {
    const media = parseMediaType(pyStrip(token));
    (byPrecedence[3 - precedence(media)] as MediaType[]).push(media);
  }
  for (const accepted of byPrecedence) {
    for (const renderer of candidates) {
      if (accepted.some((media) => satisfies(renderer, media))) return renderer;
    }
  }
  throw new NotAcceptable();
}

/** `perform_content_negotiation(request)` for the view at a route pattern. */
export function negotiate(request: FastifyRequest, pattern: string, env: Env): Renderer {
  const accept = request.headers.accept;
  const renderer = selectRenderer(
    renderersFor(pattern, env),
    QueryDict.fromRequest(request).get('format'),
    Array.isArray(accept) ? accept.join(',') : accept,
  );
  request.acceptedRenderer = renderer;
  return renderer;
}
