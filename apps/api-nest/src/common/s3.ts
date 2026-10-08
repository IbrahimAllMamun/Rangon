/**
 * Object storage, as django-storages' `S3Storage` uses it with this
 * project's options (`config/settings/base.py`, the `USE_S3` branch):
 * `querystring_auth=False`, `file_overwrite=False`, `default_acl=None`, no
 * `location`, no custom domain.
 *
 * Three things, and no SDK. What an upload is called and where a browser
 * finds it are pure functions, compared with what `S3Storage.url` prints for
 * the same settings. Talking to the bucket is three requests -- HEAD, PUT and
 * GET of one object; nothing here deletes a file, as nothing in Django does
 * -- signed with AWS Signature Version 4, which is `node:crypto` and forty
 * lines. The AWS SDK's S3 client is 26 packages and 22 MB for the same three,
 * and would still not say what URL Django gives a file (ADR-0018).
 */
import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { pyNormpath } from './python';

export interface S3Settings {
  /** `S3_ENDPOINT`: any S3-compatible server; null for AWS itself. */
  endpoint: string | null;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** `S3_REGION`, `us-east-1` unless set: part of every signature. */
  region: string;
}

/** `storages.utils.clean_name`: the name normalised, a trailing slash kept. */
export function cleanName(name: string): string {
  let cleaned = pyNormpath(name).replaceAll('\\', '/');
  if (name.endsWith('/') && !cleaned.endsWith('/')) cleaned += '/';
  return cleaned === '.' ? '' : cleaned;
}

/**
 * `S3Storage._normalize_name(clean_name(name))` with no `location`: the
 * object's key. `safe_join` resolves the name under the root, so a leading
 * slash and any `..` are gone and nothing leaves the bucket's top.
 */
export function s3Key(name: string): string {
  const cleaned = cleanName(name);
  // `posixpath.join("/", path)`: an absolute path replaces the base.
  let joined = pyNormpath(cleaned.startsWith('/') ? cleaned : `/${cleaned}`);
  if (cleaned.endsWith('/') || `${joined}/` === '/') joined += '/';
  return joined.replace(/^\/+/, '');
}

