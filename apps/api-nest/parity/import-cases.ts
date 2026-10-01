/**
 * Parity cases for the products CSV import (phase 4 part 3d): the dry run and
 * the import itself, every refusal of the upload, and the importer's reading
 * of a spreadsheet -- Python's `csv` module, `Decimal` and `int` -- through
 * files built to reach each branch of it.
 *
 * Every case is a write case: a dry run must write nothing, and an import is
 * compared by the products, variants, options, categories, brands, stock and
 * ledger rows it leaves, its audit entry and the revalidation jobs a new
 * category queues.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { multipart, type Part } from './image-cases.ts';
import { STOCK_EFFECTS } from './inventory-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const TABLES = [
  'catalog_product',
  'catalog_productvariant',
  'catalog_variantattributevalue',
  'catalog_category',
  'catalog_brand',
  'catalog_attribute',
  'catalog_attributevalue',
  'inventory_inventory',
  'inventory_inventorytransaction',
];

const EFFECTS = [
  ...STOCK_EFFECTS,
  `SELECT p.name, p.slug, c.slug AS category, b.slug AS brand, p.short_description, p.description,
          p.material, p.care_instructions, p.status, p.published, u.email AS created_by,
          p.created_at >= $1 AS created, p.updated_at >= $1 AS touched
     FROM catalog_product p JOIN catalog_category c ON c.id = p.category_id
     LEFT JOIN catalog_brand b ON b.id = p.brand_id LEFT JOIN accounts_user u ON u.id = p.created_by_id
    ORDER BY p.slug`,
  `SELECT p.slug AS product, v.sku, v.barcode, v.name, v.price::text AS price, v.cost::text AS cost,
          v.compare_at_price::text AS compare_at, v.weight_grams, v.position, v.status,
          v.created_at >= $1 AS created, v.updated_at >= $1 AS touched
     FROM catalog_productvariant v JOIN catalog_product p ON p.id = v.product_id ORDER BY v.sku`,
  `SELECT v.sku, a.code, av.value FROM catalog_variantattributevalue l
     JOIN catalog_productvariant v ON v.id = l.variant_id JOIN catalog_attribute a ON a.id = l.attribute_id
     JOIN catalog_attributevalue av ON av.id = l.attribute_value_id ORDER BY v.sku, a.code`,
  `SELECT c.name, c.slug, p.slug AS parent, c.image IS NULL AS no_image, c.position, c.is_active,
          c.show_in_navigation, c.created_at >= $1 AS created
     FROM catalog_category c LEFT JOIN catalog_category p ON p.id = c.parent_id ORDER BY c.slug`,
  `SELECT name, slug, logo IS NULL AS no_logo, is_active, is_featured, created_at >= $1 AS created
     FROM catalog_brand ORDER BY slug`,
  `SELECT a.name, a.code, a.kind, a.is_variant_defining, v.value, v.label, v.swatch, v.position
     FROM catalog_attributevalue v JOIN catalog_attribute a ON a.id = v.attribute_id
    WHERE v.created_at >= $1 OR a.created_at >= $1 ORDER BY a.code, v.value`,
];

async function reset(client: pg.Client): Promise<void> {
  await restoreTables(client, TABLES);
  await restoreSequences(client);
}

const CSV = 'text/csv';

export async function importCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const barcode = (
    await db.query<{ barcode: string }>(
      `SELECT barcode FROM catalog_productvariant WHERE sku = 'RGN-BLO-L-BEI'`,
    )
  ).rows[0]?.barcode as string;
  const branches = new Map(
    (await db.query<{ code: string; id: string }>(`SELECT code, id FROM accounts_branch`)).rows.map(
      (row) => [row.code, row.id],
    ),
  );
  await db.end();
  if (!branches.has('PAR3')) return [];
  const B = (code: string) => branches.get(code) as string;

  const cases: Case[] = [];
  const upload = (
    name: string,
    file: string | Buffer | null,
    fields: Record<string, string> = {},
    who: Who = 'owner',
    options: { filename?: string; type?: string } = {},
  ) => {
    const parts: Part[] = [];
    for (const [key, value] of Object.entries(fields)) parts.push([key, value]);
    if (file !== null) {
      parts.push([
        'file',
        {
          filename: options.filename ?? 'catalogue.csv',
          type: options.type ?? CSV,
          bytes: typeof file === 'string' ? Buffer.from(file, 'utf8') : file,
        },
      ]);
    }
    const boundary = '----ParityImport7';
    cases.push({
      name: `admin product import: ${name}`,
      method: 'POST',
      path: '/api/v1/products/import/',
      headers: { ...auth(who), 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: multipart(parts, boundary),
      reset,
      effects: EFFECTS,
      jobs: true,
    });
  };
  const commit = { dry_run: 'false' };

  // A catalogue the importer can do everything with: a product in a new
  // category under an old one, with a new brand; a product the shop has (by
  // slug), re-priced; a SKU the shop has; options old and new; opening stock.
  const good = [
    'Product Name,Category,Brand,SKU,Size,Color,Price,Cost,Compare at price,Opening stock,Weight grams,Published,Slug,Description,Extra',
    'Parity Linen Shirt,Men > Parity Shirts,Parity Looms,PAR-LIN-M-WHT,M,White,"1,450",620,,12,250,yes,,Breathable,x',
    'Parity Linen Shirt,Men > Parity Shirts,Parity Looms,PAR-LIN-L-SKY,L,Sky,৳1490,620.5,1990,0,,,,,',
    'Essential Cotton T-Shirt,,,RGN-ESS-XL-WHI,,,Tk 990,,,7,,draft,essential-cotton-t-shirt,Softer than ever,',
    'Parity Linen Shirt,Men > Parity Shirts,,PAR-LIN-XL-WHT,XL,white,1_500,0,,3,1.9,,,,',
  ].join('\r\n');

  for (const [label, fields] of [
    ['dry run by default', {}],
    ['dry run asked for', { dry_run: 'true' }],
    ['dry run, a blank flag', { dry_run: '' }],
    ['a flag that is not one', { dry_run: 'maybe' }],
  ] as [string, Record<string, string>][]) {
    upload(`${label}`, good, fields);
  }
  upload('import at DHK1', good, commit);
  upload('import at PAR3', good, { ...commit, branch: B('PAR3') });
  upload('import at a blank branch', good, { ...commit, branch: '' });
  upload('import at an inactive branch', good, { ...commit, branch: B('PAR2') });
  upload('import at a malformed branch', good, { ...commit, branch: 'x' });
  upload('import at DHK1 by the PAR3 manager', good, { ...commit, branch: B('DHK1') }, 'mirpur');
  upload('import by the PAR3 manager', good, commit, 'mirpur');
  for (const who of ['manager', 'stock', 'cashier', 'accountant', 'admin', 'anon'] as Who[]) {
    upload(`dry run as ${who}`, good, {}, who);
  }

  // The file itself.
  const files: [string, string | Buffer, { filename?: string; type?: string }?][] = [
    ['an empty file', ''],
    ['only a byte-order mark', '\uFEFF'],
    ['a blank first line', '\nproduct_name,sku,price\nA,B,1'],
    ['a header and no rows', 'product_name,sku,price\n'],
    ['a header and blank rows', 'product_name,sku,price\n\n,,\n  ,  ,  \n'],
    ['missing one column', 'product_name,sku\nA,B'],
    ['missing every column', 'name\nA'],
    ['two byte-order marks', '\uFEFF\uFEFFproduct_name,sku,price\nParity BOM,PAR-BOM,10'],
    ['upper-case, spaced headers', 'PRODUCT NAME, SKU ,Price\nParity Caps,PAR-CAPS,10'],
    ['a repeated header', 'product_name,sku,price,price\nParity Twice,PAR-TWICE,10,20'],
    [
      'short and long rows',
      'product_name,sku,price,cost\nParity Short,PAR-SHORT,10\nParity Long,PAR-LONG,10,4,9,9',
    ],
    [
      'quoted commas and new lines',
      'product_name,sku,price,description\n"Parity, Quoted",PAR-Q,10,"line one\nline two"',
    ],
    ['a quote left open', 'product_name,sku,price\nParity Open,PAR-OPEN,"10'],
    ['a stray carriage return', 'product_name,sku,price\nParity CR,PAR-CR\r,10'],
    ['carriage returns only', 'product_name,sku,price\rParity Mac,PAR-MAC,10\r'],
    ['a NUL in a cell', 'product_name,sku,price,category\nParity Nul,PAR-NUL,10,A\u0000B'],
    ['the same SKU twice', 'product_name,sku,price\nA,PAR-DUP,10\nB,PAR-DUP,11'],
    [
      'required cells blank',
      'product_name,sku,price\n,PAR-NONAME,10\nParity No SKU,,10\nParity No Price,PAR-NOPRICE,',
    ],
    [
      'bad numbers',
      'product_name,sku,price,cost,compare_at_price,weight_grams,opening_stock\nParity Bad,PAR-BAD,ten,-1,1 0,heavy,-2',
    ],
    [
      'whole numbers that are not',
      'product_name,sku,price,weight_grams,opening_stock\nParity Whole,PAR-WHOLE,10,nan,inf',
    ],
    ['a price of Tk alone', 'product_name,sku,price\nParity Tk,PAR-TK,Tk'],
    ['a price that is NaN', 'product_name,sku,price\nParity NaN,PAR-NAN,NaN'],
    ['an infinite price', 'product_name,sku,price,category\nParity Inf,PAR-INF,Infinity,Men'],
    [
      'Bengali digits',
      'product_name,sku,price,cost,opening_stock,category\nParity Bangla,PAR-BN,১২৯০,৬০০,১২,Men',
    ],
    [
      'a fraction of stock',
      'product_name,sku,price,opening_stock,category\nParity Frac,PAR-FRAC,10,2.9,Men',
    ],
    ['no category for a new product', 'product_name,sku,price\nParity Homeless,PAR-HOME,10'],
    [
      'one new category for two products',
      'product_name,sku,price,category\nParity One,PAR-ONE,10,Parity New > Deep\nParity Two,PAR-TWO,10,Parity New > Deep',
    ],
    [
      'a category path of blanks',
      'product_name,sku,price,category\nParity Blank,PAR-BLANKCAT,10, > > ',
    ],
    [
      'a brand in another case',
      'product_name,sku,price,category,brand\nParity Branded,PAR-BRAND,10,Men,parity unused',
    ],
    ['a SKU in another case', 'product_name,sku,price,category\nParity Lower,rgn-cla-l-whi,10,Men'],
    [
      'a barcode the shop has',
      `product_name,sku,price,category,barcode\nParity Clash,PAR-CLASH,10,Men,${barcode}`,
    ],
    [
      'a SKU past the column',
      `product_name,sku,price,category\nParity Long SKU,${'S'.repeat(70)},10,Men`,
    ],
    [
      'a size past the column',
      `product_name,sku,price,category,size\nParity Size,PAR-SIZE,10,Men,${'Z'.repeat(70)}`,
    ],
    [
      'a slug the shop does not have',
      'product_name,sku,price,category,slug\nParity Slugged,PAR-SLUG,10,Men,parity-made-up-slug',
    ],
    [
      'over 5000 rows',
      `product_name,sku,price\n${Array.from({ length: 5002 }, (_, i) => `P${i},S${i},1`).join('\n')}`,
    ],
    ['not UTF-8', Buffer.from([0x70, 0x72, 0x6f, 0xff, 0xfe, 0x0a])],
    [
      'a spreadsheet saved as Latin-1',
      Buffer.from('product_name,sku,price\nCaf\xe9,PAR-CAFE,10', 'latin1'),
    ],
    ['a photograph', Buffer.alloc(5 * 1024 * 1024 + 1, 0x41), { filename: 'big.csv' }],
  ];
  for (const [name, file, options] of files)
    upload(`dry run, ${name}`, file, {}, 'owner', options ?? {});
  // The ones that reach the database, imported for real.
  const committed = new Set([
    'two byte-order marks',
    'upper-case, spaced headers',
    'a repeated header',
    'short and long rows',
    'quoted commas and new lines',
    'a quote left open',
    'a NUL in a cell',
    'the same SKU twice',
    'an infinite price',
    'Bengali digits',
    'a fraction of stock',
    'no category for a new product',
    'one new category for two products',
    'a category path of blanks',
    'a brand in another case',
    'a SKU in another case',
    'a barcode the shop has',
    'a SKU past the column',
    'a size past the column',
    'a slug the shop does not have',
  ]);
  for (const [name, file] of files)
    if (committed.has(name)) upload(`import, ${name}`, file, commit);

  // The upload.
  upload('no file', null, {});
  upload('a file field that is text', null, { file: 'product_name,sku,price' });
  upload('a file with no name', '', {}, 'owner', { filename: '' });
  cases.push({
    name: 'admin product import: a JSON body',
    method: 'POST',
    path: '/api/v1/products/import/',
    headers: { ...auth('owner'), 'content-type': 'application/json' },
    body: JSON.stringify({ file: 'x', dry_run: true }),
    reset,
    effects: EFFECTS,
    jobs: true,
  });
  cases.push({
    name: 'admin product import: a urlencoded body',
    method: 'POST',
    path: '/api/v1/products/import/',
    headers: { ...auth('owner'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'file=x&dry_run=true',
    reset,
    effects: EFFECTS,
    jobs: true,
  });
  cases.push({
    name: 'admin product import: GET',
    path: '/api/v1/products/import/',
    headers: auth('owner'),
  });
  return cases;
}
