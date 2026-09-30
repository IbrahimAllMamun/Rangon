import { Inject, Injectable } from '@nestjs/common';

import { TaxSettings } from '../accounts/organization.service';
import { Dec, maxDecimal, minDecimal, pyRound } from '../common/decimal';
import { mediaUrl } from '../common/media';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns, Params } from '../database/sql';
import { AvailabilitySnapshot } from '../inventory/availability.service';
import {
  ATTRIBUTE_COLUMNS,
  ATTRIBUTE_VALUE_COLUMNS,
  IMAGE_COLUMNS,
  pick,
  VARIANT_COLUMNS,
} from './columns';
import { ListedProduct } from './product-search';

export interface AttributeValueRow {
  id: string;
  value: string;
  label: string;
  swatch: string;
  position: number;
  attribute: { id: string; code: string; name: string; kind: string };
}

interface ImageRow {
  image: string;
  altText: string;
  attributeValue: AttributeValueRow | null;
}

export interface VariantRow {
  id: string;
  productId: string;
  sku: string;
  name: string;
  price: string;
  compareAtPrice: string | null;
  status: string;
  links: AttributeValueRow[];
}

export interface ProductRelations {
  images: ImageRow[];
  variants: VariantRow[];
}

/** `AttributeValue.display`. */
export const display = (value: { label: string; value: string }): string =>
  value.label || value.value;

/** `catalog.api.serializers.colour_payload`. */
export function colourPayload(value: AttributeValueRow | null) {
  if (value === null) return null;
  return {
    code: value.attribute.code,
    value: value.value,
    label: display(value),
    swatch: value.swatch,
  };
}

/** A Decimal's truthiness: None and zero are both false. */
function truthyDecimal(value: string | null): value is string {
  return value !== null && !new Dec(value).isZero();
}

/**
 * `_payload_queryset` + `_product_payload` from orders/api/shop_views.py.
 *
 * Relations are fetched the way the Django API prefetches them -- one query per
 * relation, in the model's `Meta.ordering` -- because the payload's list order
 * *is* that ordering: images by position, variants by (product, position, sku).
 * Variant attribute links have no ordering on either side, so they are read
 * with the same unordered statement and taken in the order PostgreSQL gives.
 */
@Injectable()
export class ProductPayloadService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async relations(productIds: string[]): Promise<Map<string, ProductRelations>> {
    const byProduct = new Map<string, ProductRelations>();
    for (const id of productIds) byProduct.set(id, { images: [], variants: [] });
    if (!productIds.length) return byProduct;

    // Prefetch("images", queryset=ProductImage.objects.select_related("attribute_value__attribute"))
    const imageParams = new Params();
    const imageRows = await this.db.arrays(
      `SELECT ${columns('"catalog_productimage"', IMAGE_COLUMNS)}, ` +
        `${columns('"catalog_attributevalue"', ATTRIBUTE_VALUE_COLUMNS)}, ` +
        `${columns('"catalog_attribute"', ATTRIBUTE_COLUMNS)} ` +
        `FROM "catalog_productimage" ` +
        `LEFT OUTER JOIN "catalog_attributevalue" ON ("catalog_productimage"."attribute_value_id" = "catalog_attributevalue"."id") ` +
        `LEFT OUTER JOIN "catalog_attribute" ON ("catalog_attributevalue"."attribute_id" = "catalog_attribute"."id") ` +
        `WHERE "catalog_productimage"."product_id" IN ${imageParams.list(productIds, 'uuid')} ` +
        `ORDER BY "catalog_productimage"."position" ASC, "catalog_productimage"."created_at" ASC`,
      imageParams.values,
    );
    const valueStart = IMAGE_COLUMNS.length;
    const attributeStart = valueStart + ATTRIBUTE_VALUE_COLUMNS.length;
    for (const row of imageRows) {
      const image = pick(row, IMAGE_COLUMNS, 0);
      const value = pick(row, ATTRIBUTE_VALUE_COLUMNS, valueStart);
      const attribute = pick(row, ATTRIBUTE_COLUMNS, attributeStart);
      byProduct.get(image.product_id as string)?.images.push({
        image: image.image as string,
        altText: image.alt_text as string,
        attributeValue:
          image.attribute_value_id === null ? null : toAttributeValue(value, attribute),
      });
    }

