/**
 * The handful of Python standard-library behaviours the Django API's responses
 * depend on, reproduced exactly so the two APIs answer the same.
 *
 * Each function names the Python it mirrors. None of them is "roughly" the
 * same: a pagination link that sorts its query keys differently, or a page
 * size that parses " 12" differently, is a visible difference between the APIs.
 */

/** Python `int(text)` for the base-10 strings a query string can carry, or null where Python raises. */
export function pyInt(text: string): number | null {
  // int() strips surrounding whitespace, takes one sign, and allows single
  // underscores between digits (PEP 515). Anything else is a ValueError.
  const match = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(text);
  if (!match) return null;
  // Python ints are unbounded. Past 2^53 this loses precision, but every
  // caller only compares the result against a small bound (a page size cap, a
  // page count), where an imprecise huge number answers the same as the exact one.
  return Number((match[1] ?? '') + (match[2] ?? '').replaceAll('_', ''));
}

/**
 * Python's `Decimal(text)`: null where it raises `InvalidOperation`, else the
 * value as text -- a finite number as a literal PostgreSQL's `numeric` input
 * accepts, a special value as Python prints it (`NaN`, `-NaN`, `sNaN`,
 * `Infinity`, `-Infinity`). Use `isFiniteDecimal` before sending one to SQL.
 *
 * Python accepts surrounding whitespace, one sign, exponents, underscores
 * between digits, and `inf`/`infinity`/`nan`/`snan` in any case.
 */
export function pyDecimal(text: string): string | null {
  const trimmed = text.trim();
  const special = /^([+-]?)(inf|infinity|nan|snan)$/i.exec(trimmed);
  if (special) {
    const sign = special[1] === '-' ? '-' : '';
    const word = (special[2] ?? '').toLowerCase();
    if (word === 'snan') return `${sign}sNaN`;
    if (word === 'nan') return `${sign}NaN`;
    return `${sign}Infinity`;
  }
  const digits = '\\d+(?:_\\d+)*';
  const pattern = new RegExp(
    `^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`,
  );
  if (!pattern.test(trimmed)) return null;
  return trimmed.replaceAll('_', '');
}

/** False for the special values `pyDecimal` can answer. */
export function isFiniteDecimal(value: string): boolean {
  return !/^-?(s?NaN|Infinity)$/.test(value);
}

/** `urllib.parse.quote_plus(text, safe='')`, which `urlencode` uses. */
export function quotePlus(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.\-~]/.test(char)) out += char;
    else if (char === ' ') out += '+';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `urllib.parse.unquote_plus` with the default `errors='replace'`. */
export function unquotePlus(text: string): string {
  const spaced = text.replaceAll('+', ' ');
  const bytes: number[] = [];
  for (let i = 0; i < spaced.length; i++) {
    const char = spaced[i] as string;
    if (char === '%' && /^[0-9A-Fa-f]{2}$/.test(spaced.slice(i + 1, i + 3))) {
      bytes.push(parseInt(spaced.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte);
    }
  }
  // TextDecoder without `fatal` replaces invalid sequences with U+FFFD, as
  // Python's `errors='replace'` does.
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/**
 * `urllib.parse.parse_qsl(query, keep_blank_values=True)`: ordered pairs.
 *
 * Only `&` separates (Python 3.10+ dropped `;`). A field with no `=` is a key
 * with a blank value, because blanks are kept.
 */
export function parseQsl(query: string): [string, string][] {
  const pairs: [string, string][] = [];
  if (!query) return pairs;
  for (const field of query.split('&')) {
    if (!field) continue;
    const eq = field.indexOf('=');
    const key = eq === -1 ? field : field.slice(0, eq);
    const value = eq === -1 ? '' : field.slice(eq + 1);
    pairs.push([unquotePlus(key), unquotePlus(value)]);
  }
  return pairs;
}

/** `parse_qs(query, keep_blank_values=True)`: every value per key, in order. */
export function parseQs(query: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, value] of parseQsl(query)) {
    const values = result.get(key);
    if (values) values.push(value);
    else result.set(key, [value]);
  }
  return result;
}

/** `urlencode(sorted(query_dict.items()), doseq=True)`. */
export function urlencodeSorted(query: Map<string, string[]>): string {
  // Python sorts str keys by code point; JavaScript's default sort compares
  // UTF-16 code units, which differs only above the BMP. Compare by code point.
  const keys = [...query.keys()].sort((a, b) => compareCodePoints(a, b));
  const parts: string[] = [];
  for (const key of keys) {
    for (const value of query.get(key) ?? []) parts.push(`${quotePlus(key)}=${quotePlus(value)}`);
  }
  return parts.join('&');
}

export function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] as string).codePointAt(0)! - (right[i] as string).codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** DRF's `replace_query_param(url, key, val)`. */
export function replaceQueryParam(url: string, key: string, value: string | number): string {
  const { head, query, fragment } = splitUrl(url);
  const params = parseQs(query);
  params.set(key, [String(value)]);
  return joinUrl(head, urlencodeSorted(params), fragment);
}

/** DRF's `remove_query_param(url, key)`. */
export function removeQueryParam(url: string, key: string): string {
  const { head, query, fragment } = splitUrl(url);
  const params = parseQs(query);
  params.delete(key);
  return joinUrl(head, urlencodeSorted(params), fragment);
}

function splitUrl(url: string): { head: string; query: string; fragment: string } {
  const hash = url.indexOf('#');
  const withoutFragment = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? '' : url.slice(hash + 1);
  const question = withoutFragment.indexOf('?');
  return {
    head: question === -1 ? withoutFragment : withoutFragment.slice(0, question),
    query: question === -1 ? '' : withoutFragment.slice(question + 1),
    fragment,
  };
}

function joinUrl(head: string, query: string, fragment: string): string {
  // urlunsplit drops an empty query or fragment entirely, `?` and `#` included.
  return `${head}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`;
}

/**
 * `str.split()` with no argument: runs of what Python's `str.isspace()` calls
 * whitespace, empty pieces dropped. Not JavaScript's `\s`, which differs both
 * ways: Python counts the ASCII separators U+001C-U+001F and U+0085, and does
 * not count U+FEFF.
 */
const PY_WHITESPACE =
  // eslint-disable-next-line no-control-regex -- the separators are the point: Python splits on them.
  /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

export function pySplit(text: string): string[] {
  return text.split(PY_WHITESPACE).filter(Boolean);
}

/** Python `len()` of a str: code points, not UTF-16 units. */
export function pyLen(text: string): number {
  return Array.from(text).length;
}

/** Python `text[:n]`: the first n code points. */
export function pySlice(text: string, end: number): string {
  return Array.from(text).slice(0, end).join('');
}
