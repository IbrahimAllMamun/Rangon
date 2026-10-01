import { randomUUID } from 'node:crypto';

import { nextNumber } from '../../common/sequence';
import type { Queryable } from '../../database/database.service';
import { VARIANT_COLUMNS, type VariantRow } from './catalogue-payloads';

/**
 * `catalog.services`: how a SKU is named, numbered and created
 * (`build_sku`, `generate_barcode`, `create_variant`).
 */

/** `_token`: letters and digits only, upper case, the first few -- or "X". */
export function skuToken(value: string, length = 3): string {
  const cleaned = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, length) || 'X';
}

/** `build_sku`: `RGN-POL-BLK-M`, made unique by a numeric suffix. */
export async function buildSku(
  q: Queryable,
  productName: string,
  values: readonly { value: string }[],
): Promise<string> {
  const base = [
    'RGN',
    skuToken(productName, 3),
    ...values.map((value) => skuToken(value.value, 3)),
  ].join('-');
  let candidate = base;
  let counter = 1;
  for (;;) {
    const taken = await q.one(
      `SELECT 1 AS "a" FROM "catalog_productvariant" WHERE "catalog_productvariant"."sku" = $1 LIMIT 1`,
      [candidate],
    );
    if (!taken) return candidate;
    counter += 1;
    candidate = `${base}-${counter}`;
  }
}

/**
 * `generate_barcode`: an EAN-13 in the in-store range (prefix 20), from the
 * row-locked `barcode` sequence, with its check digit.
 */
export async function generateBarcode(q: Queryable): Promise<string> {
  const sequence = await nextNumber(q, 'barcode', '', 9);
  const body = `20${sequence.slice(-10)}`.slice(0, 12).padEnd(12, '0');
  let total = 0;
  for (const [index, digit] of [...body].entries())
    total += Number(digit) * (index % 2 === 0 ? 1 : 3);
  return `${body}${(10 - (total % 10)) % 10}`;
}

export interface ValueRef {
  id: string;
  attribute_id: string;
  value: string;
  label: string;
}

/**
 * `create_variant`: the row (its SKU derived, its name the values' display
 * names), then its barcode in a second write, then one attribute link per
 * value. Inside the caller's transaction.
 */
export async function createVariant(
  q: Queryable,
  product: { id: string; name: string },
  values: readonly ValueRef[],
  price: string,
  cost: string,
): Promise<VariantRow> {
  const row: VariantRow = {
    id: randomUUID(),
    product_id: product.id,
    sku: await buildSku(q, product.name, values),
    barcode: null,
    name: values.map((value) => value.label || value.value).join(' / '),
    price,
    compare_at_price: null,
    cost,
    weight_grams: null,
    position: 0,
    status: 'ACTIVE',
    batch_number: '',
    expiry_date: null,
  };
  await q.query(
    `INSERT INTO "catalog_productvariant" ("created_at", "updated_at", ${VARIANT_COLUMNS.map((c) => `"${c}"`).join(', ')})
     VALUES (clock_timestamp(), clock_timestamp(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    VARIANT_COLUMNS.map((column) => row[column]),
  );
  row.barcode = await generateBarcode(q);
  await q.query(
    `UPDATE "catalog_productvariant" SET "barcode" = $2 WHERE "catalog_productvariant"."id" = $1`,
    [row.id, row.barcode],
  );
  for (const value of values) {
    await q.query(
      `INSERT INTO "catalog_variantattributevalue" ("id", "created_at", "updated_at", "variant_id",
         "attribute_id", "attribute_value_id")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4)`,
      [randomUUID(), row.id, value.attribute_id, value.id],
    );
  }
  return row;
}
