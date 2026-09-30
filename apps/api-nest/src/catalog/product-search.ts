import { Injectable } from '@nestjs/common';

import { ValidationError } from '../common/errors';
import { isFiniteDecimal } from '../common/python';
import { Database } from '../database/database.service';
import { columns, ident, Params } from '../database/sql';
import { BRAND_COLUMNS, CATEGORY_COLUMNS, PRODUCT_COLUMNS, pick } from './columns';

/**
 * `catalog.search.search_products`, producing the statement Django's ORM does.
 *
 * Why the same statement and not just the same filter: several listings have
 * no total order. Django drops `Meta.ordering` from a GROUP BY query, so an
 * unknown `sort`, or an exact SKU match, is answered in whatever order
 * PostgreSQL's plan yields; `price_desc` orders by one column and leaves ties
 * to the plan. The only way to give the same page is to ask PostgreSQL the
 * same question, joins and aliases included.
 *
 * The ORM's rules this reproduces, each observed in Django's own SQL:
 * - Every `filter()` over a multi-valued relation gets fresh joins; the first
 *   use of a table is named after it, later ones `T<n>` where n counts every
 *   alias so far -- including a join the ORM created and then trimmed.
 * - `MIN/MAX(variants__price)` reuse the *last* variant join an attribute
 *   filter made (so they range over the matching variants only), else add a
 *   LEFT OUTER JOIN of their own.
 * - `select_related` joins come last, reusing a join a filter already made.
 */

export const SORTS: Record<string, string | null> = {
  relevance: null,
  newest: '"catalog_product"."created_at" DESC',
  price_asc: '20 ASC',
  price_desc: '21 DESC',
  name_asc: '"catalog_product"."name" ASC',
  name_desc: '"catalog_product"."name" DESC',
};

export interface SearchFilters {
  query?: string;
  categorySlug?: string;
  brandSlugs?: string[];
  /** Numeric literals Python's `Decimal` accepted; null for "no bound". */
  priceMin?: string | null;
  priceMax?: string | null;
  /** `attr_<code>` filters, in the order the query string first names them. */
  attributeFilters?: [string, string[]][];
  inStockOnly?: boolean;
  branchId?: string | null;
  sort?: string;
}

export interface ListedProduct {
  id: string;
  createdAt: string;
  name: string;
  slug: string;
  shortDescription: string;
  description: string;
  material: string;
  careInstructions: string;
  featured: boolean;
  seoTitle: string;
  seoDescription: string;
  sizeChartId: string | null;
  category: { id: string; name: string; slug: string; taxRate: string | null };
  brand: { id: string; name: string; slug: string } | null;
}

interface Join {
  table: string;
  alias: string;
  kind: 'INNER' | 'LEFT OUTER';
  on: string;
  rendered: boolean;
}

/** The ORM's alias map, as far as these queries need it. */
class JoinPlan {
  private count = 1; // "catalog_product"
  private readonly used = new Set<string>(['catalog_product']);
  readonly joins: Join[] = [];

  add(table: string, kind: Join['kind'], on: (alias: string) => string, rendered = true): Join {
    this.count += 1;
    const alias = this.used.has(table) ? `T${this.count}` : ident(table);
    this.used.add(table);
    const join = { table, alias, kind, on: on(alias), rendered };
    this.joins.push(join);
    return join;
  }

  clone(): JoinPlan {
    const copy = new JoinPlan();
    copy.count = this.count;
    for (const table of this.used) copy.used.add(table);
    copy.joins.push(...this.joins.map((join) => ({ ...join })));
    return copy;
  }

  render(): string {
    return this.joins
      .filter((join) => join.rendered)
      .map(
        (join) =>
          ` ${join.kind} JOIN ${join.table === join.alias.replaceAll('"', '') ? ident(join.table) : `${ident(join.table)} ${join.alias}`} ON (${join.on})`,
      )
      .join('');
  }
}

const P = '"catalog_product"';

/** A prepared search: count it, then fetch a page of it. */
export interface ProductSearch {
  count(): Promise<number>;
  page(offset: number, limit: number): Promise<ListedProduct[]>;
  /** Every matching id, for facets (`values_list("id", flat=True)`). */
  ids(): Promise<string[]>;
}

const EMPTY: ProductSearch = {
  count: async () => 0,
  page: async () => [],
  ids: async () => [],
};

@Injectable()
export class ProductSearchService {
  constructor(private readonly db: Database) {}

