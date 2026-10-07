/**
 * A stock row as the scheduled jobs read it:
 * `Inventory.objects.select_related("variant", "variant__product", "branch")`,
 * every column of the four tables in Django's order. The digest and the
 * expiry check take the first hundred rows of an order that ties, so the
 * statement -- and with it the plan -- is Django's.
 */
import { columns } from '../database/sql';

const I = '"inventory_inventory"';
const B = '"accounts_branch"';
const V = '"catalog_productvariant"';
const P = '"catalog_product"';

const INVENTORY_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'branch_id',
  'variant_id',
  'on_hand',
  'reserved',
  'average_cost',
  'reorder_point',
  'bin_location',
] as const;
const BRANCH_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'organization_id',
  'name',
  'code',
  'address',
  'phone',
  'email',
  'is_default',
  'fulfils_online_orders',
  'register_count',
  'status',
] as const;
const VARIANT_COLUMNS = [
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
const PRODUCT_COLUMNS = [
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

export const STOCK_ROW_SELECT = [
  columns(I, INVENTORY_COLUMNS),
  columns(B, BRANCH_COLUMNS),
  columns(V, VARIANT_COLUMNS),
  columns(P, PRODUCT_COLUMNS),
].join(', ');

const JOIN_BRANCH = `INNER JOIN ${B} ON (${I}."branch_id" = ${B}."id")`;
const JOIN_VARIANT = `INNER JOIN ${V} ON (${I}."variant_id" = ${V}."id")`;
const JOIN_PRODUCT = `INNER JOIN ${P} ON (${V}."product_id" = ${P}."id")`;
/** The joins as Django writes them: a filter on the variant names its join first. */
export const STOCK_ROW_FROM = `FROM ${I} ${JOIN_BRANCH} ${JOIN_VARIANT} ${JOIN_PRODUCT}`;
export const STOCK_ROW_FROM_BY_VARIANT = `FROM ${I} ${JOIN_VARIANT} ${JOIN_BRANCH} ${JOIN_PRODUCT}`;

export interface StockRow {
  id: string;
  branch_id: string;
  variant_id: string;
  on_hand: number;
  reserved: number;
  reorder_point: number;
  branch_code: string;
  sku: string;
  variant_name: string;
  expiry_date: string | null;
  product_name: string;
  /** `Inventory.available`. */
  available: number;
}

const at = (table: readonly string[], offset: number, name: string) => offset + table.indexOf(name);
const BRANCH_AT = INVENTORY_COLUMNS.length;
const VARIANT_AT = BRANCH_AT + BRANCH_COLUMNS.length;
const PRODUCT_AT = VARIANT_AT + VARIANT_COLUMNS.length;

/** One row of the statement, read by position: four tables share column names. */
export function stockRow(values: unknown[]): StockRow {
  const inventory = (name: string) => values[at(INVENTORY_COLUMNS, 0, name)];
  const onHand = inventory('on_hand') as number;
  const reserved = inventory('reserved') as number;
  return {
    id: inventory('id') as string,
    branch_id: inventory('branch_id') as string,
    variant_id: inventory('variant_id') as string,
    on_hand: onHand,
    reserved,
    reorder_point: inventory('reorder_point') as number,
    branch_code: values[at(BRANCH_COLUMNS, BRANCH_AT, 'code')] as string,
    sku: values[at(VARIANT_COLUMNS, VARIANT_AT, 'sku')] as string,
    variant_name: values[at(VARIANT_COLUMNS, VARIANT_AT, 'name')] as string,
    expiry_date: values[at(VARIANT_COLUMNS, VARIANT_AT, 'expiry_date')] as string | null,
    product_name: values[at(PRODUCT_COLUMNS, PRODUCT_AT, 'name')] as string,
    available: onHand - reserved,
  };
}
