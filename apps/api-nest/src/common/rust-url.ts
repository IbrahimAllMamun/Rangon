import { domainToASCII, domainToUnicode } from 'node:url';

import { bidiClass } from './bidi-class';

/**
 * Whether rust-url 2.5.8 parses a URL (`Url::parse`, no base) -- what
 * ammonia asks of a link before it keeps it, behind nh3.
 *
 * Only the parse's outcome is wanted, so only the steps that can fail are
 * ported, from `parser.rs` and `host.rs`: the scheme, the authority (user
 * info, host, port) and the host itself. The path, query and fragment never
 * fail. rust-url departs from the URL standard in places, and those are kept:
 * a non-special URL may have an empty host after `@` (`tel://@`), and `\`
 * ends a port in any scheme.
 *
 * The IDNA step (idna 1.1, `domain_to_ascii` with the URL deny list) is
 * Node's UTS #46 mapping (`domainToASCII`, the WHATWG algorithm) plus the two
 * checks idna makes that Node's does not: a Punycode label may not end in a
 * hyphen, and a bidi domain name must follow the Bidi Rule (RFC 5893).
 */

type SchemeType = 'special' | 'file' | 'not-special';

function schemeType(scheme: string): SchemeType {
  if (['http', 'https', 'ws', 'wss', 'ftp'].includes(scheme)) return 'special';
  if (scheme === 'file') return 'file';
  return 'not-special';
}

const isTabOrNewline = (c: string) => c === '\t' || c === '\n' || c === '\r';

/** `Input`: the code points of the input, tabs and line breaks skipped. */
class Input {
  constructor(
    private readonly chars: string[],
    private index = 0,
  ) {}

  static of(text: string): Input {
    return new Input(Array.from(text));
  }

  clone(): Input {
    return new Input(this.chars, this.index);
  }

  next(): string | undefined {
    while (this.index < this.chars.length) {
      const c = this.chars[this.index++] as string;
      if (!isTabOrNewline(c)) return c;
    }
    return undefined;
  }

  peek(): string | undefined {
    return this.clone().next();
  }

  /** The raw rest of the input, tabs and line breaks included (`chars.as_str()`). */
  rest(): string[] {
    return this.chars.slice(this.index);
  }

  /** Move past `count` code points of the raw rest. */
  skipRaw(count: number): void {
    this.index += count;
  }

  startsWith(prefix: string): boolean {
    const probe = this.clone();
    for (const c of prefix) if (probe.next() !== c) return false;
    return true;
  }

  splitPrefix(prefix: string): Input | null {
    const probe = this.clone();
    for (const c of prefix) if (probe.next() !== c) return null;
    return probe;
  }
}

class ParseError extends Error {}

/** `Url::parse(value).is_ok()`, for a value whose scheme parses. */
export function rustUrlParses(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- C0 controls and space, as rust-url trims them.
  const input = Input.of(value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''));
  let scheme = '';
  const first = input.peek();
  if (!first || !/[A-Za-z]/.test(first)) return false;
  for (;;) {
    const c = input.next();
    if (c === undefined) return false;
    if (/[A-Za-z0-9+\-.]/.test(c)) scheme += c.toLowerCase();
    else if (c === ':') break;
    else return false;
  }
  try {
    parseWithScheme(input, schemeType(scheme), scheme);
    return true;
  } catch (error) {
    if (error instanceof ParseError) return false;
    throw error;
  }
}

function parseWithScheme(input: Input, type: SchemeType, scheme: string): void {
  if (type === 'file') {
    // ammonia keeps no file: links, so the file host is never asked about.
    throw new ParseError('file');
  }
  if (type === 'special') {
    const remaining = input.clone();
    for (;;) {
      const probe = remaining.clone();
      const c = probe.next();
      if (c !== '/' && c !== '\\') break;
      remaining.next();
    }
    afterDoubleSlash(remaining, type, scheme);
    return;
  }
  const authority = input.splitPrefix('//');
  if (authority) afterDoubleSlash(authority, type, scheme);
  // Otherwise a path, which never fails.
}