/** botocore's `percent_encode(key, safe="/~")`: RFC 3986, the slashes left alone. */
export function encodeKey(key: string): string {
  let out = '';
  for (const byte of Buffer.from(key, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~/]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The endpoint rules' `isVirtualHostableS3Bucket`: a name that can be a DNS
 * label -- 3 to 63 lower-case letters, digits and hyphens, starting and
 * ending with a letter or digit.
 */
function virtualHostable(bucket: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket);
}

function trimSlashes(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * `S3Storage.url(name)`: where a browser finds an object, unsigned.
 *
 * A custom endpoint is always addressed by path: `<endpoint>/<bucket>/<key>`.
 * AWS itself is addressed by host where the bucket's name can be one -- at
 * the global endpoint, whatever the region, which is what boto's unsigned
 * client presigns -- and by path, at the region's endpoint, where it cannot.
 */
export function s3ObjectUrl(settings: S3Settings, name: string): string {
  const key = encodeKey(s3Key(name));
  if (settings.endpoint) return `${trimSlashes(settings.endpoint)}/${settings.bucket}/${key}`;
  if (virtualHostable(settings.bucket)) return `https://${settings.bucket}.s3.amazonaws.com/${key}`;
  const host =
    settings.region === 'us-east-1' ? 's3.amazonaws.com' : `s3.${settings.region}.amazonaws.com`;
  return `https://${host}/${settings.bucket}/${key}`;
}

/** Where a signed request for an object is sent: its origin and its path. */
function target(settings: S3Settings, key: string): URL {
  const encoded = encodeKey(key);
  if (settings.endpoint) {
    return new URL(`${trimSlashes(settings.endpoint)}/${settings.bucket}/${encoded}`);
  }
  // The region's own endpoint: a signature names the region, and the global
  // endpoint answers for one region only.
  const regional =
    settings.region === 'us-east-1' ? 's3.amazonaws.com' : `s3.${settings.region}.amazonaws.com`;
  return virtualHostable(settings.bucket)
    ? new URL(`https://${settings.bucket}.${regional}/${encoded}`)
    : new URL(`https://${regional}/${settings.bucket}/${encoded}`);
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

export interface SignedRequest {
  method: string;
  url: URL;
  /** Lower-case names. `host`, `x-amz-date` and `x-amz-content-sha256` are added. */
  headers: Record<string, string>;
  body?: Buffer;
}

/**
 * AWS Signature Version 4 for one S3 request, the payload hashed whole:
 * the headers to send, `Authorization` among them. Every header given is
 * signed. `now` is the request's moment.
 */
export function signRequest(
  settings: Pick<S3Settings, 'accessKey' | 'secretKey' | 'region'>,
  request: SignedRequest,
  now: Date = new Date(),
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(request.body ?? '');
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] as string).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const query = Array.from(request.url.searchParams.entries())
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join('&');
  // S3 does not encode the path a second time: it is signed as it is sent.
  const canonical = [
    request.method,
    request.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${settings.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = ['s3', 'aws4_request'].reduce(
    (current, part) => hmac(current, part),
    hmac(hmac(`AWS4${settings.secretKey}`, date), settings.region),
  );
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${settings.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** What boto raises as a `ClientError` the caller does not expect: the status and S3's own code. */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly key: string,
    detail: string,
  ) {
    super(`S3 ${method} ${key}: ${status} ${detail}`.trim());
  }
}

export interface PutOptions {
  contentType: string;
  contentEncoding?: string | null;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * One request, the answer's bytes exactly as they came. Not `fetch`: it
 * unpacks a body whose `Content-Encoding` says gzip, and an object stored
 * with that header (a receipt named `scan.gz`) has to come back as stored.
 */
function exchange(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeoutMs: number,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      {
        method,
        headers: { ...headers, 'content-length': String(body?.length ?? 0) },
        timeout: timeoutMs,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const received: Record<string, string> = {};
          for (const [name, value] of Object.entries(incoming.headers)) {
            received[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers: received,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error(`S3 ${method} timed out`)));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/**
 * The three requests the storage makes. A fault on the way (no answer, a 5xx)
 * is tried again, twice, as boto's retries would; anything S3 decided is
 * raised as it came.
 */
export class S3Client {
  constructor(
    private readonly settings: S3Settings,
    private readonly timeoutMs = 60_000,
    /** The pause before a second try; doubled before a third. */
    private readonly backoffMs = 400,
  ) {}

  private async send(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Answer> {
    const url = target(this.settings, key);
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, this.backoffMs * attempt));
      try {
        const signed = signRequest(this.settings, { method, url, headers, body });
        const answer = await exchange(method, url, signed, body, this.timeoutMs);
        if (answer.status < 500) return answer;
        last = this.error(answer, method, key);
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private error(answer: Answer, method: string, key: string): S3Error {
    return new S3Error(answer.status, method, key, answer.body.toString('utf8').slice(0, 300));
  }

  /** `head_object`: whether there is such an object. */
  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /** `upload_fileobj`: the object, whole, with its type. */
  async put(key: string, bytes: Buffer, options: PutOptions): Promise<void> {
    const headers: Record<string, string> = { 'content-type': options.contentType };
    if (options.contentEncoding) headers['content-encoding'] = options.contentEncoding;
    const answer = await this.send('PUT', key, headers, bytes);
    if (answer.status >= 300) throw this.error(answer, 'PUT', key);
  }

  /** `download_fileobj`: the bytes as stored, or null where there is no such object. */
  async get(key: string): Promise<Buffer | null> {
    const answer = await this.send('GET', key);
    if (answer.status === 404) return null;
    if (answer.status >= 300) throw this.error(answer, 'GET', key);
    return answer.body;
  }

  /** `head_object`, for what was stored with the bytes: null where there is no such object. */
  async head(
    key: string,
  ): Promise<{ contentType: string | null; contentEncoding: string | null; size: number } | null> {
    const answer = await this.send('HEAD', key);
    if (answer.status === 404) return null;
    if (answer.status >= 300) throw this.error(answer, 'HEAD', key);
    return {
      contentType: answer.headers['content-type'] ?? null,
      contentEncoding: answer.headers['content-encoding'] ?? null,
      size: Number(answer.headers['content-length'] ?? 0),
    };
  }
}
