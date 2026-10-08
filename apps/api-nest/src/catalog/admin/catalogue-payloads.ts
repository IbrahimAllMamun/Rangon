import { Inject, Injectable } from '@nestjs/common';

import { localIso } from '../../common/datetime';
import { mediaUrl } from '../../common/media';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';

/**
 * The admin serializers of `catalog/api/serializers.py` that read products,
 * variants and images -- `ProductListSerializer`, `ProductDetailSerializer`,
 * `ProductVariantSerializer`, `ProductImageSerializer` -- with the rows read
 * the way the views' `prefetch_related` reads them.
 *
 * A variant's attribute links have no `Meta.ordering`, so their order (and a
 * label built from them) is whatever PostgreSQL returns: the links are read
 * with Django's own statement, so the two APIs ask the same question.
 */

export const PRODUCT_COLUMNS = [
  'id',
  'created_at',
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
] as const;

export interface ProductRow {
  id: string;
  created_at: string;
  name: string;
  slug: string;
  category_id: string;
  brand_id: string | null;
  short_description: string;
  description: string;
  material: string;
  care_instructions: string;
  status: string;
  published: boolean;
  featured: boolean;
  is_final_sale: boolean;
  size_chart_id: string | null;
  seo_title: string;
  seo_description: string;
  created_by_id: string | null;
  category_name: string;
  brand_name: string | null;
  /** The list's annotations; absent on a row read without them. */
  min_price?: string | null;
  max_price?: string | null;
}

export const VARIANT_COLUMNS = [
  'id',
  'product_id',
  'sku',
  'barcode',
  'name',
  'price',
  'compare_at_price',
  'cost',
  'weight_grams',
  'position',
  'status',
  'batch_number',
  'expiry_date',
] as const;

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  name: string;
  price: string;
  compare_at_price: string | null;
  cost: string;
  weight_grams: number | null;
  position: number;
  status: string;
  batch_number: string;
  expiry_date: string | null;
}

export interface ImageRow {
  id: string;
  product_id: string;
  attribute_value_id: string | null;
  image: string;
  alt_text: string;
  position: number;
  is_primary: boolean;
}

interface ValueInfo {
  id: string;
  value: string;
  label: string;
  swatch: string;
  attribute_id: string;
}

interface AttributeInfo {
  id: string;
  code: string;
  name: string;
}

interface Link {
  variant_id: string;
  attribute_id: string;
  attribute_value_id: string;
}

/** Stock as `inventory.services.availability` reads it, and whether the branch ever received it. */
export interface StockContext {
  stock: Map<string, { onHand: number; reserved: number; available: number; averageCost: string }>;
  received?: Set<string>;
}

export interface ProductParts {
  images: Map<string, ImageRow[]>;
  colours: Map<string, ValueInfo & { code: string }>;
  variants: Map<string, VariantRow[]>;
  links: Map<string, { link: Link; value: ValueInfo; attribute: AttributeInfo }[]>;
  specs: Map<
    string,
    {
      attribute_value_id: string;
      value: string;
      label: string;
      swatch: string;
      code: string;
      name: string;
      kind: string;
    }[]
  >;
}

/** `str(Decimal)` of a money column as PostgreSQL prints it: already two places. */
function money(value: string | null): string | null {
  return value;
}

@Injectable()
export class CataloguePayloads {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `prefetch_related("images")` with each image's colour. */
  async images(productIds: string[], q: Queryable = this.db) {
    const images = new Map<string, ImageRow[]>();
    const colours = new Map<string, ValueInfo & { code: string }>();
    if (!productIds.length) return { images, colours };
    const sql = new SqlParams();
    const rows = await q.query<ImageRow>(
      `SELECT "catalog_productimage"."id", "catalog_productimage"."product_id",
              "catalog_productimage"."attribute_value_id", "catalog_productimage"."image",
              "catalog_productimage"."alt_text", "catalog_productimage"."position",
              "catalog_productimage"."is_primary"
         FROM "catalog_productimage" WHERE "catalog_productimage"."product_id" IN ${sql.list(productIds, 'uuid')}
        ORDER BY "catalog_productimage"."position" ASC, "catalog_productimage"."created_at" ASC`,
      sql.values,
    );
    for (const row of rows) {
      const list = images.get(row.product_id) ?? [];
      list.push(row);
      images.set(row.product_id, list);
    }
    const valueIds = [
      ...new Set(rows.flatMap((row) => (row.attribute_value_id ? [row.attribute_value_id] : []))),
    ];
    if (valueIds.length) {
      const values = await q.query<ValueInfo & { code: string }>(
        `SELECT v."id", v."value", v."label", v."swatch", v."attribute_id", a."code"
           FROM "catalog_attributevalue" v JOIN "catalog_attribute" a ON a."id" = v."attribute_id"
          WHERE v."id" = ANY($1::uuid[])`,
        [valueIds],
      );
      for (const value of values) colours.set(value.id, value);
    }
    return { images, colours };
  }

