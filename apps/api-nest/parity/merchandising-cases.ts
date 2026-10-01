/**
 * Parity cases for the merchandising admin (phase 4 part 5c): navigation
 * items (the navbar's overrides and the footer's columns and links),
 * storefront banners and the homepage carousel. Every write is compared by
 * the three tables, the audit rows and the revalidation jobs it queues --
 * navigation and banner saves queue theirs at once, from the model's
 * signals; carousel adds and removes after the commit.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { multipart, type Part } from './image-cases.ts';
import { IMAGES } from './images.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const TABLES = ['content_navigationitem', 'content_storefrontbanner', 'content_homecarouselitem'];
const BOUNDARY = 'ParityBoundary7MA4YWxkTrZu0gW';
const SUFFIX = /_[A-Za-z0-9]{7}(\.[^/]*)?$/;

const EFFECTS = [
  `SELECT n.placement, n.type, n.label, n.url, n.badge,
          regexp_replace(n.image, '_[A-Za-z0-9]{7}(\\.[^/]*)?$', '\\1') AS image,
          n.description, n.layout, n.position, n.is_active, n.starts_at::text AS starts_at,
          n.ends_at::text AS ends_at, p.label AS parent, c.slug AS category, s.slug AS page,
          n.updated_at >= $1 AS touched, n.created_at >= $1 AS created
     FROM content_navigationitem n
     LEFT JOIN content_navigationitem p ON p.id = n.parent_id
     LEFT JOIN catalog_category c ON c.id = n.category_id
     LEFT JOIN content_sitepage s ON s.id = n.page_id
    ORDER BY n.placement, n.position, n.label, n.type, c.slug, s.slug, p.label, n.url`,
  `SELECT placement, message, title, subtitle, cta_label, url,
          regexp_replace(image, '_[A-Za-z0-9]{7}(\\.[^/]*)?$', '\\1') AS image, dismissible,
          priority, is_active, starts_at::text AS starts_at, ends_at::text AS ends_at,
          updated_at >= $1 AS touched, created_at >= $1 AS created
     FROM content_storefrontbanner ORDER BY placement, priority, title, message`,
  `SELECT p.slug, h.position, u.email AS created_by, h.created_at >= $1 AS created
     FROM content_homecarouselitem h JOIN catalog_product p ON p.id = h.product_id
     LEFT JOIN accounts_user u ON u.id = h.created_by_id
    ORDER BY h.position, p.slug`,
  `SELECT action, entity_type, entity_label, actor_label, old_values::text AS old_values,
          new_values::text AS new_values, reason
     FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at, action, entity_label`,
];

const ROLES: Who[] = [
  'anon',
  'customer',
  'cashier',
  'stock',
  'accountant',
  'manager',
  'admin',
  'super',
  'norole',
];

export async function merchandisingCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const nav = (
    await db.query<{ id: string; placement: string; label: string; type: string }>(
      `SELECT id, placement, label, type FROM content_navigationitem ORDER BY placement, position, label, id`,
    )
  ).rows;
  const banners = new Map(
    (
      await db.query<{ key: string; id: string }>(
        `SELECT coalesce(nullif(title, ''), message) AS key, id FROM content_storefrontbanner`,
      )
    ).rows.map((row) => [row.key, row.id]),
  );
  const products = new Map(
    (await db.query<{ slug: string; id: string }>(`SELECT slug, id FROM catalog_product`)).rows.map(
      (row) => [row.slug, row.id],
    ),
  );
  const categories = new Map(
    (
      await db.query<{ slug: string; id: string }>(`SELECT slug, id FROM catalog_category`)
    ).rows.map((row) => [row.slug, row.id]),
  );
  const carousel = (
    await db.query<{ id: string; slug: string }>(
      `SELECT h.id, p.slug FROM content_homecarouselitem h JOIN catalog_product p ON p.id = h.product_id
        ORDER BY h.position, h.created_at`,
    )
  ).rows;
  await db.end();
  if (!products.has('parity-rack-1')) return [];

  const byLabel = (label: string, placement = 'HEADER') =>
    nav.find((item) => item.label === label && item.placement === placement)?.id as string;
  const SALE = byLabel('Sale');
  const LAST_CHANCE = byLabel('Last chance');
  const EID = byLabel('Eid edit');
  const HELP = byLabel('Help', 'FOOTER');
  const COMPANY = byLabel('Company', 'FOOTER');
  const SHOP_ALL = byLabel('Shop all', 'FOOTER');
  const headerCategory = nav.find((item) => item.type === 'CATEGORY' && item.label === '')
    ?.id as string;
  const known = new Set([
    ...nav.map((item) => item.id),
    ...banners.values(),
    ...carousel.map((c) => c.id),
  ]);
  const missing = '00000000-0000-4000-8000-000000000000';
  const N = (id: string) => `/api/v1/navigation-items/${id}/`;
  const B = (id: string) => `/api/v1/storefront-banners/${id}/`;
  const C = (id: string) => `/api/v1/home-carousel/${id}/`;
  const png = Buffer.from(IMAGES.png, 'base64');
  const gif = Buffer.from(IMAGES.gif ?? IMAGES.png, 'base64');

  const normalize = (response: unknown) => {
    const rows = Array.isArray(response) ? response : [response];
    for (const row of rows as Record<string, unknown>[]) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.id === 'string' && !known.has(row.id)) row.id = '<minted>';
      if (typeof row.image === 'string') row.image = row.image.replace(SUFFIX, '$1');
      for (const key of ['created_at', 'updated_at'])
        if (typeof row[key] === 'string' && !known.has(row.id as string)) row[key] = '<now>';
      if (typeof row.updated_at === 'string') row.updated_at = '<time>';
    }
  };

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', method = 'GET') =>
    cases.push({ name: `admin merchandising: ${name}`, method, path, headers: auth(who) });
  const write = (name: string, method: string, path: string, body: unknown, who: Who = 'owner') =>
    cases.push({
      name: `admin merchandising: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, TABLES),
      effects: EFFECTS,
      jobs: true,
      normalize,
    });
  const upload = (name: string, method: string, path: string, parts: Part[], who: Who = 'owner') =>
    cases.push({
      name: `admin merchandising: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipart(parts),
      reset: (client) => restoreTables(client, TABLES),
      effects: EFFECTS,
      jobs: true,
      normalize,
    });
  /**
   * A write from a state the fixtures do not have: `reset` runs before each
   * API's request (put the tables back, then `arrange`) and once after both
   * (put them back only).
   */
  const arranged = (
    name: string,
    method: string,
    path: string,
    body: unknown,
    arrange: (client: pg.Client) => Promise<void>,
  ) => {
    let calls = 0;
    cases.push({
      name: `admin merchandising: ${name}`,
      method,
      path,
      headers: { ...auth('owner'), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      reset: async (client) => {
        calls += 1;
        await restoreTables(client, TABLES);
        if (calls % 3 !== 0) await arrange(client);
      },
      effects: EFFECTS,
      jobs: true,
      normalize,
    });
  };

  // --- Who may read and write ------------------------------------------------------------------
  for (const who of ROLES) {
    read(`[${who}] navigation`, '/api/v1/navigation-items/', who);
    read(`[${who}] a navigation item`, N(SALE), who);
    write(
      `[${who}] add a navigation link`,
      'POST',
      '/api/v1/navigation-items/',
      { type: 'LINK', label: `By ${who}`, url: '/by' },
      who,
    );
    write(`[${who}] edit a navigation item`, 'PATCH', N(SALE), { badge: who.slice(0, 20) }, who);
    write(`[${who}] delete a navigation item`, 'DELETE', N(LAST_CHANCE), undefined, who);
    write(`[${who}] move a navigation item`, 'POST', `${N(SALE)}move/`, { direction: 'up' }, who);
    read(`[${who}] banners`, '/api/v1/storefront-banners/', who);
    write(
      `[${who}] add a banner`,
      'POST',
      '/api/v1/storefront-banners/',
      { placement: 'ANNOUNCEMENT', message: `By ${who}` },
      who,
    );
    write(
      `[${who}] delete a banner`,
      'DELETE',
      B(banners.get('Parity paused') as string),
      undefined,
      who,
    );
    read(`[${who}] the carousel`, '/api/v1/home-carousel/', who);
    read(`[${who}] GET a carousel item`, C(carousel[0]?.id as string), who);
    read(`[${who}] PATCH a carousel item`, C(carousel[0]?.id as string), who, 'PATCH');
    read(`[${who}] DELETE the carousel`, '/api/v1/home-carousel/', who, 'DELETE');
    write(
      `[${who}] add to the carousel`,
      'POST',
      '/api/v1/home-carousel/',
      { product: products.get('parity-rack-1') },
      who,
    );
    write(
      `[${who}] remove from the carousel`,
      'DELETE',
      C(carousel[1]?.id as string),
      undefined,
      who,
    );
    write(
      `[${who}] move in the carousel`,
      'POST',
      `${C(carousel[1]?.id as string)}move/`,
      { direction: 'down' },
      who,
    );
  }

  // --- Navigation: reads ------------------------------------------------------------------------
  for (const query of [
    '',
    '?placement=HEADER',
    '?placement=FOOTER',
    '?placement=header',
    '?type=GROUP',
    '?type=LINK&placement=FOOTER',
    '?type=nothing',
    '?is_active=true',
    '?is_active=false',
    '?is_active=maybe',
    `?parent=${HELP}`,
    `?parent=${missing}`,
    '?parent=abc',
    '?ordering=-position',
    '?ordering=label,-created_at',
    '?ordering=url',
    '?placement=nope&type=nope&parent=nope',
  ])
    read(`navigation ${query || '(all)'}`, `/api/v1/navigation-items/${query}`);
  for (const item of nav)
    read(`navigation item ${item.placement} ${item.type} ${item.label}`, N(item.id));
  read('navigation item, filtered out', `${N(SALE)}?placement=FOOTER`);
  read('navigation item, not a uuid', '/api/v1/navigation-items/abc/');
  read('navigation item, not there', N(missing));
  read('navigation PUT the list', '/api/v1/navigation-items/', 'owner', 'PUT');

  // --- Navigation: create -----------------------------------------------------------------------
  const add = (name: string, body: unknown) =>
    write(`add navigation ${name}`, 'POST', '/api/v1/navigation-items/', body);
  add('a link', { type: 'LINK', label: 'New in', url: '/new', badge: 'NEW', position: 5 });
  add('a link without a URL', { type: 'LINK', label: 'Nowhere' });
  add('a link without a label', { type: 'LINK', url: '/x' });
  add('a category', { type: 'CATEGORY', category: categories.get('women'), layout: 'MEGA' });
  add('a category, none named', { type: 'CATEGORY' });
  add('a category and a page', {
    type: 'CATEGORY',
    category: categories.get('men'),
    page: 'about',
  });
  add('a link with a category', {
    type: 'LINK',
    label: 'x',
    url: '/x',
    category: categories.get('men'),
  });
  add('the default type with nothing', {});
  add('a page', { type: 'PAGE', page: 'parity-faq' });
  add('a page, none named', { type: 'PAGE' });
  add('a page that is not there', { type: 'PAGE', page: 'no-such-page' });
  add('a page by a number', { type: 'PAGE', page: 5 });
  add('a page with a NUL', { type: 'PAGE', page: 'a\u0000b' });
  add('a page, blank', { type: 'PAGE', page: '' });
  add('a promo card', {
    type: 'PROMO',
    label: 'Eid',
    url: '/eid',
    description: 'Festive',
    image: null,
  });
  add('a footer column in the header', { type: 'GROUP', label: 'Col' });
  add('automatic categories in the header', { type: 'CATEGORY_LIST' });
  add('a footer column', { placement: 'FOOTER', type: 'GROUP', label: 'Legal' });
  add('a footer column with a parent', {
    placement: 'FOOTER',
    type: 'GROUP',
    label: 'x',
    parent: HELP,
  });
  add('a footer column without a heading', { placement: 'FOOTER', type: 'GROUP' });
  add('a footer column that links', { placement: 'FOOTER', type: 'GROUP', label: 'x', url: '/x' });
  add('a footer link', {
    placement: 'FOOTER',
    type: 'LINK',
    label: 'Gift cards',
    url: '/gift',
    parent: HELP,
  });
  add('a footer link without a column', {
    placement: 'FOOTER',
    type: 'LINK',
    label: 'x',
    url: '/x',
  });
  add('a footer link under a header item', {
    placement: 'FOOTER',
    type: 'LINK',
    label: 'x',
    url: '/x',
    parent: SALE,
  });
  add('a footer page', { placement: 'FOOTER', type: 'PAGE', page: 'parity-faq', parent: COMPANY });
  add('automatic categories in a column', {
    placement: 'FOOTER',
    type: 'CATEGORY_LIST',
    parent: HELP,
  });
  add('a footer link under a link', {
    placement: 'FOOTER',
    type: 'LINK',
    label: 'x',
    url: '/x',
    parent: SHOP_ALL,
  });
  add('a link under a nested item', { type: 'LINK', label: 'x', url: '/x', parent: LAST_CHANCE });
  add('a link under a header item', { type: 'LINK', label: 'Deep', url: '/deep', parent: SALE });
  add('a parent that is not a uuid', { type: 'LINK', label: 'x', url: '/x', parent: 'abc' });
  add('a parent that is not there', { type: 'LINK', label: 'x', url: '/x', parent: missing });
  add('a parent of true', { type: 'LINK', label: 'x', url: '/x', parent: true });
  add('a category that is not there', { type: 'CATEGORY', category: missing });
  add('a category that is not a uuid', { type: 'CATEGORY', category: 'men' });
  add('bad choices', { placement: 'SIDE', type: 'BUTTON', layout: 'GRID' });
  add('a position below zero', { type: 'LINK', label: 'x', url: '/x', position: -1 });
  add('a position past 2^31', { type: 'LINK', label: 'x', url: '/x', position: 2147483648 });
  add('a position as text', { type: 'LINK', label: 'x', url: '/x', position: '7' });
  add('a position as a fraction', { type: 'LINK', label: 'x', url: '/x', position: 1.5 });
  add('active as text', { type: 'LINK', label: 'x', url: '/x', is_active: 'off' });
  add('active that is not one', { type: 'LINK', label: 'x', url: '/x', is_active: 'maybe' });
  for (const [name, url] of [
    ['a site path', '/category/women?sort=new'],
    ['a web address', 'https://example.com/a'],
    ['mail', 'mailto:hello@rangon.test'],
    ['a phone', 'tel:+8801712345678'],
    ['javascript', 'javascript:alert(1)'],
    ['a protocol-relative address', '//evil.example/x'],
    ['an address with a space', 'https://ex ample.com'],
    ['a padded path', '  /sale  '],
    ['a URL past 300 characters', `/${'x'.repeat(300)}`],
  ] as [string, string][])
    add(`a link to ${name}`, { type: 'LINK', label: 'L', url });
  add('a label past 120 characters', { type: 'LINK', label: 'l'.repeat(121), url: '/x' });
  add('a badge past 24 characters', { type: 'LINK', label: 'x', url: '/x', badge: 'b'.repeat(25) });
  add('a description past 200 characters', { type: 'PROMO', description: 'd'.repeat(201) });
  for (const [name, startsAt, endsAt] of [
    ['a window', '2026-10-05T10:00', '2026-10-20T22:00:00+06:00'],
    ['a window in UTC', '2026-10-05T04:00:00Z', '2026-10-05T05:00:00.123456Z'],
    ['a window that ends first', '2026-10-20T10:00', '2026-10-05T10:00'],
    ['a window that ends as it starts', '2026-10-05T10:00', '2026-10-05T04:00Z'],
    ['a window across zones, ending first', '2026-10-05T10:00+06:00', '2026-10-05T09:59+05:00'],
    ['a start alone', '2026-10-05 10:00:00', null],
    ['an end alone', null, '2026-12-31T23:59:59.999999'],
    ['a malformed start', 'tomorrow', null],
    ['a start as a date', '2026-10-05', null],
    ['a start in Bengali digits', '২০২৬-১০-০৫T১০:০০', null],
    ['a start in the skipped hour of 2009', '2009-06-19T23:30', null],
    ['a start in the repeated hour of 2009', '2009-12-31T23:30', '2010-01-01T00:30'],
    ['a start out of range', '0001-01-01T00:00:00+06:00', null],
    ['a naive start in the first hours of the year 1 (D137)', '0001-01-01T00:00', null],
    ['a start as a number', 5, null],
  ] as [string, unknown, unknown][])
    add(name, { type: 'LINK', label: 'Timed', url: '/t', starts_at: startsAt, ends_at: endsAt });
  add('unknown fields', {
    type: 'LINK',
    label: 'x',
    url: '/x',
    id: 'y',
    display_label: 'z',
    category_name: 'q',
  });
  add('a list', []);
  add('null', 'null');
  add('broken JSON', '{"type":');
  add('an image that is not a file', { type: 'PROMO', image: 'x.png' });
  upload('add a promo card with an image', 'POST', '/api/v1/navigation-items/', [
    ['type', 'PROMO'],
    ['label', 'Pictured'],
    ['url', '/pictured'],
    ['image', { filename: 'promo card.png', type: 'image/png', bytes: png }],
  ]);
  upload('add a promo card with a GIF', 'POST', '/api/v1/navigation-items/', [
    ['type', 'PROMO'],
    ['image', { filename: 'promo.gif', type: 'image/gif', bytes: gif }],
  ]);
  upload('add a link as a form', 'POST', '/api/v1/navigation-items/', [
    ['type', 'LINK'],
    ['label', 'Form link'],
    ['url', '/form'],
    ['is_active', 'false'],
    ['position', ''],
    ['parent', ''],
  ]);
  upload('add with an image that is no image', 'POST', '/api/v1/navigation-items/', [
    ['type', 'PROMO'],
    ['image', { filename: 'fake.png', type: 'image/png', bytes: Buffer.from('not a png') }],
  ]);
  arranged(
    'add a fifth footer column',
    'POST',
    '/api/v1/navigation-items/',
    { placement: 'FOOTER', type: 'GROUP', label: 'Fifth' },
    async (client) => {
      await client.query(
        `INSERT INTO content_navigationitem (id, created_at, updated_at, placement, type, label, url,
           badge, image, description, layout, position, is_active)
         VALUES (gen_random_uuid(), now(), now(), 'FOOTER', 'GROUP', 'Fourth', '', '', '', '', 'AUTO', 9, true)`,
      );
    },
  );

  // --- Navigation: edit --------------------------------------------------------------------------
  const edit = (name: string, id: string, body: unknown, method = 'PATCH') =>
    write(`edit navigation ${name}`, method, N(id), body);
  edit('a label and a badge', SALE, { label: 'Sale!', badge: 'HOT' });
  edit('nothing', SALE, {});
  edit('the same values', SALE, { label: 'Sale', url: '/sale' });
  edit('a position and a layout', SALE, { position: 7, layout: 'DROPDOWN', is_active: false });
  edit('a description (not audited)', EID, { description: 'Changed' });
  edit('the image cleared', EID, { image: null });
  edit('into a footer column in the header', SALE, { type: 'GROUP' });
  edit('to be its own parent', SALE, { parent: SALE });
  edit('under a nested item', SALE, { parent: LAST_CHANCE });
  edit('a child moved to the top', LAST_CHANCE, { parent: null });
  edit('a category item without its category', headerCategory, { category: null });
  edit('a category item made a link', headerCategory, {
    type: 'LINK',
    label: 'x',
    url: '/x',
    category: null,
  });
  edit('a start after its end', EID, {
    starts_at: '2026-10-05T10:00',
    ends_at: '2026-10-01T10:00',
  });
  edit('an end before a stored start', byLabel('Gone'), { ends_at: '2000-01-01T00:00' });
  edit('a window', EID, { starts_at: '2026-10-05T10:00', ends_at: null });
  edit('a footer column renamed', HELP, { label: 'Support' });
  edit('a footer column given a parent', HELP, { parent: COMPANY });
  edit('a footer link moved to another column', SHOP_ALL, { parent: COMPANY });
  edit(
    'PUT with everything',
    SALE,
    {
      placement: 'HEADER',
      type: 'LINK',
      label: 'Sale',
      url: '/sale/all',
      badge: '',
      position: 2,
      is_active: true,
      layout: 'AUTO',
      starts_at: null,
      ends_at: null,
    },
    'PUT',
  );
  edit('PUT with nothing', SALE, {}, 'PUT');
  edit('a link given a bad URL', SALE, { url: 'javascript:void(0)' });
  edit('a list', SALE, []);
  write('edit navigation not there', 'PATCH', N(missing), { label: 'x' });
  write('edit navigation not there, a bad body', 'PATCH', N(missing), { position: 'x' });
  write('edit navigation, filtered out', 'PATCH', `${N(SALE)}?placement=FOOTER`, { label: 'x' });
  upload('edit navigation with an image', 'PATCH', N(EID), [
    ['image', { filename: 'eid promo.png', type: 'image/png', bytes: png }],
  ]);

  // --- Navigation: delete and move ---------------------------------------------------------------
  write('delete navigation with a child', 'DELETE', N(SALE), undefined);
  write('delete navigation, a leaf', 'DELETE', N(LAST_CHANCE), undefined);
  write('delete a footer column and its links', 'DELETE', N(HELP), undefined);
  write('delete navigation not there', 'DELETE', N(missing), undefined);
  for (const [name, id, body] of [
    ['up', SALE, { direction: 'up' }],
    ['down', SALE, { direction: 'down' }],
    ['in capitals', SALE, { direction: 'UP' }],
    [
      'past the top',
      nav.find((item) => item.placement === 'HEADER')?.id as string,
      { direction: 'up' },
    ],
    ['sideways', SALE, { direction: 'left' }],
    ['with no direction', SALE, {}],
    ['with a number', SALE, { direction: 1 }],
    ['with a list body', SALE, []],
    ['a child', LAST_CHANCE, { direction: 'down' }],
    ['a footer link', SHOP_ALL, { direction: 'up' }],
    ['a footer column', HELP, { direction: 'down' }],
  ] as [string, string, unknown][])
    write(`move navigation ${name}`, 'POST', `${N(id)}move/`, body);
  write('move navigation, filtered out', 'POST', `${N(SALE)}move/?placement=FOOTER`, {
    direction: 'up',
  });
  write('move navigation not there', 'POST', `${N(missing)}move/`, { direction: 'up' });
  upload('move navigation as a form', 'POST', `${N(SALE)}move/`, [['direction', 'down']]);

  // --- Banners ------------------------------------------------------------------------------------
  for (const query of [
    '',
    '?placement=HOME_HERO',
    '?placement=ANNOUNCEMENT&is_active=true',
    '?placement=hero',
    '?is_active=false',
    '?ordering=priority',
    '?ordering=-created_at,priority',
    '?ordering=title',
  ])
    read(`banners ${query || '(all)'}`, `/api/v1/storefront-banners/${query}`);
  for (const [key, id] of banners) read(`banner ${key}`, B(id));
  read('banner not there', B(missing));
  const banner = (name: string, body: unknown) =>
    write(`add banner ${name}`, 'POST', '/api/v1/storefront-banners/', body);
  banner('an announcement', {
    placement: 'ANNOUNCEMENT',
    message: 'Free delivery',
    dismissible: false,
    priority: 4,
  });
  banner('an announcement without a message', { placement: 'ANNOUNCEMENT', title: 'x' });
  banner('a hero', {
    placement: 'HOME_HERO',
    title: 'Eid',
    subtitle: 'Sale',
    cta_label: 'Shop',
    url: '/eid',
  });
  banner('a hero without a title', { placement: 'HOME_HERO', message: 'x' });
  banner('no placement', { message: 'x' });
  banner('a bad placement', { placement: 'SIDEBAR', message: 'x' });
  banner('a priority past the range', {
    placement: 'ANNOUNCEMENT',
    message: 'x',
    priority: -2147483649,
  });
  banner('a window', {
    placement: 'ANNOUNCEMENT',
    message: 'x',
    starts_at: '2026-10-05T10:00',
    ends_at: '2026-10-06T10:00Z',
  });
  banner('a naive start in the first hours of the year 1 (D137)', {
    placement: 'ANNOUNCEMENT',
    message: 'x',
    starts_at: '0001-01-01T03:00',
  });
  banner('a window that ends first', {
    placement: 'ANNOUNCEMENT',
    message: 'x',
    starts_at: '2026-10-06T10:00',
    ends_at: '2026-10-05T10:00',
  });
  banner('a URL anything goes', { placement: 'HOME_HERO', title: 'x', url: 'javascript:alert(1)' });
  banner('a message past 200 characters', { placement: 'ANNOUNCEMENT', message: 'm'.repeat(201) });
  banner('a list', []);
  upload('add banner a hero with an image', 'POST', '/api/v1/storefront-banners/', [
    ['placement', 'HOME_HERO'],
    ['title', 'Pictured'],
    ['image', { filename: 'hero.png', type: 'image/png', bytes: png }],
  ]);
  const HERO = banners.get('Parity hero') as string;
  write('edit banner a title and priority', 'PATCH', B(HERO), { title: 'Hero 2', priority: 9 });
  write('edit banner the subtitle (not audited)', 'PATCH', B(HERO), { subtitle: 'New' });
  write('edit banner nothing', 'PATCH', B(HERO), {});
  write('edit banner a hero without its title', 'PATCH', B(HERO), { title: '' });
  write('edit banner made an announcement', 'PATCH', B(HERO), { placement: 'ANNOUNCEMENT' });
  write(
    'edit banner an end before a stored start',
    'PATCH',
    B(banners.get('Future hero') as string),
    { ends_at: '2026-01-01T00:00' },
  );
  write('edit banner the image cleared', 'PATCH', B(HERO), { image: null });
  write('edit banner PUT without a placement', 'PUT', B(HERO), { title: 'x' });
  write('edit banner PUT', 'PUT', B(HERO), { placement: 'HOME_HERO', title: 'Replaced' });
  write('edit banner not there', 'PATCH', B(missing), { title: 'x' });
  write('delete banner', 'DELETE', B(HERO), undefined);
  write('delete banner not there', 'DELETE', B(missing), undefined);

  // --- The carousel -------------------------------------------------------------------------------
  for (const query of ['', '?ordering=-position', '?ordering=id', '?ordering=product'])
    read(`carousel ${query || '(all)'}`, `/api/v1/home-carousel/${query}`);
  read('carousel PUT an item', C(carousel[0]?.id as string), 'owner', 'PUT');
  read('carousel POST an item', C(carousel[0]?.id as string), 'owner', 'POST');
  const addProduct = (name: string, body: unknown) =>
    write(`add to carousel ${name}`, 'POST', '/api/v1/home-carousel/', body);
  addProduct('a draft', { product: products.get('parity-rack-2') });
  addProduct('a product sold at the counter only', { product: products.get('parity-draft') });
  addProduct('a product with no variants', { product: products.get('parity-empty') });
  addProduct('an archived product', { product: products.get('parity-archived') });
  addProduct('a product already there', { product: products.get(carousel[0]?.slug as string) });
  addProduct('a product not there', { product: missing });
  addProduct('a product that is not a uuid', { product: 'abc' });
  addProduct('a product as a number', { product: 12 });
  addProduct('no product', {});
  addProduct('a list', []);
  const fill = async (client: pg.Client) => {
    await client.query(
      `INSERT INTO content_homecarouselitem (id, created_at, updated_at, product_id, position)
       SELECT gen_random_uuid(), now(), now(), p.id, 100 + row_number() OVER (ORDER BY p.slug)
         FROM catalog_product p
        WHERE p.status <> 'ARCHIVED' AND p.slug <> 'parity-rack-7'
          AND p.id NOT IN (SELECT product_id FROM content_homecarouselitem)
        ORDER BY p.slug LIMIT (24 - (SELECT count(*) FROM content_homecarouselitem))`,
    );
  };
  arranged(
    'add to carousel when full',
    'POST',
    '/api/v1/home-carousel/',
    { product: products.get('parity-rack-7') },
    fill,
  );
  for (const [name, index, body] of [
    ['up', 1, { direction: 'up' }],
    ['down', 1, { direction: 'down' }],
    ['past the top', 0, { direction: 'up' }],
    ['past the end', carousel.length - 1, { direction: 'down' }],
    ['sideways', 1, { direction: 'sideways' }],
    ['with no direction', 1, {}],
    ['with a list body', 1, []],
  ] as [string, number, unknown][])
    write(`move in carousel ${name}`, 'POST', `${C(carousel[index]?.id as string)}move/`, body);
  write('move in carousel not there', 'POST', `${C(missing)}move/`, { direction: 'up' });
  write('remove from carousel', 'DELETE', C(carousel[2]?.id as string), undefined);
  write('remove from carousel not there', 'DELETE', C(missing), undefined);
  write('remove from carousel, not a uuid', 'DELETE', '/api/v1/home-carousel/abc/', undefined);
  return cases;
}
