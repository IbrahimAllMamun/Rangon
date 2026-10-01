import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  booleanField,
  charField,
  errorMessages,
  Fields,
  imageField,
  integerField,
  Invalid,
  InvalidFields,
  pkRelatedField,
  runSerializer,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import { applyFilters, modelFilter, orderingPlan, type OrderingTerm } from '../../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../../common/pagination';
import type { QueryDict } from '../../common/query-dict';
import { MediaStorage } from '../../common/storage';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import type { UploadedFile } from '../../http/multipart';
import { CataloguePayloads, type ImageRow } from './catalogue-payloads';

/**
 * `catalog.api.views.ProductImageViewSet`: product photographs, each
 * grouped under a colour the product comes in, or shared by all. Uploaded
 * as a form (multipart) or edited as JSON; paginated, ordered by position
 * then age. The first image of a product becomes its primary one.
 */

const I = '"catalog_productimage"';
const FILTERS = [
  modelFilter('product', `${I}."product_id"`, 'catalog_product'),
  modelFilter('attribute_value', `${I}."attribute_value_id"`, 'catalog_attributevalue'),
];
/** No `ordering_fields`: every field the serializer reads from the model, relations by their own ordering. */
const ORDERING: Record<string, OrderingTerm> = {
  id: `${I}."id"`,
  // `Product.Meta.ordering` is newest first.
  product: { columns: ['"catalog_product"."created_at" DESC'] },
  attribute_value: {
    columns: [
      '"catalog_attribute"."position"',
      '"catalog_attribute"."name"',
      '"catalog_attributevalue"."position"',
      '"catalog_attributevalue"."value"',
    ],
  },
  alt_text: `${I}."alt_text"`,
  position: `${I}."position"`,
  is_primary: `${I}."is_primary"`,
};
const IMAGE_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'product_id',
  'attribute_value_id',
  'image',
  'alt_text',
  'position',
  'is_primary',
  'width',
  'height',
];
const PRODUCT_ALL = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'slug',
  'category_id',
  'brand_id',
  'short_description',
  'description',
  'material',
  'care_instructions',
  'status',
  'published',
  'featured',
  'is_final_sale',
  'size_chart_id',
  'seo_title',
  'seo_description',
  'created_by_id',
];
const VALUE_ALL = [
  'id',
  'created_at',
  'updated_at',
  'attribute_id',
  'value',
  'label',
  'swatch',
  'position',
];
const ATTRIBUTE_ALL = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'code',
  'kind',
  'is_variant_defining',
  'is_filterable',
  'position',
];
const DEFAULT_ORDER = [`${I}."position" ASC`, `${I}."created_at" ASC`];

/** `core.media`: what a photograph may be, by its decoded type and its name. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

/** `validate_image_upload`: size, the type Pillow found, the name's extension. */
export function checkImageUpload(file: UploadedFile | null): UploadedFile | null {
  if (!file) return file;
  if (file.size > MAX_IMAGE_BYTES) throw Invalid.of('The image must be smaller than 10 MB.');
  const type = file.contentType.toLowerCase();
  if (type && !ALLOWED_IMAGE_TYPES.includes(type))
    throw Invalid.of('Upload a JPEG, PNG, WebP or AVIF image.');
  if (!ALLOWED_IMAGE_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext)))
    throw Invalid.of('Upload a JPEG, PNG, WebP or AVIF image.');
  return file;
}

interface ImageWithProduct extends ImageRow {
  product_name: string;
}

type ImageData = Partial<{
  product: string;
  attribute_value: string | null;
  image: UploadedFile;
  alt_text: string;
  position: number;
  is_primary: boolean;
}>;