function afterDoubleSlash(input: Input, type: SchemeType, scheme: string): void {
  const [hasAuthority, afterUserinfo] = parseUserinfo(input, type);
  const [hostIsNone, remaining] = parseHostAndPort(afterUserinfo, type, scheme);
  if (hostIsNone && hasAuthority) throw new ParseError('EmptyHost');
  void remaining;
}

/** `parse_userinfo`: whether anything was written before `@`, and the input after it. */
function parseUserinfo(input: Input, type: SchemeType): [boolean, Input] {
  let lastAt: [number, Input] | null = null;
  const remaining = input.clone();
  let charCount = 0;
  for (;;) {
    const c = remaining.next();
    if (c === undefined) break;
    if (c === '@') lastAt = [charCount, remaining.clone()];
    else if (c === '/' || c === '?' || c === '#') break;
    else if (c === '\\' && type === 'special') break;
    charCount += 1;
  }
  if (!lastAt) return [false, input];
  const [userinfoCount, after] = lastAt;
  if (userinfoCount === 0) {
    const c = after.peek();
    if (
      c !== undefined &&
      (c === '/' || c === '?' || c === '#' || (type === 'special' && c === '\\'))
    )
      throw new ParseError('EmptyHost');
    return [false, after];
  }
  let count = userinfoCount;
  let usernameEnded = false;
  let hasPassword = false;
  let hasUsername = false;
  const reader = input.clone();
  while (count > 0) {
    const c = reader.next() as string;
    count -= 1;
    if (c === ':' && !usernameEnded) {
      usernameEnded = true;
      if (count > 0) hasPassword = true;
    } else if (!hasPassword) {
      hasUsername = true;
    }
  }
  return [hasUsername || hasPassword, after];
}

/** `parse_host_and_port`: whether the host is none (empty), and the input after the port. */
function parseHostAndPort(input: Input, type: SchemeType, scheme: string): [boolean, Input] {
  const [host, remaining] = parseHost(input, type);
  if (host === '') {
    if (remaining.startsWith(':')) throw new ParseError('EmptyHost');
    if (type === 'special') throw new ParseError('EmptyHost');
  }
  const afterColon = remaining.splitPrefix(':');
  if (afterColon) {
    void scheme;
    return [host === '', parsePort(afterColon)];
  }
  return [host === '', remaining];
}

/** `parse_port`: digits up to 65535, ended by `/`, `\`, `?`, `#` or the end. */
function parsePort(input: Input): Input {
  let port = 0;
  const remaining = input.clone();
  for (;;) {
    const probe = remaining.clone();
    const c = probe.next();
    if (c === undefined) break;
    if (c >= '0' && c <= '9') {
      port = port * 10 + Number(c);
      if (port > 65535) throw new ParseError('InvalidPort');
    } else if (c !== '/' && c !== '\\' && c !== '?' && c !== '#') {
      throw new ParseError('InvalidPort');
    } else {
      break;
    }
    remaining.next();
  }
  return remaining;
}

/**
 * `Parser::parse_host`: the host's text up to `:` (outside brackets), `/`,
 * `?`, `#` or a special URL's `\`; tabs and line breaks dropped from it.
 * Answers the host as written ("" when empty -- `HostInternal::None`).
 */
function parseHost(input: Input, type: SchemeType): [string, Input] {
  const raw = input.rest();
  let insideBrackets = false;
  let taken = 0;
  let host = '';
  for (const c of raw) {
    if (c === ':' && !insideBrackets) break;
    if (c === '\\' && type === 'special') break;
    if (c === '/' || c === '?' || c === '#') break;
    taken += 1;
    if (isTabOrNewline(c)) continue;
    if (c === '[') insideBrackets = true;
    else if (c === ']') insideBrackets = false;
    host += c;
  }
  const remaining = input.clone();
  remaining.skipRaw(taken);
  if (type === 'special' && host === '') throw new ParseError('EmptyHost');
  if (type !== 'special') return [parseOpaqueHost(host), remaining];
  return [parseSpecialHost(host), remaining];
}

