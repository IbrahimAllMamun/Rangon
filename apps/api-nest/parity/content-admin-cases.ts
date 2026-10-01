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
  cases.push(...pageCases(auth));
  return cases;
}

const PAGE_TABLES = ['content_sitepage', 'content_navigationitem'];

const PAGE_EFFECTS = [
  `SELECT p.slug, p.title, p.meta_description, p.body, p.is_published, p.is_system,
          u.email AS updated_by, p.updated_at >= $1 AS touched, p.created_at >= $1 AS created
     FROM content_sitepage p LEFT JOIN accounts_user u ON u.id = p.updated_by_id
    ORDER BY p.slug`,
  `SELECT n.placement, n.type, n.label, p.slug AS page FROM content_navigationitem n
     LEFT JOIN content_sitepage p ON p.id = n.page_id ORDER BY n.placement, n.type, n.label, p.slug`,
  `SELECT action, entity_type, entity_label, actor_label, old_values::text AS old_values,
          new_values::text AS new_values, reason
     FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at, action`,
];

/**
 * The site pages (part 5b): who may read and write them, every refusal of
 * `create_page`, `update_page` and `delete_page`, and the page sanitiser on
 * what an editor sends -- each write compared by the pages, the navigation
 * items a delete takes with it, the audit rows and the revalidation jobs.
 */
