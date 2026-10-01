import type { FastifyInstance, FastifyRequest } from 'fastify';

import { BusinessError, ValidationError } from '../common/errors';
import { PyFloat, pyIntText } from '../common/python';
import { HtmlInput, parseMultipart, parseUrlencoded } from './multipart';

/**
 * Request bodies as DRF's `request.data` reads them.
 *
 * Fastify parses a body before the handler runs and refuses what it cannot
 * parse. DRF parses on first access to `request.data`, after authentication,
 * permissions and throttling, and a view that never reads it never refuses a
 * malformed body. So every body is kept as bytes here, and `requestData()`
 * parses it the first time a handler asks, with DRF's rules:
 *
 * - no body (Content-Length 0): an empty dict, whatever the Content-Type says;
 * - `application/json`: parsed, with Python's `json` types -- `4.0` is a
 *   float and `4` an int, which `str()` and `int()` tell apart (`PyFloat`);
 *   an integer past 2^53 is exact (a `bigint`);
 * - anything else, a missing Content-Type included: 415.
 *
 * DRF also parses form and multipart bodies. Nothing sends this API either
 * (the web app posts JSON), so they are refused with the same 415 -- a
 * documented difference (docs/architecture/nest-port.md).
 */

export class RawBody {
  constructor(
    readonly contentType: string | undefined,
    readonly bytes: Buffer,
  ) {}
}

export class UnsupportedMediaType extends BusinessError {
  static override code = 'UNSUPPORTED_MEDIA_TYPE';
  static override statusCode = 415;

  constructor(contentType: string) {
    super(`Unsupported media type "${contentType}" in request.`);
  }
}

/** Replace Fastify's parsers with one that keeps the bytes for `requestData()`. */
export function installBodyCapture(fastify: FastifyInstance): void {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    done(null, new RawBody(request.headers['content-type'], body as Buffer));
  });
}

const PARSED = Symbol('rangon.request-data');

/**
 * `request.data`: parsed on first use, then the same value every time.
 * `forms` lets a view that takes uploads read form bodies too (an
 * `HtmlInput`), as every DRF view can; the others still refuse them.
 */
export function requestData(request: FastifyRequest, options: { forms?: boolean } = {}): unknown {
  const holder = request as FastifyRequest & { [PARSED]?: unknown };
  if (!(PARSED in holder))
    holder[PARSED] = parse(request.body, options.forms ?? false, request.headers['content-type']);
  return holder[PARSED];
}

function isFormType(type: string): boolean {
  return type === 'multipart/form-data' || type === 'application/x-www-form-urlencoded';
}

function parse(body: unknown, forms: boolean, requestType: string | undefined): unknown {
  const header = body instanceof RawBody ? (body.contentType ?? '') : (requestType ?? '');
  const [type = '', ...params] = header.split(';');
  const mediaType = type.trim().toLowerCase();
  // GET and HEAD bodies are never read, by either API; a request without a
  // body at all never reaches the parser. An empty form body is an empty
  // QueryDict, which a serializer reads with form rules.
  if (!(body instanceof RawBody) || body.bytes.length === 0) {
    return forms && isFormType(mediaType) ? new HtmlInput() : {};
  }
  if (forms && mediaType === 'multipart/form-data') return parseMultipart(header, body.bytes);
  if (forms && mediaType === 'application/x-www-form-urlencoded')
    return parseUrlencoded(body.bytes);
  if (mediaType !== 'application/json') throw new UnsupportedMediaType(header);

  const charset = params
    .map((param) => param.split('='))
    .find(([name]) => name?.trim().toLowerCase() === 'charset')?.[1]
    ?.trim()
    .replace(/^"|"$/g, '');
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    // `ignoreBOM` keeps a byte-order mark in the text, as Python's utf-8
    // reader does -- and `json` then refuses it. A charset nobody knows is
    // ignored, as Django ignores it.
    decoder = new TextDecoder(charset || 'utf-8', { fatal: true, ignoreBOM: true });
  } catch {
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  }
  let text: string;
  try {
    text = decoder.decode(body.bytes);
  } catch (error) {
    throw new ValidationError(`JSON parse error - ${(error as Error).message}`);
  }
  return parsePythonJson(text);
}

/**
 * `json.loads(text)` with Python's types: ints stay ints (exact past 2^53, as
 * a bigint), floats become `PyFloat`. A malformed document is DRF's
 * `ParseError`: 400 `VALIDATION_ERROR`. Its message is the parser's own, which
 * is not Python's wording.
 */
export function parsePythonJson(text: string): unknown {
  try {
    return JSON.parse(text, function (_key, value: unknown, context?: { source?: string }) {
      if (typeof value !== 'number' || context?.source === undefined) return value;
      const source = context.source;
      if (/[.eE]/.test(source)) return new PyFloat(value);
      return Number.isSafeInteger(value) ? value : BigInt(source);
    });
  } catch (error) {
    throw new ValidationError(`JSON parse error - ${(error as Error).message}`);
  }
}

/** `dict.get(key)` on `request.data`, where Django calls it on whatever was parsed. */
export function dataGet(data: unknown, key: string): unknown {
  // `request.data.get(...)` on a JSON list or null is an AttributeError in the
  // Django API: a 500. Reproduced rather than improved, so the two agree until
  // Django is fixed.
  if (!isDict(data)) throw new TypeError(`'${pythonTypeName(data)}' object has no attribute 'get'`);
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

export function isDict(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat)
  );
}

/** `type(value).__name__` for a parsed JSON value. */
export function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number' || typeof value === 'bigint') return 'int';
  if (value instanceof PyFloat) return 'float';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

/** Python truthiness of a parsed JSON value: `if token:`. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === '' || value === 0 || value === 0n) return false;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Python `int(value)` on a parsed JSON value, as `int(request.data.get(...))`
 * applies it: exact (a bigint past 2^53), a float truncated toward zero, a
 * bool as 0 or 1, a str by Python's own rules. Where Python raises -- None, a
 * list, "5.0" -- this throws a plain error, and the request is a 500 as it is
 * in the Django API.
 */
export function pyIntOf(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (value instanceof PyFloat) {
    if (!Number.isFinite(value.value)) throw new Error('cannot convert float to integer');
    return BigInt(Math.trunc(value.value));
  }
  if (typeof value === 'string') {
    const parsed = pyIntText(value);
    if (parsed === null)
      throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(value)}`);
    return parsed;
  }
  throw new TypeError(
    `int() argument must be a string or a number, not '${pythonTypeName(value)}'`,
  );
}

/**
 * Let a bigint reach a JSON response as the exact integer Python would write,
 * not a TypeError: `JSON.rawJSON` emits its digits verbatim. Installed once, at start.
 */
export function installBigIntJson(): void {
  const raw = (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON;
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value(this: bigint) {
      return raw(this.toString());
    },
    configurable: true,
  });
}
