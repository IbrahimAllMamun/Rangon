import { randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { OrganizationService } from '../accounts/organization.service';
import { primaryImageUrl } from '../catalog/primary-image';
import { Dec, drfFloat } from '../common/decimal';
import { BusinessError, InsufficientStock, ValidationError } from '../common/errors';
import { pyStr, pyStrip } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { AvailabilityService, AvailabilitySnapshot } from '../inventory/availability.service';
import { CouponRow, CouponsService } from './coupons.service';
import {
  calculate,
  itemCount,
  money,
  PricedOrder,
  priceLines,
  PricedVariant,
  subtotalOf,
  ZERO,
} from './pricing';

export interface CartRow {
  id: string;
  token: string;
  customer_id: string | null;
  branch_id: string;
  coupon_id: string | null;
  is_active: boolean;
}

const CART_COLUMNS = 'id, token, customer_id, branch_id, coupon_id, is_active';

interface ItemRow {
  id: string;
  variant_id: string;
  quantity: number;
  sku: string;
  variant_name: string;
  price: string;
  cost: string;
  variant_status: string;
  product_id: string;
  product_name: string;
  product_slug: string;
  product_status: string;
  published: boolean;
  category_id: string;
  category_tax_rate: string | null;
}

export interface ShippingMethodRow {
  id: string;
  code: string;
  name: string;
  description: string;
  price: string;
  free_over: string | null;
  min_days: number;
  max_days: number;
  is_pickup: boolean;
  supports_cod: boolean;
}

/** `price_cart`'s answer: the priced order, the stock snapshots, and what changed. */
export interface CartView {
  cart: CartRow;
  priced: PricedOrder;
  availability: Map<string, AvailabilitySnapshot>;
  issues: Record<string, unknown>[];
}

/** `ShippingMethod.price_for`: free above the threshold. */
export function priceFor(method: ShippingMethodRow, subtotal: Dec): Dec {
  if (method.free_over !== null && subtotal.gte(method.free_over)) return new Dec('0.00');
  return new Dec(method.price);
}

/** `ShippingMethod.eta_label`. */
export function etaLabel(method: ShippingMethodRow): string {
  if (method.is_pickup) return 'Collect in store';
  if (method.min_days === method.max_days) {
    return `${method.min_days} day${method.min_days !== 1 ? 's' : ''}`;
  }
  return `${method.min_days}–${method.max_days} days`;
}

/** Python iteration over a JSON value: a list's items, a dict's keys, a str's characters. */
function pyIterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (value && typeof value === 'object') return Object.keys(value);
  throw new TypeError('object is not iterable');
}

/**
 * `orders.services.checkout`'s cart half: the server-authoritative cart.
 * The browser never decides a price, a discount or a total -- every read
 * re-prices from the database and re-checks stock (business-rules section 3.1).
 *
 * Statement order follows Django's: without ATOMIC_REQUESTS each one commits
 * on its own there, and a cart read can write (a new cart, a coupon dropped).
 */
@Injectable()
export class CartService {
  private readonly logger = new Logger('rangon.orders');

