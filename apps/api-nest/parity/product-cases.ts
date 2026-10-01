/**
 * Parity cases for the product admin (phase 4 part 3a): the list (filters,
 * search, ordering, pages), the detail with its stock at a branch, the form
 * (specifications, size chart, slug), delete (archive, cascade, refusal),
 * generating SKUs, and publishing. Writes are compared by every product,
 * variant, link, specification and dependent row they leave, the audit
 * entries, the number sequences, and the jobs queued.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const TABLES = [
  'catalog_product',
  'catalog_productvariant',
  'catalog_variantattributevalue',
  'catalog_productattributevalue',
  'catalog_productimage',
  'orders_cartitem',
  'content_homecarouselitem',
  'engagement_wishlistitem',
  'engagement_review',
  'purchasing_supplierproduct',
  'promotions_coupon_products',
];

export const PRODUCT_EFFECTS = [
  `SELECT p.name, p.slug, p.status, p.published, p.featured, p.is_final_sale, p.short_description,
          p.description, p.material, p.care_instructions, p.seo_title, p.seo_description,
          c.slug AS category, b.slug AS brand, s.name AS size_chart, u.email AS created_by,
          p.updated_at >= $1 AS touched, p.created_at >= $1 AS created
     FROM catalog_product p JOIN catalog_category c ON c.id = p.category_id
     LEFT JOIN catalog_brand b ON b.id = p.brand_id LEFT JOIN catalog_sizechart s ON s.id = p.size_chart_id
     LEFT JOIN accounts_user u ON u.id = p.created_by_id ORDER BY p.slug`,
  `SELECT p.slug AS product, v.sku, v.barcode, v.name, v.price::text AS price, v.cost::text AS cost,
          v.compare_at_price::text AS compare_at, v.status, v.position, v.weight_grams, v.batch_number,
          v.expiry_date::text AS expiry, v.updated_at >= $1 AS touched, v.created_at >= $1 AS created
     FROM catalog_productvariant v JOIN catalog_product p ON p.id = v.product_id ORDER BY v.sku`,
  `SELECT v.sku, a.code, av.value FROM catalog_variantattributevalue l
     JOIN catalog_productvariant v ON v.id = l.variant_id JOIN catalog_attribute a ON a.id = l.attribute_id
     JOIN catalog_attributevalue av ON av.id = l.attribute_value_id ORDER BY v.sku, a.code`,
  `SELECT p.slug, a.code, av.value FROM catalog_productattributevalue s
     JOIN catalog_product p ON p.id = s.product_id JOIN catalog_attributevalue av ON av.id = s.attribute_value_id
     JOIN catalog_attribute a ON a.id = av.attribute_id ORDER BY 1, 2, 3`,
  `SELECT (SELECT count(*) FROM catalog_productimage)::int AS images,
          (SELECT count(*) FROM orders_cartitem)::int AS cart_items,
          (SELECT count(*) FROM content_homecarouselitem)::int AS carousel,
          (SELECT count(*) FROM engagement_wishlistitem)::int AS wishlist,
          (SELECT count(*) FROM purchasing_supplierproduct)::int AS offers`,
  `SELECT action, entity_type, entity_label, actor_label, old_values::text AS old_values,
          new_values::text AS new_values, reason
     FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at, action`,
  `SELECT key, last_value FROM core_numbersequence ORDER BY key`,
];

export async function resetProducts(client: pg.Client): Promise<void> {
  await restoreTables(client, TABLES);
  await restoreSequences(client);
}

export async function productCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const products = new Map(
    (await db.query<{ slug: string; id: string }>(`SELECT slug, id FROM catalog_product`)).rows.map(
      (row) => [row.slug, row.id],
    ),
  );
  const ids = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const categories = await ids(`SELECT slug AS key, id FROM catalog_category`);
  const brands = await ids(`SELECT slug AS key, id FROM catalog_brand`);
  const values = await ids(
    `SELECT a.code || ':' || v.value AS key, v.id FROM catalog_attributevalue v JOIN catalog_attribute a ON a.id = v.attribute_id`,
  );
  const charts = await ids(`SELECT name AS key, id FROM catalog_sizechart`);
  const branches = await ids(`SELECT code AS key, id FROM accounts_branch`);
  const barcode = (
    await db.query<{ barcode: string }>(
      `SELECT barcode FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI'`,
    )
  ).rows[0]?.barcode;
  await db.end();
  if (!products.has('parity-freebie')) {
    console.log('SKIP  product admin: fixture_products.py has not been applied');
    return [];
  }
  const known = new Set(products.values());
  const P = (slug: string) => `/api/v1/products/${products.get(slug)}/`;
  const missing = '00000000-0000-4000-8000-000000000000';

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'manager') =>
    cases.push({ name: `admin products: ${name}`, path, headers: auth(who) });
  const write = (name: string, method: string, path: string, body: unknown, who: Who = 'manager') =>
    cases.push({
      name: `admin products: ${name}`,
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
        // Variants minted by generate-variants.
        const created = (response as { variants?: { id?: unknown; product?: unknown }[] } | null)
          ?.variants;
        if (Array.isArray(created) && 'created' in (response as object))
          for (const variant of created) variant.id = '<minted>';
      },
    });

  // --- The list ------------------------------------------------------------------------
  for (const query of [
    '',
    '?page_size=5',
    '?page_size=5&page=2',
    '?page_size=5&page=4',
    '?page_size=5&page=5',
    '?page=last&page_size=7',
    '?page_size=100',
    '?status=ACTIVE',
    '?status=DRAFT',
    '?status=ARCHIVED&published=true',
    '?status=bogus',
    '?published=false',
    '?featured=1',
    `?category=${categories.get('shirts')}`,
    `?brand=${brands.get('rangon')}&featured=false`,
    '?category=abc&brand=xyz&status=nope',
    '?never_ordered=true',
    '?never_ordered=True',
    '?ordering=name',
    '?ordering=-created_at',
    '?ordering=bogus',
    '?search=shirt',
    '?search=SHIRT',
    '?search=%20%20cotton%20%20',
    '?search=RGN-CLA',
    '?search=rgn-cla-l-whi',
    `?search=${barcode}`,
    '?search=kurt',
    '?search=%25',
    '?search=_',
    '?search=parity',
    '?search=zzzz',
    '?search=%20%20',
    '?search=embroidered%20panjabi',
    '?search=tee&status=ACTIVE&ordering=name',
    '?search=PAR-',
  ]) {
    read(`list ${query || '(all)'}`, `/api/v1/products/${query}`);
  }

  // --- The detail, with stock at a branch --------------------------------------------------
  for (const slug of products.keys()) read(`product ${slug}`, P(slug));
  const shirt = P('classic-oxford-shirt');
  read('product at its own branch', `${shirt}?branch=${branches.get('DHK1')}`);
  read('product at an inactive branch', `${shirt}?branch=${branches.get('PAR2')}`);
  read('product at a missing branch', `${shirt}?branch=${missing}`);
  read('product at a malformed branch', `${shirt}?branch=nope`);
  read(
    'product at an inactive branch, as the owner',
    `${shirt}?branch=${branches.get('PAR2')}`,
    'owner',
  );
  read('product filtered out', `${shirt}?status=DRAFT`);
  read('product searched out', `${shirt}?search=lipstick`);
  read('product, not a uuid', '/api/v1/products/abc/');
  read('product, missing', `/api/v1/products/${missing}/`);

  // --- The form ------------------------------------------------------------------------------
  const products_ = '/api/v1/products/';
  const leaf = categories.get('parity-leaf');
  const shirts = categories.get('shirts');
  write('create product', 'POST', products_, { name: 'Parity Fresh', category: leaf });
  write('create product, every field', 'POST', products_, {
    name: 'Parity Complete',
    category: shirts,
    brand: brands.get('rangon'),
    slug: 'parity-complete',
    short_description: 'Short.',
    description: 'Long.',
    material: 'Cotton',
    care_instructions: 'Wash cold.',
    status: 'ACTIVE',
    published: true,
    featured: 'yes',
    is_final_sale: true,
    seo_title: 'T',
    seo_description: 'D',
    spec_values: [values.get('material:Cotton'), values.get('fit:Slim')],
    size_chart: charts.get("Men's tops"),
  });
  write('create product, Bengali name', 'POST', products_, {
    name: 'জামদানি শাড়ি',
    category: leaf,
  });
  write('create product, name of an existing one', 'POST', products_, {
    name: 'Classic Oxford Shirt',
    category: leaf,
  });
  write('create product, slug taken', 'POST', products_, {
    name: 'X',
    slug: 'matte-lipstick',
    category: leaf,
  });
  write('create product, a draft published', 'POST', products_, {
    name: 'X',
    category: leaf,
    status: 'DRAFT',
    published: true,
  });
  write('create product, a variant axis as a spec', 'POST', products_, {
    name: 'X',
    category: leaf,
    spec_values: [values.get('size:S'), values.get('color:Black'), values.get('material:Cotton')],
  });
  write('create product, a spec that is gone', 'POST', products_, {
    name: 'X',
    category: leaf,
    spec_values: [missing],
  });
  write('create product, spec values malformed', 'POST', products_, {
    name: 'X',
    category: leaf,
    spec_values: ['x', 3],
  });
  write('create product, a chart its category does not use', 'POST', products_, {
    name: 'X',
    category: categories.get('lipstick'),
    size_chart: charts.get("Men's tops"),
  });
  write('create product, a chart in a category that declares nothing', 'POST', products_, {
    name: 'X',
    category: leaf,
    size_chart: charts.get('Shoe conversion'),
  });
  write('create product, bad references', 'POST', products_, {
    name: 'X',
    category: missing,
    brand: 'abc',
    size_chart: true,
    status: 'LIVE',
  });
  write('create product, nothing', 'POST', products_, {});

  const tee = P('parity-cotton-tee');
  write('rename product', 'PATCH', tee, { name: 'Parity Cotton Tee' });
  write('rename product with a slug', 'PATCH', tee, { name: 'Parity Tee', slug: 'parity-tee' });
  write('product to active and published', 'PATCH', P('parity-empty'), {
    status: 'ACTIVE',
    published: true,
  });
  write('product published alone while a draft', 'PATCH', P('parity-freebie'), { published: true });
  write('product status draft and published', 'PATCH', tee, { status: 'DRAFT', published: true });
  write('product specs set', 'PATCH', tee, {
    spec_values: [values.get('material:Linen'), values.get('material:Cotton')],
  });
  write('product specs cleared', 'PATCH', P('classic-oxford-shirt'), { spec_values: [] });
  write('product specs unchanged', 'PATCH', P('classic-oxford-shirt'), {
    spec_values: [],
    featured: false,
  });
  write('product chart set', 'PATCH', P('classic-oxford-shirt'), {
    size_chart: charts.get("Women's tops"),
  });
  write('product chart cleared', 'PATCH', P('classic-oxford-shirt'), { size_chart: null });
  write('product moved to a category its chart misses', 'PATCH', P('classic-oxford-shirt'), {
    category: categories.get('lipstick'),
  });
  write('product moved where its variants keep the chart', 'PATCH', P('leather-formal-shoes'), {
    category: categories.get('shirts'),
  });
  write('replace product', 'PUT', tee, {
    name: 'Parity Cotton Tee',
    category: categories.get('t-shirts'),
    brand: null,
    status: 'ACTIVE',
  });
  write('replace product, no category', 'PUT', tee, { name: 'X' });
  write('edit product, missing', 'PATCH', `/api/v1/products/${missing}/`, { name: 'X' });

  // --- Delete: archived, cascaded, refused ------------------------------------------------------
  write('delete product with history', 'DELETE', tee, undefined, 'admin');
  write('delete product without history', 'DELETE', P('parity-draft'), undefined, 'admin');
  write('delete product with only a single SKU', 'DELETE', P('parity-twin-a'), undefined, 'admin');
  write('delete product on a purchase order', 'DELETE', P('parity-twin-b'), undefined, 'admin');
  write('delete product as a manager', 'DELETE', P('parity-twin-a'), undefined);

  // --- Generating SKUs --------------------------------------------------------------------------
  const generate = (slug: string) => `${P(slug)}generate-variants/`;
  write('generate a matrix', 'POST', generate('parity-empty'), {
    price: '1500',
    cost: '700.5',
    selections: { color: ['White', 'Black'], size: ['M', 'S'] },
  });
  write('generate over existing variants', 'POST', generate('essential-cotton-t-shirt'), {
    price: 900,
    selections: { size: ['S', 'M', 'L'], color: ['Black'] },
  });
  write('generate a single version', 'POST', generate('parity-empty'), {
    price: '99.99',
    single: true,
  });
  write('generate a single version again', 'POST', generate('parity-twin-a'), {
    price: '1',
    single: 'true',
  });
  write('generate a single version beside sizes', 'POST', generate('parity-cotton-tee'), {
    price: '1',
    single: true,
  });
  write('generate sizes beside a single version', 'POST', generate('parity-twin-a'), {
    price: '1',
    selections: { size: ['S'] },
  });
  write('generate, no selections', 'POST', generate('parity-empty'), { price: '1' });
  write('generate, an unknown attribute', 'POST', generate('parity-empty'), {
    price: '1',
    selections: { "sh'ape": ['A'] },
  });
  write('generate, a specification', 'POST', generate('parity-empty'), {
    price: '1',
    selections: { material: ['Cotton'] },
  });
  write('generate, no values', 'POST', generate('parity-empty'), {
    price: '1',
    selections: { size: [] },
  });
  write('generate, unknown values', 'POST', generate('parity-empty'), {
    price: '1',
    selections: { size: ['XXXL', 'S', 'ABC'] },
  });
  write('generate, a negative cost', 'POST', generate('parity-empty'), {
    price: '1',
    cost: '-1',
    selections: { size: ['S'] },
  });
  write('generate, malformed', 'POST', generate('parity-empty'), {
    price: '1.234',
    single: 'maybe',
    selections: { size: 'S', color: [''] },
  });
  write('generate, selections not a dict', 'POST', generate('parity-empty'), {
    price: '1',
    selections: [],
  });
  write(
    'generate as a cashier',
    'POST',
    generate('parity-empty'),
    { price: '1', single: true },
    'cashier',
  );
  write('generate, missing product', 'POST', `/api/v1/products/${missing}/generate-variants/`, {
    price: 'x',
  });

  // --- Publishing -----------------------------------------------------------------------------------
  write('publish a product with nothing to sell', 'POST', `${P('parity-empty')}publish/`, {});
  write('publish a product priced at zero', 'POST', `${P('parity-freebie')}publish/`, {});
  write('publish a product', 'POST', `${P('parity-draft')}publish/`, {});
  write('publish a published product', 'POST', `${shirt}publish/`, {});
  write('unpublish a product', 'POST', `${shirt}unpublish/`, {});
  write('publish as a cashier', 'POST', `${shirt}publish/`, {}, 'cashier');
  write('publish, filtered out', 'POST', `${shirt}publish/?published=false`, {});

  return cases;
}
