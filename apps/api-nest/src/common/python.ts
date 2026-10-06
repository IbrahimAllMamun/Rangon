/**
 * The handful of Python standard-library behaviours the Django API's responses
 * depend on, reproduced exactly so the two APIs answer the same.
 *
 * Each function names the Python it mirrors. None of them is "roughly" the
 * same: a pagination link that sorts its query keys differently, or a page
 * size that parses " 12" differently, is a visible difference between the APIs.
 */

import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from './html-entities';

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
 * accepts, a special value as Python names it (`NaN`, `-NaN`, `sNaN`,
 * `Infinity`, `-Infinity`; a NaN's payload digits are dropped). Use
 * `isFiniteDecimal` before sending one to SQL.
 *
 * CPython's `numeric_as_ascii` first: Python whitespace stripped from both
 * ends of the text as given; then every underscore dropped, wherever it is
 * (`"_1__0_"` is 10), any script's digits made ASCII (`"১২৯০"` is 1290) and
 * any other whitespace a space, which the grammar refuses. Then the decimal
 * specification's grammar, the special values in any case.
 */
export function pyDecimal(text: string): string | null {
  let ascii = '';
  for (const char of pyStrip(text)) {
    if (char === '_') continue;
    const code = char.codePointAt(0) as number;
    if (code > 0 && code <= 127) ascii += char;
    else if (PY_SPACE.test(char)) ascii += ' ';
    else if (/\p{Nd}/u.test(char)) ascii += String(decimalDigitValue(char));
    else return null;
  }
  const trimmed = ascii;
  const special = /^([+-]?)(inf|infinity|nan\d*|snan\d*)$/i.exec(trimmed);
  if (special) {
    const sign = special[1] === '-' ? '-' : '';
    const word = (special[2] ?? '').toLowerCase();
    if (word.startsWith('snan')) return `${sign}sNaN`;
    if (word.startsWith('nan')) return `${sign}NaN`;
    return `${sign}Infinity`;
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

/** `str.isspace()` for one character past ASCII. */
const PY_SPACE = /^[\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

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
export const PY_WHITESPACE =
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

const PY_STRIP_EDGES = new RegExp(`^(?:${PY_WHITESPACE.source})|(?:${PY_WHITESPACE.source})$`, 'g');

/** Python `str.strip()` with no argument: `str.isspace()` whitespace, not `\s`. */
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP_EDGES, '');
}

/**
 * Python `str.isdigit()`: every character a decimal digit (any script) or a
 * digit-valued symbol such as a superscript or a circled number. False for ''.
 */
const PY_DIGIT =
  /^[\p{Nd}\u{B2}-\u{B3}\u{B9}\u{1369}-\u{1371}\u{19DA}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247C}\u{2488}-\u{2490}\u{24EA}\u{24F5}-\u{24FD}\u{24FF}\u{2776}-\u{277E}\u{2780}-\u{2788}\u{278A}-\u{2792}\u{10A40}-\u{10A43}\u{10E60}-\u{10E68}\u{11052}-\u{1105A}\u{1F100}-\u{1F10A}]+$/u;

export function pyIsDigit(text: string): boolean {
  return PY_DIGIT.test(text);
}

/**
 * A JSON number Python's `json` module read as a `float`: it was written with
 * a fraction or an exponent. JavaScript's `JSON.parse` makes `4.0` and `4`
 * the same number; Python does not, and `str()` of one is `"4.0"`.
 * `common/request-body.ts` produces these.
 */
export class PyFloat {
  constructor(readonly value: number) {}

  /** Python `repr(float)`: the shortest round-trip digits, Python's exponent style. */
  toString(): string {
    const value = this.value;
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    if (Object.is(value, -0)) return '-0.0';
    // Python uses scientific notation below 1e-4 and from 1e16, JavaScript
    // below 1e-6 and from 1e21. Both print the same shortest digits.
    const magnitude = Math.abs(value);
    if (magnitude >= 1e16 || magnitude < 1e-4) {
      const [mantissa, exponent] = value.toExponential().split('e') as [string, string];
      const power = Number(exponent);
      const sign = power < 0 ? '-' : '+';
      return `${mantissa}e${sign}${String(Math.abs(power)).padStart(2, '0')}`;
    }
    const text = String(value);
    return text.includes('.') ? text : `${text}.0`;
  }

  /**
   * `json.dumps` writes `repr(float)`: `4.0` stays `4.0`, which a jsonb column
   * keeps. NaN and the infinities are not JSON and fail here, as Postgres
   * refuses the `NaN` Python writes.
   */
  toJSON(): unknown {
    return (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(this.toString());
  }
}

/** Python `repr()` of a str: single quotes unless the text holds one and no double. */
export function pyReprStr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (!isPrintable(char)) {
      if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += `\\U${code.toString(16).padStart(8, '0')}`;
    } else out += char;
  }
  return out + quote;
}

