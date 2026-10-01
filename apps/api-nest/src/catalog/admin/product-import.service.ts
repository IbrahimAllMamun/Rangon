import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { RolePermissions } from '../../auth/permissions';
import type { AuditActor, AuditContext } from '../../common/audit';
import { recordAudit } from '../../common/audit';
import { Dec } from '../../common/decimal';
import {
  booleanField,
  errorMessages,
  fileField,
  Invalid,
  runSerializer,
  uuidField,
  withDefault,
} from '../../common/drf';
import { ValidationError } from '../../common/errors';
import { csvDictReader } from '../../common/pycsv';
import {
  compareCodePoints,
  isFiniteDecimal,
  pyDecimal,
  pyReprStr,
  pyStrip,
} from '../../common/python';
import { uniqueSlug } from '../../common/slugs';
import { Database, Queryable } from '../../database/database.service';
import type { UploadedFile } from '../../http/multipart';
import { NAVIGATION_TAGS, Revalidation } from '../../jobs/revalidation';
import { type Branch, StockService } from '../../inventory/stock.service';

/**
 * `catalog.importers`: a catalogue loaded from a spreadsheet -- products,
 * variants and opening stock, one row per variant -- planned (`plan`, the dry
 * run) or applied in one transaction (`apply`).
 *
 * The file is read with Python's `csv.DictReader` (common/pycsv.ts) and its
 * cells with Python's `Decimal` and `int`, every quirk kept: a price of `Tk`
 * cleans to nothing and drops its row without a word, `NaN` is a 500, a
 * dry run names a category it would create once per product that uses it.
 */

const REQUIRED_COLUMNS = ['product_name', 'sku', 'price'] as const;
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([
  ...REQUIRED_COLUMNS,
  'slug',
  'category',
  'brand',
  'short_description',
  'description',
  'material',
  'care_instructions',
  'barcode',
  'cost',
  'compare_at_price',
  'size',
  'color',
  'weight_grams',
  'opening_stock',
  'published',
]);
const MAX_ROWS = 5000;
const TRUTHY = new Set(['1', 'true', 'yes', 'y', 't', 'published', 'active']);
const FALSEY = new Set(['0', 'false', 'no', 'n', 'f', 'draft', 'unpublished', '']);

/** `ProductImportSerializer.MAX_BYTES`: a wrong file is not read at all. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * `validate_file`: within 5 MB, then `utf-8-sig` -- a leading byte-order mark
 * dropped, anything that is not UTF-8 refused.
 */
function decodeUpload(upload: UploadedFile): string {
  if (upload.size > MAX_BYTES) {
    throw Invalid.of(
      `The file is ${Math.floor(upload.size / 1024)} KB. The limit is 5 MB — is this a spreadsheet?`,
    );
  }
  const bom = upload.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bom ? upload.bytes.subarray(3) : upload.bytes,
    );
  } catch {
    throw Invalid.of(
      'The file is not readable as UTF-8 text. Export it from your spreadsheet as CSV UTF-8.',
    );
  }
}

interface RowError {
  line: number;
  column: string;
  message: string;
}

export interface ImportPlan {
  products_created: string[];
  products_updated: string[];
  variants_created: string[];
  variants_updated: string[];
  categories_created: string[];
  brands_created: string[];
  stock_receipts: number;
  errors: RowError[];
  ignored_columns: string[];
}

interface ParsedRow {
  line: number;
  productKey: string;
  productName: string;
  slug: string;
  category: string;
  brand: string;
  shortDescription: string;
  description: string;
  material: string;
  careInstructions: string;
  published: boolean;
  sku: string;
  barcode: string;
  price: string;
  cost: string;
  compareAtPrice: string | null;
  size: string;
  color: string;
  weightGrams: bigint | null;
  openingStock: bigint;
}

/**
 * The model's `DecimalField.to_python` on save: an infinite amount is
 * Django's `ValidationError`, which the API answers 400 -- price first, then
 * compare-at price, then cost, the model's order.
 */
function finiteAmounts(amounts: (string | null)[]): void {
  for (const amount of amounts) {
    if (amount !== null && !isFiniteDecimal(amount)) {
      throw new ValidationError('Invalid input.', {
        details: { non_field_errors: [`“${amount}” value must be a decimal number.`] },
      });
    }
  }
}

