/**
 * Python 3.12's `urllib.parse.urlsplit` and `urlunsplit`, with the
 * `hostname` and `port` a split result answers -- ported from
 * `Lib/urllib/parse.py` line by line, because the content validators decide
 * with them what a merchandiser's link may point at, and every refusal is a
 * message the admin shows.
 *
 * `urlsplit` raises `ValueError` for an unbalanced or invalid bracketed
 * host and for a netloc NFKC would turn into a delimiter; `port` raises for
 * a port that is not 0-65535 in ASCII digits. Both are `UrlError` here.
 */

export class UrlError extends Error {}

export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

const SCHEME_CHARS = new Set(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.'.split(''),
);
// eslint-disable-next-line no-control-regex -- C0 controls are what is matched.
const C0_OR_SPACE = /^[\x00-\x20]+/;
const USES_NETLOC = new Set([
  '',
  'ftp',
  'http',
  'gopher',
  'nntp',
  'telnet',
  'imap',
  'wais',
  'file',
  'mms',
  'https',
  'shttp',
  'snews',
  'prospero',
  'rtsp',
  'rtsps',
  'rtspu',
  'rsync',
  'svn',
  'svn+ssh',
  'sftp',
  'nfs',
  'git',
  'git+ssh',
  'ws',
  'wss',
  'itms-services',
]);

/** `str.rpartition`. */
function rpartition(text: string, separator: string): [string, string, string] {
  const at = text.lastIndexOf(separator);
  return at === -1
    ? ['', '', text]
    : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

/** `str.partition`. */
function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at === -1
    ? [text, '', '']
    : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

/** `ipaddress.ip_address(text)`: an IPv4 or IPv6 address, or null where it raises. */
function ipVersion(text: string): 4 | 6 | null {
  if (isIPv4(text)) return 4;
  return isIPv6(text) ? 6 : null;
}

/** `IPv4Address`: four decimal octets 0-255, no leading zeros, ASCII digits. */
function isIPv4(text: string): boolean {
  const octets = text.split('.');
  if (octets.length !== 4) return false;
  return octets.every(
    (octet) =>
      /^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255 && !(octet.length > 1 && octet[0] === '0'),
  );
}

/** `IPv6Address`, a `%scope` included. */
function isIPv6(text: string): boolean {
  const [address, percent, scope] = partition(text, '%');
  if (percent && (!scope || scope.includes('%'))) return false;
  const parts = address.split(':');
  if (parts.length < 3) return false;
  let ipv4Tail = false;
  if (parts[parts.length - 1]?.includes('.')) {
    if (!isIPv4(parts[parts.length - 1] as string)) return false;
    parts[parts.length - 1] = '0';
    parts.push('0');
    ipv4Tail = true;
  }
  void ipv4Tail;
  if (parts.length > 9) return false;
  let skip: number | null = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === '') {
      if (skip !== null) return false;
      skip = i;
    }
  }
  let head: number;
  let tail: number;
  if (skip !== null) {
    head = skip;
    tail = parts.length - skip - 1;
    if (parts[0] === '') {
      head -= 1;
      if (head) return false;
    }
    if (parts[parts.length - 1] === '') {
      tail -= 1;
      if (tail) return false;
    }
    if (8 - (head + tail) < 1) return false;
  } else {
    if (parts.length !== 8) return false;
    if (parts[0] === '' || parts[parts.length - 1] === '') return false;
    head = parts.length;
    tail = 0;
  }
  const hextets = [...parts.slice(0, head), ...parts.slice(parts.length - tail)];
  return hextets.every((hextet) => /^[0-9a-fA-F]{1,4}$/.test(hextet));
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith('v')) {
    if (!/^v[a-fA-F0-9]+\.[\s\S]+$/.test(hostname))
      throw new UrlError('IPvFuture address is invalid');
    return;
  }
  const version = ipVersion(hostname);
  if (version === null)
    throw new UrlError(`${hostname} does not appear to be an IPv4 or IPv6 address`);
  if (version === 4) throw new UrlError('An IPv4 address cannot be in brackets');
}

