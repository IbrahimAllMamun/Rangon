/**
 * Parity cases for product images (phase 4 part 3c): uploads as multipart
 * forms -- every refusal DRF's `ImageField`, Pillow, the extension
 * validator and `validate_image_upload` make, the colour rules, form
 * semantics for blank fields, the stored file's name -- and edits as JSON.
 *
 * Stored names differ between the APIs only by the random suffix Django's
 * storage adds when a name is taken (files are not removed between cases),
 * so names and URLs are compared with that suffix taken off.
 */
import { crc32 } from 'node:zlib';

import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { IMAGES } from './images.ts';
import { resetProducts } from './product-cases.ts';
import type { Case } from './run.ts';

const BOUNDARY = 'ParityBoundary7MA4YWxkTrZu0gW';

export type Part = [string, string] | [string, { filename: string; type: string; bytes: Buffer }];

/** A `multipart/form-data` body, as a browser builds one. */
export function multipart(parts: Part[], boundary = BOUNDARY): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (typeof value === 'string') {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: ${value.type}\r\n\r\n`,
        ),
      );
      chunks.push(value.bytes, Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const bytes = (key: keyof typeof IMAGES) => Buffer.from(IMAGES[key], 'base64');

/** A valid PNG padded past 10 MB with a private chunk Pillow reads and checks. */
function hugePng(): Buffer {
  const png = bytes('png');
  const iend = png.length - 12;
  const data = Buffer.alloc(11 * 1024 * 1024, 7);
  const type = Buffer.from('prVt');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  return Buffer.concat([png.subarray(0, iend), length, type, data, crc, png.subarray(iend)]);
}

/** A PNG whose IHDR checksum no longer matches. */
function corruptPng(): Buffer {
  const png = Buffer.from(bytes('png'));
  png[29] = (png[29] as number) ^ 0xff;
  return png;
}

/** A JPEG cut off before its scan. */
function truncatedJpeg(): Buffer {
  const jpeg = bytes('jpeg');
  return jpeg.subarray(0, jpeg.indexOf(Buffer.from([0xff, 0xda])));
}

const SUFFIX = /_[A-Za-z0-9]{7}(\.[^/]*)?$/;

export async function imageCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const products = new Map(
    (await db.query<{ slug: string; id: string }>(`SELECT slug, id FROM catalog_product`)).rows.map(
      (row) => [row.slug, row.id],
    ),
  );
  const values = new Map(
    (
      await db.query<{ key: string; id: string }>(
        `SELECT a.code || ':' || v.value AS key, v.id FROM catalog_attributevalue v JOIN catalog_attribute a ON a.id = v.attribute_id`,
      )
    ).rows.map((row) => [row.key, row.id]),
  );
  const images = (
    await db.query<{ id: string; slug: string; position: number }>(
      `SELECT i.id, p.slug, i.position FROM catalog_productimage i JOIN catalog_product p ON p.id = i.product_id
        ORDER BY p.slug, i.position, i.created_at`,
    )
  ).rows;
  await db.end();
  if (!products.has('parity-freebie')) return [];
  const known = new Set(images.map((image) => image.id));
  const tee = products.get('parity-cotton-tee') as string;
  const missing = '00000000-0000-4000-8000-000000000000';

  const EFFECTS = [
    `SELECT p.slug, av.value AS colour,
            regexp_replace(i.image, '_[A-Za-z0-9]{7}(\\.[^/]*)?$', '\\1') AS image,
            i.alt_text, i.position, i.is_primary, i.updated_at >= $1 AS touched, i.created_at >= $1 AS created
       FROM catalog_productimage i JOIN catalog_product p ON p.id = i.product_id
       LEFT JOIN catalog_attributevalue av ON av.id = i.attribute_value_id
      ORDER BY p.slug, i.position, 3, i.alt_text`,
  ];
  const normalize = (response: unknown) => {
    const row = response as { id?: unknown; url?: unknown } | null;
    if (!row || typeof row !== 'object') return;
    if (typeof row.id === 'string' && !known.has(row.id)) row.id = '<minted>';
    if (typeof row.url === 'string') row.url = row.url.replace(SUFFIX, '$1');
  };

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'manager') =>
    cases.push({ name: `admin images: ${name}`, path, headers: auth(who) });
  const upload = (
    name: string,
    parts: Part[],
    options: { method?: string; path?: string; who?: Who } = {},
  ) =>
    cases.push({
      name: `admin images: ${name}`,
      method: options.method ?? 'POST',
      path: options.path ?? '/api/v1/product-images/',
      headers: {
        ...auth(options.who ?? 'manager'),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body: multipart(parts),
      reset: resetProducts,
      effects: EFFECTS,
      normalize,
      normalizeLocation: (location) => location.replace(SUFFIX, '$1'),
    });
  const edit = (name: string, method: string, path: string, body: unknown, who: Who = 'manager') =>
    cases.push({
      name: `admin images: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      reset: resetProducts,
      effects: EFFECTS,
      normalize,
    });
  const file = (filename: string, data: Buffer, type = 'image/jpeg'): Part => [
    'image',
    { filename, type, bytes: data },
  ];

  // --- Reading ---------------------------------------------------------------------------------
  for (const query of [
    '',
    `?product=${tee}`,
    `?attribute_value=${values.get('color:White')}`,
    '?product=abc',
    '?ordering=product',
    '?ordering=-product,position',
    '?ordering=attribute_value',
    '?ordering=-is_primary,position',
    '?ordering=url',
    '?page_size=2&page=2',
  ]) {
    read(`list ${query || '(all)'}`, `/api/v1/product-images/${query}`);
  }
  for (const image of images)
    read(`image ${image.slug} #${image.position}`, `/api/v1/product-images/${image.id}/`);

  // --- Uploads ------------------------------------------------------------------------------------
  upload('a JPEG', [['product', tee], file('parity photo.jpg', bytes('jpeg'))]);
  upload('a PNG named .jpg', [['product', tee], file('parity-png.jpg', bytes('png'), 'image/png')]);
  upload('a WebP', [['product', tee], file('parity.webp', bytes('webp'), 'image/webp')]);
  upload('an AVIF', [['product', tee], file('parity.avif', bytes('avif'), 'image/avif')]);
  upload('a GIF', [['product', tee], file('parity.gif', bytes('gif'), 'image/gif')]);
  upload('a GIF named .jpg', [['product', tee], file('parity-gif.jpg', bytes('gif'))]);
  upload('a BMP', [['product', tee], file('parity.bmp', bytes('bmp'), 'image/bmp')]);
  upload('a TIFF', [['product', tee], file('parity.tiff', bytes('tiff'), 'image/tiff')]);
  upload('text', [['product', tee], file('parity-text.jpg', Buffer.from('hello'))]);
  upload('a corrupt PNG', [['product', tee], file('parity-bad.png', corruptPng(), 'image/png')]);
  upload('a JPEG cut short', [['product', tee], file('parity-cut.jpg', truncatedJpeg())]);
  upload('an empty file', [['product', tee], file('parity-empty.jpg', Buffer.alloc(0))]);
  upload('a .txt name', [['product', tee], file('parity.txt', bytes('jpeg'), 'text/plain')]);
  upload('no extension', [['product', tee], file('parity', bytes('jpeg'))]);
  upload('an image over 10 MB', [
    ['product', tee],
    file('parity-huge.png', hugePng(), 'image/png'),
  ]);
  upload('a path for a name', [['product', tee], file('../../etc/parity-up.jpg', bytes('jpeg'))]);
  upload('a Bengali name', [['product', tee], file('ছবি নতুন.jpg', bytes('jpeg'))]);
  upload('no image', [['product', tee]]);
  // Django reads a part as a file only when its `filename` is not empty.
  upload('an image with an empty file name', [['product', tee], file('', bytes('jpeg'))]);
  upload('the image as text', [
    ['product', tee],
    ['image', 'abc'],
  ]);
  upload('blank fields', [
    ['product', ''],
    ['attribute_value', ''],
    ['alt_text', ''],
    ['position', ''],
    ['is_primary', ''],
    file('parity-blank.jpg', bytes('jpeg')),
  ]);
  upload('a colour it does not come in', [
    ['product', tee],
    ['attribute_value', values.get('color:Navy') as string],
    file('parity-navy.jpg', bytes('jpeg')),
  ]);
  upload('a colour it comes in', [
    ['product', tee],
    ['attribute_value', values.get('color:White') as string],
    ['is_primary', 'true'],
    ['position', '3'],
    ['alt_text', 'White tee'],
    file('parity-white.jpg', bytes('jpeg')),
  ]);
  upload('a size as a colour', [
    ['product', tee],
    ['attribute_value', values.get('size:S') as string],
    file('parity-size.jpg', bytes('jpeg')),
  ]);
  upload('the first image of a product', [
    ['product', products.get('parity-empty') as string],
    file('parity-first.jpg', bytes('jpeg')),
  ]);
  upload('as a cashier', [['product', tee], file('parity-cashier.jpg', bytes('jpeg'))], {
    who: 'cashier',
  });
  cases.push({
    name: 'admin images: a multipart body with no boundary',
    method: 'POST',
    path: '/api/v1/product-images/',
    headers: { ...auth('manager'), 'content-type': 'multipart/form-data' },
    body: multipart([['product', tee]]),
    reset: resetProducts,
    effects: EFFECTS,
  });
  cases.push({
    name: 'admin images: a urlencoded form',
    method: 'POST',
    path: '/api/v1/product-images/',
    headers: { ...auth('manager'), 'content-type': 'application/x-www-form-urlencoded' },
    body: `product=${tee}&alt_text=caf%C3%A9`,
    reset: resetProducts,
    effects: EFFECTS,
  });
  edit('a JSON upload', 'POST', '/api/v1/product-images/', { product: tee, image: 'x.jpg' });

  // --- Edits ---------------------------------------------------------------------------------------
  const first = images.find((image) => image.slug === 'parity-cotton-tee');
  const teal = images.find((image) => image.slug === 'parity-draft');
  if (first) {
    const path = `/api/v1/product-images/${first.id}/`;
    edit('edit alt text', 'PATCH', path, { alt_text: 'New alt', position: 5, is_primary: false });
    edit('edit to a colour it does not come in', 'PATCH', path, {
      attribute_value: values.get('color:Navy'),
    });
    edit('replace without a file', 'PUT', path, { product: tee, alt_text: 'x' });
    upload(
      'replace the file',
      [['alt_text', 'Swapped'], file('parity-swap.png', bytes('png'), 'image/png')],
      {
        method: 'PATCH',
        path,
      },
    );
    edit('delete an image', 'DELETE', path, undefined, 'admin');
  }
  if (teal) {
    // Its colour's variant is gone, and the colour rule is re-checked on any edit.
    edit(
      'edit an image whose colour has no variant',
      'PATCH',
      `/api/v1/product-images/${teal.id}/`,
      {
        alt_text: 'x',
      },
    );
  }
  edit('edit a missing image', 'PATCH', `/api/v1/product-images/${missing}/`, { alt_text: 'x' });

  return cases;
}
