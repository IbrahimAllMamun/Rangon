/**
 * Parity cases for the catalogue's staff endpoints (phase 4): `RolePermission`
 * for every role, then brands and categories -- the filters, the ordering,
 * the lookups, every validation branch, and each write compared by the rows
 * it leaves and the storefront revalidation jobs it queues.
 *
 * Accounts come from fixture_accounts.py and fixture_staff.py; the demo seed
 * supplies the shop's own staff. Every write case puts the catalogue tables
 * back from a snapshot before each API's request (`restore.ts`).
 */
import pg from 'pg';

import { restoreTables } from './restore.ts';
import { type Case, token } from './run.ts';

/** Who signs in for a case: a role's account, or nobody. */
export const STAFF = {
  anon: null,
  customer: 'parity.customer@rangon.test',
  cashier: 'cashier@rangon.test',
  manager: 'manager@rangon.test',
  stock: 'stock@rangon.test',
  accountant: 'accounts@rangon.test',
  owner: 'owner@rangon.test',
  admin: 'parity.admin@rangon.test',
  super: 'parity.super@rangon.test',
  norole: 'parity.norole@rangon.test',
} as const;
export type Who = keyof typeof STAFF;

/** Signed bearer headers for each role, valid for the whole run (six hours). */
export async function staffHeaders(db: pg.Client): Promise<(who: Who) => Record<string, string>> {
  const emails = (Object.values(STAFF) as (string | null)[]).filter(
    (email): email is string => email !== null,
  );
  const rows = await db.query<{ id: string; email: string; password: string }>(
    `SELECT id, email, password FROM accounts_user WHERE email = ANY($1)`,
    [emails],
  );
  const byEmail = new Map(rows.rows.map((row) => [row.email, row]));
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  const signed = new Map<Who, string>();
  for (const [who, email] of Object.entries(STAFF) as [Who, string | null][]) {
    const user = email ? byEmail.get(email) : undefined;
    if (user) signed.set(who, `Bearer ${token(user, { exp })}`);
  }
  return (who) => {
    const header = signed.get(who);
    const headers: Record<string, string> = {};
    if (header) headers.authorization = header;
    return headers;
  };
}

const TABLES = [
  'catalog_brand',
  'catalog_category',
  'catalog_categoryattribute',
  'content_navigationitem',
];

const EFFECTS = [
  `SELECT name, slug, description, logo, is_active, is_featured,
          updated_at >= $1 AS touched, created_at >= $1 AS created
     FROM catalog_brand ORDER BY slug`,
  `SELECT c.name, c.slug, p.slug AS parent, c.description, c.image, c.position, c.is_active,
          c.show_in_navigation, c.tax_rate::text AS tax_rate, c.seo_title, c.seo_description,
          c.updated_at >= $1 AS touched, c.created_at >= $1 AS created
     FROM catalog_category c LEFT JOIN catalog_category p ON p.id = c.parent_id ORDER BY c.slug`,
  `SELECT (SELECT count(*) FROM content_navigationitem)::int AS navigation_items,
          (SELECT count(*) FROM catalog_categoryattribute)::int AS attribute_links`,
];