/** `ImportPlan.as_dict()`. */
export function planPayload(plan: ImportPlan): Record<string, unknown> {
  return {
    ok: plan.errors.length === 0,
    products_created: plan.products_created,
    products_updated: plan.products_updated,
    variants_created: plan.variants_created,
    variants_updated: plan.variants_updated,
    categories_created: plan.categories_created,
    brands_created: plan.brands_created,
    stock_receipts: plan.stock_receipts,
    ignored_columns: plan.ignored_columns,
    errors: plan.errors,
  };
}

/** A header as the importer reads it: stripped, lower case, spaces as underscores. */
const header = (name: string) => pyStrip(name).toLowerCase().replaceAll(' ', '_');

/**
 * `_decimal`: money as a person types it (`1,290`, `৳1290`, `Tk 1290`).
 * `NaN` passes `Decimal()` and then fails the sign check with
 * `InvalidOperation`, which nothing catches: a 500, as in Django.
 */
function decimalCell(raw: string, line: number, column: string, errors: RowError[]) {
  const cleaned = pyStrip(
    pyStrip(raw).replaceAll(',', '').replaceAll('৳', '').replaceAll('Tk', ''),
  );
  if (!cleaned) return null;
  const value = pyDecimal(cleaned);
  if (value === null) {
    errors.push({ line, column, message: `${pyReprStr(raw)} is not a number.` });
    return null;
  }
  if (/NaN$/.test(value)) throw new Error('decimal.InvalidOperation: [<class InvalidOperation>]');
  const negative = value === '-Infinity' || (isFiniteDecimal(value) && new Dec(value).lt(0));
  if (negative) {
    errors.push({ line, column, message: 'Cannot be negative.' });
    return null;
  }
  return value;
}

/** `_integer`: `int(Decimal(cleaned))`, truncating; NaN and infinity are not whole numbers. */
function integerCell(raw: string, line: number, column: string, errors: RowError[]) {
  const cleaned = pyStrip(raw).replaceAll(',', '');
  if (!cleaned) return null;
  const value = pyDecimal(cleaned);
  if (value === null || !isFiniteDecimal(value)) {
    errors.push({ line, column, message: `${pyReprStr(raw)} is not a whole number.` });
    return null;
  }
  const whole = BigInt(new Dec(value).trunc().toFixed(0));
  if (whole < 0n) {
    errors.push({ line, column, message: 'Cannot be negative.' });
    return null;
  }
  return whole;
}

function booleanCell(raw: string, fallback: boolean): boolean {
  const cleaned = pyStrip(raw).toLowerCase();
  if (TRUTHY.has(cleaned)) return true;
  if (FALSEY.has(cleaned)) return false;
  return fallback;
}

