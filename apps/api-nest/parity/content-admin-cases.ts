/**
 * Parity cases for the content admin (phase 4 part 5): the site settings
 * (the footer's brand block and contact details) and the social links, with
 * every normalisation `content.validators` makes of a pasted address. Each
 * write is compared by the rows it leaves, its audit entry and the `site`
 * revalidation job it queues once it has committed.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const SITE_TABLES = ['content_sitesettings', 'content_sociallink'];

const SITE_EFFECTS = [
  `SELECT s.key, s.tagline, s.address, s.phone, s.email, s.opening_hours::text AS opening_hours,
          s.show_address, s.map_embed_url, s.map_link_url, s.copyright_text, s.bottom_note,
          s.whatsapp_float, u.email AS updated_by, s.updated_at >= $1 AS touched
     FROM content_sitesettings s LEFT JOIN accounts_user u ON u.id = s.updated_by_id`,
  `SELECT platform, url, is_visible, position, updated_at >= $1 AS touched
     FROM content_sociallink ORDER BY platform`,
  `SELECT action, entity_type, entity_label, actor_label, old_values::text AS old_values,
          new_values::text AS new_values, reason
     FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at, action`,
];

export async function contentAdminCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const links = new Map(
    (
      await db.query<{ platform: string; id: string }>(
        `SELECT platform, id FROM content_sociallink`,
      )
    ).rows.map((row) => [row.platform, row.id]),
  );
  await db.end();
  if (!links.has('FACEBOOK')) return [];
  const L = (platform: string) => `/api/v1/social-links/${links.get(platform)}/`;

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', method = 'GET') =>
    cases.push({ name: `admin content: ${name}`, method, path, headers: auth(who) });
  const write = (name: string, method: string, path: string, body: unknown, who: Who = 'owner') =>
    cases.push({
      name: `admin content: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, SITE_TABLES),
      effects: SITE_EFFECTS,
      jobs: true,
      normalize: (response) => {
        const row = response as Record<string, unknown> | null;
        if (row && typeof row === 'object' && 'updated_at' in row) row.updated_at = '<now>';
      },
    });

  // --- Who may read and write ------------------------------------------------------
  for (const who of [
    'anon',
    'customer',
    'cashier',
    'stock',
    'accountant',
    'manager',
    'admin',
    'super',
    'norole',
  ] as Who[]) {
    read(`[${who}] settings`, '/api/v1/site-settings/', who);
    read(`[${who}] PUT settings`, '/api/v1/site-settings/', who, 'PUT');
    read(`[${who}] DELETE settings`, '/api/v1/site-settings/', who, 'DELETE');
    read(`[${who}] social links`, '/api/v1/social-links/', who);
    read(`[${who}] a social link`, L('FACEBOOK'), who);
    read(`[${who}] PUT a social link`, L('FACEBOOK'), who, 'PUT');
    read(`[${who}] POST social links`, '/api/v1/social-links/', who, 'POST');
    write(
      `[${who}] PATCH settings`,
      'PATCH',
      '/api/v1/site-settings/',
      { tagline: `By ${who}` },
      who,
    );
    write(
      `[${who}] PATCH a social link`,
      'PATCH',
      L('INSTAGRAM'),
      { url: 'instagram.com/rangon' },
      who,
    );
  }

  // --- Social links: reads -----------------------------------------------------------------
  for (const query of [
    '',
    '?ordering=-platform',
    '?ordering=position,-url',
    '?ordering=is_visible',
    '?ordering=label',
    '?ordering=get_platform_display',
    '?ordering=-get_platform_display,platform',
    '?ordering=example',
  ]) {
    read(`social links ${query || '(all)'}`, `/api/v1/social-links/${query}`);
  }
  for (const platform of links.keys()) read(`social link ${platform}`, L(platform));
  read('social link, not a uuid', '/api/v1/social-links/abc/');
  read('social link, not there', '/api/v1/social-links/00000000-0000-4000-8000-000000000000/');
  read(
    'social link, an ordering Django cannot do',
    `${L('FACEBOOK')}?ordering=get_platform_display`,
  );

  // --- Site settings ------------------------------------------------------------------------------
  const S = '/api/v1/site-settings/';
  const patch = (name: string, body: unknown, who: Who = 'owner') =>
    write(`settings ${name}`, 'PATCH', S, body, who);
  patch('every text field, padded', {
    tagline: '  New tagline  ',
    address: ' House 1, Road 2\nDhaka ',
    phone: ' 01712345678 ',
    copyright_text: ' © {year} Rangon ',
    bottom_note: ' Prices include VAT ',
  });
  patch('blank text fields', {
    tagline: '',
    address: '',
    phone: '',
    copyright_text: '',
    bottom_note: '',
  });
  patch('the same values again', {});
  patch('nothing', {});
  patch('an email', { email: ' Hello@Rangon.TEST ' });
  patch('a bad email', { email: 'not an email' });
  patch('a blank email', { email: '' });
  patch('booleans', { show_address: false, whatsapp_float: 'no' });
  patch('booleans as numbers', { show_address: 1, whatsapp_float: 0 });
  patch('a boolean that is not one', { show_address: 'maybe' });
  patch('nulls', { tagline: null, show_address: null, opening_hours: null });
  patch('text past its length', { tagline: 't'.repeat(201), phone: '9'.repeat(33) });
  for (const [name, hours] of [
    [
      'opening hours',
      [
        { days: 'Saturday–Thursday', hours: '10:00–20:00' },
        { days: 'Friday', hours: 'Closed' },
      ],
    ],
    [
      'opening hours with blank rows',
      [
        { days: '', hours: '' },
        { days: ' Sat  –\tThu ', hours: '  10–8 ' },
        { days: '', hours: '' },
      ],
    ],
    ['opening hours, a row missing a column', [{ days: 'Sat' }, { hours: '9–5' }]],
    [
      'opening hours, seven rows',
      Array.from({ length: 7 }, (_, i) => ({ days: `D${i}`, hours: 'h' })),
    ],
    [
      'opening hours, eight rows',
      Array.from({ length: 8 }, (_, i) => ({ days: `D${i}`, hours: 'h' })),
    ],
    ['opening hours, eight empty rows', Array.from({ length: 8 }, () => ({}))],
    ['opening hours, bad rows', [null, 'x', 5, { days: 'd'.repeat(61), hours: 7 }]],
    ['opening hours, not a list', { days: 'Sat', hours: '9' }],
    ['opening hours, a string', 'Sat 9-5'],
    ['opening hours, none', []],
  ] as [string, unknown][]) {
    patch(name, { opening_hours: hours });
  }
  for (const [name, value] of [
    ['a Google embed URL', 'https://www.google.com/maps/embed?pb=!1m18!1m12'],
    [
      'Google iframe code',
      '<iframe src="https://www.google.com/maps/embed?pb=!1m18&amp;hl=en" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy"></iframe>',
    ],
    [
      'iframe code in single quotes and capitals',
      "<IFRAME title='map' SRC = 'https://maps.google.com/maps/embed?x=1'></IFRAME>",
    ],
    ['a keyless embed', 'https://www.google.com/maps?q=Dhaka&output=embed'],
    ['an embed with a fragment', 'https://www.google.com/maps/embed?pb=1#frag'],
    ['an http embed', 'http://www.google.com/maps/embed?pb=1'],
    ['an embed on another host', 'https://evil.example/maps/embed?pb=1'],
    ['an embed with a port', 'https://www.google.com:443/maps/embed?pb=1'],
    ['an embed with credentials', 'https://a@www.google.com/maps/embed?pb=1'],
    ['an iframe without a src', '<iframe width="600"></iframe>'],
    ['markup that is not an iframe', '<b>map</b>'],
    ['an embed past 2000 characters', `https://www.google.com/maps/embed?pb=${'x'.repeat(2000)}`],
    ['a blank embed', ''],
  ] as [string, string][]) {
    patch(`map embed: ${name}`, { map_embed_url: value });
  }
  for (const [name, value] of [
    ['a share link', 'https://maps.app.goo.gl/AbCdEf'],
    ['a share link without a scheme', 'maps.app.goo.gl/AbCdEf'],
    ['a Google Maps page', 'https://www.google.com/maps/place/Rangon'],
    ['a Google search page', 'https://www.google.com/search?q=rangon'],
    ['an http link', 'http://maps.app.goo.gl/AbCdEf'],
    ['another host', 'https://evil.example/maps'],
    ['a link with a space', 'https://maps.app.goo.gl/a b'],
  ] as [string, string][]) {
    patch(`map link: ${name}`, { map_link_url: value });
  }
  patch('a list', []);
  patch('null', 'null');
  patch('broken JSON', '{"tagline":');

  // --- Social links: writes ---------------------------------------------------------------------------
  const social = (name: string, platform: string, body: unknown, who: Who = 'owner') =>
    write(`social ${name}`, 'PATCH', L(platform), body, who);
  for (const [platform, url] of [
    ['FACEBOOK', 'facebook.com/rangonfashion'],
    ['FACEBOOK', 'http://M.Facebook.com/rangon?ref=1#top'],
    ['FACEBOOK', 'https://facebook.com.evil.example/x'],
    ['FACEBOOK', 'https://user@facebook.com/x'],
    ['FACEBOOK', 'https://facebook.com:8443/x'],
    ['FACEBOOK', 'javascript:alert(1)'],
    ['FACEBOOK', 'https://face book.com/x'],
    ['INSTAGRAM', 'www.instagram.com/rangon/'],
    ['YOUTUBE', 'youtu.be/abc'],
    ['X', 'twitter.com/rangon'],
    ['TELEGRAM', 't.me/rangon'],
    ['WHATSAPP', '01712345678'],
    ['WHATSAPP', '+880 1712-345678'],
    ['WHATSAPP', '০১৭১২৩৪৫৬৭৮'],
    ['WHATSAPP', '+44 20 7946 0958'],
    ['WHATSAPP', '1234'],
    ['WHATSAPP', 'wa.me/8801712345678'],
    ['WHATSAPP', 'https://api.whatsapp.com/send?phone=8801712345678'],
    ['LINKEDIN', `https://linkedin.com/${'x'.repeat(290)}`],
    ['PINTEREST', ''],
  ] as [string, string][]) {
    social(`${platform} ${JSON.stringify(url).slice(0, 40)}`, platform, { url });
  }
  social('show a link with an address', 'FACEBOOK', { is_visible: true });
  social('show a link with none', 'TIKTOK', { is_visible: true });
  social('an address and show it', 'TIKTOK', { url: 'tiktok.com/@rangon', is_visible: true });
  social('hide a link', 'FACEBOOK', { is_visible: false });
  social('clear a shown link', 'FACEBOOK', { url: '' });
  social('nothing', 'FACEBOOK', {});
  social('the same address', 'FACEBOOK', { url: 'https://www.facebook.com/rangonfashion' });
  social('a null address', 'FACEBOOK', { url: null });
  social('an address past 300 characters', 'FACEBOOK', { url: 'x'.repeat(301) });
  social('a visibility that is not one', 'FACEBOOK', { is_visible: 'maybe' });
  social('a list', 'FACEBOOK', []);
  write(
    'social a link not there',
    'PATCH',
    '/api/v1/social-links/00000000-0000-4000-8000-000000000000/',
    { url: '' },
  );
  write(
    'social a link not there, a bad body',
    'PATCH',
    '/api/v1/social-links/00000000-0000-4000-8000-000000000000/',
    { is_visible: 'x' },
  );
  for (const [name, platform, body] of [
    ['up', 'INSTAGRAM', { direction: 'up' }],
    ['down', 'INSTAGRAM', { direction: 'down' }],
    ['in capitals', 'INSTAGRAM', { direction: 'DOWN' }],
    ['past the top', 'FACEBOOK', { direction: 'up' }],
    ['sideways', 'FACEBOOK', { direction: 'sideways' }],
    ['with no direction', 'FACEBOOK', {}],
    ['with a list body', 'FACEBOOK', []],
    ['with a number', 'FACEBOOK', { direction: 1 }],
  ] as [string, string, unknown][]) {
    write(`social move ${name}`, 'POST', `${L(platform)}move/`, body);
  }
  write(
    'social edit, an ordering Django cannot do',
    'PATCH',
    `${L('FACEBOOK')}?ordering=get_platform_display`,
    {
      is_visible: false,
    },
  );
  write(
    'social move, an ordering Django cannot do',
    'POST',
    `${L('INSTAGRAM')}move/?ordering=get_platform_display`,
    {
      direction: 'down',
    },
  );
  write(
    'social move as a cashier',
    'POST',
    `${L('INSTAGRAM')}move/`,
    { direction: 'up' },
    'cashier',
  );
  return cases;
}
