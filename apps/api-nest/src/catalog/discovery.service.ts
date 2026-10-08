import { Inject, Injectable } from '@nestjs/common';

import { drfFloat } from '../common/decimal';
import { mediaUrl } from '../common/media';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns, Params } from '../database/sql';
import { BRAND_COLUMNS, PRODUCT_COLUMNS, pick } from './columns';
import { SearchLogService } from './search-log.service';

/** `connection.ops.prep_for_like_query`: escape LIKE's own wildcards. */
export function likeContains(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/**
 * Filters and type-ahead: `catalog.search.facets` and `catalog.search.suggest`,
 * with the category helpers `content.selectors` gives them.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly db: Database,
    private readonly searchLog: SearchLogService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Filter values with counts, from the products a search matched. */
  async facets(productIds: string[]) {
    if (!productIds.length) return { brands: [], attributes: [], price: { min: 0, max: 0 } };

    const brandParams = new Params();
    const brands = await this.db.query<{ slug: string; name: string; count: number }>(
      `SELECT "catalog_brand"."slug", "catalog_brand"."name", COUNT("catalog_product"."id")::int AS "count"
         FROM "catalog_product" INNER JOIN "catalog_brand" ON ("catalog_product"."brand_id" = "catalog_brand"."id")
        WHERE ("catalog_product"."brand_id" IS NOT NULL AND "catalog_product"."id" IN ${brandParams.list(productIds, 'uuid')})
        GROUP BY "catalog_brand"."slug", "catalog_brand"."name" ORDER BY 3 DESC, "catalog_brand"."name" ASC`,
      brandParams.values,
    );

    const valueParams = new Params();
    const values = await this.db.query<{
      code: string;
      name: string;
      kind: string;
      value: string;
      label: string;
      swatch: string;
      count: number;
    }>(
      `SELECT "catalog_attribute"."code", "catalog_attribute"."name", "catalog_attribute"."kind",
              "catalog_attributevalue"."value", "catalog_attributevalue"."label", "catalog_attributevalue"."swatch",
              COUNT(DISTINCT "catalog_productvariant"."product_id")::int AS "count"
         FROM "catalog_attributevalue"
        INNER JOIN "catalog_attribute" ON ("catalog_attributevalue"."attribute_id" = "catalog_attribute"."id")
        INNER JOIN "catalog_variantattributevalue" ON ("catalog_attributevalue"."id" = "catalog_variantattributevalue"."attribute_value_id")
        INNER JOIN "catalog_productvariant" ON ("catalog_variantattributevalue"."variant_id" = "catalog_productvariant"."id")
        WHERE ("catalog_attribute"."is_filterable" AND "catalog_productvariant"."product_id" IN ${valueParams.list(productIds, 'uuid')})
        GROUP BY "catalog_attribute"."code", "catalog_attribute"."name", "catalog_attribute"."kind",
                 "catalog_attributevalue"."value", "catalog_attributevalue"."label", "catalog_attributevalue"."swatch",
                 "catalog_attribute"."position", "catalog_attributevalue"."position"
        ORDER BY "catalog_attribute"."position" ASC, "catalog_attributevalue"."position" ASC, "catalog_attributevalue"."value" ASC`,
      valueParams.values,
    );
    const grouped = new Map<
      string,
      { code: string; name: string; kind: string; values: unknown[] }
    >();
    for (const row of values) {
      let group = grouped.get(row.code);
      if (!group) {
        group = { code: row.code, name: row.name, kind: row.kind, values: [] };
        grouped.set(row.code, group);
      }
      group.values.push({
        value: row.value,
        label: row.label || row.value,
        swatch: row.swatch,
        count: row.count,
      });
    }

    const priceParams = new Params();
    const price = await this.db.one<{ min: string | null; max: string | null }>(
      `SELECT MIN("catalog_productvariant"."price") AS "min", MAX("catalog_productvariant"."price") AS "max"
         FROM "catalog_productvariant" WHERE "catalog_productvariant"."product_id" IN ${priceParams.list(productIds, 'uuid')}`,
      priceParams.values,
    );

    return {
      brands: brands.map((brand) => ({ slug: brand.slug, name: brand.name, count: brand.count })),
      attributes: [...grouped.values()],
      // Bare Decimals in a response dict: DRF's encoder writes them as floats.
      price: { min: drfFloat(price?.min ?? '0.00'), max: drfFloat(price?.max ?? '0.00') },
    };
  }

  /** Navbar type-ahead: five products, five categories, the popular terms. */
  async suggest(query: string) {
    const cleaned = (query ?? '').trim();
    const popular = async () => this.searchLog.popularTerms();
    if (Array.from(cleaned).length < 2)
      return { products: [], categories: [], popular: await popular() };

    const pattern = likeContains(cleaned);
    const productRows = await this.db.arrays(
      `SELECT ${columns('"catalog_product"', PRODUCT_COLUMNS)}, MIN("catalog_productvariant"."price") AS "price_from", ` +
        `${columns('"catalog_brand"', BRAND_COLUMNS)} FROM "catalog_product" ` +
        `LEFT OUTER JOIN "catalog_brand" ON ("catalog_product"."brand_id" = "catalog_brand"."id") ` +
        `LEFT OUTER JOIN "catalog_productvariant" ON ("catalog_product"."id" = "catalog_productvariant"."product_id") ` +
        `WHERE ("catalog_product"."published" AND "catalog_product"."status" = 'ACTIVE' AND ` +
        `(UPPER("catalog_product"."name"::text) LIKE UPPER($1) OR UPPER("catalog_brand"."name"::text) LIKE UPPER($1))) ` +
        `GROUP BY "catalog_product"."id", "catalog_brand"."id" ORDER BY "catalog_product"."name" ASC LIMIT 5`,
      [pattern],
    );
    const products = productRows.map((row) => {
      const product = pick(row, PRODUCT_COLUMNS, 0);
      const brand = pick(row, BRAND_COLUMNS, PRODUCT_COLUMNS.length + 1);
      return {
        id: product.id as string,
        name: product.name as string,
        slug: product.slug as string,
        brand: brand.id === null ? '' : (brand.name as string),
        priceFrom: (row[PRODUCT_COLUMNS.length] as string | null) ?? '0.00',
      };
    });

    const firstImage = new Map<string, string>();
    if (products.length) {
      const params = new Params();
      const images = await this.db.query<{ product_id: string; image: string }>(
        `SELECT "catalog_productimage"."product_id", "catalog_productimage"."image" FROM "catalog_productimage"
          WHERE "catalog_productimage"."product_id" IN ${params.list(
            products.map((p) => p.id),
            'uuid',
          )}
          ORDER BY "catalog_productimage"."position" ASC, "catalog_productimage"."created_at" ASC`,
        params.values,
      );
      for (const image of images) {
        if (image.image && !firstImage.has(image.product_id))
          firstImage.set(image.product_id, image.image);
      }
    }

    const categories = await this.db.query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM "catalog_category"
        WHERE ("catalog_category"."is_active" AND UPPER("catalog_category"."name"::text) LIKE UPPER($1))
        ORDER BY "catalog_category"."position" ASC, "catalog_category"."name" ASC LIMIT 5`,
      [pattern],
    );
    const categoryPayload = [];
    for (const category of categories) {
      categoryPayload.push({
        name: category.name,
        slug: category.slug,
        url: categoryUrl(await this.categoryPath(category.id)),
      });
    }

    return {
      products: products.map((product) => ({
        name: product.name,
        slug: product.slug,
        url: `/product/${product.slug}`,
        brand: product.brand,
        price: product.priceFrom,
        image: mediaUrl(firstImage.get(product.id) ?? '', this.env.mediaBase),
      })),
      categories: categoryPayload,
      popular: await popular(),
    };
  }

  /** `Category.ancestors()`: root first, following `parent` whatever its state. */
  async ancestors(categoryId: string): Promise<{ id: string; name: string; slug: string }[]> {
    const rows = await this.db.query<{ id: string; name: string; slug: string; depth: number }>(
      `WITH RECURSIVE chain AS (
         SELECT parent_id, 0 AS depth FROM catalog_category WHERE id = $1::uuid
         UNION ALL
         SELECT c.parent_id, chain.depth + 1 FROM catalog_category c JOIN chain ON c.id = chain.parent_id
          WHERE chain.parent_id IS NOT NULL AND chain.depth < 64
       )
       SELECT c.id, c.name, c.slug, chain.depth FROM chain JOIN catalog_category c ON c.id = chain.parent_id
        ORDER BY chain.depth DESC`,
      [categoryId],
    );
    return rows.map(({ id, name, slug }) => ({ id, name, slug }));
  }

  /** `content.selectors.category_path`: `women/kurti`. */
  async categoryPath(categoryId: string): Promise<string> {
    const self = await this.db.one<{ slug: string }>(
      `SELECT slug FROM catalog_category WHERE id = $1::uuid`,
      [categoryId],
    );
    const ancestors = await this.ancestors(categoryId);
    return [...ancestors.map((ancestor) => ancestor.slug), self?.slug ?? ''].join('/');
  }
}

/** `content.selectors.category_url`. */
export function categoryUrl(path: string): string {
  return `/category/${path}`;
}
