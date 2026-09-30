import { Injectable } from '@nestjs/common';

import { Database } from '../database/database.service';
import { columns, Params } from '../database/sql';
import { BRAND_COLUMNS, CATEGORY_COLUMNS, PRODUCT_COLUMNS, pick } from './columns';
import { ListedProduct } from './product-search';

/**
 * `catalog.merchandising` and the product queries the storefront pages share:
 * what to put in front of a shopper, answered from orders that happened.
 */

/** Orders that represent real trade (`merchandising.SOLD_STATUSES`). */
export const SOLD_STATUSES = [
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'RETURN_REQUESTED',
  'RETURNED',
  'REFUNDED',
] as const;

const P = '"catalog_product"';
const VISIBLE = `${P}."published" AND ${P}."status" = 'ACTIVE'`;
const WITH_RELATED =
  `SELECT ${columns(P, PRODUCT_COLUMNS)}, ${columns('"catalog_category"', CATEGORY_COLUMNS)}, ` +
  `${columns('"catalog_brand"', BRAND_COLUMNS)} FROM ${P} ` +
  `INNER JOIN "catalog_category" ON (${P}."category_id" = "catalog_category"."id") ` +
  `LEFT OUTER JOIN "catalog_brand" ON (${P}."brand_id" = "catalog_brand"."id")`;

@Injectable()
export class MerchandisingService {
  constructor(private readonly db: Database) {}

  /** A visible product by slug, with the size chart the detail page shows. */
  async visibleBySlug(
    slug: string,
  ): Promise<(ListedProduct & { sizeChartId: string | null }) | null> {
    const rows = await this.db.arrays(
      `${WITH_RELATED} WHERE (${VISIBLE} AND ${P}."slug" = $1) ORDER BY ${P}."created_at" DESC LIMIT 1`,
      [slug],
    );
    return rows[0] ? toProduct(rows[0]) : null;
  }

  /**
   * `_ranked(products)`: re-fetch with the payload's relations, in the order
   * given. Where an id appears twice the later position wins, exactly as the
   * Django API's position dict does.
   */
  async ranked(ids: string[]): Promise<ListedProduct[]> {
    if (!ids.length) return [];
    const position = new Map<string, number>();
    ids.forEach((id, index) => position.set(id, index));
    const params = new Params();
    const rows = await this.db.arrays(
      `${WITH_RELATED} WHERE ${P}."id" IN ${params.list([...position.keys()], 'uuid')} ORDER BY ${P}."created_at" DESC`,
      params.values,
    );
    const products = rows.map((row) => toProduct(row));
    // Python's sort is stable; so is Array.prototype.sort.
    return products.sort(
      (a, b) => (position.get(a.id) ?? position.size) - (position.get(b.id) ?? position.size),
    );
  }

  /** Visible products with category and brand: `base.order_by(...)[:n]` on the home page. */
  async visibleWithRelated(
    where: string,
    orderAndLimit: string,
    values: unknown[] = [],
  ): Promise<ListedProduct[]> {
    const rows = await this.db.arrays(
      `${WITH_RELATED} WHERE (${VISIBLE}${where ? ` AND ${where}` : ''}) ${orderAndLimit}`,
      values,
    );
    return rows.map((row) => toProduct(row));
  }

  /** The merchandiser's carousel, in their order; products a shopper cannot open are skipped. */
  async carouselIds(): Promise<string[]> {
    const rows = await this.db.arrays(
      `SELECT ${P}."id" FROM ${P} INNER JOIN "content_homecarouselitem" ON (${P}."id" = "content_homecarouselitem"."product_id") ` +
        `WHERE (${VISIBLE} AND "content_homecarouselitem"."id" IS NOT NULL) ` +
        `ORDER BY "content_homecarouselitem"."position" ASC, "content_homecarouselitem"."created_at" ASC`,
    );
    return rows.map((row) => row[0] as string);
  }

  /**
   * Best sellers: most order lines first (every line, whatever its order's
   * status, as the Django API counts them), ties left to the plan -- hence
   * its statement exactly.
   */
  async bestSellers(limit = 8): Promise<ListedProduct[]> {
    const rows = await this.db.arrays(
      `SELECT ${columns(P, PRODUCT_COLUMNS)}, COUNT("orders_orderitem"."id") AS "sold", ` +
        `${columns('"catalog_category"', CATEGORY_COLUMNS)}, ${columns('"catalog_brand"', BRAND_COLUMNS)} ` +
        `FROM ${P} LEFT OUTER JOIN "catalog_productvariant" ON (${P}."id" = "catalog_productvariant"."product_id") ` +
        `LEFT OUTER JOIN "orders_orderitem" ON ("catalog_productvariant"."id" = "orders_orderitem"."variant_id") ` +
        `INNER JOIN "catalog_category" ON (${P}."category_id" = "catalog_category"."id") ` +
        `LEFT OUTER JOIN "catalog_brand" ON (${P}."brand_id" = "catalog_brand"."id") ` +
        `WHERE (${VISIBLE}) GROUP BY ${P}."id", "catalog_category"."id", "catalog_brand"."id" ` +
        `HAVING COUNT("orders_orderitem"."id") > 0 ORDER BY ${PRODUCT_COLUMNS.length + 1} DESC LIMIT ${Number(limit)}`,
    );
    return rows.map((row) => toProduct(row, PRODUCT_COLUMNS.length + 1));
  }

