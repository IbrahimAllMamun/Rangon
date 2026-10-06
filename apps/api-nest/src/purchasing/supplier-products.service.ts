import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { CataloguePayloads, type VariantRow } from '../catalog/admin/catalogue-payloads';
import { likeContains } from '../catalog/discovery.service';
import { type AuditContext, recordAudit } from '../common/audit';
import { localIso } from '../common/datetime';
import {
  booleanField,
  charField,
  decimalField,
  errorMessages,
  type Fields,
  integerField,
  Invalid,
  pkRelatedField,
  runSerializer,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  booleanFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
  searchTerms,
  uuidFilter,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';

/**
 * `purchasing.api.views.SupplierProductViewSet`: which suppliers sell which
 * variants, and what they charge. Reference data, so a row may be edited and
 * deleted; not branch-scoped, as a price list is agreed with the business.
 * One offer per variant is the preferred one, and `set-preferred` is the only
 * way to move that flag.
 */

const O = '"purchasing_supplierproduct"';
const S = '"purchasing_supplier"';
const V = '"catalog_productvariant"';
const P = '"catalog_product"';
const OFFER_COLUMNS = `${O}."id", ${O}."created_at", ${O}."updated_at", ${O}."supplier_id",
  ${O}."variant_id", ${O}."supplier_sku", ${O}."last_cost", ${O}."lead_time_days",
  ${O}."minimum_order_quantity", ${O}."is_preferred", ${O}."is_active", ${O}."last_purchased_at",
  ${O}."notes", ${O}."created_by_id"`;
const SELECT = `${OFFER_COLUMNS}, ${S}."name" AS "supplier_name", ${S}."code" AS "supplier_code",
  ${S}."status" AS "supplier_status", ${S}."lead_time_days" AS "supplier_lead_time_days",
  ${V}."sku", ${V}."name" AS "variant_name", ${P}."name" AS "product_name"`;
const JOINS = {
  supplier: `INNER JOIN ${S} ON (${O}."supplier_id" = ${S}."id")`,
  variant: `INNER JOIN ${V} ON (${O}."variant_id" = ${V}."id")`,
  product: `INNER JOIN ${P} ON (${V}."product_id" = ${P}."id")`,
} as const;
type Join = keyof typeof JOINS;
const FILTERS: readonly FilterField[] = [
  modelFilter('supplier', `${O}."supplier_id"`, 'purchasing_supplier'),
  modelFilter('variant', `${O}."variant_id"`, 'catalog_productvariant'),
  uuidFilter('product', `${V}."product_id"`),
  booleanFilter('is_preferred', `${O}."is_preferred"`),
  booleanFilter('is_active', `${O}."is_active"`),
];
const ORDERING = {
  last_cost: `${O}."last_cost"`,
  last_purchased_at: `${O}."last_purchased_at"`,
  created_at: `${O}."created_at"`,
};

interface OfferRow {
  id: string;
  created_at: string;
  updated_at: string;
  supplier_id: string;
  variant_id: string;
  supplier_sku: string;
  last_cost: string;
  lead_time_days: number | null;
  minimum_order_quantity: number;
  is_preferred: boolean;
  is_active: boolean;
  last_purchased_at: string | null;
  notes: string;
  created_by_id: string | null;
  supplier_name: string;
  supplier_code: string;
  supplier_status: string;
  supplier_lead_time_days: number;
  sku: string;
  variant_name: string;
  product_name: string;
}

type OfferData = Partial<{
  supplier: string;
  variant: string;
  supplier_sku: string;
  last_cost: string;
  lead_time_days: number | null;
  minimum_order_quantity: number;
  is_active: boolean;
  notes: string;
}>;

@Injectable()
export class SupplierProductsService {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `SupplierProductSerializer(offers, many=True).data`. */
  private async serialise(rows: OfferRow[], q: Queryable = this.db) {
    const links = await this.payloads.links([...new Set(rows.map((row) => row.variant_id))], q);
    const tz = this.env.DJANGO_TIME_ZONE;
    return rows.map((row) => ({
      id: row.id,
      supplier: row.supplier_id,
      supplier_name: row.supplier_name,
      supplier_code: row.supplier_code,
      supplier_status: row.supplier_status,
      variant: row.variant_id,
      sku: row.sku,
      product_name: row.product_name,
      variant_label: this.payloads.label(
        { id: row.variant_id, name: row.variant_name } as VariantRow,
        links,
      ),
      supplier_sku: row.supplier_sku,
      last_cost: row.last_cost,
      lead_time_days: row.lead_time_days,
      // This item's lead time, falling back to the supplier's.
      effective_lead_time_days: row.lead_time_days ?? row.supplier_lead_time_days,
      minimum_order_quantity: row.minimum_order_quantity,
      is_preferred: row.is_preferred,
      is_active: row.is_active,
      last_purchased_at: localIso(row.last_purchased_at, tz),
      notes: row.notes,
      created_at: localIso(row.created_at, tz),
    }));
  }

  /**
   * `filter_queryset(get_queryset())`: the conditions, and the joins in the
   * order Django's query holds them -- each filter and then the search names
   * its tables first, and `select_related` adds what is left.
   */
  private async queryset(query: QueryDict, sql: SqlParams) {
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const joins: Join[] = [];
    const join = (...names: Join[]) => {
      for (const name of names) if (!joins.includes(name)) joins.push(name);
    };
    if (query.get('supplier')) join('supplier');
    if (query.get('variant')) join('variant');
    if (pyStrip(query.get('product') ?? '')) join('variant', 'product');
    const terms = searchTerms(query);
    if (terms.length) join('variant', 'product', 'supplier');
    for (const term of terms) {
      const like = sql.add(likeContains(term));
      where.push(
        `(UPPER(${O}."supplier_sku"::text) LIKE UPPER(${like}) OR UPPER(${V}."sku"::text) LIKE UPPER(${like})
          OR UPPER(${P}."name"::text) LIKE UPPER(${like}) OR UPPER(${S}."name"::text) LIKE UPPER(${like}))`,
      );
    }
    join('supplier', 'variant', 'product');
    return { where, from: `FROM ${O} ${joins.map((name) => JOINS[name]).join(' ')}` };
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const { where, from } = await this.queryset(query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [
      `${O}."is_preferred" DESC`,
      `${O}."last_cost" ASC`,
    ];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${from} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<OfferRow>(
      `SELECT ${SELECT} ${from} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  /** `get_object()`: the filtered queryset, then the key. */
  async find(pk: string, query: QueryDict): Promise<OfferRow> {
    const sql = new SqlParams();
    const { where, from } = await this.queryset(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${O}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<OfferRow>(
      `SELECT ${SELECT} ${from} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(pk: string, query: QueryDict) {
    return (await this.serialise([await this.find(pk, query)]))[0];
  }

  private async byId(id: string, q: Queryable = this.db) {
    const row = (await q.one<OfferRow>(
      `SELECT ${SELECT} FROM ${O} ${JOINS.supplier} ${JOINS.variant} ${JOINS.product}
        WHERE ${O}."id" = $1 LIMIT 21`,
      [id],
    )) as OfferRow;
    return (await this.serialise([row], q))[0];
  }

  private exists(table: string) {
    return async (id: string) =>
      (await this.db.one(`SELECT 1 AS "a" FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
  }

  /** `SupplierProductSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  private async validate(
    data: unknown,
    instance: OfferRow | null,
    partial: boolean,
  ): Promise<OfferData> {
    const fields: Fields = {
      supplier: pkRelatedField(this.exists('purchasing_supplier')),
      variant: pkRelatedField(this.exists('catalog_productvariant')),
      supplier_sku: charField({ maxLength: 64, required: false, allowBlank: true }),
      last_cost: decimalField(14, 2, { required: false }),
      lead_time_days: integerField({
        required: false,
        allowNull: true,
        minValue: 0,
        maxValue: 32767,
      }),
      minimum_order_quantity: integerField({ required: false, minValue: 0, maxValue: 2147483647 }),
      is_active: booleanField({ required: false }),
      notes: charField({ required: false, allowBlank: true }),
    };
    const result = await runSerializer<OfferData>(fields, data, {
      partial,
      // `UniqueTogetherValidator(fields=["supplier", "variant"])`, in the shop's own words.
      validate: async (attrs) => {
        const supplier = attrs.supplier ?? instance?.supplier_id;
        const variant = attrs.variant ?? instance?.variant_id;
        const changed =
          instance === null || supplier !== instance.supplier_id || variant !== instance.variant_id;
        if (changed) {
          const clash = await this.db.one(
            `SELECT 1 AS "a" FROM ${O}
              WHERE (${O}."supplier_id" = $1 AND ${O}."variant_id" = $2${
                instance ? ` AND NOT (${O}."id" = $3)` : ''
              }) LIMIT 1`,
            instance ? [supplier, variant, instance.id] : [supplier, variant],
          );
          if (clash)
            throw Invalid.of(
              'This supplier already has a price recorded for this product.',
              'unique',
            );
        }
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `create`: `serializer.save(created_by=request.user)`. Never preferred: that is its own act. */
  async create(user: RequestUser, data: unknown) {
    const values = await this.validate(data, null, false);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO ${O} ("id", "created_at", "updated_at", "supplier_id", "variant_id",
         "supplier_sku", "last_cost", "lead_time_days", "minimum_order_quantity", "is_preferred",
         "is_active", "last_purchased_at", "notes", "created_by_id")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, false, $8, NULL,
               $9, $10)`,
      [
        id,
        values.supplier,
        values.variant,
        values.supplier_sku ?? '',
        values.last_cost ?? '0.00',
        values.lead_time_days ?? null,
        values.minimum_order_quantity ?? 1,
        values.is_active ?? true,
        values.notes ?? '',
        user.id,
      ],
    );
    return this.byId(id);
  }

  /** `update`: the offer found first, then the body; every column written back as read. */
  async update(pk: string, query: QueryDict, data: () => unknown, partial: boolean) {
    const instance = await this.find(pk, query);
    const values = await this.validate(data(), instance, partial);
    const has = (key: keyof OfferData) => Object.hasOwn(values, key);
    await this.db.query(
      `UPDATE ${O} SET "updated_at" = clock_timestamp(), "supplier_id" = $2, "variant_id" = $3,
         "supplier_sku" = $4, "last_cost" = $5, "lead_time_days" = $6,
         "minimum_order_quantity" = $7, "is_preferred" = $8, "is_active" = $9,
         "last_purchased_at" = $10, "notes" = $11, "created_by_id" = $12
       WHERE ${O}."id" = $1`,
      [
        instance.id,
        values.supplier ?? instance.supplier_id,
        values.variant ?? instance.variant_id,
        values.supplier_sku ?? instance.supplier_sku,
        values.last_cost ?? instance.last_cost,
        has('lead_time_days') ? values.lead_time_days : instance.lead_time_days,
        values.minimum_order_quantity ?? instance.minimum_order_quantity,
        instance.is_preferred,
        values.is_active ?? instance.is_active,
        instance.last_purchased_at,
        values.notes ?? instance.notes,
        instance.created_by_id,
      ],
    );
    return this.byId(instance.id);
  }

  async destroy(pk: string, query: QueryDict): Promise<void> {
    const instance = await this.find(pk, query);
    await this.db.query(`DELETE FROM ${O} WHERE ${O}."id" IN ($1)`, [instance.id]);
  }

  /**
   * `set_preferred` and `set_preferred_supplier`: the offer locked, the
   * incumbent demoted and this one promoted in one transaction -- the index
   * allows one preferred offer per variant -- and audited every time.
   */
  async setPreferred(user: RequestUser, pk: string, query: QueryDict, context: AuditContext) {
    const found = await this.find(pk, query);
    return this.db.transaction(async (tx) => {
      const offer = await tx.one<{ id: string; is_preferred: boolean; is_active: boolean }>(
        `SELECT ${OFFER_COLUMNS} FROM ${O}
          WHERE (${O}."supplier_id" = $1 AND ${O}."variant_id" = $2) LIMIT 21 FOR UPDATE`,
        [found.supplier_id, found.variant_id],
      );
      if (!offer) {
        throw new ValidationError(
          `${found.supplier_name} is not recorded as a supplier of this product.`,
          { details: { variant_id: found.variant_id, supplier_id: found.supplier_id } },
        );
      }
      if (!offer.is_active) {
        throw new ValidationError(
          `${found.supplier_name} no longer supplies this product, so it cannot be the preferred one.`,
        );
      }
      const previous = await tx.one<{ id: string; supplier_id: string }>(
        `SELECT ${OFFER_COLUMNS} FROM ${O}
          WHERE (${O}."is_preferred" AND ${O}."variant_id" = $1 AND NOT (${O}."id" = $2))
          ORDER BY ${O}."is_preferred" DESC, ${O}."last_cost" ASC LIMIT 1 FOR UPDATE`,
        [found.variant_id, offer.id],
      );
      const promote = (id: string, preferred: boolean) =>
        tx.query(
          `UPDATE ${O} SET "updated_at" = clock_timestamp(), "is_preferred" = $2
            WHERE ${O}."id" = $1`,
          [id, preferred],
        );
      if (previous) await promote(previous.id, false);
      if (!offer.is_preferred) await promote(offer.id, true);
      const incumbent = previous
        ? await tx.one<{ name: string }>(`SELECT "name" FROM ${S} WHERE ${S}."id" = $1 LIMIT 21`, [
            previous.supplier_id,
          ])
        : null;
      const label = (await tx.one<{ name: string; sku: string }>(
        `SELECT ${S}."name", ${V}."sku" FROM ${O} ${JOINS.supplier} ${JOINS.variant}
          WHERE ${O}."id" = $1`,
        [offer.id],
      )) as { name: string; sku: string };
      await recordAudit(tx, context, {
        action: 'UPDATE',
        entity: { type: 'SupplierProduct', id: offer.id, label: `${label.name} → ${label.sku}` },
        actor: { id: user.id, email: user.email },
        oldValues: { preferred_supplier: incumbent?.name ?? null },
        newValues: { preferred_supplier: found.supplier_name },
        reason: 'Preferred supplier changed',
      });
      return this.byId(offer.id, tx);
    });
  }
}
