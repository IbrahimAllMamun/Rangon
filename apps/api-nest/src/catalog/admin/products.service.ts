import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { RolePermissions } from '../../auth/permissions';
import { AuditActor, AuditContext, recordAudit } from '../../common/audit';
import { Dec } from '../../common/decimal';
import {
  booleanField,
  charField,
  choiceField,
  decimalField,
  dictField,
  errorMessages,
  Fields,
  Invalid,
  InvalidFields,
  listField,
  pkRelatedField,
  runSerializer,
  slugField,
  uuidField,
  withDefault,
} from '../../common/drf';
import { Conflict, NotFound, ValidationError } from '../../common/errors';
import {
  applyFilters,
  booleanFilter,
  choiceFilter,
  modelFilter,
  orderingFrom,
} from '../../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../../common/pagination';
import { compareCodePoints, pyRepr, pyStrip } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { uniqueSlug } from '../../common/slugs';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { AvailabilityService } from '../../inventory/availability.service';
import { Revalidation } from '../../jobs/revalidation';
import {
  CataloguePayloads,
  PRODUCT_COLUMNS,
  type ProductRow,
  type StockContext,
  type VariantRow,
} from './catalogue-payloads';
import { refuseIfReferenced } from './deletion';
import { createVariant, type ValueRef } from './variant-writes';

/**
 * `catalog.api.views.ProductViewSet`: the admin's product list, form and
 * actions -- generating SKUs, publishing, archiving. Paginated (25, up to
 * 100), newest first with the key breaking ties, so pages never overlap.
 */

const P = '"catalog_product"';
const STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

const FILTERS = [
  choiceFilter('status', `${P}."status"`, STATUSES),
  booleanFilter('published', `${P}."published"`),
  booleanFilter('featured', `${P}."featured"`),
  modelFilter('category', `${P}."category_id"`, 'catalog_category'),
  modelFilter('brand', `${P}."brand_id"`, 'catalog_brand'),
];
const ORDERING = { name: `${P}."name"`, created_at: `${P}."created_at"` };

const SELECT = `${PRODUCT_COLUMNS.map((column) => `${P}."${column}"`).join(', ')},
  MIN("catalog_productvariant"."price") AS "min_price", MAX("catalog_productvariant"."price") AS "max_price",
  "catalog_category"."name" AS "category_name", "catalog_brand"."name" AS "brand_name"`;
const FROM = `FROM ${P}
  LEFT OUTER JOIN "catalog_productvariant" ON (${P}."id" = "catalog_productvariant"."product_id")
  INNER JOIN "catalog_category" ON (${P}."category_id" = "catalog_category"."id")
  LEFT OUTER JOIN "catalog_brand" ON (${P}."brand_id" = "catalog_brand"."id")`;
const GROUP = `GROUP BY ${P}."id", "catalog_category"."id", "catalog_brand"."id"`;

