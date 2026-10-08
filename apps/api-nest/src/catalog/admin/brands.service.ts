import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  booleanField,
  charField,
  errorMessages,
  Fields,
  imageField,
  runSerializer,
  slugField,
  UniqueCheck,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import { applyFilters, booleanFilter, orderingFrom } from '../../common/filtering';
import { mediaUrl } from '../../common/media';
import type { QueryDict } from '../../common/query-dict';
import { uniqueSlug } from '../../common/slugs';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { refuseIfReferenced } from './deletion';

/**
 * `catalog.api.views.BrandViewSet`: a plain `ModelViewSet` over `Brand`,
 * unpaginated, filtered by `is_active` and `is_featured`, ordered by `name`
 * unless `?ordering=` says otherwise. No audit entries and no signals.
 */

export interface BrandRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo: string | null;
  is_active: boolean;
  is_featured: boolean;
}

const COLUMNS = `"catalog_brand"."id", "catalog_brand"."name", "catalog_brand"."slug",
  "catalog_brand"."description", "catalog_brand"."logo", "catalog_brand"."is_active",
  "catalog_brand"."is_featured"`;

const FILTERS = [
  booleanFilter('is_active', '"catalog_brand"."is_active"'),
  booleanFilter('is_featured', '"catalog_brand"."is_featured"'),
];
const ORDERING = { name: '"catalog_brand"."name"' };

type BrandData = Partial<{
  name: string;
  slug: string;
  description: string;
  logo: null;
  is_active: boolean;
  is_featured: boolean;
}>;

@Injectable()
export class BrandsService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `BrandSerializer(brand).data`. */
  serialise(row: BrandRow): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      logo: mediaUrl(row.logo, this.env.mediaBase),
      is_active: row.is_active,
      is_featured: row.is_featured,
    };
  }

  /** `filter_queryset(get_queryset())`: the filters' conditions and the order. */
  private async queryset(
    query: QueryDict,
    sql: SqlParams,
  ): Promise<{ where: string[]; order: string }> {
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const order = orderingFrom(query, ORDERING) ?? ['"catalog_brand"."name" ASC'];
    return { where, order: order.join(', ') };
  }

  async list(query: QueryDict): Promise<Record<string, unknown>[]> {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const rows = await this.db.query<BrandRow>(
      `SELECT ${COLUMNS} FROM "catalog_brand"${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${order}`,
      sql.values,
    );
    return rows.map((row) => this.serialise(row));
  }

  /** `get_object()`: the filtered queryset, then the primary key -- a 404 either way. */
  async find(pk: string, query: QueryDict): Promise<BrandRow> {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`"catalog_brand"."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<BrandRow>(
      `SELECT ${COLUMNS} FROM "catalog_brand" WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  private unique(column: 'name' | 'slug', exclude: string | null): UniqueCheck {
    return {
      message: `brand with this ${column} already exists.`,
      exists: async (value) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM "catalog_brand" WHERE ("catalog_brand"."${column}" = $1${
            exclude ? ` AND NOT ("catalog_brand"."id" = $2)` : ''
          }) LIMIT 1`,
          exclude ? [value, exclude] : [value],
        )) !== null,
    };
  }

  /** `BrandSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validate(data: unknown, instance: BrandRow | null, partial: boolean): Promise<BrandData> {
    const exclude = instance?.id ?? null;
    const fields: Fields = {
      name: charField({ maxLength: 120, unique: this.unique('name', exclude) }),
      slug: slugField({ maxLength: 140, required: false, unique: this.unique('slug', exclude) }),
      description: charField({ allowBlank: true, required: false }),
      logo: imageField({ required: false, allowNull: true }),
      is_active: booleanField({ required: false }),
      is_featured: booleanField({ required: false }),
    };
    const result = await runSerializer<BrandData>(fields, data, {
      partial,
      validate: async (attrs) => {
        // Create only: renaming keeps the slug, which is a URL (see CategorySerializer).
        if (instance === null && !attrs.slug && attrs.name) {
          attrs.slug = await uniqueSlug(this.db, 'catalog_brand', 'brand', attrs.name, 140);
        }
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  async create(data: BrandData): Promise<BrandRow> {
    const row: BrandRow = {
      id: randomUUID(),
      name: data.name as string,
      slug: data.slug ?? '',
      description: data.description ?? '',
      // `FileField` stores an absent file as "", never NULL.
      logo: '',
      is_active: data.is_active ?? true,
      is_featured: data.is_featured ?? false,
    };
    if (!row.slug) row.slug = await uniqueSlug(this.db, 'catalog_brand', 'brand', row.name, 140);
    await this.db.query(
      `INSERT INTO "catalog_brand" ("id", "created_at", "updated_at", "name", "slug", "description",
         "logo", "is_active", "is_featured")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7)`,
      [row.id, row.name, row.slug, row.description, row.logo, row.is_active, row.is_featured],
    );
    return row;
  }

  /** `serializer.save()` on an instance: every column written back, `updated_at` stamped. */
  async update(instance: BrandRow, data: BrandData): Promise<BrandRow> {
    const row: BrandRow = { ...instance, ...data } as BrandRow;
    // Setting the file to None stores "": `str()` of an empty `FieldFile`.
    if (data.logo === null) row.logo = '';
    if (!row.slug) row.slug = await uniqueSlug(this.db, 'catalog_brand', 'brand', row.name, 140);
    await this.db.query(
      `UPDATE "catalog_brand" SET "updated_at" = clock_timestamp(), "name" = $2, "slug" = $3,
         "description" = $4, "logo" = $5, "is_active" = $6, "is_featured" = $7
       WHERE "catalog_brand"."id" = $1`,
      [row.id, row.name, row.slug, row.description, row.logo, row.is_active, row.is_featured],
    );
    return row;
  }

  /** `brand.delete()`: refused while any product names the brand (`PROTECT`). */
  async destroy(instance: BrandRow): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      await refuseIfReferenced(
        tx,
        [`SELECT 1 FROM "catalog_product" WHERE "catalog_product"."brand_id" = $1 LIMIT 1`],
        instance.id,
      );
      await tx.query(`DELETE FROM "catalog_brand" WHERE "catalog_brand"."id" IN ($1)`, [
        instance.id,
      ]);
    });
  }
}
