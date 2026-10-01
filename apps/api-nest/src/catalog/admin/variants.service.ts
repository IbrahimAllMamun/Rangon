import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { RolePermissions } from '../../auth/permissions';
import { AuditActor, AuditContext, recordAudit } from '../../common/audit';
import {
  charField,
  choiceField,
  dateField,
  decimalField,
  errorMessages,
  Fields,
  integerField,
  pkRelatedField,
  runSerializer,
  UniqueCheck,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import {
  applyFilters,
  choiceFilter,
  modelFilter,
  orderingFrom,
  searchTerms,
} from '../../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../../common/pagination';
import { pyStrip } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { AvailabilityService } from '../../inventory/availability.service';
import { CataloguePayloads, VARIANT_COLUMNS, type VariantRow } from './catalogue-payloads';
import { refuseIfReferenced } from './deletion';
import { generateBarcode } from './variant-writes';

/**
 * `catalog.api.views.ProductVariantViewSet`: SKUs for the purchasing and
 * label screens. Paginated; ordered as `Meta.ordering` says -- the product
 * (newest first), then position, then SKU; DRF's `SearchFilter` over SKU,
 * barcode and product name, every term required, any field matching it.
 */

const V = '"catalog_productvariant"';
const STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

const FILTERS = [
  modelFilter('product', `${V}."product_id"`, 'catalog_product'),
  choiceFilter('status', `${V}."status"`, STATUSES),
];
const ORDERING = { sku: `${V}."sku"`, created_at: `${V}."created_at"` };
const DEFAULT_ORDER = [
  `"catalog_product"."created_at" DESC`,
  `${V}."position" ASC`,
  `${V}."sku" ASC`,
];

export interface VariantWithProduct extends VariantRow {
  product_name: string;
  brand_name: string | null;
}

const SELECT = `${VARIANT_COLUMNS.map((column) => `${V}."${column}"`).join(', ')},
  "catalog_product"."name" AS "product_name", "catalog_brand"."name" AS "brand_name"`;
const FROM = `FROM ${V}
  INNER JOIN "catalog_product" ON (${V}."product_id" = "catalog_product"."id")
  LEFT OUTER JOIN "catalog_brand" ON ("catalog_product"."brand_id" = "catalog_brand"."id")`;

/** Django's `prep_for_like_query`: a literal inside `LIKE '%...%'`. */
function likeContains(text: string): string {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

type VariantData = Partial<{
  product: string;
  sku: string;
  barcode: string | null;
  name: string;
  price: string;
  compare_at_price: string | null;
  cost: string;
  weight_grams: number | null;
  position: number;
  status: string;
  batch_number: string;
  expiry_date: string | null;
}>;

@Injectable()
export class VariantsService {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    private readonly availability: AvailabilityService,
    private readonly permissions: RolePermissions,
  ) {}

  /** `filter_queryset`: django-filter, then the search terms. */
  private async conditions(query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    for (const term of searchTerms(query)) {
      const like = sql.add(likeContains(term));
      where.push(
        `(UPPER(${V}."sku"::text) LIKE UPPER(${like}) OR UPPER(${V}."barcode"::text) LIKE UPPER(${like})
          OR UPPER("catalog_product"."name"::text) LIKE UPPER(${like}))`,
      );
    }
    return where;
  }

  async serialise(rows: VariantWithProduct[], partial = false): Promise<Record<string, unknown>[]> {
    const links = await this.payloads.links(rows.map((row) => row.id));
    return rows.map((row) =>
      this.payloads.variant(
        row,
        { name: row.product_name, brandName: row.brand_name },
        links,
        null,
        partial,
      ),
    );
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? DEFAULT_ORDER;
    const pageSize = pageSizeFrom(query, STANDARD_PAGINATION);
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${FROM} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSize);
    const rows = await this.db.query<VariantWithProduct>(
      `SELECT ${SELECT} ${FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  async find(pk: string, query: QueryDict): Promise<VariantWithProduct> {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${V}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<VariantWithProduct>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  private unique(column: 'sku' | 'barcode', exclude: string | null): UniqueCheck {
    return {
      message: `product variant with this ${column} already exists.`,
      exists: async (value) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM ${V} WHERE (${V}."${column}" = $1${exclude ? ` AND NOT (${V}."id" = $2)` : ''}) LIMIT 1`,
          exclude ? [value, exclude] : [value],
        )) !== null,
    };
  }

  /** `ProductVariantSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validate(
    data: unknown,
    instance: VariantRow | null,
    partial: boolean,
  ): Promise<VariantData> {
    const exclude = instance?.id ?? null;
    const fields: Fields = {
      product: pkRelatedField(
        async (id) =>
          (await this.db.one(`SELECT 1 FROM "catalog_product" WHERE "id" = $1 LIMIT 21`, [id])) !==
          null,
      ),
      sku: charField({ maxLength: 64, unique: this.unique('sku', exclude) }),
      barcode: charField({
        allowBlank: true,
        allowNull: true,
        maxLength: 64,
        required: false,
        unique: this.unique('barcode', exclude),
      }),
      name: charField({ allowBlank: true, maxLength: 200, required: false }),
      price: decimalField(14, 2, { required: false, minValue: '0.00' }),
      compare_at_price: decimalField(14, 2, { required: false, allowNull: true }),
      cost: decimalField(14, 2, { required: false }),
      weight_grams: integerField({
        allowNull: true,
        maxValue: 2147483647,
        minValue: 0,
        required: false,
      }),
      position: integerField({ maxValue: 2147483647, minValue: 0, required: false }),
      status: choiceField(STATUSES, { required: false }),
      batch_number: charField({ allowBlank: true, maxLength: 64, required: false }),
      expiry_date: dateField({ allowNull: true, required: false }),
    };
    const result = await runSerializer<VariantData>(fields, data, { partial });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  private async withProduct(row: VariantRow): Promise<VariantWithProduct> {
    const product = (await this.db.one<{ name: string; brand_name: string | null }>(
      `SELECT p."name", b."name" AS "brand_name" FROM "catalog_product" p
         LEFT OUTER JOIN "catalog_brand" b ON (p."brand_id" = b."id") WHERE p."id" = $1`,
      [row.product_id],
    )) as { name: string; brand_name: string | null };
    return { ...row, product_name: product.name, brand_name: product.brand_name };
  }

  private values(row: VariantRow): unknown[] {
    return VARIANT_COLUMNS.map((column) => row[column]);
  }

  /** `serializer.save()` for a new SKU: the model's defaults, a blank barcode stored as NULL. */
  async create(data: VariantData): Promise<VariantWithProduct> {
    const row: VariantRow = {
      id: randomUUID(),
      product_id: data.product as string,
      sku: data.sku as string,
      barcode: data.barcode || null,
      name: data.name ?? '',
      price: data.price ?? '0.00',
      compare_at_price: data.compare_at_price ?? null,
      cost: data.cost ?? '0.00',
      weight_grams: data.weight_grams ?? null,
      position: data.position ?? 0,
      status: data.status ?? 'ACTIVE',
      batch_number: data.batch_number ?? '',
      expiry_date: data.expiry_date ?? null,
    };
    await this.db.query(
      `INSERT INTO ${V} ("created_at", "updated_at", ${VARIANT_COLUMNS.map((c) => `"${c}"`).join(', ')})
       VALUES (clock_timestamp(), clock_timestamp(), ${VARIANT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`,
      this.values(row),
    );
    return this.withProduct(row);
  }

  async update(instance: VariantWithProduct, data: VariantData): Promise<VariantWithProduct> {
    const { product, ...rest } = data;
    const row: VariantRow = { ...instance, ...rest };
    if (product !== undefined) row.product_id = product;
    if (row.barcode === '') row.barcode = null;
    const columns = VARIANT_COLUMNS.filter((column) => column !== 'id');
    await this.db.query(
      `UPDATE ${V} SET "updated_at" = clock_timestamp(), ${columns
        .map((column, index) => `"${column}" = $${index + 2}`)
        .join(', ')} WHERE ${V}."id" = $1`,
      [row.id, ...columns.map((column) => row[column])],
    );
    return this.withProduct(row);
  }

  /**
   * `perform_destroy`: a SKU ever sold or stocked is archived; any other is
   * deleted, unless a count sheet, a transfer or a purchase order names it
   * (`PROTECT`: 409, after the audit entry, which Django writes first).
   */
  async destroy(
    variant: VariantWithProduct,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<void> {
    const history = await this.db.one(
      `SELECT 1 AS "a" WHERE EXISTS (SELECT 1 FROM "orders_orderitem" WHERE "variant_id" = $1)
          OR EXISTS (SELECT 1 FROM "inventory_inventory" WHERE "variant_id" = $1)
          OR EXISTS (SELECT 1 FROM "inventory_inventorytransaction" WHERE "variant_id" = $1)`,
      [variant.id],
    );
    const entity = {
      type: 'ProductVariant',
      id: variant.id,
      label: await this.label(variant),
    };
    if (history) {
      await this.db.query(
        `UPDATE ${V} SET "status" = 'ARCHIVED', "updated_at" = clock_timestamp() WHERE ${V}."id" = $1`,
        [variant.id],
      );
      await recordAudit(this.db, context, {
        action: 'UPDATE',
        entity,
        actor,
        newValues: { status: 'ARCHIVED' },
        reason: 'Archived instead of deleted: the variant has stock or sales history.',
      });
      return;
    }
    await recordAudit(this.db, context, {
      action: 'DELETE',
      entity,
      actor,
      oldValues: { sku: variant.sku },
    });
    await this.db.transaction(async (tx: Queryable) => {
      await refuseIfReferenced(
        tx,
        [
          `SELECT 1 FROM "inventory_stockcountitem" WHERE "variant_id" = $1 LIMIT 1`,
          `SELECT 1 FROM "inventory_stocktransferitem" WHERE "variant_id" = $1 LIMIT 1`,
          `SELECT 1 FROM "purchasing_purchaseorderitem" WHERE "variant_id" = $1 LIMIT 1`,
        ],
        variant.id,
      );
      for (const statement of [
        `UPDATE "engagement_wishlistitem" SET "variant_id" = NULL WHERE "variant_id" = $1`,
        `DELETE FROM "catalog_variantattributevalue" WHERE "variant_id" = $1`,
        `DELETE FROM "orders_cartitem" WHERE "variant_id" = $1`,
        `DELETE FROM "purchasing_supplierproduct" WHERE "variant_id" = $1`,
        `DELETE FROM ${V} WHERE ${V}."id" = $1`,
      ]) {
        await tx.query(statement, [variant.id]);
      }
    });
  }

  /** `str(variant)`: `"<sku> — <product> <label>"`, stripped. */
  private async label(variant: VariantWithProduct): Promise<string> {
    const links = await this.payloads.links([variant.id]);
    return pyStrip(
      `${variant.sku} — ${variant.product_name} ${this.payloads.label(variant, links)}`,
    );
  }

  /** `lookup_variant`: the barcode exactly, else the SKU in any case. */
  async lookup(code: string): Promise<VariantWithProduct | null> {
    const stripped = pyStrip(code);
    if (!stripped) return null;
    for (const condition of [`${V}."barcode" = $1`, `UPPER(${V}."sku"::text) = UPPER($1)`]) {
      const row = await this.db.one<VariantWithProduct>(
        `SELECT ${SELECT} ${FROM} WHERE ${condition} ORDER BY ${DEFAULT_ORDER.join(', ')} LIMIT 1`,
        [stripped],
      );
      if (row) return row;
    }
    return null;
  }

  /** The lookup's answer: the variant with its stock at the branch asked for. */
  async lookupPayload(
    variant: VariantWithProduct,
    user: RequestUser,
    branchParam: unknown,
  ): Promise<Record<string, unknown>> {
    const branch = await this.permissions.resolveBranch(user, branchParam);
    const stock = await this.availability.availability(branch.id, [variant.id]);
    const links = await this.payloads.links([variant.id]);
    return this.payloads.variant(
      variant,
      { name: variant.product_name, brandName: variant.brand_name },
      links,
      {
        stock,
      },
    );
  }

  /**
   * `barcode`: the variant's in-store barcode, assigned under its row lock if
   * it has none -- so two requests for one unlabelled SKU print one number.
   */
  async barcode(
    variant: VariantWithProduct,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<{ barcode: string; created: boolean }> {
    return this.db.transaction(async (tx: Queryable) => {
      const locked = (await tx.one<{ barcode: string | null }>(
        `SELECT ${V}."barcode" FROM ${V} WHERE ${V}."id" = $1 LIMIT 21 FOR UPDATE`,
        [variant.id],
      )) as { barcode: string | null };
      if (locked.barcode) return { barcode: locked.barcode, created: false };
      const barcode = await generateBarcode(tx);
      await tx.query(
        `UPDATE ${V} SET "barcode" = $2, "updated_at" = clock_timestamp() WHERE ${V}."id" = $1`,
        [variant.id, barcode],
      );
      await recordAudit(tx, context, {
        action: 'UPDATE',
        entity: {
          type: 'ProductVariant',
          id: variant.id,
          label: await this.label({ ...variant, barcode }),
        },
        actor,
        newValues: { barcode },
        reason: 'In-store barcode assigned for labelling',
      });
      return { barcode, created: true };
    });
  }
}