/** Django's `prep_for_like_query`: a literal inside `LIKE '%...%'`. */
function likeContains(text: string): string {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

type ProductData = Partial<{
  name: string;
  slug: string;
  category: string;
  brand: string | null;
  short_description: string;
  description: string;
  material: string;
  care_instructions: string;
  status: string;
  published: boolean;
  featured: boolean;
  is_final_sale: boolean;
  seo_title: string;
  seo_description: string;
  spec_values: string[];
  size_chart: string | null;
}>;

@Injectable()
export class ProductsService {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    private readonly availability: AvailabilityService,
    private readonly permissions: RolePermissions,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `filter_queryset(get_queryset())` as WHERE conditions, in Django's order of work. */
  private async conditions(query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    if (query.get('never_ordered') === 'true') {
      where.push(`${P}."status" = ${sql.add('DRAFT')}`);
      where.push(
        `NOT EXISTS (SELECT 1 FROM "catalog_productvariant" U1
           INNER JOIN "purchasing_purchaseorderitem" U2 ON (U1."id" = U2."variant_id")
          WHERE U1."product_id" = ${P}."id")`,
      );
    }
    const search = pyStrip(query.get('search') ?? '');
    if (search) where.push(await this.searchCondition(search, sql));
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  /**
   * What the storefront search finds (an exact SKU or barcode outright, else
   * ranked full text or a similar name -- over every product, not only the
   * published ones), or any product whose name or SKU contains the text, or
   * whose barcode it is.
   */
  private async searchCondition(search: string, sql: SqlParams): Promise<string> {
    const exact = await this.db.one(
      `SELECT 1 AS "a" FROM ${P}
         INNER JOIN "catalog_productvariant" T3 ON (${P}."id" = T3."product_id")
        WHERE (UPPER(T3."sku"::text) = UPPER($1) OR T3."barcode" = $1) LIMIT 1`,
      [search],
    );
    const term = sql.add(search);
    const ranked = exact
      ? `SELECT DISTINCT U0."id" FROM ${P} U0 INNER JOIN "catalog_productvariant" U3 ON (U0."id" = U3."product_id")
          WHERE (UPPER(U3."sku"::text) = UPPER(${term}) OR U3."barcode" = ${term})`
      : `SELECT U0."id" FROM ${P} U0 LEFT OUTER JOIN "catalog_brand" U2 ON (U0."brand_id" = U2."id")
          WHERE (ts_rank((((setweight(to_tsvector(COALESCE(U0."name", '')), 'A') ||
                 setweight(to_tsvector(COALESCE(U0."short_description", '')), 'B')) ||
                 setweight(to_tsvector(COALESCE(U2."name", '')), 'B')) ||
                 setweight(to_tsvector(COALESCE(U0."description", '')), 'C')), websearch_to_tsquery(${term}))
                 > ${sql.add('0.01', 'float8')} OR U0."name" % ${term})`;
    const like = sql.add(likeContains(search));
    const fragments = `SELECT U0."id" FROM ${P} U0
        LEFT OUTER JOIN "catalog_productvariant" U1 ON (U0."id" = U1."product_id")
       WHERE (UPPER(U0."name"::text) LIKE UPPER(${like}) OR UPPER(U1."sku"::text) LIKE UPPER(${like})
              OR U1."barcode" = ${term})`;
    return `(${P}."id" IN (${ranked}) OR ${P}."id" IN (${fragments}))`;
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [`${P}."created_at" DESC`, `${P}."id" ASC`];
    const pageSize = pageSizeFrom(query, STANDARD_PAGINATION);
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM (SELECT ${P}."id" AS "col1" ${FROM} ${whereSql} GROUP BY 1) subquery`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSize);
    const rows = await this.db.query<ProductRow>(
      `SELECT ${SELECT} ${FROM} ${whereSql} ${GROUP} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    const parts = await this.payloads.parts(rows.map((row) => row.id));
    return paginated(
      page,
      rows.map((row) => this.payloads.listItem(row, parts)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the whole filtered queryset, then the key (`get()` drops the ordering). */
  async find(pk: string, query: QueryDict): Promise<ProductRow> {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${P}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<ProductRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} ${GROUP} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  /** A product as `ProductDetailSerializer` reads it, with or without the stock context. */
  async detail(
    product: ProductRow,
    context: StockContext | null,
  ): Promise<Record<string, unknown>> {
    const parts = await this.payloads.parts([product.id]);
    return this.payloads.detail(product, parts, context);
  }

  /**
   * `retrieve`'s serializer context: stock at the branch asked for (or the
   * user's), and which variants that branch has ever received at a cost.
   */
  async stockContext(
    product: ProductRow,
    user: RequestUser,
    branchParam: unknown,
  ): Promise<StockContext> {
    const branch = await this.permissions.resolveBranch(user, branchParam);
    const variants = (await this.payloads.variants([product.id])).variants.get(product.id) ?? [];
    const ids = variants.map((variant) => variant.id);
    const stock = await this.availability.availability(branch.id, ids);
    const received = new Set<string>();
    if (ids.length) {
      const sql = new SqlParams();
      const rows = await this.db.query<{ variant_id: string }>(
        `SELECT DISTINCT "inventory_inventorytransaction"."variant_id" FROM "inventory_inventorytransaction"
          WHERE ("inventory_inventorytransaction"."branch_id" = ${sql.add(branch.id, 'uuid')}
            AND "inventory_inventorytransaction"."transaction_type" IN ('PURCHASE', 'TRANSFER_IN')
            AND "inventory_inventorytransaction"."variant_id" IN ${sql.list(ids, 'uuid')})`,
        sql.values,
      );
      for (const row of rows) received.add(row.variant_id);
    }
    return { stock, received };
  }

  // --- The product form ---------------------------------------------------------

  /** `ProductWriteSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validate(
    data: unknown,
    instance: ProductRow | null,
    partial: boolean,
  ): Promise<ProductData> {
    const exists = (table: string) => async (id: string) =>
      (await this.db.one(`SELECT 1 FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !== null;
    const fields: Fields = {
      name: charField({ maxLength: 200 }),
      slug: slugField({
        maxLength: 220,
        required: false,
        unique: {
          message: 'product with this slug already exists.',
          exists: async (value) =>
            (await this.db.one(
              `SELECT 1 AS "a" FROM ${P} WHERE (${P}."slug" = $1${instance ? ` AND NOT (${P}."id" = $2)` : ''}) LIMIT 1`,
              instance ? [value, instance.id] : [value],
            )) !== null,
        },
      }),
      category: pkRelatedField(exists('catalog_category')),
      brand: pkRelatedField(exists('catalog_brand'), { required: false, allowNull: true }),
      short_description: charField({ allowBlank: true, maxLength: 320, required: false }),
      description: charField({ allowBlank: true, required: false }),
      material: charField({ allowBlank: true, maxLength: 120, required: false }),
      care_instructions: charField({ allowBlank: true, required: false }),
      status: choiceField(STATUSES, { required: false }),
      published: booleanField({ required: false }),
      featured: booleanField({ required: false }),
      is_final_sale: booleanField({ required: false }),
      seo_title: charField({ allowBlank: true, maxLength: 200, required: false }),
      seo_description: charField({ allowBlank: true, maxLength: 320, required: false }),
      spec_values: listField(uuidField(), { required: false }),
      size_chart: pkRelatedField(exists('catalog_sizechart'), { required: false, allowNull: true }),
    };
    const result = await runSerializer<ProductData>(fields, data, {
      partial,
      hooks: { spec_values: (value: string[]) => this.checkSpecs(value) },
      validate: async (attrs) => {
        // On an update too: a rename without a slug is given a fresh one (D120).
        if (!attrs.slug && attrs.name) {
          attrs.slug = await uniqueSlug(this.db, 'catalog_product', 'product', attrs.name, 220);
        }
        if (attrs.published && attrs.status === 'DRAFT') {
          throw new InvalidFields({
            published: [
              {
                message: 'A draft product cannot be published. Set status to ACTIVE first.',
                code: 'invalid',
              },
            ],
          });
        }
        await this.checkSizeChart(attrs, instance);
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `validate_spec_values`: every id still there, none of them a variant axis. */
  private async checkSpecs(value: string[]): Promise<string[]> {
    const rows = value.length
      ? await this.db.query<{ id: string; name: string; is_variant_defining: boolean }>(
          `SELECT v."id", a."name", a."is_variant_defining" FROM "catalog_attributevalue" v
             INNER JOIN "catalog_attribute" a ON (v."attribute_id" = a."id") WHERE v."id" = ANY($1::uuid[])`,
          [value],
        )
      : [];
    const found = new Map(rows.map((row) => [row.id, row]));
    if (value.some((id) => !found.has(id)))
      throw Invalid.of('Those specification values no longer exist. Reload the form.');
    const axes = [
      ...new Set(rows.filter((row) => row.is_variant_defining).map((row) => row.name)),
    ].sort(compareCodePoints);
    if (axes.length) {
      throw Invalid.of(
        `${axes.join(', ')} build separate SKUs, so ${axes.length > 1 ? 'they' : 'it'} cannot also be ` +
          'stated as a specification. Pick the values in the variant matrix instead.',
      );
    }
    return value;
  }

  /** The attribute ids a category offers, inherited down the tree (`category_attributes`). */
  private async offered(categoryId: string, q: Queryable = this.db): Promise<Set<string>> {
    const chain: string[] = [];
    let current: string | null = categoryId;
    while (current !== null) {
      chain.push(current);
      const row: { parent_id: string | null } | null = await q.one(
        `SELECT "parent_id" FROM "catalog_category" WHERE "id" = $1`,
        [current],
      );
      current = row?.parent_id ?? null;
    }
    const links = await q.query<{ attribute_id: string }>(
      `SELECT DISTINCT "attribute_id" FROM "catalog_categoryattribute" WHERE "category_id" = ANY($1::uuid[])`,
      [chain],
    );
    return new Set(links.map((link) => link.attribute_id));
  }

  /** `size_chart_problem`: why this chart cannot describe a product in this category. */
  async chartProblem(
    chartId: string,
    categoryId: string,
    productId: string | null,
    q: Queryable = this.db,
  ): Promise<string | null> {
    const chart = (await q.one<{ name: string; attribute_id: string; attribute_name: string }>(
      `SELECT c."name", c."attribute_id", a."name" AS "attribute_name" FROM "catalog_sizechart" c
         INNER JOIN "catalog_attribute" a ON (c."attribute_id" = a."id") WHERE c."id" = $1`,
      [chartId],
    )) as { name: string; attribute_id: string; attribute_name: string };
    const offered = await this.offered(categoryId, q);
    if (!offered.size || offered.has(chart.attribute_id)) return null;
    if (productId) {
      const built = await q.one(
        `SELECT 1 AS "a" FROM "catalog_variantattributevalue" l
           INNER JOIN "catalog_productvariant" v ON (l."variant_id" = v."id")
          WHERE (v."product_id" = $1 AND l."attribute_id" = $2) LIMIT 1`,
        [productId, chart.attribute_id],
      );
      if (built) return null;
    }
    const category = await q.one<{ name: string }>(
      `SELECT "name" FROM "catalog_category" WHERE "id" = $1`,
      [categoryId],
    );
    return (
      `“${chart.name}” is a ${chart.attribute_name} chart, and ${category?.name ?? ''} does not use ` +
      `${chart.attribute_name}. Pick a chart for one of this product's sizes.`
    );
  }

  /** `_check_size_chart`: only when the chart or the category is what is changing. */
  private async checkSizeChart(attrs: ProductData, product: ProductRow | null): Promise<void> {
    const categoryMoves =
      attrs.category !== undefined && (product === null || attrs.category !== product.category_id);
    if (attrs.size_chart === undefined && !categoryMoves) return;
    const chart =
      attrs.size_chart !== undefined ? attrs.size_chart : (product?.size_chart_id ?? null);
    const category = attrs.category ?? product?.category_id ?? null;
    if (chart === null || category === null) return;
    const problem = await this.chartProblem(chart, category, product?.id ?? null);
    if (problem) {
      throw new InvalidFields({ size_chart: [{ message: problem, code: 'invalid' }] });
    }
  }

  /** `set_product_specs`: replace the product's specifications with exactly these values. */
  private async setSpecs(
    productId: string,
    valueIds: string[],
    actor: AuditActor,
    context: AuditContext,
    productLabel: string,
  ): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      const wanted = [...new Set(valueIds)];
      const values = new Map(
        (
          await tx.query<{ id: string; text: string; is_variant_defining: boolean; name: string }>(
            `SELECT v."id", a."name" || ': ' || COALESCE(NULLIF(v."label", ''), v."value") AS "text",
                    a."is_variant_defining", a."name"
               FROM "catalog_attributevalue" v INNER JOIN "catalog_attribute" a ON (v."attribute_id" = a."id")
              WHERE v."id" = ANY($1::uuid[])`,
            [wanted],
          )
        ).map((row) => [row.id, row]),
      );
      const missing = wanted.filter((id) => !values.has(id));
      if (missing.length) {
        throw new ValidationError('Those specification values no longer exist.', {
          details: { spec_values: missing },
        });
      }
      const axes = [
        ...new Set(
          wanted
            .map((id) => values.get(id))
            .filter((row) => row?.is_variant_defining)
            .map((row) => row?.name as string),
        ),
      ].sort(compareCodePoints);
      if (axes.length) {
        throw new ValidationError(
          `${axes.join(', ')} build separate SKUs, so ${axes.length > 1 ? 'they' : 'it'} cannot also be ` +
            'stated as a specification. Pick the values in the variant matrix instead.',
          { details: { spec_values: axes } },
        );
      }
      const existing = await tx.query<{ id: string; attribute_value_id: string; text: string }>(
        `SELECT p."id", p."attribute_value_id", a."name" || ': ' || COALESCE(NULLIF(v."label", ''), v."value") AS "text"
           FROM "catalog_productattributevalue" p
           INNER JOIN "catalog_attributevalue" v ON (p."attribute_value_id" = v."id")
           INNER JOIN "catalog_attribute" a ON (v."attribute_id" = a."id")
          WHERE p."product_id" = $1
          ORDER BY a."position" ASC, a."name" ASC, v."position" ASC, v."value" ASC`,
        [productId],
      );
      const have = new Map(existing.map((row) => [row.attribute_value_id, row]));
      const removed = existing.filter((row) => !wanted.includes(row.attribute_value_id));
      const added = wanted.filter((id) => !have.has(id));
      if (removed.length) {
        await tx.query(`DELETE FROM "catalog_productattributevalue" WHERE "id" = ANY($1::uuid[])`, [
          removed.map((row) => row.id),
        ]);
      }
      for (const id of added) {
        await tx.query(
          `INSERT INTO "catalog_productattributevalue" ("id", "created_at", "updated_at", "product_id", "attribute_value_id")
           VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3)`,
          [randomUUID(), productId, id],
        );
      }
      if (added.length || removed.length) {
        await recordAudit(tx, context, {
          action: 'UPDATE',
          entity: { type: 'Product', id: productId, label: productLabel },
          actor,
          oldValues: { specs: existing.map((row) => row.text).sort(compareCodePoints) },
          newValues: {
            specs: wanted.map((id) => values.get(id)?.text as string).sort(compareCodePoints),
          },
          reason: 'Specification attributes changed',
        });
      }
    });
  }

  /** `set_product_size_chart`: point the product at a chart, or clear it. */
  private async setSizeChart(
    product: { id: string; name: string; category_id: string; size_chart_id: string | null },
    chartId: string | null,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<string | null> {
    return this.db.transaction(async (tx: Queryable) => {
      if (chartId !== null) {
        const problem = await this.chartProblem(chartId, product.category_id, product.id, tx);
        if (problem) throw new ValidationError(problem, { details: { size_chart: [problem] } });
      }
      if (product.size_chart_id === chartId) return chartId;
      const name = async (id: string | null) =>
        id === null
          ? null
          : ((
              await tx.one<{ name: string }>(
                `SELECT "name" FROM "catalog_sizechart" WHERE "id" = $1`,
                [id],
              )
            )?.name ?? null);
      const before = await name(product.size_chart_id);
      await tx.query(
        `UPDATE ${P} SET "size_chart_id" = $2, "updated_at" = clock_timestamp() WHERE ${P}."id" = $1`,
        [product.id, chartId],
      );
      await recordAudit(tx, context, {
        action: 'UPDATE',
        entity: { type: 'Product', id: product.id, label: product.name },
        actor,
        oldValues: { size_chart: before },
        newValues: { size_chart: await name(chartId) },
        reason: 'Size chart changed',
      });
      return chartId;
    });
  }

  /** `ProductWriteSerializer(product).data`: the form's own fields, as saved. */
  writePayload(product: ProductRow): Record<string, unknown> {
    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      category: product.category_id,
      brand: product.brand_id,
      short_description: product.short_description,
      description: product.description,
      material: product.material,
      care_instructions: product.care_instructions,
      status: product.status,
      published: product.published,
      featured: product.featured,
      is_final_sale: product.is_final_sale,
      seo_title: product.seo_title,
      seo_description: product.seo_description,
      size_chart: product.size_chart_id,
    };
  }

  private async categoryName(id: string): Promise<string> {
    return (
      (
        await this.db.one<{ name: string }>(
          `SELECT "name" FROM "catalog_category" WHERE "id" = $1`,
          [id],
        )
      )?.name ?? ''
    );
  }

  /**
   * `perform_create`: the product, then its specifications and size chart
   * through their services (each audited if it changed anything), then the
   * product's own audit entry.
   */
  async create(data: ProductData, actor: AuditActor, context: AuditContext): Promise<ProductRow> {
    const { spec_values: specs, size_chart: chart, ...fields } = data;
    const row = {
      id: randomUUID(),
      created_at: '',
      name: fields.name as string,
      slug: fields.slug ?? '',
      category_id: fields.category as string,
      brand_id: fields.brand ?? null,
      short_description: fields.short_description ?? '',
      description: fields.description ?? '',
      material: fields.material ?? '',
      care_instructions: fields.care_instructions ?? '',
      status: fields.status ?? 'DRAFT',
      published: fields.published ?? false,
      featured: fields.featured ?? false,
      is_final_sale: fields.is_final_sale ?? false,
      size_chart_id: null as string | null,
      seo_title: fields.seo_title ?? '',
      seo_description: fields.seo_description ?? '',
      created_by_id: actor.id,
      category_name: '',
      brand_name: null,
    } satisfies ProductRow;
    if (!row.slug)
      row.slug = await uniqueSlug(this.db, 'catalog_product', 'product', row.name, 220);
    await this.db.query(
      `INSERT INTO ${P} ("updated_at", ${PRODUCT_COLUMNS.map((column) => `"${column}"`).join(', ')})
       VALUES (clock_timestamp(), $1, clock_timestamp(), ${PRODUCT_COLUMNS.slice(2)
         .map((_, index) => `$${index + 2}`)
         .join(', ')})`,
      [row.id, ...PRODUCT_COLUMNS.slice(2).map((column) => row[column])],
    );
    if (specs !== undefined) await this.setSpecs(row.id, specs, actor, context, row.name);
    if (chart !== undefined)
      row.size_chart_id = await this.setSizeChart(row, chart, actor, context);
    await recordAudit(this.db, context, {
      action: 'CREATE',
      entity: { type: 'Product', id: row.id, label: row.name },
      actor,
      newValues: { name: row.name, category: await this.categoryName(row.category_id) },
    });
    return row;
  }

  /** `perform_update`: every column written back, specs and chart, an audit entry if the status fields moved. */
  async update(
    instance: ProductRow,
    data: ProductData,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<ProductRow> {
    const { spec_values: specs, size_chart: chart, category, brand, ...fields } = data;
    const row: ProductRow = { ...instance, ...fields };
    if (category !== undefined) row.category_id = category;
    if (brand !== undefined) row.brand_id = brand;
    if (!row.slug)
      row.slug = await uniqueSlug(this.db, 'catalog_product', 'product', row.name, 220);
    const columns = PRODUCT_COLUMNS.filter((column) => column !== 'id' && column !== 'created_at');
    await this.db.query(
      `UPDATE ${P} SET "updated_at" = clock_timestamp(), ${columns
        .map((column, index) => `"${column}" = $${index + 2}`)
        .join(', ')} WHERE ${P}."id" = $1`,
      [row.id, ...columns.map((column) => row[column])],
    );
    if (specs !== undefined) await this.setSpecs(row.id, specs, actor, context, row.name);
    if (chart !== undefined)
      row.size_chart_id = await this.setSizeChart(row, chart, actor, context);
    const tracked = ['name', 'status', 'published', 'featured'] as const;
    const changed = tracked.filter((key) => instance[key] !== row[key]);
    if (changed.length) {
      await recordAudit(this.db, context, {
        action: 'UPDATE',
        entity: { type: 'Product', id: row.id, label: row.name },
        actor,
        oldValues: Object.fromEntries(changed.map((key) => [key, instance[key]])),
        newValues: Object.fromEntries(changed.map((key) => [key, row[key]])),
      });
    }
    return row;
  }

  /**
   * `perform_destroy`: a product ever sold or stocked is archived, not
   * deleted; any other goes, with its variants, images, specifications and
   * whatever only pointed at it -- unless a count sheet, a transfer or a
   * purchase order still names a variant (`PROTECT`: 409). The audit entry
   * is written first, outside the delete, as Django writes it.
   */
  async destroy(product: ProductRow, actor: AuditActor, context: AuditContext): Promise<void> {
    const history = await this.db.one(
      `SELECT 1 AS "a" FROM "catalog_productvariant" v WHERE v."product_id" = $1 AND (
         EXISTS (SELECT 1 FROM "orders_orderitem" i WHERE i."variant_id" = v."id")
         OR EXISTS (SELECT 1 FROM "inventory_inventory" s WHERE s."variant_id" = v."id")
         OR EXISTS (SELECT 1 FROM "inventory_inventorytransaction" t WHERE t."variant_id" = v."id"))
       LIMIT 1`,
      [product.id],
    );
    const entity = { type: 'Product', id: product.id, label: product.name };
    if (history) {
      await this.db.query(
        `UPDATE ${P} SET "status" = 'ARCHIVED', "published" = false, "updated_at" = clock_timestamp()
          WHERE ${P}."id" = $1`,
        [product.id],
      );
      await recordAudit(this.db, context, {
        action: 'UPDATE',
        entity,
        actor,
        newValues: { status: 'ARCHIVED' },
        reason: 'Archived instead of deleted: the product has stock or sales history.',
      });
      return;
    }
    await recordAudit(this.db, context, {
      action: 'DELETE',
      entity,
      actor,
      oldValues: { name: product.name },
    });
    const carousel = await this.db.transaction(async (tx: Queryable) => {
      const variants = `(SELECT "id" FROM "catalog_productvariant" WHERE "product_id" = $1)`;
      await refuseIfReferenced(
        tx,
        [
          `SELECT 1 FROM "inventory_stockcountitem" WHERE "variant_id" IN ${variants} LIMIT 1`,
          `SELECT 1 FROM "inventory_stocktransferitem" WHERE "variant_id" IN ${variants} LIMIT 1`,
          `SELECT 1 FROM "purchasing_purchaseorderitem" WHERE "variant_id" IN ${variants} LIMIT 1`,
        ],
        product.id,
      );
      for (const statement of [
        `DELETE FROM "catalog_variantattributevalue" WHERE "variant_id" IN ${variants}`,
        `DELETE FROM "orders_cartitem" WHERE "variant_id" IN ${variants}`,
        `DELETE FROM "purchasing_supplierproduct" WHERE "variant_id" IN ${variants}`,
        `DELETE FROM "engagement_wishlistitem" WHERE "product_id" = $1 OR "variant_id" IN ${variants}`,
        `DELETE FROM "catalog_productvariant" WHERE "product_id" = $1`,
        `DELETE FROM "catalog_productimage" WHERE "product_id" = $1`,
        `DELETE FROM "catalog_productattributevalue" WHERE "product_id" = $1`,
        `DELETE FROM "engagement_review" WHERE "product_id" = $1`,
        `DELETE FROM "promotions_coupon_products" WHERE "product_id" = $1`,
      ]) {
        await tx.query(statement, [product.id]);
      }
      const removed = await tx.query(
        `DELETE FROM "content_homecarouselitem" WHERE "product_id" = $1 RETURNING "id"`,
        [product.id],
      );
      await tx.query(`DELETE FROM ${P} WHERE ${P}."id" = $1`, [product.id]);
      return removed.length;
    });
    // `content.signals`: each carousel entry removed asks for the homepage, once committed.
    for (let i = 0; i < carousel; i++) await this.revalidation.request('home');
  }

  // --- Actions ----------------------------------------------------------------------

  /** `GenerateVariantsSerializer(data).is_valid(raise_exception=True)`. */
  async validateGenerate(data: unknown): Promise<{
    selections: Record<string, string[]>;
    single: boolean;
    price: string;
    cost: string;
  }> {
    const fields: Fields = {
      selections: withDefault(dictField({ child: listField(charField()) }), () => ({})),
      single: withDefault(booleanField({ required: false }), () => false),
      price: decimalField(14, 2),
      cost: withDefault(decimalField(14, 2, { required: false }), () => '0.00'),
    };
    type Generate = {
      selections: Record<string, string[]>;
      single: boolean;
      price: string;
      cost: string;
    };
    const result = await runSerializer<Generate>(fields, data, {
      validate: (attrs) => {
        if (
          attrs.single &&
          Object.values(attrs.selections ?? {}).some((values) => values.length > 0)
        ) {
          throw new InvalidFields({
            selections: [
              { message: 'A single version has no sizes or colours to choose.', code: 'invalid' },
            ],
          });
        }
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  private async liveVariants(q: Queryable, productId: string) {
    return q.query<{ id: string; sku: string; links: number }>(
      `SELECT v."id", v."sku",
              (SELECT COUNT(*) FROM "catalog_variantattributevalue" l WHERE l."variant_id" = v."id")::int AS "links"
         FROM "catalog_productvariant" v INNER JOIN ${P} ON (v."product_id" = ${P}."id")
        WHERE v."product_id" = $1 AND NOT (v."status" = 'ARCHIVED')
        ORDER BY ${P}."created_at" DESC, v."position" ASC, v."sku" ASC`,
      [productId],
    );
  }

  /**
   * `generate_variants`: the cartesian product of the chosen values, skipping
   * combinations the product already has. All or nothing.
   */
  async generate(
    product: ProductRow,
    selections: Record<string, string[]>,
    price: string,
    cost: string,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<VariantRow[]> {
    return this.db.transaction(async (tx: Queryable) => {
      if (!Object.keys(selections).length)
        throw new ValidationError('Choose at least one attribute value.');
      const groups: ValueRef[][] = [];
      for (const [code, values] of Object.entries(selections)) {
        const attribute = await tx.one<{ id: string; name: string; is_variant_defining: boolean }>(
          `SELECT "id", "name", "is_variant_defining" FROM "catalog_attribute" WHERE "code" = $1
            ORDER BY "position" ASC, "name" ASC LIMIT 1`,
          [code],
        );
        if (!attribute) throw new ValidationError(`Unknown attribute ${pyRepr(code)}.`);
        const refuse = (message: string) =>
          new ValidationError(message, { details: { selections: [message] } });
        if (!attribute.is_variant_defining)
          throw refuse(`${attribute.name} is a specification, not a variant option.`);
        if (!values.length) throw refuse(`Choose at least one ${attribute.name} value.`);
        const options = await tx.query<ValueRef>(
          `SELECT v."id", v."attribute_id", v."value", v."label" FROM "catalog_attributevalue" v
             INNER JOIN "catalog_attribute" a ON (v."attribute_id" = a."id")
            WHERE (v."attribute_id" = $1 AND v."value" = ANY($2::text[]))
            ORDER BY a."position" ASC, a."name" ASC, v."position" ASC, v."value" ASC`,
          [attribute.id, values],
        );
        const known = new Set(options.map((option) => option.value));
        const unknown = [...new Set(values.filter((value) => !known.has(value)))].sort(
          compareCodePoints,
        );
        if (unknown.length) throw refuse(`${attribute.name} has no value ${unknown.join(', ')}.`);
        groups.push(options);
      }

      const existing = new Set(
        (
          await tx.query<{ signature: string }>(
            `SELECT COALESCE(string_agg(l."attribute_value_id"::text, ',' ORDER BY l."attribute_value_id"::text), '') AS "signature"
               FROM "catalog_productvariant" v
               LEFT JOIN "catalog_variantattributevalue" l ON (l."variant_id" = v."id")
              WHERE v."product_id" = $1 GROUP BY v."id"`,
            [product.id],
          )
        ).map((row) => row.signature),
      );
      const single = (await this.liveVariants(tx, product.id)).find(
        (variant) => variant.links === 0,
      );
      if (single) {
        throw new Conflict(
          `${product.name} is sold as one version (${single.sku}). Archive that SKU before giving ` +
            'it sizes or colours.',
          { details: { single_variant: single.id, sku: single.sku } },
        );
      }

      const created: VariantRow[] = [];
      let combinations: ValueRef[][] = [[]];
      for (const group of groups)
        combinations = combinations.flatMap((head) => group.map((value) => [...head, value]));
      for (const combination of combinations) {
        const signature = [...new Set(combination.map((value) => value.id))].sort().join(',');
        if (existing.has(signature)) continue;
        created.push(await createVariant(tx, product, combination, price, cost));
      }
      await recordAudit(tx, context, {
        action: 'CREATE',
        entity: { type: 'Product', id: product.id, label: product.name },
        actor,
        newValues: { variants_created: created.length },
        reason: 'Variant matrix generated',
      });
      return created;
    });
  }

  /**
   * `create_single_variant`: one SKU with no options, under the product's row
   * lock -- a retried submit finds the first and makes nothing.
   */
  async createSingle(
    product: ProductRow,
    price: string,
    cost: string,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<VariantRow[]> {
    return this.db.transaction(async (tx: Queryable) => {
      const locked = (await tx.one<{ id: string; name: string }>(
        `SELECT ${P}."id", ${P}."name" FROM ${P} WHERE ${P}."id" = $1 LIMIT 21 FOR UPDATE`,
        [product.id],
      )) as { id: string; name: string };
      const live = await this.liveVariants(tx, locked.id);
      if (live.some((variant) => variant.links === 0)) return [];
      if (live.length) {
        throw new Conflict(
          `${locked.name} already comes in ${live.length} version${live.length === 1 ? '' : 's'}. ` +
            'Add another size or colour instead.',
          { details: { variant_count: live.length } },
        );
      }
      const variant = await createVariant(tx, locked, [], price, cost);
      await recordAudit(tx, context, {
        action: 'CREATE',
        entity: { type: 'Product', id: locked.id, label: locked.name },
        actor,
        newValues: { variants_created: 1, sku: variant.sku },
        reason: 'Single-version SKU created',
      });
      return [variant];
    });
  }

  /** The variants `generate-variants` answers with: no stock context. */
  async variantPayloads(
    product: ProductRow,
    variants: VariantRow[],
  ): Promise<Record<string, unknown>[]> {
    const links = await this.payloads.links(variants.map((variant) => variant.id));
    return variants.map((variant) =>
      this.payloads.variant(
        variant,
        { name: product.name, brandName: product.brand_name },
        links,
        null,
      ),
    );
  }

  /** `publish_product`: only with something to sell, at a price above zero. */
  async publish(
    product: ProductRow,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<ProductRow> {
    return this.db.transaction(async (tx: Queryable) => {
      const prices = await tx.query<{ price: string }>(
        `SELECT "price" FROM "catalog_productvariant" WHERE ("product_id" = $1 AND "status" = 'ACTIVE')`,
        [product.id],
      );
      if (!prices.length)
        throw new ValidationError('A product needs at least one active variant before publishing.');
      if (!prices.some((row) => new Dec(row.price).gt(0))) {
        throw new ValidationError(
          'Every variant of this product is priced at zero, so publishing it would give the stock ' +
            'away. Set a retail price first.',
          { details: { product_id: product.id } },
        );
      }
      await tx.query(
        `UPDATE ${P} SET "published" = true, "status" = 'ACTIVE', "updated_at" = clock_timestamp()
          WHERE ${P}."id" = $1`,
        [product.id],
      );
      await recordAudit(tx, context, {
        action: 'UPDATE',
        entity: { type: 'Product', id: product.id, label: product.name },
        actor,
        newValues: { published: true },
      });
      return { ...product, published: true, status: 'ACTIVE' };
    });
  }

  async unpublish(product: ProductRow): Promise<ProductRow> {
    await this.db.query(
      `UPDATE ${P} SET "published" = false, "updated_at" = clock_timestamp() WHERE ${P}."id" = $1`,
      [product.id],
    );
    return { ...product, published: false };
  }
}
