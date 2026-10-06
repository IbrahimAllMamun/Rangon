import { Inject, Injectable } from '@nestjs/common';

import { CataloguePayloads, type VariantRow } from '../catalog/admin/catalogue-payloads';
import { money } from '../checkout/pricing';
import { localIso } from '../common/datetime';
import { Dec } from '../common/decimal';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';

/**
 * `PurchaseOrderSerializer` and the serializers nested in it: an order with
 * its lines, its deliveries and what went back. Lines carry no order of their
 * own, so each is read with the statement Django's prefetch sends.
 */

export const PO = '"purchasing_purchaseorder"';
export const PO_SELECT = `${PO}."id", ${PO}."created_at", ${PO}."number", ${PO}."supplier_id",
  ${PO}."branch_id", ${PO}."status", ${PO}."payment_status", ${PO}."invoice_number",
  ${PO}."ordered_at", ${PO}."expected_at", ${PO}."completed_at", ${PO}."subtotal",
  ${PO}."discount_total", ${PO}."tax_total", ${PO}."shipping_total", ${PO}."grand_total",
  ${PO}."paid_total", ${PO}."credited_total", ${PO}."currency", ${PO}."notes",
  "purchasing_supplier"."name" AS "supplier_name", "accounts_branch"."code" AS "branch_code"`;
export const PO_FROM = `FROM ${PO}
  INNER JOIN "purchasing_supplier" ON (${PO}."supplier_id" = "purchasing_supplier"."id")
  INNER JOIN "accounts_branch" ON (${PO}."branch_id" = "accounts_branch"."id")`;

export interface PurchaseOrderRow {
  id: string;
  created_at: string;
  number: string;
  supplier_id: string;
  branch_id: string;
  status: string;
  payment_status: string;
  invoice_number: string;
  ordered_at: string | null;
  expected_at: string | null;
  completed_at: string | null;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  shipping_total: string;
  grand_total: string;
  paid_total: string;
  credited_total: string;
  currency: string;
  notes: string;
  supplier_name: string;
  branch_code: string;
}

interface ItemRow {
  id: string;
  purchase_order_id: string;
  variant_id: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_returned: number;
  unit_cost: string;
  discount: string;
  tax_rate: string;
  line_total: string;
}

interface ReceiptRow {
  id: string;
  number: string;
  purchase_order_id: string;
  received_at: string;
  received_by_id: string | null;
  notes: string;
  is_posted: boolean;
}

interface ReturnRow {
  id: string;
  created_at: string;
  number: string;
  purchase_order_id: string;
  reason: string;
  notes: string;
  returned_at: string;
  returned_by_id: string | null;
  credit_total: string;
}

interface DocumentLine {
  id: string;
  document_id: string;
  purchase_order_item_id: string;
  quantity: number;
  unit_cost: string;
}

interface VariantInfo {
  id: string;
  sku: string;
  name: string;
  product_name: string;
}

export const RETURN_REASONS: Readonly<Record<string, string>> = {
  DAMAGED: 'Damaged in transit',
  DEFECTIVE: 'Faulty goods',
  WRONG_ITEM: 'Wrong item delivered',
  OVER_DELIVERED: 'More than was ordered',
  EXPIRED: 'Expired or short-dated',
  OTHER: 'Other',
};

const ITEM_COLUMNS = `"id", "purchase_order_id", "variant_id", "quantity_ordered", "quantity_received",
  "quantity_returned", "unit_cost", "discount", "tax_rate", "line_total"`;

