import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { localIso, parsePgTimestamptz } from '../common/datetime';
import { type AwareMoment, dateTimeField } from '../common/datetime-field';
import { Dec } from '../common/decimal';
import {
  booleanField,
  charField,
  choiceField,
  decimalField,
  errorMessages,
  type Fields,
  integerField,
  Invalid,
  InvalidFields,
  jsonField,
  manyPkRelatedField,
  runSerializer,
  type UniqueCheck,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  booleanFilter,
  choiceFilter,
  type FilterField,
  orderingFrom,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { compareCodePoints, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { parsePythonJson } from '../http/request-body';

/**
 * `promotions.api.views.CouponViewSet`: the back office's coupons. A plain
 * `ModelViewSet` -- what a coupon is worth at a checkout is
 * `checkout/coupons.service.ts` -- whose delete deactivates a coupon that was
 * ever redeemed, since its redemptions are part of order history.
 */

const C = '"promotions_coupon"';
const SELECT = `${C}."id", ${C}."created_at", ${C}."code", ${C}."description",
  ${C}."discount_type", ${C}."value", ${C}."minimum_order_value", ${C}."maximum_discount",
  ${C}."starts_at", ${C}."ends_at", ${C}."usage_limit", ${C}."usage_limit_per_customer",
  ${C}."used_count", ${C}."channels"::text AS "channels", ${C}."is_active", ${C}."created_by_id"`;
const TYPES = ['PERCENTAGE', 'FIXED', 'FREE_SHIPPING'] as const;
/** `orders.models.Channel.values`, in the enum's order. */
const CHANNELS = ['POS', 'ONLINE', 'PHONE', 'SOCIAL', 'OTHER'] as const;
const FILTERS: readonly FilterField[] = [
  booleanFilter('is_active', `${C}."is_active"`),
  choiceFilter('discount_type', `${C}."discount_type"`, TYPES),
];
const ORDERING = { created_at: `${C}."created_at"`, used_count: `${C}."used_count"` };
const COUNT = { minValue: 0, maxValue: 2147483647 };

interface CouponRow {
  id: string;
  created_at: string;
  code: string;
  description: string;
  discount_type: string;
  value: string;
  minimum_order_value: string;
  maximum_discount: string | null;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  usage_limit_per_customer: number | null;
  used_count: number;
  /** The stored JSON's own text. */
  channels: string;
  is_active: boolean;
  created_by_id: string | null;
}

type CouponData = Partial<{
  code: string;
  description: string;
  discount_type: string;
  value: string;
  minimum_order_value: string;
  maximum_discount: string | null;
  starts_at: AwareMoment | null;
  ends_at: AwareMoment | null;
  usage_limit: number | null;
  usage_limit_per_customer: number | null;
  categories: string[];
  products: string[];
  channels: unknown;
  is_active: boolean;
}>;

type Bound = AwareMoment | string | null;

/** A window bound as an instant, in microseconds. */
function micros(bound: AwareMoment | string): bigint {
  if (typeof bound !== 'string') return bound.micros;
  const { epochSeconds, microseconds } = parsePgTimestamptz(bound);
  return BigInt(epochSeconds) * 1_000_000n + BigInt(microseconds);
}

/**
 * `validate_channels`: where the coupon can be spent. Empty means everywhere;
 * anything else is a list of sales channels, stored once each in the enum's
 * order.
 */
export function cleanChannels(value: unknown): string[] {
  if (value === null || value === '') return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw Invalid.of('Choose where the coupon can be used.');
  const known: readonly string[] = CHANNELS;
  const unknown = [...new Set(value as string[])]
    .filter((item) => !known.includes(item))
    .sort(compareCodePoints);
  if (unknown.length) throw Invalid.of(`Not a sales channel: ${unknown.join(', ')}.`);
  return CHANNELS.filter((channel) => (value as string[]).includes(channel));
}

@Injectable()
export class CouponsAdminService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The categories and products each coupon is restricted to, in each model's own order. */
  private async restrictions(ids: string[], q: Queryable = this.db) {
    const read = async (through: string, table: string, column: string, order: string) => {
      const found = new Map<string, string[]>();
      if (!ids.length) return found;
      const sql = new SqlParams();
      const rows = await q.query<{ coupon_id: string; id: string }>(
        `SELECT "${through}"."coupon_id", "${table}"."id" FROM "${table}"
           INNER JOIN "${through}" ON ("${table}"."id" = "${through}"."${column}")
          WHERE "${through}"."coupon_id" IN ${sql.list(ids, 'uuid')} ORDER BY ${order}`,
        sql.values,
      );
      for (const row of rows)
        found.set(row.coupon_id, [...(found.get(row.coupon_id) ?? []), row.id]);
      return found;
    };
    return {
      categories: await read(
        'promotions_coupon_categories',
        'catalog_category',
        'category_id',
        `"catalog_category"."position" ASC, "catalog_category"."name" ASC`,
      ),
      products: await read(
        'promotions_coupon_products',
        'catalog_product',
        'product_id',
        `"catalog_product"."created_at" DESC`,
      ),
    };
  }

  /** `CouponSerializer(coupons, many=True).data`. */
  private async serialise(rows: CouponRow[], q: Queryable = this.db) {
    const { categories, products } = await this.restrictions(
      rows.map((row) => row.id),
      q,
    );
    const tz = this.env.DJANGO_TIME_ZONE;
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      description: row.description,
      discount_type: row.discount_type,
      value: row.value,
      minimum_order_value: row.minimum_order_value,
      maximum_discount: row.maximum_discount,
      starts_at: localIso(row.starts_at, tz),
      ends_at: localIso(row.ends_at, tz),
      usage_limit: row.usage_limit,
      usage_limit_per_customer: row.usage_limit_per_customer,
      used_count: row.used_count,
      is_exhausted: row.usage_limit !== null && row.used_count >= row.usage_limit,
      categories: categories.get(row.id) ?? [],
      products: products.get(row.id) ?? [],
      channels: parsePythonJson(row.channels),
      is_active: row.is_active,
      created_at: localIso(row.created_at, tz),
    }));
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [`${C}."created_at" DESC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${C} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<CouponRow>(
      `SELECT ${SELECT} FROM ${C} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  /** `get_object()`: the filtered queryset, then the key. */
  private async find(pk: string, query: QueryDict): Promise<CouponRow> {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${C}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<CouponRow>(
      `SELECT ${SELECT} FROM ${C} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(pk: string, query: QueryDict) {
    return (await this.serialise([await this.find(pk, query)]))[0];
  }

  private async answer(id: string) {
    const row = (await this.db.one<CouponRow>(
      `SELECT ${SELECT} FROM ${C} WHERE ${C}."id" = $1 LIMIT 21`,
      [id],
    )) as CouponRow;
    return (await this.serialise([row]))[0];
  }

  private exists(table: string) {
    return async (id: string) =>
      (await this.db.one(`SELECT 1 AS "a" FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
  }

  /** `CouponSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  private async validate(data: unknown, instance: CouponRow | null, partial: boolean) {
    const exclude = instance?.id ?? null;
    const unique: UniqueCheck = {
      message: 'coupon with this code already exists.',
      exists: async (value) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM ${C} WHERE (${C}."code" = $1${
            exclude ? ` AND NOT (${C}."id" = $2)` : ''
          }) LIMIT 1`,
          exclude ? [value, exclude] : [value],
        )) !== null,
    };
    const tz = this.env.DJANGO_TIME_ZONE;
    const fields: Fields = {
      code: charField({ maxLength: 32, unique }),
      description: charField({ maxLength: 255, required: false, allowBlank: true }),
      discount_type: choiceField(TYPES),
      value: decimalField(10, 2, { required: false }),
      minimum_order_value: decimalField(14, 2, { required: false }),
      maximum_discount: decimalField(14, 2, { required: false, allowNull: true }),
      starts_at: dateTimeField(tz, { required: false, allowNull: true }),
      ends_at: dateTimeField(tz, { required: false, allowNull: true }),
      usage_limit: integerField({ required: false, allowNull: true, ...COUNT }),
      usage_limit_per_customer: integerField({ required: false, allowNull: true, ...COUNT }),
      categories: manyPkRelatedField(this.exists('catalog_category'), { required: false }),
      products: manyPkRelatedField(this.exists('catalog_product'), { required: false }),
      channels: jsonField({ required: false }),
      is_active: booleanField({ required: false }),
    };
    const result = await runSerializer<CouponData>(fields, data, {
      partial,
      hooks: { channels: (value: unknown) => cleanChannels(value) },
      // Every rule is checked against the coupon as it would be left, so a
      // PATCH of half a combination cannot slip past to the table's own check.
      validate: (attrs) => {
        const resulting = <K extends keyof CouponData & keyof CouponRow>(field: K) =>
          Object.hasOwn(attrs, field) ? attrs[field] : (instance?.[field] ?? null);
        const startsAt = resulting('starts_at') as Bound;
        const endsAt = resulting('ends_at') as Bound;
        if (startsAt && endsAt) {
          // Two values from the request share a zone and compare by wall
          // clock, as Python compares them; a stored one compares by instant.
          const notAfter =
            typeof startsAt !== 'string' && typeof endsAt !== 'string'
              ? endsAt.wall <= startsAt.wall
              : micros(endsAt) <= micros(startsAt);
          if (notAfter) {
            throw new InvalidFields({
              ends_at: [{ message: 'The end date must be after the start.', code: 'invalid' }],
            });
          }
        }
        const refuse = (message: string, code = 'invalid') =>
          new InvalidFields({ value: [{ message, code }] });
        if (resulting('discount_type') === 'FREE_SHIPPING') {
          // The discount is the shipping line: an amount beside it means nothing.
          attrs.value = '0.00';
          return attrs;
        }
        const value = resulting('value') as string | null;
        if (value === null) throw refuse('This field is required.', 'required');
        if (new Dec(value).lte(0))
          throw refuse('A discount of zero gives nothing away. Enter an amount above 0.');
        if (resulting('discount_type') === 'PERCENTAGE' && new Dec(value).gt(100))
          throw refuse('A percentage cannot exceed 100.');
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `field.set(ids)`: the rows not asked for removed, the new ones added. */
  private async setRelated(
    tx: Queryable,
    through: string,
    column: string,
    id: string,
    ids: string[],
  ) {
    const wanted = [...new Set(ids)];
    const current = (
      await tx.query<{ related: string }>(
        `SELECT "${column}" AS "related" FROM "${through}" WHERE "coupon_id" = $1`,
        [id],
      )
    ).map((row) => row.related);
    const stale = current.filter((related) => !wanted.includes(related));
    if (stale.length) {
      await tx.query(
        `DELETE FROM "${through}" WHERE ("coupon_id" = $1 AND "${column}" = ANY($2::uuid[]))`,
        [id, stale],
      );
    }
    for (const related of wanted.filter((related) => !current.includes(related))) {
      await tx.query(`INSERT INTO "${through}" ("coupon_id", "${column}") VALUES ($1, $2)`, [
        id,
        related,
      ]);
    }
  }

  private bound(value: Bound): string | null {
    if (value === null) return null;
    return typeof value === 'string' ? value : value.pg;
  }

  /** `create`: `serializer.save(created_by=request.user)`, then the two restrictions. */
  async create(user: RequestUser, data: unknown) {
    const values = await this.validate(data, null, false);
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ${C} ("id", "created_at", "updated_at", "code", "description",
           "discount_type", "value", "minimum_order_value", "maximum_discount", "starts_at",
           "ends_at", "usage_limit", "usage_limit_per_customer", "used_count", "channels",
           "is_active", "created_by_id")
         VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, $8::timestamptz,
                 $9::timestamptz, $10, $11, 0, $12::jsonb, $13, $14)`,
        [
          id,
          // `Coupon.save()`: a code is trimmed and upper-cased.
          pyStrip(values.code as string).toUpperCase(),
          values.description ?? '',
          values.discount_type,
          values.value ?? '0.00',
          values.minimum_order_value ?? '0.00',
          values.maximum_discount ?? null,
          this.bound(values.starts_at ?? null),
          this.bound(values.ends_at ?? null),
          values.usage_limit ?? null,
          Object.hasOwn(values, 'usage_limit_per_customer') ? values.usage_limit_per_customer : 1,
          JSON.stringify(values.channels === undefined ? [] : values.channels),
          values.is_active ?? true,
          user.id,
        ],
      );
      await this.setRelated(
        tx,
        'promotions_coupon_categories',
        'category_id',
        id,
        values.categories ?? [],
      );
      await this.setRelated(
        tx,
        'promotions_coupon_products',
        'product_id',
        id,
        values.products ?? [],
      );
    });
    return this.answer(id);
  }

  /** `update`: the coupon found first, then the body; every column written back as read. */
  async update(pk: string, query: QueryDict, data: () => unknown, partial: boolean) {
    const instance = await this.find(pk, query);
    const values = await this.validate(data(), instance, partial);
    const has = (key: keyof CouponData) => Object.hasOwn(values, key);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE ${C} SET "updated_at" = clock_timestamp(), "code" = $2, "description" = $3,
           "discount_type" = $4, "value" = $5, "minimum_order_value" = $6,
           "maximum_discount" = $7, "starts_at" = $8::timestamptz, "ends_at" = $9::timestamptz,
           "usage_limit" = $10, "usage_limit_per_customer" = $11, "used_count" = $12,
           "channels" = $13::jsonb, "is_active" = $14, "created_by_id" = $15
         WHERE ${C}."id" = $1`,
        [
          instance.id,
          pyStrip(values.code ?? instance.code).toUpperCase(),
          values.description ?? instance.description,
          values.discount_type ?? instance.discount_type,
          values.value ?? instance.value,
          values.minimum_order_value ?? instance.minimum_order_value,
          has('maximum_discount') ? values.maximum_discount : instance.maximum_discount,
          this.bound(has('starts_at') ? (values.starts_at ?? null) : instance.starts_at),
          this.bound(has('ends_at') ? (values.ends_at ?? null) : instance.ends_at),
          has('usage_limit') ? values.usage_limit : instance.usage_limit,
          has('usage_limit_per_customer')
            ? values.usage_limit_per_customer
            : instance.usage_limit_per_customer,
          instance.used_count,
          has('channels') ? JSON.stringify(values.channels) : instance.channels,
          values.is_active ?? instance.is_active,
          instance.created_by_id,
        ],
      );
      if (values.categories)
        await this.setRelated(
          tx,
          'promotions_coupon_categories',
          'category_id',
          instance.id,
          values.categories,
        );
      if (values.products)
        await this.setRelated(
          tx,
          'promotions_coupon_products',
          'product_id',
          instance.id,
          values.products,
        );
    });
    return this.answer(instance.id);
  }

  /**
   * `perform_destroy`: a coupon ever redeemed is deactivated; any other is
   * deleted, its restrictions with it, and the carts and orders that named it
   * left without one (`SET_NULL`).
   */
  async destroy(pk: string, query: QueryDict): Promise<void> {
    const instance = await this.find(pk, query);
    const redeemed = await this.db.one(
      `SELECT 1 AS "a" FROM "promotions_couponredemption" WHERE "coupon_id" = $1 LIMIT 1`,
      [instance.id],
    );
    if (redeemed) {
      await this.db.query(
        `UPDATE ${C} SET "updated_at" = clock_timestamp(), "is_active" = false WHERE ${C}."id" = $1`,
        [instance.id],
      );
      return;
    }
    await this.db.transaction(async (tx) => {
      for (const through of ['promotions_coupon_categories', 'promotions_coupon_products'])
        await tx.query(`DELETE FROM "${through}" WHERE "coupon_id" IN ($1)`, [instance.id]);
      for (const table of ['orders_cart', 'orders_order'])
        await tx.query(`UPDATE "${table}" SET "coupon_id" = NULL WHERE "coupon_id" IN ($1)`, [
          instance.id,
        ]);
      await tx.query(`DELETE FROM ${C} WHERE ${C}."id" IN ($1)`, [instance.id]);
    });
  }

  /** `redemptions`: every use of the coupon, newest first, the released ones included. */
  async redemptions(pk: string, query: QueryDict) {
    const instance = await this.find(pk, query);
    const rows = await this.db.query<{
      id: string;
      created_at: string;
      order_id: string;
      customer_id: string | null;
      discount_amount: string;
      released_at: string | null;
      order_number: string;
      customer_name: string | null;
    }>(
      `SELECT r."id", r."created_at", r."order_id", r."customer_id", r."discount_amount",
              r."released_at", "orders_order"."number" AS "order_number",
              "customers_customer"."name" AS "customer_name"
         FROM "promotions_couponredemption" r
         INNER JOIN "orders_order" ON (r."order_id" = "orders_order"."id")
         LEFT OUTER JOIN "customers_customer" ON (r."customer_id" = "customers_customer"."id")
        WHERE r."coupon_id" = $1 ORDER BY r."created_at" DESC`,
      [instance.id],
    );
    const tz = this.env.DJANGO_TIME_ZONE;
    return rows.map((row) => ({
      id: row.id,
      coupon: instance.id,
      order: row.order_id,
      order_number: row.order_number,
      customer: row.customer_id,
      customer_name: row.customer_name ?? '',
      discount_amount: row.discount_amount,
      released_at: localIso(row.released_at, tz),
      created_at: localIso(row.created_at, tz),
    }));
  }
}