/** `parse(content)`: every row, and every problem, before anything is written. */
export function parseImport(content: string): {
  rows: ParsedRow[];
  errors: RowError[];
  ignored: string[];
} {
  const errors: RowError[] = [];
  const { fieldnames, rows: records } = csvDictReader(content.replace(/^\uFEFF+/, ''));
  if (fieldnames === null) throw new ValidationError('The file is empty.');
  const headers = fieldnames.map(header);
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new ValidationError(
      `The file is missing the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}. ` +
        `Every row needs at least ${REQUIRED_COLUMNS.join(', ')}.`,
    );
  }
  const ignored = [
    ...new Set(headers.filter((column) => column && !KNOWN_COLUMNS.has(column))),
  ].sort(compareCodePoints);

  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  let index = 0;
  for (const record of records()) {
    const line = index + 2;
    index += 1;
    if (line - 1 > MAX_ROWS) {
      errors.push({
        line,
        column: '',
        message: `More than ${MAX_ROWS} rows. Split the file, or check it is the one you meant to upload.`,
      });
      break;
    }
    const row = new Map<string, string>();
    for (const [key, value] of record) {
      if (key === null) continue;
      row.set(header(key), typeof value === 'string' ? pyStrip(value) : '');
    }
    if (![...row.values()].some(Boolean)) continue;
    const get = (column: string) => row.get(column) ?? '';

    const name = get('product_name');
    const sku = get('sku');
    if (!name) errors.push({ line, column: 'product_name', message: 'Required.' });
    if (!sku) errors.push({ line, column: 'sku', message: 'Required.' });
    if (sku) {
      const first = seen.get(sku);
      if (first !== undefined) {
        errors.push({
          line,
          column: 'sku',
          message: `${pyReprStr(sku)} is already used on line ${first}. A SKU identifies one variant.`,
        });
      } else seen.set(sku, line);
    }
    const price = decimalCell(get('price'), line, 'price', errors);
    if (price === null && pyStrip(get('price')) === '')
      errors.push({ line, column: 'price', message: 'Required.' });
    const cost = decimalCell(get('cost'), line, 'cost', errors);
    const compare = decimalCell(get('compare_at_price'), line, 'compare_at_price', errors);
    const weight = integerCell(get('weight_grams'), line, 'weight_grams', errors);
    const stock = integerCell(get('opening_stock'), line, 'opening_stock', errors);
    if (!name || !sku || price === null) continue;

    const slug = pyStrip(get('slug'));
    rows.push({
      line,
      productKey: slug || pyStrip(name).toLowerCase(),
      productName: name,
      slug,
      category: get('category'),
      brand: get('brand'),
      shortDescription: get('short_description'),
      description: get('description'),
      material: get('material'),
      careInstructions: get('care_instructions'),
      published: booleanCell(get('published'), true),
      sku,
      barcode: get('barcode'),
      price,
      cost: cost ?? '0.00',
      compareAtPrice: compare,
      size: get('size'),
      color: get('color'),
      weightGrams: weight,
      openingStock: stock ?? 0n,
    });
  }
  if (!rows.length && !errors.length)
    throw new ValidationError('The file has a header but no rows.');
  return { rows, errors, ignored };
}

interface ProductRef {
  id: string;
  name: string;
  category_id: string;
  brand_id: string | null;
  short_description: string;
  description: string;
  material: string;
  care_instructions: string;
}

@Injectable()
export class ProductImportService {
  constructor(
    private readonly db: Database,
    private readonly stock: StockService,
    private readonly revalidation: Revalidation,
    private readonly permissions: RolePermissions,
  ) {}

