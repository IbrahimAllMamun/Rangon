/**
 * Response comparison for the parity harness.
 *
 * JSON is compared by value: object key order is ignored (the web app reads
 * keys, not positions), array order is not (a list's order is part of what a
 * page shows). Numbers compare numerically, so Python's `450.0` equals `450`.
 */

export interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Difference {
  path: string;
  django: unknown;
  nest: unknown;
}

/** Paths are JSON-pointer-ish: `$.results[3].variants[0].price`. */
export function diffJson(a: unknown, b: unknown, path = '$', out: Difference[] = []): Difference[] {
  if (out.length > 50) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a !== b) out.push({ path, django: a, nest: b });
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push({ path, django: a, nest: b });
      return out;
    }
    if (a.length !== b.length)
      out.push({ path: `${path}.length`, django: a.length, nest: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      diffJson(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in left))
        out.push({ path: `${path}.${key}`, django: '<absent>', nest: right[key] });
      else if (!(key in right))
        out.push({ path: `${path}.${key}`, django: left[key], nest: '<absent>' });
      else diffJson(left[key], right[key], `${path}.${key}`, out);
    }
    return out;
  }
  if (a !== b) out.push({ path, django: a, nest: b });
  return out;
}

function mediaType(headers: Record<string, string>): string {
  return (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Every observable difference between two responses to the same request. */
export function compare(django: Captured, nest: Captured, sentRequestId?: string): Difference[] {
  const out: Difference[] = [];
  if (django.status !== nest.status)
    out.push({ path: 'status', django: django.status, nest: nest.status });

  const type = mediaType(django.headers);
  if (type !== mediaType(nest.headers))
    out.push({ path: 'content-type', django: type, nest: mediaType(nest.headers) });

  for (const header of ['location', 'allow', 'www-authenticate']) {
    if ((django.headers[header] ?? null) !== (nest.headers[header] ?? null)) {
      out.push({
        path: `header:${header}`,
        django: django.headers[header] ?? null,
        nest: nest.headers[header] ?? null,
      });
    }
  }
  if (sentRequestId !== undefined) {
    const echoed = Array.from(sentRequestId).slice(0, 64).join('');
    for (const [side, response] of [
      ['django', django],
      ['nest', nest],
    ] as const) {
      if (response.headers['x-request-id'] !== echoed) {
        out.push({
          path: `header:x-request-id(${side})`,
          django: echoed,
          nest: response.headers['x-request-id'],
        });
      }
    }
  }

  if (type === 'application/json') {
    let left: unknown;
    let right: unknown;
    try {
      left = JSON.parse(django.body);
      right = JSON.parse(nest.body);
    } catch (error) {
      out.push({
        path: 'body',
        django: django.body.slice(0, 200),
        nest: `unparseable: ${String(error)}`,
      });
      return out;
    }
    // Both mint a fresh id per request: present on both, never equal.
    for (const body of [left, right]) {
      const error = (body as { error?: Record<string, unknown> } | null)?.error;
      if (error && typeof error === 'object' && 'request_id' in error)
        error.request_id = '<request-id>';
    }
    out.push(...diffJson(left, right));
  } else if (django.body !== nest.body) {
    out.push({ path: 'body', django: django.body.slice(0, 300), nest: nest.body.slice(0, 300) });
  }
  return out;
}