@Injectable()
export class PurchaseDocuments {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  /** The variants a set of order lines name, each with its product's name, and their labels. */
  private async variants(q: Queryable, variantIds: string[]) {
    const unique = [...new Set(variantIds)];
    const rows = unique.length
      ? await q.query<VariantInfo>(
          `SELECT v."id", v."sku", v."name", p."name" AS "product_name"
             FROM "catalog_productvariant" v
             INNER JOIN "catalog_product" p ON (v."product_id" = p."id")
            WHERE v."id" = ANY($1::uuid[])`,
          [unique],
        )
      : [];
    const links = await this.payloads.links(unique, q);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      of: (id: string) => byId.get(id) as VariantInfo,
      label: (id: string) =>
        this.payloads.label({ id, name: byId.get(id)?.name ?? '' } as VariantRow, links),
    };
  }

  private async emails(q: Queryable, ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (!unique.length) return new Map();
    const rows = await q.query<{ id: string; email: string }>(
      `SELECT "id", "email" FROM "accounts_user" WHERE "id" = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((row) => [row.id, row.email]));
  }

  /** The order lines a document's lines point at, whichever order they are on. */
  private async orderItems(q: Queryable, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await q.query<{ id: string; variant_id: string }>(
      `SELECT "id", "variant_id" FROM "purchasing_purchaseorderitem" WHERE "id" = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((row) => [row.id, row.variant_id]));
  }

  private async lines(
    q: Queryable,
    table: string,
    parent: string,
    ids: string[],
  ): Promise<DocumentLine[]> {
    if (!ids.length) return [];
    const sql = new SqlParams();
    return q.query<DocumentLine>(
      `SELECT "id", "${parent}" AS "document_id", "purchase_order_item_id", "quantity", "unit_cost"
         FROM "${table}" WHERE "${table}"."${parent}" IN ${sql.list(ids, 'uuid')}`,
      sql.values,
    );
  }

  /** `PurchaseReceiptSerializer(receipts, many=True).data`, in the order given. */
  async receipts(q: Queryable, receipts: ReceiptRow[]) {
    const lines = await this.lines(
      q,
      'purchasing_purchasereceiptitem',
      'receipt_id',
      receipts.map((receipt) => receipt.id),
    );
    const items = await this.orderItems(
      q,
      lines.map((line) => line.purchase_order_item_id),
    );
    const variants = await this.variants(q, [...items.values()]);
    const emails = await this.emails(
      q,
      receipts.map((receipt) => receipt.received_by_id),
    );
    return receipts.map((receipt) => ({
      id: receipt.id,
      number: receipt.number,
      purchase_order: receipt.purchase_order_id,
      received_at: this.iso(receipt.received_at),
      received_by: receipt.received_by_id,
      received_by_email: receipt.received_by_id ? (emails.get(receipt.received_by_id) ?? '') : '',
      notes: receipt.notes,
      is_posted: receipt.is_posted,
      items: lines
        .filter((line) => line.document_id === receipt.id)
        .map((line) => ({
          id: line.id,
          purchase_order_item: line.purchase_order_item_id,
          sku: variants.of(items.get(line.purchase_order_item_id) as string).sku,
          quantity: line.quantity,
          unit_cost: line.unit_cost,
        })),
    }));
  }

  /** `PurchaseReturnSerializer(returns, many=True).data`, in the order given. */
  async returns(q: Queryable, returns: ReturnRow[]) {
    const lines = await this.lines(
      q,
      'purchasing_purchasereturnitem',
      'purchase_return_id',
      returns.map((row) => row.id),
    );
    const items = await this.orderItems(
      q,
      lines.map((line) => line.purchase_order_item_id),
    );
    const variants = await this.variants(q, [...items.values()]);
    const emails = await this.emails(
      q,
      returns.map((row) => row.returned_by_id),
    );
    return returns.map((row) => ({
      id: row.id,
      number: row.number,
      purchase_order: row.purchase_order_id,
      reason: row.reason,
      reason_label: RETURN_REASONS[row.reason] ?? row.reason,
      notes: row.notes,
      returned_at: this.iso(row.returned_at),
      returned_by_email: row.returned_by_id ? (emails.get(row.returned_by_id) ?? '') : '',
      credit_total: row.credit_total,
      items: lines
        .filter((line) => line.document_id === row.id)
        .map((line) => {
          const variantId = items.get(line.purchase_order_item_id) as string;
          return {
            id: line.id,
            purchase_order_item: line.purchase_order_item_id,
            sku: variants.of(variantId).sku,
            product_name: variants.of(variantId).product_name,
            variant_label: variants.label(variantId),
            quantity: line.quantity,
            unit_cost: line.unit_cost,
          };
        }),
      created_at: this.iso(row.created_at),
    }));
  }

  receiptRows(q: Queryable, where: string, values: unknown[]): Promise<ReceiptRow[]> {
    return q.query<ReceiptRow>(
      `SELECT "id", "number", "purchase_order_id", "received_at", "received_by_id", "notes",
              "is_posted"
         FROM "purchasing_purchasereceipt" WHERE ${where}`,
      values,
    );
  }

  returnRows(q: Queryable, where: string, values: unknown[]): Promise<ReturnRow[]> {
    return q.query<ReturnRow>(
      `SELECT "id", "created_at", "number", "purchase_order_id", "reason", "notes", "returned_at",
              "returned_by_id", "credit_total"
         FROM "purchasing_purchasereturn" WHERE ${where}`,
      values,
    );
  }

  /** `PurchaseOrderSerializer(orders, many=True).data`, in the order given. */
  async orders(rows: PurchaseOrderRow[], q: Queryable = this.db) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const sql = new SqlParams();
    const within = `IN ${sql.list(ids, 'uuid')}`;
    const items = await q.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM "purchasing_purchaseorderitem"
        WHERE "purchasing_purchaseorderitem"."purchase_order_id" ${within}`,
      sql.values,
    );
    const variants = await this.variants(
      q,
      items.map((item) => item.variant_id),
    );
    const receiptRows = await this.receiptRows(
      q,
      `"purchasing_purchasereceipt"."purchase_order_id" ${within}
        ORDER BY "purchasing_purchasereceipt"."received_at" DESC`,
      sql.values,
    );
    const receipts = await this.receipts(q, receiptRows);
    const returnRows = await this.returnRows(
      q,
      `"purchasing_purchasereturn"."purchase_order_id" ${within}
        ORDER BY "purchasing_purchasereturn"."returned_at" DESC`,
      sql.values,
    );
    const returns = await this.returns(q, returnRows);
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      supplier: row.supplier_id,
      supplier_name: row.supplier_name,
      branch: row.branch_id,
      branch_code: row.branch_code,
      status: row.status,
      payment_status: row.payment_status,
      invoice_number: row.invoice_number,
      ordered_at: this.iso(row.ordered_at),
      expected_at: row.expected_at,
      completed_at: this.iso(row.completed_at),
      subtotal: row.subtotal,
      discount_total: row.discount_total,
      tax_total: row.tax_total,
      shipping_total: row.shipping_total,
      grand_total: row.grand_total,
      paid_total: row.paid_total,
      credited_total: row.credited_total,
      // The agreed total, less cash paid and credit taken: below zero once
      // goods go back on an order already paid.
      outstanding: money(new Dec(row.grand_total).minus(row.paid_total).minus(row.credited_total)),
      currency: row.currency,
      notes: row.notes,
      items: items
        .filter((item) => item.purchase_order_id === row.id)
        .map((item) => ({
          id: item.id,
          variant: item.variant_id,
          sku: variants.of(item.variant_id).sku,
          product_name: variants.of(item.variant_id).product_name,
          variant_label: variants.label(item.variant_id),
          quantity_ordered: item.quantity_ordered,
          quantity_received: item.quantity_received,
          quantity_returned: item.quantity_returned,
          quantity_outstanding: item.quantity_ordered - item.quantity_received,
          unit_cost: item.unit_cost,
          discount: item.discount,
          tax_rate: item.tax_rate,
          line_total: item.line_total,
        })),
      receipts: receipts.filter((receipt) => receipt.purchase_order === row.id),
      returns: returns.filter((entry) => entry.purchase_order === row.id),
      created_at: this.iso(row.created_at),
    }));
  }

  /** One order by id, as a write answers with it. */
  async order(id: string, q: Queryable = this.db) {
    const row = (await q.one<PurchaseOrderRow>(
      `SELECT ${PO_SELECT} ${PO_FROM} WHERE ${PO}."id" = $1 LIMIT 21`,
      [id],
    )) as PurchaseOrderRow;
    return (await this.orders([row], q))[0] as Record<string, unknown>;
  }

  /**
   * `get_unpublished_products`: the products on this order a shopper cannot
   * see yet, with whether each could be published -- an active variant priced
   * above zero, the test `publish_product` applies.
   */
  async unpublishedProducts(orderId: string) {
    const rows = await this.db.query<{
      id: string;
      name: string;
      slug: string;
      status: string;
      published: boolean;
      variant_count: string;
      priced_variant_count: string;
    }>(
      `SELECT DISTINCT "catalog_product"."id", "catalog_product"."name", "catalog_product"."slug",
              "catalog_product"."status", "catalog_product"."published",
              COUNT(DISTINCT "catalog_productvariant"."id")
                FILTER (WHERE "catalog_productvariant"."status" = 'ACTIVE') AS "variant_count",
              COUNT(DISTINCT "catalog_productvariant"."id")
                FILTER (WHERE ("catalog_productvariant"."price" > 0
                               AND "catalog_productvariant"."status" = 'ACTIVE'))
                AS "priced_variant_count"
         FROM "catalog_product"
         LEFT OUTER JOIN "catalog_productvariant"
           ON ("catalog_product"."id" = "catalog_productvariant"."product_id")
         LEFT OUTER JOIN "purchasing_purchaseorderitem"
           ON ("catalog_productvariant"."id" = "purchasing_purchaseorderitem"."variant_id")
        WHERE ("purchasing_purchaseorderitem"."purchase_order_id" = $1
               AND NOT ("catalog_product"."published" AND "catalog_product"."status" = 'ACTIVE'))
        GROUP BY "catalog_product"."id" ORDER BY "catalog_product"."name" ASC`,
      [orderId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      published: row.published,
      variant_count: Number(row.variant_count),
      priced_variant_count: Number(row.priced_variant_count),
      can_publish: Number(row.priced_variant_count) > 0,
    }));
  }
}