export async function catalogAdminCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const brandRows = await db.query<{ slug: string; id: string }>(
    `SELECT slug, id FROM catalog_brand ORDER BY slug`,
  );
  const categoryRows = await db.query<{ slug: string; id: string }>(
    `SELECT slug, id FROM catalog_category ORDER BY slug`,
  );
  await db.end();
  const brand = new Map(brandRows.rows.map((row) => [row.slug, row.id]));
  const category = new Map(categoryRows.rows.map((row) => [row.slug, row.id]));
  if (!brand.has('parity-unused') || !category.has('parity-doomed')) {
    console.log('SKIP  catalogue admin: fixture_staff.py has not been applied');
    return [];
  }
  const known = new Set([...brand.values(), ...category.values()]);
  const B = (slug: string) => brand.get(slug) as string;
  const C = (slug: string) => category.get(slug) as string;
  const missing = '00000000-0000-4000-8000-000000000000';

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'manager', method = 'GET') =>
    cases.push({ name: `admin catalogue: ${name}`, method, path, headers: auth(who) });
  const write = (name: string, method: string, path: string, body: unknown, who: Who = 'manager') =>
    cases.push({
      name: `admin catalogue: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, TABLES),
      effects: EFFECTS,
      jobs: true,
      // A created row's id is minted by each API.
      normalize: (response) => {
        const row = response as { id?: unknown } | null;
        if (row && typeof row === 'object' && typeof row.id === 'string' && !known.has(row.id))
          row.id = '<minted>';
      },
    });

  // --- RolePermission, for every role ------------------------------------------
  for (const who of Object.keys(STAFF) as Who[]) {
    read(`[${who}] list brands`, '/api/v1/brands/', who);
    read(`[${who}] list categories`, '/api/v1/categories/', who);
    // `{}` is refused by the serializer, so a permitted create writes nothing.
    write(`[${who}] create brand (invalid body)`, 'POST', '/api/v1/brands/', {}, who);
    read(`[${who}] delete a brand that is not there`, `/api/v1/brands/${missing}/`, who, 'DELETE');
    // No handler for the method: the permission check sees no action, so a
    // manager is refused and an owner told the method is not allowed.
    read(`[${who}] PUT on the list route`, '/api/v1/brands/', who, 'PUT');
    read(`[${who}] POST on a detail route`, `/api/v1/brands/${B('rangon')}/`, who, 'POST');
    read(
      `[${who}] PATCH on an action route`,
      `/api/v1/categories/${C('men')}/attributes/`,
      who,
      'PATCH',
    );
  }
  cases.push({
    name: 'admin catalogue: bad token on a staff route',
    path: '/api/v1/brands/',
    headers: { authorization: 'Bearer abc' },
  });
  cases.push({
    name: 'admin catalogue: bad token, wrong method',
    method: 'PUT',
    path: '/api/v1/brands/',
    headers: { authorization: 'Bearer abc' },
  });

  // --- Brands: list, filters, ordering ---------------------------------------------
  for (const query of [
    '',
    '?is_active=false',
    '?is_active=TRUE',
    '?is_active=1',
    '?is_active=0',
    '?is_active=yes',
    '?is_active=',
    '?is_featured=true&is_active=true',
    '?is_active=true&is_active=false',
    '?ordering=-name',
    '?ordering=name',
    '?ordering=bogus',
    '?ordering=bogus,-name',
    '?ordering=',
    '?ordering=%20-name%20',
    '?ordering=slug',
    '?ordering=-',
    '?ordering=-name&is_featured=0',
  ]) {
    read(`brands ${query || '(all)'}`, `/api/v1/brands/${query}`);
  }

  // --- Brands: one at a time ---------------------------------------------------------
  for (const [slug, id] of brand) read(`brand ${slug}`, `/api/v1/brands/${id}/`);
  const rangon = B('rangon');
  read('brand: not a uuid', '/api/v1/brands/abc/');
  read('brand: no such id', `/api/v1/brands/${missing}/`);
  read('brand: upper-case id', `/api/v1/brands/${rangon.toUpperCase()}/`);
  read('brand: braced id', `/api/v1/brands/%7B${rangon}%7D/`);
  read('brand: id without hyphens', `/api/v1/brands/${rangon.replaceAll('-', '')}/`);
  read('brand: filtered out of its own lookup', `/api/v1/brands/${rangon}/?is_active=false`);
  read('brand: ordering ignored by a lookup', `/api/v1/brands/${rangon}/?ordering=bogus`);

  // DefaultRouter's format-suffix routes: Django serves them, this API does not
  // (a documented difference, parity/known-differences.ts).
  read('format suffix: list', '/api/v1/brands.json');
  read('format suffix: detail', `/api/v1/brands/${rangon}.json`);
  read('format suffix: browsable API', '/api/v1/brands.api');

  // --- Brands: create ---------------------------------------------------------------
  write('create brand', 'POST', '/api/v1/brands/', { name: 'Parity New' });
  write('create brand, every field', 'POST', '/api/v1/brands/', {
    name: 'Parity Full',
    slug: 'parity-full',
    description: 'All of it.',
    is_active: false,
    is_featured: 'yes',
    logo: null,
  });
  write('create brand, Bengali name', 'POST', '/api/v1/brands/', { name: 'শাড়ি ঘর' });
  write('create brand, name that spells nothing', 'POST', '/api/v1/brands/', { name: '!!!' });
  write('create brand, slug taken by another case', 'POST', '/api/v1/brands/', { name: 'RANGON' });
  write('create brand, name taken', 'POST', '/api/v1/brands/', { name: 'Rangon' });
  write('create brand, slug taken', 'POST', '/api/v1/brands/', { name: 'X', slug: 'rangon' });
  write('create brand, bad slug', 'POST', '/api/v1/brands/', { name: 'X', slug: 'a b' });
  write('create brand, slug with a NUL', 'POST', '/api/v1/brands/', {
    name: 'X',
    slug: 'a\u0000b',
  });
  write('create brand, long name', 'POST', '/api/v1/brands/', { name: 'x'.repeat(121) });
  for (const name of ['', '   ', null, 5, 4.5, [1], { a: 1 }, true]) {
    write(`create brand, name ${JSON.stringify(name)}`, 'POST', '/api/v1/brands/', { name });
  }
  write('create brand, logo not a file', 'POST', '/api/v1/brands/', { name: 'X', logo: 'x.png' });
  write('create brand, logo blank', 'POST', '/api/v1/brands/', { name: 'X', logo: '' });
  write('create brand, bad boolean', 'POST', '/api/v1/brands/', { name: 'X', is_active: 'maybe' });
  write('create brand, list body', 'POST', '/api/v1/brands/', []);
  write('create brand, null body', 'POST', '/api/v1/brands/', 'null');
  write('create brand, malformed body', 'POST', '/api/v1/brands/', '{"name":');

  // --- Brands: update and delete ------------------------------------------------------
  const parityBrand = `/api/v1/brands/${B('parity-brand')}/`;
  write('replace brand', 'PUT', parityBrand, { name: 'Parity Brand', description: 'Replaced.' });
  write('replace brand, no name', 'PUT', parityBrand, { description: 'x' });
  write('edit brand featured', 'PATCH', parityBrand, { is_featured: false });
  write('edit brand slug', 'PATCH', parityBrand, { slug: 'parity-brand-2' });
  write('edit brand to a taken name', 'PATCH', parityBrand, { name: 'Rangon' });
  write('edit brand to its own name', 'PATCH', parityBrand, { name: 'Parity Brand' });
  write('edit brand, blank slug', 'PATCH', parityBrand, { slug: '' });
  write('edit brand, clear logo', 'PATCH', parityBrand, { logo: null });
  write('edit brand, no such id', 'PATCH', `/api/v1/brands/${missing}/`, { name: '' });
  write('edit brand, filtered out', 'PATCH', `${parityBrand}?is_featured=false`, { name: 'Y' });
  write(
    'delete unused brand',
    'DELETE',
    `/api/v1/brands/${B('parity-unused')}/`,
    undefined,
    'admin',
  );
  write('delete brand with products', 'DELETE', `/api/v1/brands/${rangon}/`, undefined, 'admin');
  write(
    'delete brand, filtered out',
    'DELETE',
    `/api/v1/brands/${B('parity-unused')}/?is_active=true`,
    undefined,
    'admin',
  );

  // --- Categories: list, filters, ordering --------------------------------------------
  for (const query of [
    '',
    '?tree=true',
    '?tree=True',
    '?tree=true&is_active=false',
    '?is_active=false',
    `?parent=${C('parity')}`,
    `?parent=${C('men')}&ordering=-name`,
    '?parent=abc',
    `?parent=${missing}`,
    '?parent=',
    '?parent=null',
    '?parent=12345',
    `?parent=%20${C('men')}`,
    `?parent=%7B${C('men')}%7D`,
    '?parent=abc&is_active=maybe',
    '?ordering=name',
    '?ordering=-created_at',
    '?ordering=-position,name',
    '?ordering=slug',
    '?tree=true&ordering=-name',
  ]) {
    read(`categories ${query || '(all)'}`, `/api/v1/categories/${query}`);
  }

  // --- Categories: one at a time, and their attributes --------------------------------------
  for (const [slug, id] of category) {
    read(`category ${slug}`, `/api/v1/categories/${id}/`);
    read(`category ${slug} attributes`, `/api/v1/categories/${id}/attributes/`);
  }
  read('category: root as a tree', `/api/v1/categories/${C('parity')}/?tree=true`);
  read('category: child under tree=true', `/api/v1/categories/${C('parity-middle')}/?tree=true`);
  read(
    'category: parent filter excludes it',
    `/api/v1/categories/${C('shirts')}/?parent=${C('parity')}`,
  );
  read('category: not a uuid', '/api/v1/categories/abc/');
  read('category attributes: not a uuid', '/api/v1/categories/abc/attributes/');
  read('category attributes: missing', `/api/v1/categories/${missing}/attributes/`);

  // --- Categories: create ---------------------------------------------------------------
  const parity = C('parity');
  write('create category', 'POST', '/api/v1/categories/', { name: 'Parity Fresh' });
  write('create category, every field', 'POST', '/api/v1/categories/', {
    name: 'Parity Complete',
    parent: parity,
    slug: 'parity-complete',
    description: 'Described.',
    position: '7',
    is_active: false,
    show_in_navigation: 'off',
    tax_rate: '0.15',
    seo_title: 'T',
    seo_description: 'D',
    image: null,
  });
  write('create category, tree response', 'POST', '/api/v1/categories/?tree=true', {
    name: 'Parity Treed',
  });
  write('create category, Bengali name', 'POST', '/api/v1/categories/', { name: 'পাঞ্জাবি' });
  write('create category, slug of an existing one', 'POST', '/api/v1/categories/', { name: 'Men' });
  write('create category, slug taken', 'POST', '/api/v1/categories/', { name: 'X', slug: 'men' });
  write('create category, no name', 'POST', '/api/v1/categories/', { slug: 'x' });
  for (const rate of ['1.5', '-0.1', 0.15, '0.12345', 'abc', '', null, '1', 'NaN', '-0', 12]) {
    write(`create category, tax_rate ${JSON.stringify(rate)}`, 'POST', '/api/v1/categories/', {
      name: 'Rated',
      tax_rate: rate,
    });
  }
  for (const position of [-1, 2147483648, '5.0', 5.5, true, '', null, 'abc', '  8 ', 3.0]) {
    write(`create category, position ${JSON.stringify(position)}`, 'POST', '/api/v1/categories/', {
      name: 'Placed',
      position,
    });
  }
  for (const parent of [
    'abc',
    123,
    true,
    [1],
    null,
    '',
    missing,
    `{${parity}}`,
    parity.toUpperCase(),
  ]) {
    write(`create category, parent ${JSON.stringify(parent)}`, 'POST', '/api/v1/categories/', {
      name: 'Parented',
      parent,
    });
  }
  write('create category, several errors', 'POST', '/api/v1/categories/', {
    name: 'x'.repeat(130),
    parent: 'abc',
    position: -3,
    tax_rate: '2',
    seo_title: 'y'.repeat(201),
    slug: 'no good',
  });

  // --- Categories: update, cycles, delete --------------------------------------------------
  const middle = `/api/v1/categories/${C('parity-middle')}/`;
  const leaf = `/api/v1/categories/${C('parity-leaf')}/`;
  write('replace category', 'PUT', middle, { name: 'Parity Middle', description: 'Replaced.' });
  write('replace category, no name', 'PUT', middle, { description: 'x' });
  write('move category under its own grandchild', 'PUT', middle, {
    name: 'Parity Middle',
    parent: C('parity-leaf'),
  });
  write('move root under its descendant', 'PATCH', `/api/v1/categories/${parity}/`, {
    parent: C('parity-leaf'),
  });
  write('make category its own parent', 'PATCH', middle, { parent: C('parity-middle') });
  write('move category to the top', 'PATCH', leaf, { parent: null });
  write('move category under Men', 'PATCH', leaf, { parent: C('men') });
  write('edit category flags', 'PATCH', leaf, {
    is_active: false,
    image: null,
    tax_rate: null,
    position: 4,
  });
  write('edit category slug taken', 'PATCH', leaf, { slug: 'shirts' });
  write('edit category under tree=true, a child', 'PATCH', `${leaf}?tree=true`, { name: 'Z' });
  write('edit root under tree=true', 'PATCH', `/api/v1/categories/${parity}/?tree=true`, {
    description: 'Tree.',
  });
  write(
    'delete category with its navigation',
    'DELETE',
    `/api/v1/categories/${C('parity-doomed')}/`,
    undefined,
    'admin',
  );
  write(
    'delete inactive category',
    'DELETE',
    `/api/v1/categories/${C('parity-hidden')}/`,
    undefined,
    'admin',
  );
  write(
    'delete category with children',
    'DELETE',
    `/api/v1/categories/${C('men')}/`,
    undefined,
    'admin',
  );
  write(
    'delete category with products',
    'DELETE',
    `/api/v1/categories/${C('shirts')}/`,
    undefined,
    'admin',
  );
  write('delete category, not a uuid', 'DELETE', '/api/v1/categories/abc/', undefined, 'admin');

  return cases;
}