  /** `visible_products()` in a statement: ids in `Meta.ordering` (newest first) unless told otherwise. */
  async visibleIds(where: string, values: unknown[], orderAndLimit: string): Promise<string[]> {
    const rows = await this.db.arrays(
      `SELECT ${P}."id" FROM ${P} WHERE (${VISIBLE}${where ? ` AND ${where}` : ''}) ${orderAndLimit}`,
      values,
    );
    return rows.map((row) => row[0] as string);
  }

  /**
   * `bought_together`: products that shared orders with this one, most shared
   * orders first; topped up from the same category, newest first.
   */
  async boughtTogether(product: ListedProduct, limit = 8): Promise<string[]> {
    const params = new Params();
    const productId = params.add(product.id, 'uuid');
    const coOccurring = await this.db.arrays(
      `SELECT "catalog_productvariant"."product_id", COUNT(DISTINCT "orders_orderitem"."order_id") AS "shared" ` +
        `FROM "orders_orderitem" INNER JOIN "catalog_productvariant" ON ("orders_orderitem"."variant_id" = "catalog_productvariant"."id") ` +
        `WHERE ("orders_orderitem"."order_id" IN (SELECT U0."order_id" FROM "orders_orderitem" U0 ` +
        `INNER JOIN "orders_order" U1 ON (U0."order_id" = U1."id") ` +
        `INNER JOIN "catalog_productvariant" U2 ON (U0."variant_id" = U2."id") ` +
        `WHERE (U1."status" IN ${params.list(SOLD_STATUSES)} AND U2."product_id" = ${productId})) ` +
        `AND NOT ("catalog_productvariant"."product_id" = ${productId})) ` +
        `GROUP BY "catalog_productvariant"."product_id" ORDER BY 2 DESC LIMIT ${Number(limit)}`,
      params.values,
    );
    const rankedIds = coOccurring.map((row) => row[0] as string);

    let result: string[] = [];
    if (rankedIds.length) {
      // `in_bulk` answers in the database's order; the ranking is reapplied.
      const visibleParams = new Params();
      const visible = new Set(
        await this.visibleIds(
          `${P}."id" IN ${visibleParams.list(rankedIds, 'uuid')}`,
          visibleParams.values,
          `ORDER BY ${P}."created_at" DESC`,
        ),
      );
      result = rankedIds.filter((id) => visible.has(id));
    }

    if (result.length < limit) {
      const seen = [...new Set([...result, product.id])];
      const fillerParams = new Params();
      const filler = await this.visibleIds(
        `${P}."category_id" = ${fillerParams.add(product.category.id, 'uuid')} AND NOT (${P}."id" IN ${fillerParams.list(seen, 'uuid')})`,
        fillerParams.values,
        `ORDER BY ${P}."created_at" DESC LIMIT ${Number(limit - result.length)}`,
      );
      result.push(...filler);
    }
    return result.slice(0, limit);
  }

  /**
   * `price_drops`: visible products with a real reduction, deepest first. The
   * same product can come back once per discounted variant -- `_ranked` keeps
   * its later position -- so the list is returned as the database gives it.
   */
  async priceDrops(limit = 12): Promise<string[]> {
    const money = 'numeric(14, 2)';
    const discount =
      `(((("catalog_productvariant"."compare_at_price")::${money} - ("catalog_productvariant"."price")::${money}) * 100) / ` +
      `("catalog_productvariant"."compare_at_price")::${money})`;
    const rows = await this.db.arrays(
      `SELECT DISTINCT ${columns(P, PRODUCT_COLUMNS)}, ${discount} AS "drop_percent" FROM ${P} ` +
        `INNER JOIN "catalog_productvariant" ON (${P}."id" = "catalog_productvariant"."product_id") ` +
        `WHERE (${VISIBLE} AND "catalog_productvariant"."compare_at_price" > ("catalog_productvariant"."price") ` +
        `AND "catalog_productvariant"."compare_at_price" IS NOT NULL) ` +
        `ORDER BY ${PRODUCT_COLUMNS.length + 1} DESC LIMIT ${Number(limit)}`,
    );
    return rows.map((row) => row[0] as string);
  }
}

/** A product row followed by its category's and brand's columns, from `categoryStart`. */
export function toProduct(
  row: unknown[],
  categoryStart: number = PRODUCT_COLUMNS.length,
): ListedProduct {
  const product = pick(row, PRODUCT_COLUMNS, 0);
  const category = pick(row, CATEGORY_COLUMNS, categoryStart);
  const brand = pick(row, BRAND_COLUMNS, categoryStart + CATEGORY_COLUMNS.length);
  return {
    id: product.id as string,
    createdAt: product.created_at as string,
    name: product.name as string,
    slug: product.slug as string,
    shortDescription: product.short_description as string,
    description: product.description as string,
    material: product.material as string,
    careInstructions: product.care_instructions as string,
    featured: product.featured as boolean,
    seoTitle: product.seo_title as string,
    seoDescription: product.seo_description as string,
    sizeChartId: (product.size_chart_id as string | null) ?? null,
    category: {
      id: category.id as string,
      name: category.name as string,
      slug: category.slug as string,
      taxRate: (category.tax_rate as string | null) ?? null,
    },
    brand:
      brand.id === null
        ? null
        : { id: brand.id as string, name: brand.name as string, slug: brand.slug as string },
  };
}
