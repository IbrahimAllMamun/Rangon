/**
 * Column lists in the Django models' field order.
 *
 * Where a statement has to be the Django API's own -- a `SELECT DISTINCT`
 * whose plan, and therefore whose order on ties, depends on what it selects --
 * it selects these, in this order. Everywhere else only the columns a payload
 * reads are selected.
 */
export const PRODUCT_COLUMNS = [
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
] as const;

export const CATEGORY_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'parent_id',
  'name',
  'slug',
  'description',
  'image',
  'position',
  'is_active',
  'show_in_navigation',
  'tax_rate',
  'seo_title',
  'seo_description',
] as const;

export const BRAND_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'slug',
  'description',
  'logo',
  'is_active',
  'is_featured',
] as const;

export const VARIANT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
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

export const ATTRIBUTE_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'code',
  'kind',
  'is_variant_defining',
  'is_filterable',
  'position',
] as const;

export const ATTRIBUTE_VALUE_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'attribute_id',
  'value',
  'label',
  'swatch',
  'position',
] as const;

export const IMAGE_COLUMNS = [
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
] as const;

/** Map an array row onto names, from `start`. */
export function pick<const T extends readonly string[]>(
  row: unknown[],
  names: T,
  start: number,
): Record<T[number], unknown> {
  const out = {} as Record<T[number], unknown>;
  names.forEach((name, index) => {
    out[name as T[number]] = row[start + index];
  });
  return out;
}
