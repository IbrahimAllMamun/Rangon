/**
 * Purchase-order arithmetic for the admin screens.
 *
 * This is a *preview* of what the server will compute, never the authority:
 * `POST /purchase-orders/` recalculates every figure from the lines it is sent
 * (`purchasing.services.recalculate_totals`) and the response replaces whatever
 * was shown here. The point of duplicating it is that a buyer must see the
 * grand total before committing the order, not after.
 *
 * It therefore has to agree with the server exactly, including the rounding.
 * The server quantises **per line** — `quantize(unit_cost * quantity)` — and
 * sums the quantised values, so summing first and rounding once would drift by
 * a paisa on some orders. `quantize` here mirrors that.
 */

/** Money as the API speaks it: a decimal string with two places. */
export type Money = string;

export interface DraftLine {
  /** Stable key for React; not sent to the API. */
  key: string;
  variantId: string;
  sku: string;
  productName: string;
  variantLabel: string;
  quantity: string;
  unitCost: string;
  discount: string;
}

export interface LineTotals {
  gross: number;
  discount: number;
  net: number;
}

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  shipping: number;
  grandTotal: number;
  lineCount: number;
  unitCount: number;
}

/** Two decimal places, half-up — the same shape as the backend's `quantize`. */
export function quantize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** A blank number field means zero, not NaN. */
function num(value: string): number {
  if (value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function lineTotals(line: DraftLine): LineTotals {
  const gross = quantize(num(line.unitCost) * num(line.quantity));
  const discount = quantize(num(line.discount));
  return { gross, discount, net: quantize(gross - discount) };
}

/**
 * Order totals.
 *
 * Tax is deliberately absent: `tax_rate` sits on the line and defaults to zero,
 * and the VAT decision is still open (business-rules.md §3.4). Showing a tax row
 * that is always zero would imply the question had been answered.
 */
export function orderTotals(lines: DraftLine[], shipping: string): OrderTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let unitCount = 0;

  for (const line of lines) {
    const totals = lineTotals(line);
    subtotal += totals.gross;
    discountTotal += totals.discount;
    unitCount += num(line.quantity);
  }

  const shippingValue = quantize(num(shipping));
  return {
    subtotal: quantize(subtotal),
    discountTotal: quantize(discountTotal),
    shipping: shippingValue,
    grandTotal: quantize(subtotal - discountTotal + shippingValue),
    lineCount: lines.length,
    unitCount,
  };
}

export interface LineProblem {
  key: string;
  message: string;
}

/**
 * What the API would refuse, checked before the round trip.
 *
 * The server is still the authority — it re-validates all of this — but a buyer
 * should not have to submit a twelve-line order to be told line four has no
 * quantity.
 */
export function validateLines(lines: DraftLine[]): LineProblem[] {
  const problems: LineProblem[] = [];
  const seen = new Map<string, string>();

  for (const line of lines) {
    const quantity = num(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      problems.push({ key: line.key, message: "Quantity must be a whole number of 1 or more." });
    }
    if (num(line.unitCost) < 0) {
      problems.push({ key: line.key, message: "Unit cost cannot be negative." });
    }
    const totals = lineTotals(line);
    if (totals.discount > totals.gross) {
      problems.push({ key: line.key, message: "Discount cannot exceed the line total." });
    }
    // `purchasing_poi_uniq` is a database constraint on (purchase_order,
    // variant), so a duplicate variant fails with an opaque 409. Catch it here.
    const duplicate = seen.get(line.variantId);
    if (duplicate) {
      problems.push({
        key: line.key,
        message: "This variant is already on the order — change its quantity instead.",
      });
    } else {
      seen.set(line.variantId, line.key);
    }
  }
  return problems;
}

/** The payload `POST /purchase-orders/` expects. */
export function toCreatePayload(lines: DraftLine[]) {
  return lines.map((line) => ({
    variant: line.variantId,
    quantity: Number(line.quantity),
    unit_cost: line.unitCost === "" ? "0" : line.unitCost,
    discount: line.discount === "" ? "0" : line.discount,
  }));
}

/* ------------------------------------------------------------- receiving -- */

export interface OrderItem {
  id: string;
  variant: string;
  sku: string;
  product_name: string;
  variant_label: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_outstanding: number;
  unit_cost: Money;
  discount: Money;
  line_total: Money;
}

export interface ReceiveDraft {
  itemId: string;
  quantity: string;
  unitCost: string;
}

/**
 * The receipt a buyer most often wants: everything still outstanding, at the
 * cost that was ordered. Fully received lines are dropped rather than shown as
 * zero — the database refuses `quantity_received > quantity_ordered`, so a line
 * with nothing outstanding has nothing to offer.
 */
export function defaultReceipt(items: OrderItem[]): ReceiveDraft[] {
  return items
    .filter((item) => item.quantity_outstanding > 0)
    .map((item) => ({
      itemId: item.id,
      quantity: String(item.quantity_outstanding),
      unitCost: item.unit_cost,
    }));
}

export interface ReceiveProblem {
  itemId: string;
  message: string;
}

export function validateReceipt(
  drafts: ReceiveDraft[],
  items: OrderItem[],
): ReceiveProblem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const problems: ReceiveProblem[] = [];

  for (const draft of drafts) {
    const quantity = num(draft.quantity);
    if (quantity === 0) continue; // receiving nothing on a line is allowed
    const item = byId.get(draft.itemId);
    if (!item) continue;

    if (!Number.isInteger(quantity) || quantity < 0) {
      problems.push({ itemId: draft.itemId, message: "Quantity must be a whole number." });
      continue;
    }
    if (quantity > item.quantity_outstanding) {
      problems.push({
        itemId: draft.itemId,
        message: `Only ${item.quantity_outstanding} outstanding — receiving more would breach the order.`,
      });
    }
    if (num(draft.unitCost) < 0) {
      problems.push({ itemId: draft.itemId, message: "Unit cost cannot be negative." });
    }
  }
  return problems;
}

/**
 * The payload `POST /purchase-orders/{id}/receive/` expects, dropping lines
 * receiving nothing.
 *
 * `unit_cost` is sent only when it differs from what was ordered: it feeds the
 * weighted-average cost recalculation (ADR-0006), so resending an unchanged
 * figure is noise, and sending a *wrong* one silently moves every future margin.
 */
export function toReceivePayload(drafts: ReceiveDraft[], items: OrderItem[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return drafts
    .filter((draft) => num(draft.quantity) > 0)
    .map((draft) => {
      const ordered = byId.get(draft.itemId)?.unit_cost;
      const changed = ordered !== undefined && num(draft.unitCost) !== num(ordered);
      return {
        item: draft.itemId,
        quantity: Number(draft.quantity),
        ...(changed ? { unit_cost: draft.unitCost } : {}),
      };
    });
}

/** Value of a receipt, so the dialog can state what is about to hit the ledger. */
export function receiptValue(drafts: ReceiveDraft[]): number {
  return quantize(
    drafts.reduce((total, draft) => total + quantize(num(draft.quantity) * num(draft.unitCost)), 0),
  );
}
