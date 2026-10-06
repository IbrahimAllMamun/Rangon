import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { Dec } from '../common/decimal';
import { CouponInvalid } from '../common/errors';
import { pyStrip } from '../common/python';
import { Database, Queryable } from '../database/database.service';
import { lineTotal, money, PricedLine, quantize, ZERO } from './pricing';

export interface CouponRow {
  id: string;
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
  channels: unknown;
  is_active: boolean;
}

export interface CouponResult {
  coupon: CouponRow;
  discount: Dec;
  freeShipping: boolean;
  eligibleSubtotal: Dec;
}

const COUPON_COLUMNS = `id, code, description, discount_type, value, minimum_order_value,
  maximum_discount, starts_at, ends_at, usage_limit, usage_limit_per_customer, used_count,
  channels, is_active`;

export function pyTruthyJson(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `item in container` for a JSON value: list membership, dict key, substring. */
export function pyContains(container: unknown, item: string): boolean {
  if (Array.isArray(container)) return container.includes(item);
  if (typeof container === 'string') return container.includes(item);
  if (container && typeof container === 'object') return Object.hasOwn(container, item);
  // A number or a boolean: `in` is a TypeError in Python.
  throw new TypeError('argument of type is not iterable');
}

/** `Coupon.is_exhausted`. */
export function isExhausted(coupon: CouponRow): boolean {
  return coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit;
}

/**
 * `promotions.services`: the client sends a code, a claim; eligibility,
 * amount, caps and usage are decided here (docs/business-rules.md section 3.3).
 */
@Injectable()
export class CouponsService {
  constructor(private readonly db: Database) {}

  async byId(id: string, q: Queryable = this.db): Promise<CouponRow | null> {
    return q.one<CouponRow>(`SELECT ${COUPON_COLUMNS} FROM promotions_coupon WHERE id = $1::uuid`, [
      id,
    ]);
  }

  /**
   * `get_coupon(code)`. `code` is what the request sent, which Django then
   * calls `.strip()` on: anything but a str is an AttributeError there, a 500.
   */
  async byCode(code: unknown): Promise<CouponRow> {
    if (typeof code !== 'string')
      throw new TypeError(`'${typeof code}' object has no attribute 'strip'`);
    const coupon = await this.db.one<CouponRow>(
      `SELECT ${COUPON_COLUMNS} FROM promotions_coupon WHERE code = $1 ORDER BY created_at DESC LIMIT 1`,
      [pyStrip(code).toUpperCase()],
    );
    if (!coupon)
      throw new CouponInvalid('That coupon code was not recognised.', { details: { code } });
    return coupon;
  }

  /** `_eligible_subtotal`: the lines the coupon applies to; a category covers its descendants. */
  private async eligibleSubtotal(coupon: CouponRow, lines: PricedLine[]): Promise<Dec> {
    const categories = await this.db.query<{ id: string }>(
      `SELECT category_id AS id FROM promotions_coupon_categories WHERE coupon_id = $1::uuid`,
      [coupon.id],
    );
    const products = await this.db.query<{ id: string }>(
      `SELECT product_id AS id FROM promotions_coupon_products WHERE coupon_id = $1::uuid`,
      [coupon.id],
    );
    if (!categories.length && !products.length) {
      return quantize(lines.reduce((sum, line) => sum.plus(lineTotal(line)), ZERO));
    }
    const productIds = new Set(products.map((row) => row.id));
    const expanded = new Set<string>();
    for (const category of categories) {
      for (const id of await this.descendantIds(category.id)) expanded.add(id);
    }
    let total = ZERO;
    for (const line of lines) {
      if (productIds.has(line.variant.productId) || expanded.has(line.variant.categoryId)) {
        total = total.plus(lineTotal(line));
      }
    }
    return quantize(total);
  }

  /** `Category.descendant_ids()`: self, then each level of children. */
  private async descendantIds(rootId: string): Promise<string[]> {
    const ids = [rootId];
    let frontier = [rootId];
    while (frontier.length) {
      const rows = await this.db.query<{ id: string }>(
        `SELECT id FROM catalog_category WHERE parent_id = ANY($1::uuid[])`,
        [frontier],
      );
      frontier = rows.map((row) => row.id);
      ids.push(...frontier);
    }
    return ids;
  }

  /** `validate_coupon`: refuse with `CouponInvalid`, or the discount the backend will honour. */
  async validate(
    coupon: CouponRow,
    lines: PricedLine[],
    subtotal: Dec,
    customerId: string | null,
    channel = 'ONLINE',
  ): Promise<CouponResult> {
    if (!coupon.is_active) throw new CouponInvalid('This coupon is no longer active.');
    if (coupon.starts_at || coupon.ends_at) {
      const window = await this.db.one<{ early: boolean; late: boolean }>(
        `SELECT coalesce(clock_timestamp() < $1::timestamptz, false) AS early,
                coalesce(clock_timestamp() > $2::timestamptz, false) AS late`,
        [coupon.starts_at, coupon.ends_at],
      );
      if (window?.early) throw new CouponInvalid('This coupon is not valid yet.');
      if (window?.late) throw new CouponInvalid('This coupon has expired.');
    }
    if (isExhausted(coupon)) throw new CouponInvalid('This coupon has reached its usage limit.');
    // `coupon.channels and channel not in coupon.channels`, Python's `in`
    // for whatever JSON the column holds (a list, as the admin writes it).
    if (pyTruthyJson(coupon.channels) && !pyContains(coupon.channels, channel)) {
      throw new CouponInvalid('This coupon cannot be used on this channel.');
    }

    if (coupon.usage_limit_per_customer && customerId) {
      const used = await this.db.one<{ count: string }>(
        `SELECT count(*) AS count FROM promotions_couponredemption
          WHERE coupon_id = $1::uuid AND customer_id = $2::uuid AND released_at IS NULL`,
        [coupon.id, customerId],
      );
      if (Number(used?.count ?? 0) >= coupon.usage_limit_per_customer) {
        throw new CouponInvalid('You have already used this coupon.');
      }
    }

    if (subtotal.lt(coupon.minimum_order_value)) {
      throw new CouponInvalid(
        `This coupon needs a minimum order of ${coupon.minimum_order_value}.`,
        {
          details: { minimum_order_value: coupon.minimum_order_value, subtotal: money(subtotal) },
        },
      );
    }

    const eligible = await this.eligibleSubtotal(coupon, lines);
    if (eligible.lte(0))
      throw new CouponInvalid('No items in your cart are eligible for this coupon.');

    const freeShipping = coupon.discount_type === 'FREE_SHIPPING';
    let discount: Dec;
    if (freeShipping) discount = ZERO;
    else if (coupon.discount_type === 'PERCENTAGE') {
      discount = quantize(eligible.times(coupon.value).div(100));
    } else {
      discount = quantize(Dec.min(coupon.value, eligible));
    }
    if (coupon.maximum_discount !== null && discount.gt(coupon.maximum_discount)) {
      discount = quantize(coupon.maximum_discount);
    }
    // Python's `min(discount, subtotal)` answers the first of two equal values.
    if (subtotal.lt(discount)) discount = subtotal;
    return { coupon, discount, freeShipping, eligibleSubtotal: eligible };
  }

  /**
   * `promotions.services.redeem`: count the use under the coupon's row lock,
   * re-checking both limits -- validation ran before this lock existed, so
   * two checkouts can both have passed it (business-rules section 3.3).
   */
  async redeem(
    tx: Queryable,
    couponId: string,
    orderId: string,
    discount: Dec,
    customerId: string | null,
  ): Promise<void> {
    const coupon = await tx.one<{
      id: string;
      usage_limit: number | null;
      used_count: number;
      usage_limit_per_customer: number | null;
    }>(
      `SELECT id, usage_limit, used_count, usage_limit_per_customer FROM promotions_coupon WHERE id = $1::uuid FOR UPDATE`,
      [couponId],
    );
    if (!coupon) return;
    if (isExhausted(coupon as unknown as CouponRow))
      throw new CouponInvalid('This coupon has reached its usage limit.');
    if (coupon.usage_limit_per_customer && customerId) {
      const used = await tx.one<{ count: string }>(
        `SELECT count(*) AS count FROM promotions_couponredemption
          WHERE coupon_id = $1::uuid AND customer_id = $2::uuid AND released_at IS NULL AND NOT (order_id = $3::uuid)`,
        [couponId, customerId, orderId],
      );
      if (Number(used?.count ?? 0) >= coupon.usage_limit_per_customer) {
        throw new CouponInvalid('You have already used this coupon.');
      }
    }
    const created = await tx.query(
      `INSERT INTO promotions_couponredemption
         (id, created_at, updated_at, coupon_id, order_id, customer_id, discount_amount, released_at)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4::uuid, $5, NULL)
       ON CONFLICT (coupon_id, order_id) DO NOTHING RETURNING id`,
      [randomUUID(), couponId, orderId, customerId, money(quantize(discount))],
    );
    if (created.length) {
      await tx.query(
        `UPDATE promotions_coupon SET updated_at = clock_timestamp(), used_count = $2 WHERE id = $1::uuid`,
        [couponId, coupon.used_count + 1],
      );
    }
  }

  /**
   * `promotions.services.release`: the use given back when a sale is undone
   * -- each of the order's live redemptions locked, then its coupon, the
   * count taken down (never below zero) and the redemption marked released.
   */
  async release(tx: Queryable, orderId: string): Promise<void> {
    const redemptions = await tx.query<{ id: string; coupon_id: string }>(
      `SELECT "id", "coupon_id" FROM "promotions_couponredemption"
        WHERE ("promotions_couponredemption"."order_id" = $1
               AND "promotions_couponredemption"."released_at" IS NULL)
        ORDER BY "promotions_couponredemption"."created_at" DESC FOR UPDATE`,
      [orderId],
    );
    for (const redemption of redemptions) {
      const coupon = (await tx.one<{ used_count: number }>(
        `SELECT "used_count" FROM "promotions_coupon" WHERE "promotions_coupon"."id" = $1
          LIMIT 21 FOR UPDATE`,
        [redemption.coupon_id],
      )) as { used_count: number };
      await tx.query(
        `UPDATE "promotions_coupon" SET "updated_at" = clock_timestamp(), "used_count" = $2
          WHERE "promotions_coupon"."id" = $1`,
        [redemption.coupon_id, Math.max(coupon.used_count - 1, 0)],
      );
      await tx.query(
        `UPDATE "promotions_couponredemption" SET "updated_at" = clock_timestamp(),
                "released_at" = clock_timestamp() WHERE "promotions_couponredemption"."id" = $1`,
        [redemption.id],
      );
    }
  }
}