  /**
   * `ProductViewSet.import_csv`: `ProductImportSerializer`, then a dry run
   * (the default) or the import at the branch `resolve_branch` allows -- 201,
   * or 400 with the same body when a row is wrong.
   */
  async handle(user: RequestUser, data: unknown, actor: AuditActor, context: AuditContext) {
    const validated = await runSerializer<{
      file: string;
      dry_run: boolean;
      branch?: string | null;
    }>(
      {
        file: fileField(),
        dry_run: withDefault(booleanField({ required: false }), () => true),
        branch: uuidField({ required: false, allowNull: true }),
      },
      data,
      { hooks: { file: (upload: UploadedFile) => decodeUpload(upload) } },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const { file, dry_run: dryRun, branch } = validated.values;
    if (dryRun)
      return { status: 200, body: { dry_run: true, ...planPayload(await this.plan(file)) } };
    const target = await this.permissions.resolveBranch(user, branch ?? null);
    const result = await this.apply(file, target, actor, context);
    return {
      status: result.errors.length ? 400 : 201,
      body: { dry_run: false, ...planPayload(result) },
    };
  }

  /** `plan(content)`: what the file would do, without a transaction and without a write. */
  async plan(content: string): Promise<ImportPlan> {
    return this.run(this.db, content, false, null, null, null);
  }

  /** `apply(content, branch, actor)`: all of it in one transaction, or none of it. */
  async apply(
    content: string,
    branch: Branch,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<ImportPlan> {
    return this.db.transaction((tx) => this.run(tx, content, true, branch, actor, context));
  }

  /** `_category_for`: `Women > Ethnic > Kurti`, made where missing (and named in the plan). */
  private async categoryFor(q: Queryable, path: string, created: string[], commit: boolean) {
    const parts = path
      .split('>')
      .map((part) => pyStrip(part))
      .filter(Boolean);
    if (!parts.length) return null;
    let parent: string | null = null;
    let missing = false;
    for (const [index, part] of parts.entries()) {
      if (!missing) {
        const existing: { id: string } | null = await q.one<{ id: string }>(
          `SELECT "catalog_category"."id" FROM "catalog_category"
            WHERE (UPPER("catalog_category"."name"::text) = UPPER($1)
              AND ${parent ? '"catalog_category"."parent_id" = $2::uuid' : '"catalog_category"."parent_id" IS NULL'})
            ORDER BY "catalog_category"."position" ASC, "catalog_category"."name" ASC LIMIT 1`,
          parent ? [part, parent] : [part],
        );
        if (existing) {
          parent = existing.id;
          continue;
        }
        missing = true;
      }
      created.push(parts.slice(0, index + 1).join(' > '));
      if (commit) {
        const id = randomUUID();
        const slug = await uniqueSlug(q, 'catalog_category', 'category', part, 140);
        await q.query(
          `INSERT INTO "catalog_category" ("id", "created_at", "updated_at", "parent_id", "name", "slug",
             "description", "image", "position", "is_active", "show_in_navigation", "tax_rate",
             "seo_title", "seo_description")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4, '', '', 0, true,
                   true, NULL, '', '')`,
          [id, parent, part, slug],
        );
        // `content.signals`: a saved category queues the storefront's revalidation at once.
        await this.revalidation.request(...NAVIGATION_TAGS);
        parent = id;
      }
    }
    return !commit && missing ? null : parent;
  }

  /** `_brand_for`: matched in any case, made where missing. */
  private async brandFor(q: Queryable, name: string, created: string[], commit: boolean) {
    const cleaned = pyStrip(name);
    if (!cleaned) return null;
    const existing = await q.one<{ id: string }>(
      `SELECT "catalog_brand"."id" FROM "catalog_brand"
        WHERE UPPER("catalog_brand"."name"::text) = UPPER($1)
        ORDER BY "catalog_brand"."name" ASC LIMIT 1`,
      [cleaned],
    );
    if (existing) return existing.id;
    created.push(cleaned);
    if (!commit) return null;
    const id = randomUUID();
    const slug = await uniqueSlug(q, 'catalog_brand', 'brand', cleaned, 140);
    await q.query(
      `INSERT INTO "catalog_brand" ("id", "created_at", "updated_at", "name", "slug", "description",
         "logo", "is_active", "is_featured")
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, '', '', true, false)`,
      [id, cleaned, slug],
    );
    return id;
  }

  private async run(
    q: Queryable,
    content: string,
    commit: boolean,
    branch: Branch | null,
    actor: AuditActor | null,
    context: AuditContext | null,
  ): Promise<ImportPlan> {
    const { rows, errors, ignored } = parseImport(content);
    const result: ImportPlan = {
      products_created: [],
      products_updated: [],
      variants_created: [],
      variants_updated: [],
      categories_created: [],
      brands_created: [],
      stock_receipts: 0,
      errors: [...errors],
      ignored_columns: ignored,
    };
    if (errors.length) return result;
    if (commit && branch === null && rows.some((row) => row.openingStock)) {
      throw new ValidationError(
        'This file carries opening stock, so it needs a branch to receive it into.',
      );
    }

    const groups = new Map<string, ParsedRow[]>();
    for (const row of rows) {
      const group = groups.get(row.productKey);
      if (group) group.push(row);
      else groups.set(row.productKey, [row]);
    }

    for (const group of groups.values()) {
      const head = group[0] as ParsedRow;
      const category = await this.categoryFor(q, head.category, result.categories_created, commit);
      const brand = await this.brandFor(q, head.brand, result.brands_created, commit);
      let product = await q.one<ProductRef>(
        `SELECT "id", "name", "category_id", "brand_id", "short_description", "description",
                "material", "care_instructions"
           FROM "catalog_product"
          WHERE ${head.slug ? '"catalog_product"."slug" = $1' : 'UPPER("catalog_product"."name"::text) = UPPER($1)'}
          ORDER BY "catalog_product"."created_at" DESC LIMIT 1`,
        [head.slug || head.productName],
      );

      if (!product) {
        result.products_created.push(head.productName);
        if (commit) {
          if (!category) {
            throw new ValidationError(
              `${pyReprStr(head.productName)} has no category. Every product needs one: add a ` +
                "`category` column, for example 'Women > Ethnic'.",
            );
          }
          const id = randomUUID();
          const slug =
            head.slug || (await uniqueSlug(q, 'catalog_product', 'product', head.productName, 220));
          await q.query(
            `INSERT INTO "catalog_product" ("id", "created_at", "updated_at", "name", "slug",
               "category_id", "brand_id", "short_description", "description", "material",
               "care_instructions", "status", "published", "featured", "is_final_sale",
               "size_chart_id", "seo_title", "seo_description", "created_by_id")
             VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4::uuid, $5::uuid, $6,
                     $7, $8, $9, 'ACTIVE', $10, false, false, NULL, '', '', $11::uuid)`,
            [
              id,
              head.productName,
              slug,
              category,
              brand,
              head.shortDescription,
              head.description,
              head.material,
              head.careInstructions,
              head.published,
              actor?.id ?? null,
            ],
          );
          product = {
            id,
            name: head.productName,
            category_id: category,
            brand_id: brand,
            short_description: head.shortDescription,
            description: head.description,
            material: head.material,
            care_instructions: head.careInstructions,
          };
        }
      } else {
        result.products_updated.push(product.name);
        if (commit) {
          // Only what the file says: a blank cell is "not in this file".
          const changes: [string, unknown][] = [];
          for (const [column, value] of [
            ['category_id', category],
            ['brand_id', brand],
            ['short_description', head.shortDescription],
            ['description', head.description],
            ['material', head.material],
            ['care_instructions', head.careInstructions],
          ] as [keyof ProductRef, string | null][]) {
            if (value && product[column] !== value) changes.push([column, value]);
          }
          if (changes.length) {
            await q.query(
              `UPDATE "catalog_product" SET ${changes
                .map(([column], index) => `"${column}" = $${index + 2}`)
                .join(', ')}, "updated_at" = clock_timestamp() WHERE "id" = $1::uuid`,
              [product.id, ...changes.map(([, value]) => value)],
            );
          }
        }
      }

      for (const row of group) await this.variant(q, row, product, result, commit, branch, actor);
    }

    if (commit && result.errors.length === 0 && context) {
      await recordAudit(q, context, {
        action: 'PRODUCT_IMPORT',
        actor,
        newValues: {
          products_created: result.products_created.length,
          products_updated: result.products_updated.length,
          variants_created: result.variants_created.length,
          variants_updated: result.variants_updated.length,
          stock_receipts: result.stock_receipts,
        },
        reason: 'Catalogue imported from a spreadsheet',
        branchId: branch?.id ?? null,
      });
    }
    return result;
  }

  /** `_variant`: an existing SKU re-priced, a new one made with its options and opening stock. */
  private async variant(
    q: Queryable,
    row: ParsedRow,
    product: ProductRef | null,
    result: ImportPlan,
    commit: boolean,
    branch: Branch | null,
    actor: AuditActor | null,
  ): Promise<void> {
    const existing = await q.one<Record<string, unknown> & { id: string }>(
      `SELECT "catalog_productvariant".* FROM "catalog_productvariant"
         INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
        WHERE "catalog_productvariant"."sku" = $1
        ORDER BY "catalog_product"."created_at" DESC, "catalog_productvariant"."position" ASC,
                 "catalog_productvariant"."sku" ASC LIMIT 1`,
      [row.sku],
    );
    if (existing) {
      result.variants_updated.push(row.sku);
      if (commit) {
        const next = { ...existing };
        next.price = row.price;
        if (!new Dec(isFiniteDecimal(row.cost) ? row.cost : '1').isZero()) next.cost = row.cost;
        next.compare_at_price = row.compareAtPrice;
        if (row.barcode) next.barcode = row.barcode;
        if (row.weightGrams !== null) next.weight_grams = row.weightGrams.toString();
        finiteAmounts([
          next.price as string,
          next.compare_at_price as string | null,
          next.cost as string,
        ]);
        // `existing.save()`: every column written back.
        await q.query(
          `UPDATE "catalog_productvariant" SET "created_at" = $2, "updated_at" = clock_timestamp(),
             "product_id" = $3::uuid, "sku" = $4, "barcode" = $5, "name" = $6, "price" = $7,
             "compare_at_price" = $8, "cost" = $9, "weight_grams" = $10, "position" = $11,
             "status" = $12, "batch_number" = $13, "expiry_date" = $14
           WHERE "id" = $1::uuid`,
          [
            next.id,
            next.created_at,
            next.product_id,
            next.sku,
            next.barcode,
            next.name,
            next.price,
            next.compare_at_price,
            next.cost,
            next.weight_grams,
            next.position,
            next.status,
            next.batch_number,
            next.expiry_date,
          ],
        );
      }
      return;
    }

    result.variants_created.push(row.sku);
    if (row.openingStock) result.stock_receipts += 1;
    if (!commit || !product) return;

    finiteAmounts([row.price, row.compareAtPrice, row.cost]);
    const id = randomUUID();
    await q.query(
      `INSERT INTO "catalog_productvariant" ("id", "created_at", "updated_at", "product_id", "sku",
         "barcode", "name", "price", "compare_at_price", "cost", "weight_grams", "position", "status",
         "batch_number", "expiry_date")
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4, '', $5, $6, $7, $8, 0,
               'ACTIVE', '', NULL)`,
      [
        id,
        product.id,
        row.sku,
        row.barcode || null,
        row.price,
        row.compareAtPrice,
        row.cost,
        row.weightGrams === null ? null : row.weightGrams.toString(),
      ],
    );
    for (const [kind, code, label, value] of [
      ['SIZE', 'size', 'Size', row.size],
      ['COLOR', 'color', 'Colour', row.color],
    ] as const) {
      if (!value) continue;
      const attributeValue = await this.attributeValue(q, kind, code, label, value);
      await q.query(
        `INSERT INTO "catalog_variantattributevalue" ("id", "created_at", "updated_at", "variant_id",
           "attribute_id", "attribute_value_id")
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4::uuid)`,
        [randomUUID(), id, attributeValue.attribute_id, attributeValue.id],
      );
    }
    if (row.openingStock && branch) {
      await this.stock.receiveStock(q, {
        branch,
        variantId: id,
        quantity: row.openingStock,
        unitCost: row.cost,
        actor,
        referenceType: 'product_import',
        referenceId: null,
        notes: `Opening stock, imported from a spreadsheet (line ${row.line})`,
      });
    }
  }

  /** `_attribute_value`: the shop's first attribute of the kind (made if none), and its value. */
  private async attributeValue(
    q: Queryable,
    kind: string,
    code: string,
    label: string,
    value: string,
  ): Promise<{ id: string; attribute_id: string }> {
    let attribute = (
      await q.one<{ id: string }>(
        `SELECT "catalog_attribute"."id" FROM "catalog_attribute"
          WHERE "catalog_attribute"."kind" = $1
          ORDER BY "catalog_attribute"."position" ASC, "catalog_attribute"."id" ASC LIMIT 1`,
        [kind],
      )
    )?.id;
    if (!attribute) {
      attribute = randomUUID();
      await q.query(
        `INSERT INTO "catalog_attribute" ("id", "created_at", "updated_at", "name", "code", "kind",
           "is_variant_defining", "is_filterable", "position")
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, true, true, 0)`,
        [attribute, label, code, kind],
      );
    }
    const existing = await q.one<{ id: string }>(
      `SELECT "catalog_attributevalue"."id" FROM "catalog_attributevalue"
         INNER JOIN "catalog_attribute" ON ("catalog_attributevalue"."attribute_id" = "catalog_attribute"."id")
        WHERE ("catalog_attributevalue"."attribute_id" = $1::uuid
          AND UPPER("catalog_attributevalue"."value"::text) = UPPER($2))
        ORDER BY "catalog_attribute"."position" ASC, "catalog_attribute"."name" ASC,
                 "catalog_attributevalue"."position" ASC, "catalog_attributevalue"."value" ASC LIMIT 1`,
      [attribute, value],
    );
    if (existing) return { id: existing.id, attribute_id: attribute };
    const id = randomUUID();
    await q.query(
      `INSERT INTO "catalog_attributevalue" ("id", "created_at", "updated_at", "attribute_id", "value",
         "label", "swatch", "position")
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $3, '', 0)`,
      [id, attribute, value],
    );
    return { id, attribute_id: attribute };
  }
}
