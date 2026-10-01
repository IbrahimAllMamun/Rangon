/**
 * Python 3.12's `urlsplit`, `urlunsplit`, `SplitResult.hostname`/`.port`
 * and `html.unescape`, and the content validators built on them. Expected
 * values printed by the Django API's container; the ports were also compared
 * with CPython on 30,000 generated addresses (and the validators on 48,000)
 * before they were committed.
 */
import { ValidationError } from '../../src/common/errors';
import { pyHtmlUnescape } from '../../src/common/python';
import { hostname, port, urlsplit, UrlError, urlunsplit } from '../../src/common/pyurl';
import {
  normalizeMapEmbed,
  normalizeMapLink,
  normalizeSocialUrl,
  validateLinkUrl,
} from '../../src/content/validators';

describe('urlsplit', () => {
  it.each([
    [
      'https://www.facebook.com/rangon?x=1#top',
      ['https', 'www.facebook.com', '/rangon', 'x=1', 'top'],
      'www.facebook.com',
      null,
      'https://www.facebook.com/rangon?x=1#top',
    ],
    [
      'HTTPS://Example.COM:443/a',
      ['https', 'Example.COM:443', '/a', '', ''],
      'example.com',
      443,
      'https://Example.COM:443/a',
    ],
    ['//host/path', ['', 'host', '/path', '', ''], 'host', null, '//host/path'],
    ['http://[::1]:80/', ['http', '[::1]:80', '/', '', ''], '::1', 80, 'http://[::1]:80/'],
    [
      'http://user@host:99999/',
      ['http', 'user@host:99999', '/', '', ''],
      'host',
      'ValueError',
      'http://user@host:99999/',
    ],
    [
      'http://host:12a/',
      ['http', 'host:12a', '/', '', ''],
      'host',
      'ValueError',
      'http://host:12a/',
    ],
    ['mailto:a@b.c', ['mailto', '', 'a@b.c', '', ''], null, null, 'mailto:a@b.c'],
    ['  \u0001https://a.b/\tc\n', ['https', 'a.b', '/c', '', ''], 'a.b', null, 'https://a.b/c'],
    [
      'http://\uff45xample.com/',
      ['http', '\uff45xample.com', '/', '', ''],
      '\uff45xample.com',
      null,
      'http://\uff45xample.com/',
    ],
    ['http://[v1.x]/', ['http', '[v1.x]', '/', '', ''], 'v1.x', null, 'http://[v1.x]/'],
    ['path?q#f', ['', '', 'path', 'q', 'f'], null, null, 'path?q#f'],
    ['1http://x', ['', '', '1http://x', '', ''], null, null, '1http://x'],
  ])('%j', (url, parts, host, portNumber, rebuilt) => {
    const split = urlsplit(url);
    expect([split.scheme, split.netloc, split.path, split.query, split.fragment]).toEqual(parts);
    expect(hostname(split)).toBe(host);
    if (portNumber === 'ValueError') expect(() => port(split)).toThrow(UrlError);
    else expect(port(split)).toBe(portNumber);
    expect(urlunsplit(split)).toBe(rebuilt);
  });

  // An unbalanced bracket, a bracketed IPv4 address, and a netloc NFKC turns into a delimiter.
  it.each(['http://[::1', 'http://a\u2100b/', 'http://[127.0.0.1]/'])('refuses %j', (url) => {
    expect(() => urlsplit(url)).toThrow(UrlError);
  });
});

describe('html.unescape', () => {
  it.each([
    ['&amp;&lt;&gt;', '&<>'],
    ['&ampx', '&x'],
    ['&#x26;&#38;', '&&'],
    ['&#0;', '\ufffd'],
    ['&#x80;', '\u20ac'],
    ['&#xD800;', '\ufffd'],
    ['&#1114112;', '\ufffd'],
    ['&notit;', '\u00acit;'],
    ['&NotEqualTilde;', '\u2242\u0338'],
    ['&#;', '&#;'],
    ['a &copy b', 'a \u00a9 b'],
  ])('%j', (text, unescaped) => {
    expect(pyHtmlUnescape(text)).toBe(unescaped);
  });
});

const VALIDATORS: Record<string, (value: string, platform: string) => string> = {
  social: (value, platform) => normalizeSocialUrl(platform, value),
  embed: (value) => normalizeMapEmbed(value),
  link: (value) => normalizeMapLink(value),
  url: (value) => validateLinkUrl(value),
};