  constructor(
    private readonly db: Database,
    private readonly organization: OrganizationService,
    private readonly stock: AvailabilityService,
    private readonly coupons: CouponsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async cartWhere(where: string, values: unknown[]): Promise<CartRow | null> {
    return this.db.one<CartRow>(
      `SELECT ${CART_COLUMNS} FROM orders_cart WHERE ${where} ORDER BY last_activity_at DESC LIMIT 1`,
      values,
    );
  }

  /** `get_or_create_cart`: the customer's, else the token's, else a new one. */
  async getOrCreate(token: string | null, customerId: string | null): Promise<CartRow> {
    const branchId = await this.organization.storefrontBranchId();
    if (!branchId) throw new ValidationError('No branch is configured to sell from.');

    if (customerId) {
      const cart = await this.cartWhere('customer_id = $1::uuid AND is_active', [customerId]);
      if (cart) {
        if (token && cart.token !== token) await this.mergeGuest(cart, token);
        return cart;
      }
    }
    if (token) {
      const cart = await this.cartWhere('token = $1 AND is_active', [token]);
      if (cart) {
        if (customerId && cart.customer_id === null) {
          await this.db.query(
            `UPDATE orders_cart SET customer_id = $2::uuid, updated_at = clock_timestamp() WHERE id = $1::uuid`,
            [cart.id, customerId],
          );
          cart.customer_id = customerId;
        }
        return cart;
      }
    }
    // A token that belonged to a cart already checked out would collide on
    // the unique index: a fresh cart gets a fresh token, and the response's
    // X-Cart-Token says so.
    let chosen = token;
    if (
      chosen &&
      (await this.db.one(`SELECT 1 AS found FROM orders_cart WHERE token = $1 LIMIT 1`, [chosen]))
    ) {
      chosen = null;
    }
    const created = await this.db.one<CartRow>(
      `INSERT INTO orders_cart (id, created_at, updated_at, customer_id, token, branch_id, coupon_id,
                                is_active, last_activity_at)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4::uuid, NULL, true,
               clock_timestamp())
       RETURNING ${CART_COLUMNS}`,
      [randomUUID(), customerId, chosen || randomBytes(24).toString('base64url'), branchId],
    );
    return created as CartRow;
  }

  /** `_merge_guest_cart`: signing in should not lose what the visitor put in the basket. */
  private async mergeGuest(cart: CartRow, guestToken: string): Promise<void> {
    const guest = await this.cartWhere('token = $1 AND is_active', [guestToken]);
    if (!guest || guest.id === cart.id) return;
    const items = await this.db.query<{ variant_id: string; quantity: number }>(
      `SELECT variant_id, quantity FROM orders_cartitem WHERE cart_id = $1::uuid ORDER BY created_at ASC`,
      [guest.id],
    );
    for (const item of items) {
      const existing = await this.itemWhere(cart.id, 'variant_id = $2::uuid', [item.variant_id]);
      if (existing) {
        await this.db.query(
          `UPDATE orders_cartitem SET quantity = $2, updated_at = clock_timestamp() WHERE id = $1::uuid`,
          [existing.id, existing.quantity + item.quantity],
        );
      } else {
        await this.insertItem(cart.id, item.variant_id, BigInt(item.quantity));
      }
    }
    await this.db.query(
      `UPDATE orders_cart SET is_active = false, updated_at = clock_timestamp() WHERE id = $1::uuid`,
      [guest.id],
    );
  }

  private async itemWhere(
    cartId: string,
    where: string,
    values: unknown[],
  ): Promise<{ id: string; variant_id: string; quantity: number } | null> {
    return this.db.one(
      `SELECT id, variant_id, quantity FROM orders_cartitem
        WHERE (cart_id = $1::uuid AND ${where}) ORDER BY created_at ASC LIMIT 1`,
      [cartId, ...values],
    );
  }

  private async insertItem(cartId: string, variantId: string, quantity: bigint): Promise<void> {
    await this.db.query(
      `INSERT INTO orders_cartitem (id, created_at, updated_at, cart_id, variant_id, quantity)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4)`,
      [randomUUID(), cartId, variantId, quantity.toString()],
    );
  }

  /** The cart's lines with their variant, product and category, in `Meta.ordering`. */
  private async items(cartId: string, q: Queryable = this.db): Promise<ItemRow[]> {
    return q.query<ItemRow>(
      `SELECT i.id, i.variant_id, i.quantity, v.sku, v.name AS variant_name, v.price, v.cost,
              v.status AS variant_status, p.id AS product_id, p.name AS product_name,
              p.slug AS product_slug, p.status AS product_status, p.published, p.category_id,
              c.tax_rate AS category_tax_rate
         FROM orders_cartitem i
        INNER JOIN catalog_productvariant v ON (i.variant_id = v.id)
        INNER JOIN catalog_product p ON (v.product_id = p.id)
        INNER JOIN catalog_category c ON (p.category_id = c.id)
        WHERE i.cart_id = $1::uuid
        ORDER BY i.created_at ASC`,
      [cartId],
    );
  }

  /**
   * `ProductVariant.label`: its name, else its attribute values joined --
   * read the way the property reads them, one variant at a time and in the
   * order PostgreSQL gives (the links have no ordering).
   */
  async variantLabel(variantId: string, name: string): Promise<string> {
    if (name) return name;
    const links = await this.db.query<{ attribute_value_id: string }>(
      `SELECT "catalog_variantattributevalue"."id", "catalog_variantattributevalue"."created_at",
              "catalog_variantattributevalue"."updated_at", "catalog_variantattributevalue"."variant_id",
              "catalog_variantattributevalue"."attribute_id", "catalog_variantattributevalue"."attribute_value_id"
         FROM "catalog_variantattributevalue" WHERE "catalog_variantattributevalue"."variant_id" = $1::uuid`,
      [variantId],
    );
    const values: string[] = [];
    for (const link of links) {
      const value = await this.db.one<{ label: string; value: string }>(
        `SELECT label, value FROM catalog_attributevalue WHERE id = $1::uuid`,
        [link.attribute_value_id],
      );
      values.push(value ? value.label || value.value : '');
    }
    return values.join(' / ');
  }

  private variantOf(item: ItemRow): PricedVariant {
    return {
      id: item.variant_id,
      sku: item.sku,
      price: item.price,
      cost: item.cost,
      productId: item.product_id,
      productName: item.product_name,
      categoryId: item.category_id,
      categoryTaxRate: item.category_tax_rate,
      label: () => this.variantLabel(item.variant_id, item.variant_name),
    };
  }

  /** `price_cart`: re-price from scratch and report anything that changed. */
  async price(
    cart: CartRow,
    shippingMethod: ShippingMethodRow | null = null,
    q: Queryable = this.db,
  ): Promise<CartView> {
    const items = await this.items(cart.id, q);
    const issues: Record<string, unknown>[] = [];

    const sellable: ItemRow[] = [];
    for (const item of items) {
      const visible = item.published && item.product_status === 'ACTIVE';
      if (item.variant_status !== 'ACTIVE' || !visible) {
        issues.push({
          code: 'UNAVAILABLE',
          variant_id: item.variant_id,
          message: `${item.product_name} is no longer available.`,
        });
        continue;
      }
      sellable.push(item);
    }

    const snapshots = await this.stock.availability(
      cart.branch_id,
      sellable.map((item) => item.variant_id),
      q,
    );
    const raw: [PricedVariant, number, Dec | null][] = [];
    for (const item of sellable) {
      const snapshot = snapshots.get(item.variant_id) as AvailabilitySnapshot;
      if (snapshot.available < item.quantity) {
        issues.push({
          code: 'INSUFFICIENT_STOCK',
          variant_id: item.variant_id,
          requested: item.quantity,
          available: snapshot.available,
          message: `Only ${snapshot.available} left of ${item.product_name} ${await this.variantLabel(item.variant_id, item.variant_name)}.`,
        });
      }
      raw.push([this.variantOf(item), item.quantity, ZERO]);
    }

    // Cost is the branch's weighted average now (ADR-0006), as the counter freezes it.
    const costs = new Map([...snapshots].map(([id, snapshot]) => [id, snapshot.averageCost]));
    const lines = priceLines(raw, costs);
    const subtotal = subtotalOf(lines);

    let couponDiscount = ZERO;
    let freeShipping = false;
    if (cart.coupon_id && lines.length) {
      const coupon = await this.coupons.byId(cart.coupon_id, q);
      try {
        const result = await this.coupons.validate(
          coupon as CouponRow,
          lines,
          subtotal,
          cart.customer_id,
        );
        couponDiscount = result.discount;
        freeShipping = result.freeShipping;
      } catch (error) {
        // A refusal is written for the shopper and says why; anything else
        // is written for a developer and never reaches the shopper. Either
        // way the coupon is dropped: a cart that cannot be priced with it
        // must not be priced as if it applied.
        let message: string;
        if (error instanceof BusinessError) message = error.message;
        else {
          this.logger.error(
            `Coupon ${coupon?.code} could not be re-validated`,
            (error as Error).stack,
          );
          message = 'This coupon could not be applied, so it has been removed.';
        }
        issues.push({ code: 'COUPON_INVALID', message, coupon: coupon?.code });
        cart.coupon_id = null;
        await q.query(
          `UPDATE orders_cart SET coupon_id = NULL, updated_at = clock_timestamp() WHERE id = $1::uuid`,
          [cart.id],
        );
      }
    }

    let shippingTotal = ZERO;
    if (shippingMethod && lines.length) {
      shippingTotal = freeShipping ? ZERO : priceFor(shippingMethod, subtotal);
    }

    const priced = calculate(lines, {
      couponDiscount,
      shippingTotal,
      couponId: cart.coupon_id,
      organisation: await this.organization.taxSettings(),
    });
    return { cart, priced, availability: snapshots, issues };
  }

  /** `inventory.services.check_availability`: fail fast, before the lock that decides. */
  private async checkAvailability(
    branchId: string,
    variantId: string,
    quantity: bigint,
  ): Promise<void> {
    const snapshots = await this.stock.availability(branchId, [variantId]);
    if (this.env.RANGON_ALLOW_OVERSELL) return;
    const snapshot = snapshots.get(variantId) as AvailabilitySnapshot;
    if (BigInt(snapshot.available) < quantity) {
      const variant = await this.db.one<{ sku: string }>(
        `SELECT sku FROM catalog_productvariant WHERE id = $1::uuid`,
        [variantId],
      );
      const sku = variant ? variant.sku : variantId;
      throw new InsufficientStock(`Only ${snapshot.available} unit(s) of ${sku} are available.`, {
        details: {
          variant_id: variantId,
          sku: variant ? variant.sku : '',
          requested: Number.isSafeInteger(Number(quantity)) ? Number(quantity) : quantity,
          available: snapshot.available,
        },
      });
    }
  }

  /**
   * `add_item`. The stock check is advisory; the one that decides is taken at
   * checkout. `variantId` is resolved only after the quantity passes -- where
   * Django first evaluates the lookup, and so raises for a malformed id.
   */
  async addItem(
    cart: CartRow,
    variantLookup: () => string | null,
    quantity: bigint,
  ): Promise<void> {
    if (quantity <= 0n) throw new ValidationError('Quantity must be at least 1.');
    const variantId = variantLookup();
    const variant = variantId
      ? await this.db.one<{
          id: string;
          status: string;
          published: boolean;
          product_status: string;
        }>(
          `SELECT v.id, v.status, p.published, p.status AS product_status
             FROM catalog_productvariant v INNER JOIN catalog_product p ON (v.product_id = p.id)
            WHERE v.id = $1::uuid LIMIT 1`,
          [variantId],
        )
      : null;
    if (
      !variant ||
      variant.status !== 'ACTIVE' ||
      !(variant.published && variant.product_status === 'ACTIVE')
    ) {
      throw new ValidationError('That product is not available.');
    }
    const item = await this.itemWhere(cart.id, 'variant_id = $2::uuid', [variant.id]);
    const newQuantity = BigInt(item?.quantity ?? 0) + quantity;
    await this.checkAvailability(cart.branch_id, variant.id, newQuantity);
    if (!item) await this.insertItem(cart.id, variant.id, quantity);
    else {
      await this.db.query(
        `UPDATE orders_cartitem SET quantity = $2, updated_at = clock_timestamp() WHERE id = $1::uuid`,
        [item.id, newQuantity.toString()],
      );
    }
    await this.db.query(
      `UPDATE orders_cart SET last_activity_at = clock_timestamp() WHERE id = $1::uuid`,
      [cart.id],
    );
  }

  /** `update_item`: a quantity of zero or less removes the line. */
  async updateItem(cart: CartRow, itemId: string | null, quantity: bigint): Promise<void> {
    const item = itemId ? await this.itemWhere(cart.id, 'id = $2::uuid', [itemId]) : null;
    if (!item) throw new ValidationError('That item is not in your cart.');
    if (quantity <= 0n) {
      await this.db.query(`DELETE FROM orders_cartitem WHERE id = $1::uuid`, [item.id]);
      return;
    }
    await this.checkAvailability(cart.branch_id, item.variant_id, quantity);
    await this.db.query(
      `UPDATE orders_cartitem SET quantity = $2, updated_at = clock_timestamp() WHERE id = $1::uuid`,
      [item.id, quantity.toString()],
    );
  }

  /** `cart.items.all().delete()`. */
  async clear(cart: CartRow): Promise<void> {
    await this.db.query(`DELETE FROM orders_cartitem WHERE cart_id = $1::uuid`, [cart.id]);
  }

  /** `apply_coupon`: validated against the cart as it prices now, then kept on it. */
  async applyCoupon(cart: CartRow, code: unknown): Promise<void> {
    const coupon = await this.coupons.byCode(code);
    const view = await this.price(cart);
    await this.coupons.validate(coupon, view.priced.lines, view.priced.subtotal, cart.customer_id);
    await this.setCoupon(cart, coupon.id);
    await this.price(cart);
  }

  /** `remove_coupon`. */
  async removeCoupon(cart: CartRow): Promise<void> {
    await this.setCoupon(cart, null);
  }

  private async setCoupon(
    cart: CartRow,
    couponId: string | null,
    q: Queryable = this.db,
  ): Promise<void> {
    cart.coupon_id = couponId;
    await q.query(
      `UPDATE orders_cart SET coupon_id = $2::uuid, updated_at = clock_timestamp() WHERE id = $1::uuid`,
      [cart.id, couponId],
    );
  }

  /** `shipping_options`: the city's zone (else the default zone), its methods priced here. */
  async shippingOptions(city: string, subtotal: Dec): Promise<Record<string, unknown>[]> {
    const zones = await this.db.query<{
      id: string;
      name: string;
      cities: unknown;
      is_default: boolean;
    }>(
      `SELECT id, name, cities, is_default FROM shipping_shippingzone WHERE is_active ORDER BY position ASC, name ASC`,
    );
    // Evaluated whether or not a zone matches, as Python evaluates `next()`'s default.
    const fallback = await this.db.one<{ id: string; name: string }>(
      `SELECT id, name FROM shipping_shippingzone WHERE (is_active AND is_default)
        ORDER BY position ASC, name ASC LIMIT 1`,
    );
    const matches = (zone: { cities: unknown; is_default: boolean }) => {
      if (!city) return zone.is_default;
      const needle = pyStrip(city).toLowerCase();
      return pyIterate(zone.cities).some((entry) => needle === pyStrip(pyStr(entry)).toLowerCase());
    };
    const zone = zones.find(matches) ?? fallback;
    if (!zone) return [];
    const methods = await this.db.query<ShippingMethodRow>(
      `SELECT id, code, name, description, price, free_over, min_days, max_days, is_pickup, supports_cod
         FROM shipping_shippingmethod WHERE (zone_id = $1::uuid AND is_active)
        ORDER BY position ASC, price ASC`,
      [zone.id],
    );
    return methods.map((method) => ({
      id: method.id,
      code: method.code,
      name: method.name,
      description: method.description,
      // A bare Decimal in a dict: DRF's encoder writes a float.
      price: drfFloat(money(priceFor(method, subtotal))),
      eta: etaLabel(method),
      is_pickup: method.is_pickup,
      supports_cod: method.supports_cod,
      zone: zone.name,
    }));
  }

  /** `CartSerializer` with `price_cart`'s context. */
  async payload(view: CartView): Promise<Record<string, unknown>> {
    const cart = view.cart;
    const rows = await this.db.query<ItemRow>(
      `SELECT i.id, i.variant_id, i.quantity, v.sku, v.name AS variant_name, v.price, p.id AS product_id,
              p.name AS product_name, p.slug AS product_slug
         FROM orders_cartitem i
        INNER JOIN catalog_productvariant v ON (i.variant_id = v.id)
        INNER JOIN catalog_product p ON (v.product_id = p.id)
        WHERE i.cart_id = $1::uuid ORDER BY i.created_at ASC`,
      [cart.id],
    );
    const items: Record<string, unknown>[] = [];
    for (const row of rows) {
      items.push({
        id: row.id,
        variant: row.variant_id,
        sku: row.sku,
        product_name: row.product_name,
        product_slug: row.product_slug,
        variant_label: await this.variantLabel(row.variant_id, row.variant_name),
        quantity: row.quantity,
        unit_price: row.price,
        image: await primaryImageUrl(this.db, row.product_id, this.env.mediaBase),
        available: view.availability.get(row.variant_id)?.available ?? 0,
      });
    }
    const coupon = cart.coupon_id ? await this.coupons.byId(cart.coupon_id) : null;
    const priced = view.priced;
    return {
      id: cart.id,
      token: cart.token,
      items,
      totals: {
        subtotal: money(priced.subtotal),
        discount_total: money(priced.discountTotal),
        coupon_discount: money(priced.couponDiscount),
        tax_total: money(priced.taxTotal),
        shipping_total: money(priced.shippingTotal),
        grand_total: money(priced.grandTotal),
        item_count: itemCount(priced),
      },
      issues: view.issues,
      coupon_code: coupon?.code ?? '',
    };
  }
}