    // "variants", ordered ("product", "position", "sku") -- `product` means the
    // product's own ordering, -created_at, hence the join.
    const variantParams = new Params();
    const variantRows = await this.db.arrays(
      `SELECT ${columns('"catalog_productvariant"', VARIANT_COLUMNS)} FROM "catalog_productvariant" ` +
        `INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id") ` +
        `WHERE "catalog_productvariant"."product_id" IN ${variantParams.list(productIds, 'uuid')} ` +
        `ORDER BY "catalog_product"."created_at" DESC, "catalog_productvariant"."position" ASC, "catalog_productvariant"."sku" ASC`,
      variantParams.values,
    );
    const variants = variantRows.map((row) => {
      const variant = pick(row, VARIANT_COLUMNS, 0);
      return {
        id: variant.id as string,
        productId: variant.product_id as string,
        sku: variant.sku as string,
        name: variant.name as string,
        price: variant.price as string,
        compareAtPrice: variant.compare_at_price as string | null,
        status: variant.status as string,
        links: [] as AttributeValueRow[],
      } satisfies VariantRow;
    });
    for (const variant of variants) byProduct.get(variant.productId)?.variants.push(variant);

    // "variants__attribute_values__attribute" and "__attribute_value": the
    // links unordered, then each related table by id.
    if (variants.length) {
      const linkParams = new Params();
      const links = await this.db.query<{
        variant_id: string;
        attribute_id: string;
        attribute_value_id: string;
      }>(
        `SELECT "catalog_variantattributevalue"."id", "catalog_variantattributevalue"."created_at", ` +
          `"catalog_variantattributevalue"."updated_at", "catalog_variantattributevalue"."variant_id", ` +
          `"catalog_variantattributevalue"."attribute_id", "catalog_variantattributevalue"."attribute_value_id" ` +
          `FROM "catalog_variantattributevalue" WHERE "catalog_variantattributevalue"."variant_id" IN ` +
          linkParams.list(
            variants.map((variant) => variant.id),
            'uuid',
          ),
        linkParams.values,
      );
      if (links.length) {
        const attributes = await this.byId(
          'catalog_attribute',
          ATTRIBUTE_COLUMNS,
          unique(links.map((link) => link.attribute_id)),
        );
        const values = await this.byId(
          'catalog_attributevalue',
          ATTRIBUTE_VALUE_COLUMNS,
          unique(links.map((link) => link.attribute_value_id)),
        );
        const variantById = new Map(variants.map((variant) => [variant.id, variant]));
        for (const link of links) {
          const value = values.get(link.attribute_value_id);
          const attribute = attributes.get(link.attribute_id);
          if (!value || !attribute) continue;
          // The link's own attribute, not the value's: `link.attribute.code`.
          variantById.get(link.variant_id)?.links.push(toAttributeValue(value, attribute));
        }
      }
    }
    return byProduct;
  }

  /** `_product_payload(product, snapshots=..., tax=...)`. */
  payload(
    product: ListedProduct,
    relations: ProductRelations,
    snapshots: Map<string, AvailabilitySnapshot>,
    tax: TaxSettings,
  ): Record<string, unknown> {
    const images = relations.images.map((image) => ({
      url: mediaUrl(image.image, this.env.MEDIA_URL),
      alt: effectiveAlt(image, product.name),
      // `null` marks a shared image -- a flat-lay or a size chart -- which
      // shows for every colour and never changes the selection.
      color: colourPayload(image.attributeValue),
    }));

    const variants: Record<string, unknown>[] = [];
    const prices: string[] = [];
    for (const variant of relations.variants) {
      if (variant.status !== 'ACTIVE') continue;
      const snapshot = snapshots.get(variant.id);
      const attributes: Record<string, unknown> = {};
      for (const link of variant.links) {
        attributes[link.attribute.code] = {
          value: link.value,
          label: display(link),
          swatch: link.swatch,
        };
      }
      prices.push(variant.price);
      variants.push({
        id: variant.id,
        sku: variant.sku,
        label: variantLabel(variant),
        price: variant.price,
        compare_at_price: truthyDecimal(variant.compareAtPrice) ? variant.compareAtPrice : null,
        available: snapshot ? snapshot.available : 0,
        in_stock: Boolean(snapshot && snapshot.available > 0),
        attributes,
      });
    }
    const priceList = prices.length ? prices : ['0.00'];

    return {
      tax: taxPayload(product, tax),
      id: product.id,
      name: product.name,
      slug: product.slug,
      short_description: product.shortDescription,
      description: product.description,
      material: product.material,
      care_instructions: product.careInstructions,
      category: { name: product.category.name, slug: product.category.slug },
      brand: product.brand ? { name: product.brand.name, slug: product.brand.slug } : null,
      images,
      variants,
      price_min: minDecimal(priceList),
      price_max: maxDecimal(priceList),
      in_stock: variants.some((variant) => variant.in_stock),
      drop_percent: dropPercent(relations.variants),
      featured: product.featured,
      seo_title: product.seoTitle || product.name,
      seo_description: product.seoDescription || product.shortDescription,
    };
  }

  private async byId<const T extends readonly string[]>(
    table: string,
    names: T,
    ids: string[],
  ): Promise<Map<string, Record<T[number], unknown>>> {
    const params = new Params();
    const rows = await this.db.arrays(
      `SELECT ${columns(`"${table}"`, names)} FROM "${table}" WHERE "${table}"."id" IN ${params.list(ids, 'uuid')}`,
      params.values,
    );
    return new Map(
      rows.map((row) => {
        const record = pick(row, names, 0);
        return [(record as Record<string, unknown>).id as string, record];
      }),
    );
  }
}