function checkBracketedNetloc(netloc: string): void {
  const hostAndPort = rpartition(netloc, '@')[2];
  const [before, open, bracketed] = partition(hostAndPort, '[');
  let hostname: string;
  if (open) {
    if (before) throw new UrlError('Invalid IPv6 URL');
    const [host, , port] = partition(bracketed, ']');
    if (port && !port.startsWith(':')) throw new UrlError('Invalid IPv6 URL');
    hostname = host;
  } else {
    hostname = partition(hostAndPort, ':')[0];
  }
  checkBracketedHost(hostname);
}

function checkNetloc(netloc: string): void {
  // eslint-disable-next-line no-control-regex -- C0 controls are what is matched.
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replaceAll('@', '').replaceAll(':', '').replaceAll('#', '').replaceAll('?', '');
  const normalized = n.normalize('NFKC');
  if (n === normalized) return;
  for (const c of '/?#@:') {
    if (normalized.includes(c))
      throw new UrlError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
}

/** `urlsplit(url)`. */
export function urlsplit(input: string): SplitResult {
  let url = input.replace(C0_OR_SPACE, '').replace(/[\t\r\n]/g, '');
  let scheme = '';
  let netloc = '';
  let query = '';
  let fragment = '';
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]$/.test(url[0] as string)) {
    if ([...url.slice(0, i)].every((c) => SCHEME_CHARS.has(c))) {
      scheme = url.slice(0, i).toLowerCase();
      url = url.slice(i + 1);
    }
  }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') {
      const at = url.indexOf(c, 2);
      if (at >= 0) delim = Math.min(delim, at);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    const open = netloc.includes('[');
    const close = netloc.includes(']');
    if (open !== close) throw new UrlError('Invalid IPv6 URL');
    if (open && close) checkBracketedNetloc(netloc);
  }
  if (url.includes('#'))
    [url, fragment] = [url.slice(0, url.indexOf('#')), url.slice(url.indexOf('#') + 1)];
  if (url.includes('?'))
    [url, query] = [url.slice(0, url.indexOf('?')), url.slice(url.indexOf('?') + 1)];
  checkNetloc(netloc);
  return { scheme, netloc, path: url, query, fragment };
}

/** `SplitResult._hostinfo`. */
function hostinfo(netloc: string): [hostname: string, port: string | null] {
  const info = rpartition(netloc, '@')[2];
  const [, open, bracketed] = partition(info, '[');
  let hostname: string;
  let port: string;
  if (open) {
    const [host, , rest] = partition(bracketed, ']');
    hostname = host;
    port = partition(rest, ':')[2];
  } else {
    [hostname, , port] = partition(info, ':');
  }
  return [hostname, port || null];
}

/** `SplitResult.hostname`: lower-cased (an IPv6 zone excepted), or null. */
export function hostname(parts: SplitResult): string | null {
  const [host] = hostinfo(parts.netloc);
  if (!host) return null;
  const [address, percent, zone] = partition(host, '%');
  return address.toLowerCase() + percent + zone;
}

/** `SplitResult.port`: the port, null for none, `UrlError` where Python raises. */
export function port(parts: SplitResult): number | null {
  const [, raw] = hostinfo(parts.netloc);
  if (raw === null) return null;
  if (!/^[0-9]+$/.test(raw))
    throw new UrlError(`Port could not be cast to integer value as '${raw}'`);
  const value = Number(raw);
  if (!(value >= 0 && value <= 65535)) throw new UrlError('Port out of range 0-65535');
  return value;
}

/** `urlunsplit((scheme, netloc, path, query, fragment))`. */
export function urlunsplit(parts: SplitResult): string {
  let url = parts.path;
  if (parts.netloc) {
    if (url && !url.startsWith('/')) url = `/${url}`;
    url = `//${parts.netloc}${url}`;
  } else if (url.startsWith('//')) {
    url = `//${url}`;
  } else if (parts.scheme && USES_NETLOC.has(parts.scheme) && (!url || url.startsWith('/'))) {
    url = `//${url}`;
  }
  if (parts.scheme) url = `${parts.scheme}:${url}`;
  if (parts.query) url = `${url}?${parts.query}`;
  if (parts.fragment) url = `${url}#${parts.fragment}`;
  return url;
}