/** `str.isprintable()` for one character: not a control, format, separator or unassigned one, space excepted. */
function isPrintable(char: string): boolean {
  if (char === ' ') return true;
  return !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(char);
}

/**
 * Python `str(value)` for a value parsed from a JSON body (`request.data`):
 * what `str(request.data.get("email", ""))` writes into an audit row, or
 * DRF's `CharField` makes of a number.
 */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  return pyRepr(value);
}

/** Python `repr(value)` for a value parsed from a JSON body. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return pyReprStr(value);
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof PyFloat) return value.toString();
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const items = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${pyReprStr(key)}: ${pyRepr(item)}`,
    );
    return `{${items.join(', ')}}`;
  }
  return String(value);
}

/**
 * Python `int(text)`: surrounding whitespace, one sign, digits of any script
 * (`int("৫")` is 5) with single underscores between them. Exact, as a bigint;
 * null where Python raises ValueError.
 */
export function pyIntText(text: string): bigint | null {
  const match = /^([+-]?)(\p{Nd}(?:_?\p{Nd})*)$/u.exec(pyStrip(text));
  if (!match) return null;
  let value = 0n;
  for (const char of (match[2] as string).replaceAll('_', '')) {
    value = value * 10n + BigInt(decimalDigitValue(char));
  }
  return match[1] === '-' ? -value : value;
}

/**
 * The value of a Unicode decimal digit. Every script's digits are encoded as
 * contiguous runs of ten from zero, so the value is the distance from the
 * start of the run, modulo ten.
 */
function decimalDigitValue(char: string): number {
  let code = char.codePointAt(0) as number;
  let distance = 0;
  while (/\p{Nd}/u.test(String.fromCodePoint(code - 1))) {
    code -= 1;
    distance += 1;
  }
  return distance % 10;
}

/**
 * Python's format spec applied to a string: `[[fill]align][0][width][.precision][s]`.
 * Whatever Python refuses for a string -- a sign, `=`, `#`, a thousands
 * separator, any type but `s` -- throws.
 */
function pyFormatStrSpec(value: string, spec: string): string {
  if (spec === '') return value;
  const chars = [...spec];
  let at = 0;
  let fill = ' ';
  let align = '<';
  if (chars.length > 1 && '<>=^'.includes(chars[1] as string)) {
    fill = chars[0] as string;
    align = chars[1] as string;
    at = 2;
  } else if (chars.length > 0 && '<>=^'.includes(chars[0] as string)) {
    align = chars[0] as string;
    at = 1;
  }
  const filled = at === 2;
  if (chars[at] === '+' || chars[at] === '-')
    throw new Error('ValueError: Sign not allowed in string format specifier');
  if (chars[at] === ' ')
    throw new Error('ValueError: Space not allowed in string format specifier');
  if (chars[at] === 'z')
    throw new Error('ValueError: Negative zero coercion (z) not allowed in format specifier');
  if (chars[at] === '#')
    throw new Error('ValueError: Alternate form (#) not allowed in string format specifier');
  if (!filled && chars[at] === '0') {
    fill = '0';
    at += 1;
  }
  const digits = (): number | null => {
    let text = '';
    while (at < chars.length && /^[0-9]$/.test(chars[at] as string)) text += chars[at++];
    if (text.length > 9) throw new Error('ValueError: Too many decimal digits in format string');
    return text === '' ? null : Number(text);
  };
  const width = digits();
  if (chars[at] === ',' || chars[at] === '_')
    throw new Error(`ValueError: Cannot specify '${chars[at]}' with 's'.`);
  let precision: number | null = null;
  if (chars[at] === '.') {
    at += 1;
    precision = digits();
    if (precision === null) throw new Error('ValueError: Format specifier missing precision');
  }
  if (at < chars.length - 1) throw new Error('ValueError: Invalid format specifier');
  if (at === chars.length - 1 && chars[at] !== 's')
    throw new Error(`ValueError: Unknown format code '${chars[at]}' for object of type 'str'`);
  if (align === '=')
    throw new Error("ValueError: '=' alignment not allowed in string format specifier");

  let points = [...value];
  if (precision !== null) points = points.slice(0, precision);
  const pad = Math.max(0, (width ?? 0) - points.length);
  const left = align === '>' ? pad : align === '^' ? Math.floor(pad / 2) : 0;
  return fill.repeat(left) + points.join('') + fill.repeat(pad - left);
}

