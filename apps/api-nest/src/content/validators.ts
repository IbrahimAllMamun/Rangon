/**
 * `content.validators`: what a merchandiser may type into a link, a social
 * profile or a map. Each value ends up in an `href` or an iframe `src` on the
 * storefront, so it is normalised to a few safe shapes or refused -- with
 * Python's `urlsplit` (common/pyurl.ts), its regular expressions' Unicode
 * classes, and `html.unescape` for a pasted `<iframe>`.
 */
import { canonicalPhone } from '../common/phone';
import { ValidationError } from '../common/errors';
import { hostname, port, type SplitResult, urlsplit, UrlError, urlunsplit } from '../common/pyurl';
import { pyHtmlUnescape, pyLen, pyStrip } from '../common/python';

/** C0 controls, DEL, space and backslash: a browser strips some before parsing a URL. */
// eslint-disable-next-line no-control-regex -- C0 controls are what is matched.
const UNSAFE_CHARS = /[\x00-\x20\x7f\\]/;

export const LINK_MESSAGE =
  'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.';

const SOCIAL_URL_MAX = 300;
const MAP_EMBED_MAX = 2000;
const MAP_LINK_MAX = 500;

export function fail(field: string, message: string): ValidationError {
  return new ValidationError(message, { details: { [field]: [message] } });
}

function bounded(value: string, limit: number, field: string): string {
  const length = pyLen(value);
  if (length > limit)
    throw fail(field, `That address is too long (${length} characters; ${limit} at most).`);
  return value;
}

/** `_web_address`: a plain `http(s)://host/...`, no credentials, no port -- or a refusal. */
function webAddress(value: string, field: string, message: string): SplitResult {
  let parts: SplitResult;
  let portNumber: number | null;
  try {
    parts = urlsplit(value);
    portNumber = port(parts);
  } catch (error) {
    if (error instanceof UrlError) throw fail(field, message);
    throw error;
  }
  if (
    !['http', 'https'].includes(parts.scheme.toLowerCase()) ||
    !hostname(parts) ||
    parts.netloc.includes('@') ||
    portNumber !== null
  )
    throw fail(field, message);
  return parts;
}

/** `validate_link_url`: a site path with one leading slash, `mailto:`, `tel:`, or a web address. */
export function validateLinkUrl(raw: string, field = 'url'): string {
  const value = pyStrip(raw ?? '');
  if (!value) return '';
  if (UNSAFE_CHARS.test(value)) throw fail(field, LINK_MESSAGE);
  if (value.startsWith('/')) {
    if (value.startsWith('//')) throw fail(field, LINK_MESSAGE);
    return value;
  }
  const scheme = (value.split(':', 1)[0] as string).toLowerCase();
  if ((scheme === 'mailto' || scheme === 'tel') && pyLen(value) > pyLen(scheme) + 1) return value;
  webAddress(value, field, LINK_MESSAGE);
  return value;
}

export const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  WHATSAPP: 'WhatsApp',
  MESSENGER: 'Messenger',
  X: 'X (Twitter)',
  LINKEDIN: 'LinkedIn',
  PINTEREST: 'Pinterest',
  THREADS: 'Threads',
  TELEGRAM: 'Telegram',
};

const PLATFORM_HOSTS: Readonly<Record<string, readonly string[]>> = {
  FACEBOOK: ['facebook.com', 'fb.com', 'fb.me'],
  INSTAGRAM: ['instagram.com'],
  TIKTOK: ['tiktok.com'],
  YOUTUBE: ['youtube.com', 'youtu.be'],
  WHATSAPP: ['wa.me', 'whatsapp.com'],
  MESSENGER: ['m.me', 'messenger.com'],
  X: ['x.com', 'twitter.com'],
  LINKEDIN: ['linkedin.com'],
  PINTEREST: ['pinterest.com', 'pin.it'],
  THREADS: ['threads.net', 'threads.com'],
  TELEGRAM: ['t.me', 'telegram.me'],
};

export const PLATFORM_EXAMPLES: Readonly<Record<string, string>> = {
  FACEBOOK: 'https://www.facebook.com/rangonfashion',
  INSTAGRAM: 'https://www.instagram.com/rangonfashion',
  TIKTOK: 'https://www.tiktok.com/@rangonfashion',
  YOUTUBE: 'https://www.youtube.com/@rangonfashion',
  WHATSAPP: '01712345678',
  MESSENGER: 'https://m.me/rangonfashion',
  X: 'https://x.com/rangonfashion',
  LINKEDIN: 'https://www.linkedin.com/company/rangonfashion',
  PINTEREST: 'https://www.pinterest.com/rangonfashion',
  THREADS: 'https://www.threads.net/@rangonfashion',
  TELEGRAM: 'https://t.me/rangonfashion',
};