  /** `prefetch_related("variants__attribute_values__attribute_value")`, plus each link's attribute. */
  async variants(productIds: string[], q: Queryable = this.db) {
    const variants = new Map<string, VariantRow[]>();
    if (!productIds.length) return { variants, links: new Map() };
    const sql = new SqlParams();
    const rows = await q.query<VariantRow>(
      `SELECT ${VARIANT_COLUMNS.map((column) => `"catalog_productvariant"."${column}"`).join(', ')}
         FROM "catalog_productvariant"
         INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
        WHERE "catalog_productvariant"."product_id" IN ${sql.list(productIds, 'uuid')}
        ORDER BY "catalog_product"."created_at" DESC, "catalog_productvariant"."position" ASC,
                 "catalog_productvariant"."sku" ASC`,
      sql.values,
    );
    for (const row of rows) {
      const list = variants.get(row.product_id) ?? [];
      list.push(row);
      variants.set(row.product_id, list);
    }
    return {
      variants,
      links: await this.links(
        rows.map((row) => row.id),
        q,
      ),
    };
  }

  /** A variant's attribute links, read with Django's statement: no order of their own. */
  async links(variantIds: string[], q: Queryable = this.db) {
    const links = new Map<string, { link: Link; value: ValueInfo; attribute: AttributeInfo }[]>();
    if (!variantIds.length) return links;
    const sql = new SqlParams();
    const rows = await q.query<Link>(
      `SELECT "catalog_variantattributevalue"."id", "catalog_variantattributevalue"."created_at",
              "catalog_variantattributevalue"."updated_at", "catalog_variantattributevalue"."variant_id",
              "catalog_variantattributevalue"."attribute_id", "catalog_variantattributevalue"."attribute_value_id"
         FROM "catalog_variantattributevalue"
        WHERE "catalog_variantattributevalue"."variant_id" IN ${sql.list(variantIds, 'uuid')}`,
      sql.values,
    );
    if (!rows.length) return links;
    const values = new Map(
      (
        await q.query<ValueInfo>(
          `SELECT "id", "value", "label", "swatch", "attribute_id" FROM "catalog_attributevalue"
            WHERE "id" = ANY($1::uuid[])`,
          [[...new Set(rows.map((row) => row.attribute_value_id))]],
        )
      ).map((value) => [value.id, value]),
    );
    const attributes = new Map(
      (
        await q.query<AttributeInfo>(
          `SELECT "id", "code", "name" FROM "catalog_attribute" WHERE "id" = ANY($1::uuid[])`,
          [[...new Set(rows.map((row) => row.attribute_id))]],
        )
      ).map((attribute) => [attribute.id, attribute]),
    );
    for (const row of rows) {
      const list = links.get(row.variant_id) ?? [];
      list.push({
        link: row,
        value: values.get(row.attribute_value_id) as ValueInfo,
        attribute: attributes.get(row.attribute_id) as AttributeInfo,
      });
      links.set(row.variant_id, list);
    }
    return links;
  }

  /** `Prefetch("spec_values", ...select_related("attribute_value__attribute"))`, in its order. */
  async specs(productIds: string[], q: Queryable = this.db) {
    const specs: ProductParts['specs'] = new Map();
    if (!productIds.length) return specs;
    const sql = new SqlParams();
    const rows = await q.query<{
      product_id: string;
      attribute_value_id: string;
      value: string;
      label: string;
      swatch: string;
      code: string;
      name: string;
      kind: string;
    }>(
      `SELECT p."product_id", p."attribute_value_id", v."value", v."label", v."swatch",
              a."code", a."name", a."kind"
         FROM "catalog_productattributevalue" p
         INNER JOIN "catalog_attributevalue" v ON (p."attribute_value_id" = v."id")
         INNER JOIN "catalog_attribute" a ON (v."attribute_id" = a."id")
        WHERE p."product_id" IN ${sql.list(productIds, 'uuid')}
        ORDER BY a."position" ASC, a."name" ASC, v."position" ASC, v."value" ASC`,
      sql.values,
    );
    for (const row of rows) {
      const list = specs.get(row.product_id) ?? [];
      list.push(row);
      specs.set(row.product_id, list);
    }
    return specs;
  }

  async parts(productIds: string[], q: Queryable = this.db): Promise<ProductParts> {
    const { images, colours } = await this.images(productIds, q);
    const { variants, links } = await this.variants(productIds, q);
    const specs = await this.specs(productIds, q);
    return { images, colours, variants, links, specs };
  }

  /** `variant.label`: its own name, else its values' display names joined. */
  label(variant: VariantRow, links: ProductParts['links']): string {
    if (variant.name) return variant.name;
    return (links.get(variant.id) ?? []).map(({ value }) => value.label || value.value).join(' / ');
  }