/** A `KeyError` or an `AttributeError`: the two DRF reads as "this field is not there". */
export class PyLookupError extends Error {}

/**
 * `template.format(**fields)` for templates that name their fields, every
 * field a string: `{name}`, `{name!r}`, `{name:>12}`, `{name[0]}`, a spec
 * built from fields (`{name:{name}}`), and `{{`/`}}` for braces. Anything
 * Python would refuse -- an unknown or positional field, a stray brace, a
 * spec no string takes -- throws, as Python raises: a `PyLookupError` where
 * Python's is a KeyError or an AttributeError. Every attribute is one
 * (`{name.upper}`): for those a string has, Python prints the object found,
 * a method's memory address and all, and no template is meant to.
 */
export function pyFormatNamed(
  template: string,
  fields: Record<string, string>,
  nested = false,
): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const char = template[i] as string;
    if (char === '}') {
      if (template[i + 1] !== '}') throw new Error("Single '}' encountered in format string");
      out += '}';
      i += 1;
      continue;
    }
    if (char !== '{') {
      out += char;
      continue;
    }
    if (template[i + 1] === '{') {
      out += '{';
      i += 1;
      continue;
    }
    // The field runs to its own closing brace: a spec may hold fields of its own.
    let depth = 1;
    let end = i + 1;
    for (; end < template.length; end++) {
      if (template[end] === '{') depth += 1;
      else if (template[end] === '}' && --depth === 0) break;
    }
    if (depth !== 0) throw new Error("ValueError: expected '}' before end of string");
    const field = template.slice(i + 1, end);
    const match = /^([^!:]*)(?:!([^:]*))?(?::([\s\S]*))?$/.exec(field) as RegExpExecArray;
    const [, path = '', conversion, spec = ''] = match;
    if (conversion !== undefined && !/^[rsa]$/.test(conversion))
      throw new Error(`ValueError: Unknown conversion specifier ${conversion}`);
    const name = /^[^.[]*/.exec(path)?.[0] ?? '';
    if (name === '' || /^[0-9]+$/.test(name))
      throw new Error('IndexError: Replacement index out of range for positional args tuple');
    if (!Object.hasOwn(fields, name)) throw new PyLookupError(`KeyError: ${name}`);
    let value = fields[name] as string;
    let rest = path.slice(name.length);
    while (rest !== '') {
      const index = /^\[([^\]]*)\]/.exec(rest);
      if (!index)
        throw new PyLookupError(`AttributeError: 'str' object has no usable attribute ${rest}`);
      if (!/^[0-9]+$/.test(index[1] as string))
        throw new Error('TypeError: string indices must be integers');
      const point = [...value][Number(index[1])];
      if (point === undefined) throw new Error('IndexError: string index out of range');
      value = point;
      rest = rest.slice(index[0].length);
    }
    if (conversion === 'r' || conversion === 'a') value = pyReprStr(value);
    if (spec.includes('{') || spec.includes('}')) {
      if (nested) throw new Error('ValueError: Max string recursion exceeded');
      out += pyFormatStrSpec(value, pyFormatNamed(spec, fields, true));
    } else {
      out += pyFormatStrSpec(value, spec);
    }
    i = end;
  }
  return out;
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

/**
 * Python's `html.unescape`: numeric references (the Windows-1252 remapping,
 * U+FFFD for surrogates and beyond U+10FFFF, nothing for the code points
 * Python treats as invalid) and HTML5's named ones, the longest legacy name
 * matched when no semicolon follows.
 */
export function pyHtmlUnescape(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(CHARREF, (_match, ref: string) => {
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const digits = ref.slice(hex ? 2 : 1).replace(/;$/, '');
      const num = parseInt(digits, hex ? 16 : 10);
      const remapped = INVALID_CHARREFS[num];
      if (remapped !== undefined) return remapped;
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�';
      if (INVALID_CODEPOINTS.has(num)) return '';
      return String.fromCodePoint(num);
    }
    if (Object.hasOwn(HTML5_ENTITIES, ref)) return HTML5_ENTITIES[ref] as string;
    const chars = Array.from(ref);
    for (let x = chars.length - 1; x > 1; x--) {
      const name = chars.slice(0, x).join('');
      if (Object.hasOwn(HTML5_ENTITIES, name))
        return (HTML5_ENTITIES[name] as string) + chars.slice(x).join('');
    }
    return `&${ref}`;
  });
}