@Injectable()
export class ProductImagesService {
  private readonly storage: MediaStorage;

  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    @Inject(ENV) env: Env,
  ) {
    this.storage = new MediaStorage(env.MEDIA_ROOT, env.DJANGO_TIME_ZONE);
  }

  /**
   * The queryset's statement as Django sends it -- every column of the image,
   * its product, its colour and the colour's attribute (`select_related`) --
   * so rows an ordering leaves tied come back in the same order.
   */
  private select(where: string[], order: string[]): string {
    const all = (table: string, columns: string[]) =>
      columns.map((column) => `"${table}"."${column}"`).join(', ');
    return `SELECT ${all('catalog_productimage', IMAGE_COLUMNS)}, ${all('catalog_product', PRODUCT_ALL)},
        ${all('catalog_attributevalue', VALUE_ALL)}, ${all('catalog_attribute', ATTRIBUTE_ALL)}
      FROM ${I}
      INNER JOIN "catalog_product" ON (${I}."product_id" = "catalog_product"."id")
      LEFT OUTER JOIN "catalog_attributevalue" ON (${I}."attribute_value_id" = "catalog_attributevalue"."id")
      LEFT OUTER JOIN "catalog_attribute" ON ("catalog_attributevalue"."attribute_id" = "catalog_attribute"."id")
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order.join(', ')}`;
  }

  /** Rows read positionally: the statement repeats column names. */
  private async rows(text: string, values: unknown[]): Promise<ImageWithProduct[]> {
    return (await this.db.arrays(text, values)).map((row) => ({
      id: row[0] as string,
      product_id: row[3] as string,
      attribute_value_id: row[4] as string | null,
      image: row[5] as string,
      alt_text: row[6] as string,
      position: row[7] as number,
      is_primary: row[8] as boolean,
      product_name: row[IMAGE_COLUMNS.length + 3] as string,
    }));
  }

  async serialise(rows: ImageWithProduct[]): Promise<Record<string, unknown>[]> {
    const { colours } = await this.payloads.images([...new Set(rows.map((row) => row.product_id))]);
    return rows.map((row) => this.payloads.image(row, row.product_name, colours));
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const plan = orderingPlan(query, ORDERING);
    const pageSize = pageSizeFrom(query, STANDARD_PAGINATION);
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${I}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSize);
    // Django's slice: no OFFSET on the first page.
    const offset = page.offset ? ` OFFSET ${page.offset}` : '';
    const rows = await this.rows(
      `${this.select(where, plan?.order ?? DEFAULT_ORDER)} LIMIT ${page.limit}${offset}`,
      sql.values,
    );
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  async find(pk: string, query: QueryDict): Promise<ImageWithProduct> {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${I}."id" = ${sql.add(id, 'uuid')}`);
    const [row] = await this.rows(`${this.select(where, DEFAULT_ORDER)} LIMIT 21`, sql.values);
    if (!row) throw new NotFound();
    return row;
  }

  /** `ProductImageSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validate(data: unknown, instance: ImageRow | null, partial: boolean): Promise<ImageData> {
    const exists = (table: string) => async (id: string) =>
      (await this.db.one(`SELECT 1 FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !== null;
    const fields: Fields = {
      product: pkRelatedField(exists('catalog_product')),
      attribute_value: pkRelatedField(exists('catalog_attributevalue'), {
        required: false,
        allowNull: true,
      }),
      image: imageField(),
      alt_text: charField({ allowBlank: true, maxLength: 200, required: false }),
      position: integerField({ maxValue: 2147483647, minValue: 0, required: false }),
      is_primary: booleanField({ required: false }),
    };
    const result = await runSerializer<ImageData>(fields, data, {
      partial,
      hooks: { image: (file: UploadedFile | null) => checkImageUpload(file) },
      // The colour rules are the model's `clean()`, so the Django admin obeys them too.
      validate: async (attrs) => {
        const valueId =
          attrs.attribute_value !== undefined
            ? attrs.attribute_value
            : (instance?.attribute_value_id ?? null);
        const productId = attrs.product ?? instance?.product_id ?? null;
        const problem = await this.colourProblem(valueId, productId);
        if (problem)
          throw new InvalidFields({ attribute_value: [{ message: problem, code: 'invalid' }] });
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `ProductImage.clean`: only a variant-defining colour the product comes in. */
  private async colourProblem(
    valueId: string | null,
    productId: string | null,
  ): Promise<string | null> {
    if (valueId === null) return null;
    const value = (await this.db.one<{ kind: string; is_variant_defining: boolean }>(
      `SELECT a."kind", a."is_variant_defining" FROM "catalog_attributevalue" v
         INNER JOIN "catalog_attribute" a ON (v."attribute_id" = a."id") WHERE v."id" = $1`,
      [valueId],
    )) as { kind: string; is_variant_defining: boolean };
    if (value.kind !== 'COLOR') return 'Images group by colour; that is not a colour attribute.';
    if (!value.is_variant_defining) return 'That colour attribute does not define variants.';
    if (productId) {
      const carried = await this.db.one(
        `SELECT 1 AS "a" FROM "catalog_variantattributevalue" l
           INNER JOIN "catalog_productvariant" v ON (l."variant_id" = v."id")
          WHERE (l."attribute_value_id" = $2 AND v."product_id" = $1) LIMIT 1`,
        [productId, valueId],
      );
      if (!carried) return 'This product has no variant in that colour.';
    }
    return null;
  }

  private async productName(id: string): Promise<string> {
    return (
      await this.db.one<{ name: string }>(`SELECT "name" FROM "catalog_product" WHERE "id" = $1`, [
        id,
      ])
    )?.name as string;
  }

  /**
   * `perform_create`: the file stored, the row written -- and made the
   * product's primary image if it has none.
   */
  async create(data: ImageData): Promise<ImageWithProduct> {
    const file = data.image as UploadedFile;
    const name = await this.storage.save('products/%Y/%m/', file.name, file.bytes);
    const row: ImageRow = {
      id: randomUUID(),
      product_id: data.product as string,
      attribute_value_id: data.attribute_value ?? null,
      image: name,
      alt_text: data.alt_text ?? '',
      position: data.position ?? 0,
      is_primary: data.is_primary ?? false,
    };
    await this.db.query(
      `INSERT INTO ${I} ("id", "created_at", "updated_at", "product_id", "attribute_value_id", "image",
         "alt_text", "position", "is_primary", "width", "height")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, NULL, NULL)`,
      [
        row.id,
        row.product_id,
        row.attribute_value_id,
        row.image,
        row.alt_text,
        row.position,
        row.is_primary,
      ],
    );
    const primary = await this.db.one(
      `SELECT 1 AS "a" FROM ${I} WHERE (${I}."is_primary" AND ${I}."product_id" = $1) LIMIT 1`,
      [row.product_id],
    );
    if (!primary) {
      row.is_primary = true;
      await this.db.query(`UPDATE ${I} SET "is_primary" = true WHERE ${I}."id" = $1`, [row.id]);
    }
    return { ...row, product_name: await this.productName(row.product_id) };
  }

  /** `serializer.save()` on an image: a new file stored if one was sent, every column written. */
  async update(instance: ImageWithProduct, data: ImageData): Promise<ImageWithProduct> {
    const { image, product, attribute_value, ...rest } = data;
    const row: ImageRow = { ...instance, ...rest };
    if (product !== undefined) row.product_id = product;
    if (attribute_value !== undefined) row.attribute_value_id = attribute_value;
    if (image) row.image = await this.storage.save('products/%Y/%m/', image.name, image.bytes);
    await this.db.query(
      `UPDATE ${I} SET "updated_at" = clock_timestamp(), "product_id" = $2, "attribute_value_id" = $3,
         "image" = $4, "alt_text" = $5, "position" = $6, "is_primary" = $7
       WHERE ${I}."id" = $1`,
      [
        row.id,
        row.product_id,
        row.attribute_value_id,
        row.image,
        row.alt_text,
        row.position,
        row.is_primary,
      ],
    );
    return { ...row, product_name: await this.productName(row.product_id) };
  }

  async destroy(image: ImageRow): Promise<void> {
    await this.db.query(`DELETE FROM ${I} WHERE ${I}."id" IN ($1)`, [image.id]);
  }
}