  /**
   * `ProductVariantSerializer(variant, context).data`. `brandName` is the
   * product's brand, or null for none -- and then, in a partial update's
   * answer, DRF leaves `brand_name` out rather than default it.
   */
  variant(
    variant: VariantRow,
    product: { name: string; brandName: string | null },
    links: ProductParts['links'],
    context: StockContext | null,
    partial = false,
  ): Record<string, unknown> {
    let stock: Record<string, unknown> | null = null;
    if (context) {
      const snapshot = context.stock.get(variant.id);
      const flag =
        context.received === undefined ? {} : { received: context.received.has(variant.id) };
      stock = snapshot
        ? {
            on_hand: snapshot.onHand,
            reserved: snapshot.reserved,
            available: snapshot.available,
            average_cost: snapshot.averageCost,
            ...flag,
          }
        : { on_hand: 0, reserved: 0, available: 0, ...flag };
    }
    const out: Record<string, unknown> = {
      id: variant.id,
      product: variant.product_id,
      product_name: product.name,
      brand_name: product.brandName ?? '',
      sku: variant.sku,
      barcode: variant.barcode,
      name: variant.name,
      label: this.label(variant, links),
      price: money(variant.price),
      compare_at_price: money(variant.compare_at_price),
      cost: money(variant.cost),
      weight_grams: variant.weight_grams,
      position: variant.position,
      status: variant.status,
      batch_number: variant.batch_number,
      expiry_date: variant.expiry_date,
      attributes: (links.get(variant.id) ?? []).map(({ value, attribute }) => ({
        attribute_code: attribute.code,
        attribute_name: attribute.name,
        value: value.value,
        label: value.label || value.value,
        swatch: value.swatch,
      })),
      stock,
    };
    if (partial && product.brandName === null) delete out.brand_name;
    return out;
  }

  /** `colour_payload(value)`. */
  colour(valueId: string | null, colours: ProductParts['colours']): Record<string, string> | null {
    const value = valueId ? colours.get(valueId) : undefined;
    if (!value) return null;
    return {
      code: value.code,
      value: value.value,
      label: value.label || value.value,
      swatch: value.swatch,
    };
  }

  /** `image.effective_alt`. */
  alt(image: ImageRow, productName: string, colours: ProductParts['colours']): string {
    if (image.alt_text) return image.alt_text;
    const colour = image.attribute_value_id ? colours.get(image.attribute_value_id) : undefined;
    const label = colour ? colour.label || colour.value : '';
    return label ? `${productName} in ${label}` : productName;
  }

  /** `ProductImageSerializer(image).data`. */
  image(
    image: ImageRow,
    productName: string,
    colours: ProductParts['colours'],
  ): Record<string, unknown> {
    return {
      id: image.id,
      product: image.product_id,
      attribute_value: image.attribute_value_id,
      color: this.colour(image.attribute_value_id, colours),
      url: mediaUrl(image.image, this.env.mediaBase),
      alt_text: image.alt_text,
      alt: this.alt(image, productName, colours),
      position: image.position,
      is_primary: image.is_primary,
    };
  }

  /** `ProductListSerializer(product).data`. */
  listItem(product: ProductRow, parts: ProductParts): Record<string, unknown> {
    const images = parts.images.get(product.id) ?? [];
    const primary = images.find((image) => image.is_primary) ?? images[0];
    const out: Record<string, unknown> = {
      id: product.id,
      name: product.name,
      slug: product.slug,
      short_description: product.short_description,
      category: product.category_id,
      category_name: product.category_name,
      brand: product.brand_id,
      brand_name: product.brand_name ?? '',
      status: product.status,
      published: product.published,
      featured: product.featured,
      primary_image:
        primary && primary.image
          ? {
              url: mediaUrl(primary.image, this.env.mediaBase),
              alt: this.alt(primary, product.name, parts.colours),
            }
          : null,
      variant_count: (parts.variants.get(product.id) ?? []).length,
    };
    // Only an annotated row carries the price range; any other skips the field.
    if (product.min_price !== undefined) out.min_price = product.min_price;
    if (product.max_price !== undefined) out.max_price = product.max_price;
    out.created_at = localIso(product.created_at, this.env.DJANGO_TIME_ZONE);
    return out;
  }

  /** `ProductDetailSerializer(product, context).data`. */
  detail(
    product: ProductRow,
    parts: ProductParts,
    context: StockContext | null,
  ): Record<string, unknown> {
    const specs = parts.specs.get(product.id) ?? [];
    const grouped = new Map<
      string,
      { attribute_code: string; attribute_name: string; kind: string; values: unknown[] }
    >();
    for (const spec of specs) {
      let row = grouped.get(spec.code);
      if (!row) {
        row = { attribute_code: spec.code, attribute_name: spec.name, kind: spec.kind, values: [] };
        grouped.set(spec.code, row);
      }
      row.values.push({ value: spec.value, label: spec.label || spec.value, swatch: spec.swatch });
    }
    const brand = { name: product.name, brandName: product.brand_name };
    return {
      ...this.listItem(product, parts),
      description: product.description,
      material: product.material,
      care_instructions: product.care_instructions,
      is_final_sale: product.is_final_sale,
      seo_title: product.seo_title,
      seo_description: product.seo_description,
      specs: [...grouped.values()],
      spec_value_ids: specs.map((spec) => spec.attribute_value_id),
      size_chart: product.size_chart_id,
      variants: (parts.variants.get(product.id) ?? []).map((variant) =>
        this.variant(variant, brand, parts.links, context),
      ),
      images: (parts.images.get(product.id) ?? []).map((image) =>
        this.image(image, product.name, parts.colours),
      ),
    };
  }
}
