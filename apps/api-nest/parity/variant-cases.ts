/**
 * Parity cases for the variant admin (phase 4 part 3b): the paginated list
 * with DRF's `SearchFilter`, the form, archive-or-delete, `lookup` at a
 * branch, and `barcode`. Writes reuse the product cases' reset and effects.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { PRODUCT_EFFECTS, resetProducts } from './product-cases.ts';
import type { Case } from './run.ts';

export async function variantCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const variants = new Map(
    (
      await db.query<{ sku: string; id: string }>(`SELECT sku, id FROM catalog_productvariant`)
    ).rows.map((row) => [row.sku, row.id]),
  );
  const products = new Map(
    (await db.query<{ slug: string; id: string }>(`SELECT slug, id FROM catalog_product`)).rows.map(
      (row) => [row.slug, row.id],
    ),
  );
  const branches = new Map(
    (await db.query<{ code: string; id: string }>(`SELECT code, id FROM accounts_branch`)).rows.map(
      (row) => [row.code, row.id],
    ),
  );
  const barcode = (
    await db.query<{ barcode: string }>(
      `SELECT barcode FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI'`,
    )
  ).rows[0]?.barcode as string;
  await db.end();
  if (!variants.has('PAR-FREE')) return [];
  const known = new Set(variants.values());
  const missing = '00000000-0000-4000-8000-000000000000';
  const Vp = (sku: string) => `/api/v1/variants/${variants.get(sku)}/`;

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'manager', method = 'GET') =>
    cases.push({ name: `admin variants: ${name}`, method, path, headers: auth(who) });
  const write = (name: string, method: string, path: string, body: unknown, who: Who = 'manager') =>
    cases.push({
      name: `admin variants: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: resetProducts,
      effects: PRODUCT_EFFECTS,
      jobs: true,
      normalize: (response) => {
        const row = response as { id?: unknown } | null;
        if (row && typeof row === 'object' && typeof row.id === 'string' && !known.has(row.id))
          row.id = '<minted>';
      },
    });

  // --- The list ---------------------------------------------------------------------------------
  for (const query of [
    '',
    '?page=2',
    '?page=4',
    '?page_size=100',
    `?product=${products.get('essential-cotton-t-shirt')}`,
    `?product=${products.get('essential-cotton-t-shirt')}&status=ACTIVE&ordering=-sku`,
    '?status=ARCHIVED',
    '?product=abc&status=GONE',
    '?ordering=sku&page_size=100',
    '?ordering=-created_at,sku&page_size=100',
    '?search=cla',
    '?search=RGN-CLA%20WHI',
    '?search=RGN-CLA,WHI',
    '?search=%22oxford%20shirt%22',
    '?search=%27Classic%20Oxford%27',
    `?search=${barcode}`,
    '?search=200000',
    '?search=%25',
    '?search=_',
    '?search=%22',
    '?search=,,,',
    '?search=a%00b',
    '?search=zzz',
    '?search=tee&status=ACTIVE',
  ]) {
    read(`list ${query || '(all)'}`, `/api/v1/variants/${query}`);
  }

  for (const [sku, id] of variants) read(`variant ${sku}`, `/api/v1/variants/${id}/`);
  read('variant searched out', `${Vp('RGN-CLA-L-WHI')}?search=lipstick`);
  read('variant, not a uuid', '/api/v1/variants/abc/');

  // --- lookup -----------------------------------------------------------------------------------------
  for (const [label, code] of [
    ['a barcode', barcode],
    ['a SKU in another case', 'rgn-cla-l-whi'],
    ['a padded SKU', '  RGN-CLA-L-WHI  '],
    ['nothing', ''],
    ['blank', '  '],
    ['no match', 'NOPE'],
    ['a fragment', 'RGN-CLA'],
  ] as [string, string][]) {
    read(`lookup ${label}`, `/api/v1/variants/lookup/?code=${encodeURIComponent(code)}`);
  }
  read('lookup, no code at all', '/api/v1/variants/lookup/');
  // Django resolves the path before the method: these reach the lookup
  // route, which takes only GET, not the detail route with `lookup` as a key.
  read('DELETE lookup', '/api/v1/variants/lookup/', 'manager', 'DELETE');
  read('DELETE lookup as an owner', '/api/v1/variants/lookup/', 'owner', 'DELETE');
  read('PATCH lookup as an owner', '/api/v1/variants/lookup/', 'owner', 'PATCH');
  read(
    'lookup at own branch',
    `/api/v1/variants/lookup/?code=${barcode}&branch=${branches.get('DHK1')}`,
  );
  read(
    'lookup at an inactive branch',
    `/api/v1/variants/lookup/?code=${barcode}&branch=${branches.get('PAR2')}`,
  );
  read('lookup at a malformed branch', `/api/v1/variants/lookup/?code=${barcode}&branch=x`);
  read('lookup, no match, bad branch', '/api/v1/variants/lookup/?code=NOPE&branch=x');
  read('lookup as a cashier', `/api/v1/variants/lookup/?code=${barcode}`, 'cashier');
  read('lookup as a customer', `/api/v1/variants/lookup/?code=${barcode}`, 'customer');

  // --- The form ---------------------------------------------------------------------------------------
  const list = '/api/v1/variants/';
  const empty = products.get('parity-empty');
  write('create variant', 'POST', list, { product: empty, sku: 'PAR-NEW-1', price: '250' });
  write('create variant, every field', 'POST', list, {
    product: empty,
    sku: ' PAR-NEW-2 ',
    barcode: '',
    name: 'Large',
    price: '-0.00',
    compare_at_price: '300.10',
    cost: '120',
    weight_grams: '350',
    position: 2,
    status: 'DRAFT',
    batch_number: 'B-7',
    expiry_date: '2027-1-5',
  });
  for (const date of [
    '2027-W01-1',
    '20270105',
    '2027-02-30',
    '',
    5,
    '2027-01-05T00:00',
    '2027-01-05\n',
    // `date.fromisoformat` stops after the day: the trailing digits are ignored.
    '2027010512',
    '2027W0112',
  ]) {
    write(`create variant, expiry ${JSON.stringify(date)}`, 'POST', list, {
      product: empty,
      sku: 'PAR-DATED',
      expiry_date: date,
    });
  }
  write('create variant, taken SKU and barcode', 'POST', list, {
    product: empty,
    sku: 'RGN-CLA-L-WHI',
    barcode,
  });
  write('create variant, bad numbers', 'POST', list, {
    product: 'abc',
    sku: 'x'.repeat(65),
    price: '-1',
    compare_at_price: 'abc',
    weight_grams: -5,
    status: 'LIVE',
  });
  write('create variant, nothing', 'POST', list, {});
  write('edit variant price', 'PATCH', Vp('PAR-TWA'), { price: '1200.5', barcode: null });
  write('edit variant to a taken SKU', 'PATCH', Vp('PAR-TWA'), { sku: 'PAR-TWB' });
  write('edit variant, its own SKU', 'PATCH', Vp('PAR-TWA'), { sku: 'PAR-TWA', barcode: '' });
  write('edit variant of an unbranded product', 'PATCH', Vp('PAR-FREE'), { name: 'Free' });
  write('move variant to another product', 'PATCH', Vp('PAR-TWA'), {
    product: products.get('parity-freebie'),
  });
  write('replace variant', 'PUT', Vp('PAR-TWA'), {
    product: products.get('parity-twin-a'),
    sku: 'PAR-TWA-2',
  });
  write('replace variant, no SKU', 'PUT', Vp('PAR-TWA'), {
    product: products.get('parity-twin-a'),
  });
  write('delete variant with history', 'DELETE', Vp('RGN-CLA-L-WHI'), undefined, 'admin');
  write('delete variant without history', 'DELETE', Vp('PAR-DRAFT'), undefined, 'admin');
  write('delete variant on a purchase order', 'DELETE', Vp('PAR-TWB'), undefined, 'admin');
  write('delete variant as a manager', 'DELETE', Vp('PAR-TWA'), undefined);

  // --- barcode ---------------------------------------------------------------------------------------
  write('barcode for an unlabelled SKU', 'POST', `${Vp('PAR-TWA')}barcode/`, {});
  write('barcode for a labelled SKU', 'POST', `${Vp('RGN-CLA-L-WHI')}barcode/`, {});
  write('barcode as a cashier', 'POST', `${Vp('PAR-TWA')}barcode/`, {}, 'cashier');
  write('barcode, missing variant', 'POST', `/api/v1/variants/${missing}/barcode/`, {});

  return cases;
}