/** `_host_matches`: the domain itself or a subdomain of it, never a look-alike. */
function hostMatches(host: string, allowed: readonly string[]): boolean {
  const clean = host.toLowerCase().replace(/\.+$/, '');
  return allowed.some((domain) => clean === domain || clean.endsWith(`.${domain}`));
}

/** `_whatsapp_url`: `https://wa.me/<digits>` for anything that is a phone number, else null. */
function whatsappUrl(value: string, field: string): string | null {
  if (/[A-Za-z/]/.test(value)) return null;
  const digits = canonicalPhone(value) || value.replace(/\P{Nd}/gu, '');
  if (!/^\p{Nd}{8,15}$/u.test(digits))
    throw fail(field, 'Enter the WhatsApp number, for example 01712345678.');
  return `https://wa.me/${digits}`;
}

/** `normalize_social_url`: a profile on the platform's own domain, always `https://`. */
export function normalizeSocialUrl(platform: string, raw: string, field = 'url'): string {
  let value = pyStrip(raw ?? '');
  if (!value) return '';
  if (platform === 'WHATSAPP') {
    const built = whatsappUrl(value, field);
    if (built !== null) return built;
  }
  const message = `Enter a ${PLATFORM_LABELS[platform]} address, for example ${PLATFORM_EXAMPLES[platform] ?? ''}.`;
  if (UNSAFE_CHARS.test(value)) throw fail(field, message);
  if (!value.includes('://')) value = `https://${value}`;
  const parts = webAddress(value, field, message);
  const host = hostname(parts) ?? '';
  if (!hostMatches(host, PLATFORM_HOSTS[platform] ?? [])) throw fail(field, message);
  const url = urlunsplit({
    scheme: 'https',
    netloc: host.toLowerCase(),
    path: parts.path,
    query: parts.query,
    fragment: parts.fragment,
  });
  return bounded(url, SOCIAL_URL_MAX, field);
}

const GOOGLE_MAP_HOSTS = new Set(['google.com', 'www.google.com', 'maps.google.com']);
const MAP_LINK_HOSTS = ['google.com', 'maps.app.goo.gl', 'goo.gl'];
/** Python's `\b` is Unicode's word boundary, and `\s` its whitespace. */
const W = '[\\p{L}\\p{N}_]';
const S =
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const IFRAME_SRC = new RegExp(
  `<iframe(?!${W})[^>]*?(?<!${W})src${S}*=${S}*(["'])([\\s\\S]*?)\\1`,
  'iu',
);

const MAP_MESSAGE =
  'Paste the embed code from Google Maps (Share → Embed a map), ' +
  'or its https://www.google.com/maps/embed?… address.';

/** `normalize_map_embed`: Google's embed URL, pasted bare or inside Google's `<iframe>` code. */
export function normalizeMapEmbed(raw: string, field = 'map_embed_url'): string {
  let value = pyStrip(raw ?? '');
  if (!value) return '';
  if (value.includes('<')) {
    const match = IFRAME_SRC.exec(value);
    if (!match) throw fail(field, MAP_MESSAGE);
    value = pyStrip(pyHtmlUnescape(match[2] as string));
  }
  if (UNSAFE_CHARS.test(value)) throw fail(field, MAP_MESSAGE);
  const parts = webAddress(value, field, MAP_MESSAGE);
  const isEmbedPath = parts.path.startsWith('/maps/embed');
  const isQueryEmbed = parts.path === '/maps' && parts.query.includes('output=embed');
  if (
    parts.scheme.toLowerCase() !== 'https' ||
    !GOOGLE_MAP_HOSTS.has((hostname(parts) ?? '').toLowerCase()) ||
    !(isEmbedPath || isQueryEmbed)
  )
    throw fail(field, MAP_MESSAGE);
  const url = urlunsplit({
    scheme: 'https',
    netloc: 'www.google.com',
    path: parts.path,
    query: parts.query,
    fragment: '',
  });
  return bounded(url, MAP_EMBED_MAX, field);
}

/** `normalize_map_link`: a Google Maps page to open (the short `maps.app.goo.gl` form too). */
export function normalizeMapLink(raw: string, field = 'map_link_url'): string {
  let value = pyStrip(raw ?? '');
  if (!value) return '';
  const message = 'Paste the Google Maps link to your shop (Share → Copy link).';
  if (!value.includes('://')) value = `https://${value}`;
  if (UNSAFE_CHARS.test(value)) throw fail(field, message);
  const parts = webAddress(value, field, message);
  const host = (hostname(parts) ?? '').toLowerCase();
  if (
    parts.scheme.toLowerCase() !== 'https' ||
    !hostMatches(host, MAP_LINK_HOSTS) ||
    (hostMatches(host, ['google.com']) && !parts.path.startsWith('/maps'))
  )
    throw fail(field, message);
  return bounded(value, MAP_LINK_MAX, field);
}