function toAttributeValue(
  value: Record<(typeof ATTRIBUTE_VALUE_COLUMNS)[number], unknown>,
  attribute: Record<(typeof ATTRIBUTE_COLUMNS)[number], unknown>,
): AttributeValueRow {
  return {
    id: value.id as string,
    value: value.value as string,
    label: value.label as string,
    swatch: value.swatch as string,
    position: value.position as number,
    attribute: {
      id: attribute.id as string,
      code: attribute.code as string,
      name: attribute.name as string,
      kind: attribute.kind as string,
    },
  };
}

/** `ProductImage.effective_alt`. */
function effectiveAlt(image: ImageRow, productName: string): string {
  if (image.altText) return image.altText;
  const colour = image.attributeValue ? display(image.attributeValue) : '';
  return colour ? `${productName} in ${colour}` : productName;
}

/** `ProductVariant.label`: its name, else its values joined. */
export function variantLabel(variant: VariantRow): string {
  if (variant.name) return variant.name;
  return variant.links.map((link) => display(link)).join(' / ');
}

/**
 * `merchandising.price_drop_payload`: the deepest reduction across *every*
 * variant, active or not, as a whole percentage rounded half to even.
 */
export function dropPercent(variants: VariantRow[]): number {
  let best = 0;
  for (const variant of variants) {
    const compareAt = variant.compareAtPrice;
    if (!truthyDecimal(compareAt) || new Dec(compareAt).lte(variant.price)) continue;
    const percent = pyRound(new Dec(compareAt).minus(variant.price).times(100).div(compareAt));
    best = Math.max(best, percent);
  }
  return best;
}

/** `_tax_payload`: a category override replaces the organisation rate. */
function taxPayload(product: ListedProduct, [mode, defaultRate]: TaxSettings) {
  return { mode, rate: product.category.taxRate === null ? defaultRate : product.category.taxRate };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