  async search(filters: SearchFilters): Promise<ProductSearch> {
    const params = new Params();
    const plan = new JoinPlan();
    const where: string[] = [`${P}."published"`, `${P}."status" = ${params.add('ACTIVE')}`];
    let categoryJoin: Join | null = null;
    let brandJoin: Join | null = null;

    if (filters.categorySlug) {
      const category = await this.db.one<{ id: string }>(
        `SELECT id FROM catalog_category WHERE slug = $1 AND is_active
          ORDER BY position ASC, name ASC LIMIT 1`,
        [filters.categorySlug],
      );
      if (!category) return EMPTY;
      const ids = await this.descendantIds(category.id);
      // `category_id__in` resolves the relation and then trims the join: it
      // renders nothing yet, but it takes an alias number and a place, and
      // `select_related` later reuses it.
      categoryJoin = plan.add(
        'catalog_category',
        'INNER',
        (alias) => `${P}."category_id" = ${alias}."id"`,
        false,
      );
      where.push(`${P}."category_id" IN ${params.list(ids, 'uuid')}`);
    }

    if (filters.brandSlugs && filters.brandSlugs.length) {
      brandJoin = plan.add('catalog_brand', 'INNER', (alias) => `${P}."brand_id" = ${alias}."id"`);
      where.push(`${brandJoin.alias}."slug" IN ${params.list(filters.brandSlugs)}`);
    }

    let lastVariant: Join | null = null;
    for (const [code, values] of filters.attributeFilters ?? []) {
      if (!values.length) continue;
      const variant = plan.add(
        'catalog_productvariant',
        'INNER',
        (alias) => `${P}."id" = ${alias}."product_id"`,
      );
      const link = plan.add(
        'catalog_variantattributevalue',
        'INNER',
        (alias) => `${variant.alias}."id" = ${alias}."variant_id"`,
      );
      const attribute = plan.add(
        'catalog_attribute',
        'INNER',
        (alias) => `${link.alias}."attribute_id" = ${alias}."id"`,
      );
      const value = plan.add(
        'catalog_attributevalue',
        'INNER',
        (alias) => `${link.alias}."attribute_value_id" = ${alias}."id"`,
      );
      where.push(`${attribute.alias}."code" = ${params.add(code)}`);
      where.push(`${value.alias}."value" IN ${params.list(values)}`);
      lastVariant = variant;
    }

    const priceSource =
      lastVariant ??
      plan.add(
        'catalog_productvariant',
        'LEFT OUTER',
        (alias) => `${P}."id" = ${alias}."product_id"`,
      );
    const minPrice = `MIN(${priceSource.alias}."price")`;
    const maxPrice = `MAX(${priceSource.alias}."price")`;

    // `DecimalField.to_python` refuses a non-finite bound while the filter is
    // built: a 400 on `price_min=NaN`, never a query.
    for (const bound of [filters.priceMin, filters.priceMax]) {
      if (bound != null && !isFiniteDecimal(bound)) {
        throw new ValidationError(undefined, {
          details: { non_field_errors: [`\u201c${bound}\u201d value must be a decimal number.`] },
        });
      }
    }

    const having: string[] = [];
    if (filters.priceMin != null)
      having.push(`${minPrice} >= ${params.add(filters.priceMin, 'numeric')}`);
    if (filters.priceMax != null)
      having.push(`${minPrice} <= ${params.add(filters.priceMax, 'numeric')}`);

    if (filters.inStockOnly) {
      const variant = plan.add(
        'catalog_productvariant',
        'INNER',
        (alias) => `${P}."id" = ${alias}."product_id"`,
      );
      const stock = plan.add(
        'inventory_inventory',
        'INNER',
        (alias) => `${variant.alias}."id" = ${alias}."variant_id"`,
      );
      where.push(`${stock.alias}."on_hand" > (${stock.alias}."reserved")`);
      if (filters.branchId)
        where.push(`${stock.alias}."branch_id" = ${params.add(filters.branchId, 'uuid')}`);
    }

    let rank: string | null = null;
    let orderBy: string | null;
    const sort = filters.sort ?? 'relevance';
    let finalPlan = plan;
    let finalWhere = where;
    let finalParams = params;
    let exactMatch = false;

    const query = filters.query ?? '';
    if (query) {
      const cleaned = query.trim();
      // Exact SKU/barcode wins outright -- scanning must never be fuzzy.
      const exactPlan = plan.clone();
      const exactParams = new Params();
      exactParams.values.push(...params.values);
      const sku = exactPlan.add(
        'catalog_productvariant',
        'INNER',
        (alias) => `${P}."id" = ${alias}."product_id"`,
      );
      const exactWhere = [
        ...where,
        `(UPPER(${sku.alias}."sku"::text) = UPPER(${exactParams.add(cleaned)}) OR ${sku.alias}."barcode" = ${exactParams.add(cleaned)})`,
      ];
      const exists = await this.db.arrays(
        `SELECT 1 FROM ${P}${exactPlan.render()} WHERE (${exactWhere.join(' AND ')})
          GROUP BY ${P}."id"${having.length ? ` HAVING ${having.join(' AND ')}` : ''} LIMIT 1`,
        exactParams.values,
      );
      if (exists.length) {
        finalPlan = exactPlan;
        finalWhere = exactWhere;
        finalParams = exactParams;
        exactMatch = true;
      } else {
        const brandForRank =
          brandJoin ??
          plan.add('catalog_brand', 'LEFT OUTER', (alias) => `${P}."brand_id" = ${alias}."id"`);
        brandJoin = brandForRank;
        const q = params.add(cleaned);
        rank =
          `ts_rank((((setweight(to_tsvector(COALESCE(${P}."name", '')), 'A') || ` +
          `setweight(to_tsvector(COALESCE(${P}."short_description", '')), 'B')) || ` +
          `setweight(to_tsvector(COALESCE(${brandForRank.alias}."name", '')), 'B')) || ` +
          `setweight(to_tsvector(COALESCE(${P}."description", '')), 'C')), websearch_to_tsquery(${q}))`;
        where.push(`(${rank} > ${params.add('0.01', 'float8')} OR ${P}."name" % ${q})`);
      }
    }

    if (exactMatch) {
      // `exact.distinct()` straight back: no ordering at all.
      orderBy = null;
    } else if (rank && sort === 'relevance') {
      orderBy = '22 DESC';
    } else if (Object.hasOwn(SORTS, sort) && SORTS[sort]) {
      // Own keys only: `?sort=constructor` must not find Object.prototype's.
      orderBy = SORTS[sort] as string;
    } else if (sort === 'relevance' && !query) {
      orderBy = `${P}."featured" DESC, ${P}."created_at" DESC`;
    } else {
      // An unknown sort keeps whatever the search set (-rank), else nothing.
      orderBy = rank ? '22 DESC' : null;
    }

    // Snapshot for the count, which Django runs without select_related.
    const countJoins = finalPlan.render();

    // select_related("brand", "category"): reuse, else join -- category first.
    const category =
      categoryJoin && finalPlan.joins.find((join) => join.alias === categoryJoin!.alias);
    let categoryAlias: string;
    if (category) {
      category.rendered = true;
      categoryAlias = category.alias;
    } else {
      categoryAlias = finalPlan.add(
        'catalog_category',
        'INNER',
        (alias) => `${P}."category_id" = ${alias}."id"`,
      ).alias;
    }
    const brandAlias =
      (brandJoin && finalPlan.joins.find((join) => join.alias === brandJoin!.alias)?.alias) ??
      finalPlan.add('catalog_brand', 'LEFT OUTER', (alias) => `${P}."brand_id" = ${alias}."id"`)
        .alias;

    const whereSql = `(${finalWhere.join(' AND ')})`;
    const havingSql = having.length
      ? ` HAVING ${having.length > 1 ? `(${having.join(' AND ')})` : having[0]}`
      : '';
    const rankSelect = rank ? `, ${rank} AS "rank"` : '';
    const productCols = columns(P, PRODUCT_COLUMNS);
    const values = finalParams.values;
    const db = this.db;

    // The count's inner statement, as Django writes it; also the id list facets read.
    const groupedSql =
      `SELECT DISTINCT ` +
      PRODUCT_COLUMNS.map((name, index) => `${P}.${ident(name)} AS "col${index + 1}"`).join(', ') +
      `, ${minPrice} AS "min_price", ${maxPrice} AS "max_price"${rankSelect}` +
      ` FROM ${P}${countJoins} WHERE ${whereSql} GROUP BY 1${rank ? ', 22' : ''}${havingSql}`;

    const selectSql =
      `SELECT DISTINCT ${productCols}, ${minPrice} AS "min_price", ${maxPrice} AS "max_price"${rankSelect}, ` +
      `${columns(categoryAlias, CATEGORY_COLUMNS)}, ${columns(brandAlias, BRAND_COLUMNS)}` +
      ` FROM ${P}${finalPlan.render()} WHERE ${whereSql}` +
      ` GROUP BY ${P}."id"${rank ? ', 22' : ''}, ${categoryAlias}."id", ${brandAlias}."id"${havingSql}` +
      (orderBy ? ` ORDER BY ${orderBy}` : '');

    const categoryStart = PRODUCT_COLUMNS.length + 2 + (rank ? 1 : 0);
    const brandStart = categoryStart + CATEGORY_COLUMNS.length;

    return {
      async count() {
        const row = await db.one<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM (${groupedSql}) subquery`,
          values,
        );
        return row?.count ?? 0;
      },
      async page(offset, limit) {
        if (limit <= 0) return [];
        const rows = await db.arrays(
          `${selectSql} LIMIT ${Number(limit)}${offset > 0 ? ` OFFSET ${Number(offset)}` : ''}`,
          values,
        );
        return rows.map((row) => toListed(row, categoryStart, brandStart));
      },
      async ids() {
        const rows = await db.arrays(`SELECT "col1" FROM (${groupedSql}) subquery`, values);
        return rows.map((row) => row[0] as string);
      },
    };
  }

  /** `Category.descendant_ids()`: self, then every level of children, active or not. */
  async descendantIds(rootId: string): Promise<string[]> {
    const ids = [rootId];
    let frontier = [rootId];
    while (frontier.length) {
      const params = new Params();
      const rows = await this.db.query<{ id: string }>(
        `SELECT id FROM catalog_category WHERE parent_id IN ${params.list(frontier, 'uuid')}`,
        params.values,
      );
      frontier = rows.map((row) => row.id);
      ids.push(...frontier);
    }
    return ids;
  }
}

function toListed(row: unknown[], categoryStart: number, brandStart: number): ListedProduct {
  const product = pick(row, PRODUCT_COLUMNS, 0);
  const category = pick(row, CATEGORY_COLUMNS, categoryStart);
  const brand = pick(row, BRAND_COLUMNS, brandStart);
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