function outcome(run: () => string): unknown[] {
  try {
    return ['ok', run()];
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return ['error', error.message, error.details];
  }
}

describe('content validators', () => {
  it.each([
    ['social', 'WHATSAPP', '+880 1712-345678', ['ok', 'https://wa.me/8801712345678']],
    [
      'social',
      'WHATSAPP',
      '1234',
      [
        'error',
        'Enter the WhatsApp number, for example 01712345678.',
        { url: ['Enter the WhatsApp number, for example 01712345678.'] },
      ],
    ],
    ['social', 'FACEBOOK', 'fb.com/x', ['ok', 'https://fb.com/x']],
    [
      'social',
      'FACEBOOK',
      'evilfacebook.com/x',
      [
        'error',
        'Enter a Facebook address, for example https://www.facebook.com/rangonfashion.',
        { url: ['Enter a Facebook address, for example https://www.facebook.com/rangonfashion.'] },
      ],
    ],
    [
      'social',
      'INSTAGRAM',
      'https://user@instagram.com/x',
      [
        'error',
        'Enter a Instagram address, for example https://www.instagram.com/rangonfashion.',
        {
          url: ['Enter a Instagram address, for example https://www.instagram.com/rangonfashion.'],
        },
      ],
    ],
    ['social', 'X', 'HTTPS://Twitter.COM./a?b#c', ['ok', 'https://twitter.com./a?b#c']],
    [
      'embed',
      '',
      '<iframe src="https://www.google.com/maps/embed?pb=1&amp;x=2" width="600"></iframe>',
      ['ok', 'https://www.google.com/maps/embed?pb=1&x=2'],
    ],
    [
      'embed',
      '',
      'https://maps.google.com/maps?q=a&output=embed',
      ['ok', 'https://www.google.com/maps?q=a&output=embed'],
    ],
    [
      'embed',
      '',
      '<div>',
      [
        'error',
        'Paste the embed code from Google Maps (Share \u2192 Embed a map), or its https://www.google.com/maps/embed?\u2026 address.',
        {
          map_embed_url: [
            'Paste the embed code from Google Maps (Share \u2192 Embed a map), or its https://www.google.com/maps/embed?\u2026 address.',
          ],
        },
      ],
    ],
    [
      'embed',
      '',
      'http://www.google.com/maps/embed?pb=1',
      [
        'error',
        'Paste the embed code from Google Maps (Share \u2192 Embed a map), or its https://www.google.com/maps/embed?\u2026 address.',
        {
          map_embed_url: [
            'Paste the embed code from Google Maps (Share \u2192 Embed a map), or its https://www.google.com/maps/embed?\u2026 address.',
          ],
        },
      ],
    ],
    ['link', '', 'maps.app.goo.gl/abc', ['ok', 'https://maps.app.goo.gl/abc']],
    [
      'link',
      '',
      'https://www.google.com/search?q=a',
      [
        'error',
        'Paste the Google Maps link to your shop (Share \u2192 Copy link).',
        { map_link_url: ['Paste the Google Maps link to your shop (Share \u2192 Copy link).'] },
      ],
    ],
    ['link', '', 'https://google.com/maps/place/x', ['ok', 'https://google.com/maps/place/x']],
    ['url', '', '/shop', ['ok', '/shop']],
    [
      'url',
      '',
      '//evil.com',
      [
        'error',
        'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
        {
          url: [
            'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
          ],
        },
      ],
    ],
    ['url', '', 'tel:+880', ['ok', 'tel:+880']],
    [
      'url',
      '',
      'tel:',
      [
        'error',
        'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
        {
          url: [
            'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
          ],
        },
      ],
    ],
    [
      'url',
      '',
      'javascript:alert(1)',
      [
        'error',
        'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
        {
          url: [
            'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
          ],
        },
      ],
    ],
    [
      'url',
      '',
      'https://a.b:8080/',
      [
        'error',
        'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
        {
          url: [
            'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
          ],
        },
      ],
    ],
    [
      'url',
      '',
      '/a b',
      [
        'error',
        'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
        {
          url: [
            'Use a site path such as /shop, or a full address starting with https://, mailto: or tel:.',
          ],
        },
      ],
    ],
  ])('%s %s %j', (kind, platform, value, expected) => {
    expect(
      outcome(() => (VALIDATORS[kind] as (v: string, p: string) => string)(value, platform)),
    ).toEqual(expected);
  });
});