function parseOpaqueHost(host: string): string {
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) throw new ParseError('InvalidIpv6Address');
    parseIpv6(host.slice(1, -1));
    return host;
  }
  if (/[\0\t\n\r #/:<>?@[\\\]^|]/.test(host)) throw new ParseError('InvalidDomainCharacter');
  return host;
}

function parseSpecialHost(host: string): string {
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) throw new ParseError('InvalidIpv6Address');
    parseIpv6(host.slice(1, -1));
    return host;
  }
  const domain = domainToAsciiIdna(percentDecode(host));
  if (domain === '') throw new ParseError('EmptyHost');
  if (endsInANumber(domain)) parseIpv4(domain);
  return domain;
}

/** `percent_decode`, then UTF-8: invalid bytes are an IDNA error (U+FFFD). */
function percentDecode(text: string): string | null {
  if (!text.includes('%')) return text;
  const bytes: number[] = [];
  const encoded = Buffer.from(text, 'utf8');
  for (let i = 0; i < encoded.length; i++) {
    const byte = encoded[i] as number;
    if (byte === 0x25 && i + 2 < encoded.length + 0) {
      const hex = encoded.subarray(i + 1, i + 3).toString('latin1');
      if (hex.length === 2 && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(byte);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

// --- IDNA: `domain_to_ascii_from_cow(domain, AsciiDenyList::URL)` ----------------------------

/** The URL standard's forbidden domain code points, the deny list idna applies. */
// eslint-disable-next-line no-control-regex -- C0 controls are forbidden domain code points.
const FORBIDDEN_DOMAIN = /[\x00-\x20#%/:<>?@[\\\]^|\x7f]/;

function domainToAsciiIdna(domain: string | null): string {
  // The deny list applies to the host as decoded, before Node's mapping can
  // drop a tab or decode a "%" again, and to what the mapping makes of it.
  if (domain === null || FORBIDDEN_DOMAIN.test(domain)) throw new ParseError('IdnaError');
  const ascii = domainToASCII(domain);
  if (ascii === '' || FORBIDDEN_DOMAIN.test(ascii)) throw new ParseError('IdnaError');
  // idna's Punycode preconditions, on each label as UTS #46 maps it, before
  // any decoding: a label that starts "xn--" must be ASCII after it, must not
  // end in a hyphen (it would decode to nothing or to ASCII only) and must not
  // be longer than 2000 after the prefix. Node's mapping lets these through.
  for (const label of mappedLabels(domain)) {
    if (!label.startsWith('xn--')) continue;
    if (
      // eslint-disable-next-line no-control-regex -- ASCII is the point.
      /[^\x00-\x7f]/.test(label) ||
      label.endsWith('-') ||
      label.length - 4 > PUNYCODE_DECODE_MAX_INPUT_LENGTH
    )
      throw new ParseError('IdnaError');
    // `after_punycode_decode` and `check_label`: the label must decode, must
    // not start with a combining mark, and must already be what the mapping
    // makes of it -- valid, normalized, no dot. A decoded "xn--..." is asked
    // about with a letter in front, so that it is not decoded again.
    const decoded = punycodeDecode(label.slice(4));
    if (decoded === null || /^\p{M}/u.test(decoded) || decoded.includes('.'))
      throw new ParseError('IdnaError');
    const probe = /^xn--/i.test(decoded) ? `a${decoded}` : decoded;
    if (domainToUnicode(domainToASCII(probe)) !== probe) throw new ParseError('IdnaError');
  }
  checkBidi(domainToUnicode(ascii));
  return ascii;
}

/**
 * The labels of a domain as UTS #46 maps them, for the checks above: an ASCII
 * label is lower-cased; any other is NFKC-folded with the code points the
 * mapping ignores dropped -- which is the mapping for every label that could
 * spell "xn--".
 */
function mappedLabels(domain: string): string[] {
  return domain.split(/[.\u3002\uff0e\uff61]/).map((label) =>
    // eslint-disable-next-line no-control-regex -- ASCII is the point.
    /^[\x00-\x7f]*$/.test(label)
      ? label.toLowerCase()
      : label.normalize('NFKC').toLowerCase().normalize('NFKC').replace(IGNORED, ''),
  );
}

/** Code points UTS #46 maps to nothing: soft hyphen, joiners' kin, variation selectors. */
const IGNORED =
  // eslint-disable-next-line no-misleading-character-class -- single code points, never combined.
  /[\u00ad\u034f\u180b-\u180d\u180f\u200b\u2060\u2064\ufe00-\ufe0f\ufeff\u{1bca0}-\u{1bca3}\u{e0100}-\u{e01ef}]/gu;

const PUNYCODE_DECODE_MAX_INPUT_LENGTH = 2000;

/** idna's `Decoder::decode` (RFC 3492), as its internal caller uses it: null on any error. */
function punycodeDecode(input: string): string | null {
  const BASE = 36;
  const T_MIN = 1;
  const T_MAX = 26;
  const delimiter = input.lastIndexOf('-');
  // A delimiter at the very start leaves it in the encoded part, where it is no digit.
  const base = delimiter === -1 ? '' : input.slice(0, delimiter);
  const encoded = delimiter > 0 ? input.slice(delimiter + 1) : input;
  const output = Array.from(base.toLowerCase());
  let length = output.length;
  let codePoint = 0x80;
  let bias = 72;
  let i = 0;
  const digit = (c: string) =>
    c >= '0' && c <= '9'
      ? c.charCodeAt(0) - 0x30 + 26
      : c >= 'a' && c <= 'z'
        ? c.charCodeAt(0) - 0x61
        : c >= 'A' && c <= 'Z'
          ? c.charCodeAt(0) - 0x41
          : -1;
  const insertions: [number, string][] = [];
  let index = 0;
  while (index < encoded.length) {
    const previous = i;
    let weight = 1;
    let k = BASE;
    for (;;) {
      if (index >= encoded.length) return null;
      const d = digit(encoded[index++] as string);
      if (d < 0) return null;
      i += d * weight;
      if (i > 0xffffffff) return null;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      weight *= BASE - t;
      if (weight > 0xffffffff) return null;
      k += BASE;
    }
    bias = adapt(i - previous, length + 1, previous === 0);
    codePoint += Math.floor(i / (length + 1));
    if (codePoint > 0xffffffff) return null;
    i %= length + 1;
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    for (const insertion of insertions) if (insertion[0] >= i) insertion[0] += 1;
    insertions.push([i, String.fromCodePoint(codePoint)]);
    length += 1;
    i += 1;
  }
  insertions.sort((a, b) => a[0] - b[0]);
  const result: string[] = [];
  let next = 0;
  for (let position = 0; position < length; position++) {
    const insertion = insertions[next];
    if (insertion && insertion[0] === position) {
      result.push(insertion[1]);
      next += 1;
    } else {
      result.push(output.shift() as string);
    }
  }
  return result.join('');
}

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((36 - 1) * 26) / 2) {
    d = Math.floor(d / (36 - 1));
    k += 36;
  }
  return k + Math.floor((36 * d) / (d + 38));
}

const FIRST = new Set(['L', 'R', 'AL']);
const LAST_LTR = new Set(['L', 'EN']);
const LAST_RTL = new Set(['R', 'AL', 'EN', 'AN']);
const MIDDLE_LTR = new Set(['L', 'EN', 'ES', 'CS', 'ET', 'ON', 'BN', 'NSM']);
const MIDDLE_RTL = new Set(['R', 'AL', 'AN', 'EN', 'ES', 'CS', 'ET', 'ON', 'BN', 'NSM']);
const RTL = new Set(['R', 'AL', 'AN']);

/** idna's `is_bidi`: a code point of class R, AL or AN, outside the ranges it skips. */
function isBidiDomain(codePoints: number[]): boolean {
  for (const c of codePoints) {
    if (c < 0x0590) continue;
    if (c >= 0x0900 && c <= 0xfb1c) continue;
    if (c >= 0x1f000 && c <= 0x3ffff) continue;
    if (c >= 0xff00 && c <= 0x107ff) continue;
    if (c >= 0x11000 && c <= 0x1e7ff) continue;
    if (RTL.has(bidiClass(c))) return true;
  }
  return false;
}

/** The Bidi Rule over every label of a bidi domain name, as idna's `process_inner` applies it. */
function checkBidi(unicode: string): void {
  const codePoints = Array.from(unicode, (c) => c.codePointAt(0) as number);
  if (!isBidiDomain(codePoints)) return;
  for (const label of unicode.split('.')) {
    const chars = Array.from(label, (c) => c.codePointAt(0) as number);
    if (!chars.length) continue;
    const firstBc = bidiClass(chars[0] as number);
    if (!FIRST.has(firstBc)) throw new ParseError('Bidi');
    const ltr = firstBc === 'L';
    let end = chars.length;
    while (end > 1 && bidiClass(chars[end - 1] as number) === 'NSM') end -= 1;
    if (end === 1) continue;
    const lastBc = bidiClass(chars[end - 1] as number);
    if (!(ltr ? LAST_LTR : LAST_RTL).has(lastBc)) throw new ParseError('Bidi');
    let numerals: 'undecided' | 'european' | 'arabic' = 'undecided';
    for (let i = 1; i < end - 1; i++) {
      const bc = bidiClass(chars[i] as number);
      if (!(ltr ? MIDDLE_LTR : MIDDLE_RTL).has(bc)) throw new ParseError('Bidi');
      if (ltr) continue;
      if (numerals === 'undecided') {
        if (bc === 'EN') numerals = 'european';
        else if (bc === 'AN') numerals = 'arabic';
      } else if (numerals === 'european' && bc === 'AN') {
        throw new ParseError('Bidi');
      } else if (numerals === 'arabic' && bc === 'EN') {
        throw new ParseError('Bidi');
      }
    }
    if (
      !ltr &&
      ((numerals === 'european' && lastBc === 'AN') || (numerals === 'arabic' && lastBc === 'EN'))
    )
      throw new ParseError('Bidi');
  }
}

// --- IPv4 and IPv6 (`host.rs`) ----------------------------------------------------------------

function endsInANumber(input: string): boolean {
  const parts = input.split('.');
  let last = parts.pop() as string;
  if (last === '') {
    if (!parts.length) return false;
    last = parts.pop() as string;
  }
  if (last !== '' && /^[0-9]+$/.test(last)) return true;
  return parseIpv4Number(last) !== 'error';
}

function parseIpv4Number(text: string): number | null | 'error' {
  if (text === '') return 'error';
  let input = text;
  let radix = 10;
  if (input.startsWith('0x') || input.startsWith('0X')) {
    input = input.slice(2);
    radix = 16;
  } else if (input.length >= 2 && input.startsWith('0')) {
    input = input.slice(1);
    radix = 8;
  }
  if (input === '') return 0;
  const valid = radix === 8 ? /^[0-7]+$/ : radix === 10 ? /^[0-9]+$/ : /^[0-9A-Fa-f]+$/;
  if (!valid.test(input)) return 'error';
  const value = BigInt(radix === 16 ? `0x${input}` : radix === 8 ? `0o${input}` : input);
  return value > 0xffffffffn ? null : Number(value);
}

function parseIpv4(input: string): void {
  const parts = input.split('.');
  if (parts[parts.length - 1] === '') parts.pop();
  if (parts.length > 4) throw new ParseError('InvalidIpv4Address');
  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseIpv4Number(part);
    if (n === null || n === 'error') throw new ParseError('InvalidIpv4Address');
    numbers.push(n);
  }
  const ipv4 = numbers.pop() as number;
  // `ipv4 > u32::MAX >> (8 * numbers.len())`: at most three numbers precede it.
  if (ipv4 > 0xffffffff >>> (8 * numbers.length)) throw new ParseError('InvalidIpv4Address');
  if (numbers.some((n) => n > 255)) throw new ParseError('InvalidIpv4Address');
}

function parseIpv6(text: string): void {
  const input = Buffer.from(text, 'utf8');
  const len = input.length;
  let isIpv4 = false;
  let piecePointer = 0;
  let compressPointer: number | null = null;
  let i = 0;
  if (len < 2) throw new ParseError('InvalidIpv6Address');
  const hex = (byte: number) =>
    byte >= 0x30 && byte <= 0x39
      ? byte - 0x30
      : byte >= 0x61 && byte <= 0x66
        ? byte - 0x57
        : byte >= 0x41 && byte <= 0x46
          ? byte - 0x37
          : -1;
  if (input[0] === 0x3a) {
    if (input[1] !== 0x3a) throw new ParseError('InvalidIpv6Address');
    i = 2;
    piecePointer = 1;
    compressPointer = 1;
  }
  while (i < len) {
    if (piecePointer === 8) throw new ParseError('InvalidIpv6Address');
    if (input[i] === 0x3a) {
      if (compressPointer !== null) throw new ParseError('InvalidIpv6Address');
      i += 1;
      piecePointer += 1;
      compressPointer = piecePointer;
      continue;
    }
    const start = i;
    const end = Math.min(len, start + 4);
    while (i < end && hex(input[i] as number) !== -1) i += 1;
    if (i < len) {
      if (input[i] === 0x2e) {
        if (i === start) throw new ParseError('InvalidIpv6Address');
        i = start;
        if (piecePointer > 6) throw new ParseError('InvalidIpv6Address');
        isIpv4 = true;
      } else if (input[i] === 0x3a) {
        i += 1;
        if (i === len) throw new ParseError('InvalidIpv6Address');
      } else {
        throw new ParseError('InvalidIpv6Address');
      }
    }
    if (isIpv4) break;
    piecePointer += 1;
  }
  if (isIpv4) {
    if (piecePointer > 6) throw new ParseError('InvalidIpv6Address');
    let numbersSeen = 0;
    while (i < len) {
      if (numbersSeen > 0) {
        if (numbersSeen < 4 && i < len && input[i] === 0x2e) i += 1;
        else throw new ParseError('InvalidIpv6Address');
      }
      let ipv4Piece: number | null = null;
      while (i < len) {
        const digit = (input[i] as number) - 0x30;
        if (digit < 0 || digit > 9) break;
        if (ipv4Piece === null) ipv4Piece = digit;
        else if (ipv4Piece === 0) throw new ParseError('InvalidIpv6Address');
        else {
          ipv4Piece = ipv4Piece * 10 + digit;
          if (ipv4Piece > 255) throw new ParseError('InvalidIpv6Address');
        }
        i += 1;
      }
      if (ipv4Piece === null) throw new ParseError('InvalidIpv6Address');
      numbersSeen += 1;
      if (numbersSeen === 2 || numbersSeen === 4) piecePointer += 1;
    }
    if (numbersSeen !== 4) throw new ParseError('InvalidIpv6Address');
  }
  if (i < len) throw new ParseError('InvalidIpv6Address');
  // With a compression, the pieces after it move to the end, which cannot fail.
  if (compressPointer === null && piecePointer !== 8) throw new ParseError('InvalidIpv6Address');
}