function pageCases(auth: (who: Who) => Record<string, string>): Case[] {
  const cases: Case[] = [];
  const P = '/api/v1/site-pages/';
  const read = (name: string, path: string, who: Who = 'owner', method = 'GET') =>
    cases.push({ name: `admin pages: ${name}`, method, path, headers: auth(who) });
  const write = (name: string, method: string, path: string, body: unknown, who: Who = 'owner') =>
    cases.push({
      name: `admin pages: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, PAGE_TABLES),
      effects: PAGE_EFFECTS,
      jobs: true,
      normalize: (response) => {
        const row = response as Record<string, unknown> | null;
        if (row && typeof row === 'object' && 'updated_at' in row) {
          row.updated_at = '<time>';
          row.created_at = '<time>';
          if (typeof row.id === 'string' && row.slug !== undefined && row.is_system === false)
            row.id = '<id>';
        }
      },
    });

  // --- Who may read and write ----------------------------------------------------------
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
    read(`[${who}] list`, P, who);
    read(`[${who}] a page`, `${P}about/`, who);
    read(`[${who}] PUT a page`, `${P}about/`, who, 'PUT');
    read(`[${who}] PUT the list`, P, who, 'PUT');
    write(`[${who}] create`, 'POST', P, { title: `By ${who}` }, who);
    write(`[${who}] edit`, 'PATCH', `${P}parity-faq/`, { title: `FAQ by ${who}` }, who);
    write(`[${who}] delete`, 'DELETE', `${P}parity-faq/`, undefined, who);
  }

  // --- Reads ----------------------------------------------------------------------------
  for (const query of [
    '',
    '?ordering=-title',
    '?ordering=slug,-created_at',
    '?ordering=path',
    '?ordering=updated_by_name,-is_published',
    '?ordering=body',
    '?ordering=-id',
  ])
    read(`list ${query || '(all)'}`, `${P}${query}`);
  for (const slug of [
    'about',
    'contact',
    'privacy',
    'parity-size-guide',
    'parity-draft-page',
    'parity-faq',
  ])
    read(`page ${slug}`, `${P}${slug}/`);
  read('a page not there', `${P}nothing-here/`);
  read('a page by a slug with a space', `${P}about%20us/`);
  read('a page by a Bengali slug', `${P}${encodeURIComponent('পাতা')}/`);
  read('a page through an ordering', `${P}about/?ordering=-title`);

  // --- Create -----------------------------------------------------------------------------
  const create = (name: string, body: unknown, who: Who = 'owner') =>
    write(`create ${name}`, 'POST', P, body, who);
  create('a title only', { title: 'Size chart for kids' });
  create('a title and an address', { title: 'Gift cards', slug: 'Gift Cards!! 2026' });
  create('everything', {
    title: '  Care   guide ',
    slug: 'care',
    meta_description: '  How to\n wash \t things ',
    body: '<h2>Wash</h2><p>Cold <strong>only</strong></p><script>alert(1)</script><p><br></p>',
    is_published: false,
  });
  create('an address that is taken', { title: 'Another size guide', slug: 'parity-size-guide' });
  create('a standard address', { title: 'About' });
  create('a standard address, spelled out', { title: 'x', slug: 'Privacy' });
  create('a Bengali title', { title: 'আমাদের কথা' });
  create('a Bengali title and an address', { title: 'আমাদের কথা', slug: 'amader-kotha' });
  create('a title of spaces', { title: '   ' });
  create('a title of a zero-width space', { title: '\u200b' });
  create('no title', { slug: 'no-title' });
  create('a null title', { title: null });
  create('a title past 120 characters', { title: 't'.repeat(121) });
  create('an address past 64 characters', { title: 'x', slug: 's'.repeat(65) });
  create('an address of 64 characters with a hyphen at the cut', {
    title: 'x',
    slug: `${'a'.repeat(63)} b`,
  });
  create('a body as a number', { title: 'Numbers', body: 5 });
  create('a null body', { title: 'Null body', body: null });
  create("a body past the sanitiser's limit", { title: 'Long', body: 'x'.repeat(100_001) });
  create("a body past the serializer's limit", { title: 'Longer', body: 'x'.repeat(200_001) });
  create('a body that cleans down to the limit', {
    title: 'Trimmed',
    body: `${'x'.repeat(100_000)}<script>${'y'.repeat(50)}</script>`,
  });
  create('a body of hostile markup', {
    title: 'Hostile',
    body: '<a href="javascript:alert(1)" onclick="x">a</a><img src=x onerror=y><iframe></iframe><a href="https://ok.test/" title="t">b</a>',
  });
  create('publish as text', { title: 'Text flag', is_published: 'no' });
  create('unknown fields', { title: 'Extra', is_system: true, id: 'x', updated_by: 'y' });
  create('a list', []);
  create('null', 'null');
  create('broken JSON', '{"title":');

  // --- Edit -------------------------------------------------------------------------------
  const edit = (name: string, slug: string, body: unknown, who: Who = 'owner') =>
    write(`edit ${name}`, 'PATCH', `${P}${slug}/`, body, who);
  edit('a title', 'parity-faq', { title: '  Questions   answered ' });
  edit('the same values', 'parity-faq', { title: 'FAQ', meta_description: 'Questions' });
  edit('nothing', 'parity-faq', {});
  edit('a body', 'parity-faq', { body: '<p>Ask <em>us</em>.</p><p></p>' });
  edit('a body that cleans to the same', 'parity-faq', { body: '<p>Ask.</p><p><br></p>' });
  edit('a standard page unpublished', 'about', { is_published: false });
  edit('a standard page retitled', 'returns', { title: 'Returns & exchanges' });
  edit('a blank title', 'parity-faq', { title: '' });
  edit('a title of spaces', 'parity-faq', { title: '  ' });
  edit('a null title', 'parity-faq', { title: null });
  edit('a description past 300 characters', 'parity-faq', { meta_description: 'd'.repeat(301) });
  edit("a body past the sanitiser's limit", 'parity-faq', { body: 'x'.repeat(100_001) });
  edit('a page not there', 'nothing-here', { title: 'x' });
  edit('a page not there, a bad body', 'nothing-here', { title: '' });
  edit('a list', 'parity-faq', []);
  edit('through an ordering', 'parity-faq?ordering=-title', { title: 'Ordered' });

  // --- Delete -----------------------------------------------------------------------------
  const remove = (name: string, slug: string, who: Who = 'owner') =>
    write(`delete ${name}`, 'DELETE', `${P}${slug}/`, undefined, who);
  remove('a page nothing links to', 'parity-faq');
  remove('a page the navigation links to', 'parity-size-guide');
  remove('an unpublished page', 'parity-draft-page');
  remove('a standard page', 'about');
  remove('a page not there', 'nothing-here');
  return cases;
}
