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
  /**
   * True once a buyer has typed in the cost box. Switching supplier re-prices
   * the other lines from the new supplier's list; a figure somebody entered by
   * hand is never overwritten (`purchase-order-form.tsx`).
   */
  costTouched?: boolean;
  /**
   * The product the variant belongs to. Lines are shown grouped by it, and a
   * scan of any one variant brings in the rest of that product.
   */
  productId?: string;
  /** Units the branch holds, as a hint for how many to order. Null when unknown. */
  onHand?: number | null;
}

export interface LineTotals {
  gross: number;
  discount: number;
  net: number;
}

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  /** VAT the supplier charges, summed per line the way the server sums it. */
  taxTotal: number;
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

/**
 * Whether a line is on the order.
 *
 * A scan brings in every variant of the product, and the ones the buyer does
 * not want sit at 0 rather than having to be deleted one by one. Those are not
 * lines of the order: they are neither sent nor counted.
 */
export function isOrdered(line: DraftLine): boolean {
  const quantity = num(line.quantity);
  return Number.isInteger(quantity) && quantity >= 1;
}

export function orderedLines(lines: DraftLine[]): DraftLine[] {
  return lines.filter(isOrdered);
}

export interface LineGroup {
  /** The product's id, or the variant's for a line that came without one. */
  key: string;
  productId: string | null;
  productName: string;
  lines: DraftLine[];
}

/** Lines gathered by product, each product where its first line appears. */
export function groupLines(lines: DraftLine[]): LineGroup[] {
  const groups = new Map<string, LineGroup>();
  for (const line of lines) {
    const key = line.productId ?? `variant:${line.variantId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, productId: line.productId ?? null, productName: line.productName, lines: [] };
      groups.set(key, group);
    }
    group.lines.push(line);
  }
  return [...groups.values()];
}

/**
 * Put more of one product's variants on the order.
 *
 * The product's lines -- those already there and `added` -- are kept together,
 * where the product first appears, in `catalogueOrder`: the product's own
 * order (its variants' positions, then SKU), not the order they were scanned
 * in. A variant already on the order is never added twice.
 */
export function mergeProductLines(
  lines: DraftLine[],
  productId: string,
  added: DraftLine[],
  catalogueOrder: string[],
): DraftLine[] {
  const present = new Set(lines.map((line) => line.variantId));
  const fresh = added.filter((line) => !present.has(line.variantId));
  const rank = new Map(catalogueOrder.map((variantId, index) => [variantId, index]));
  const position = (line: DraftLine) => rank.get(line.variantId) ?? Number.MAX_SAFE_INTEGER;

  const product = [...lines.filter((line) => line.productId === productId), ...fresh].sort(
    (a, b) => position(a) - position(b),
  );
  const first = lines.findIndex((line) => line.productId === productId);
  const others = lines.filter((line) => line.productId !== productId);
  const at =
    first === -1
      ? others.length
      : lines.slice(0, first).filter((line) => line.productId !== productId).length;
  return [...others.slice(0, at), ...product, ...others.slice(at)];
}

/** One more of a variant already on the order: what a second scan means. */
export function bumpQuantity(lines: DraftLine[], variantId: string): DraftLine[] {
  return lines.map((line) => {
    if (line.variantId !== variantId) return line;
    const quantity = num(line.quantity);
    const next = Number.isInteger(quantity) && quantity >= 0 ? quantity + 1 : 1;
    return { ...line, quantity: String(next) };
  });
}

export function lineTotals(line: DraftLine): LineTotals {
  const gross = quantize(num(line.unitCost) * num(line.quantity));
  const discount = quantize(num(line.discount));
  return { gross, discount, net: quantize(gross - discount) };
}

/**
 * A VAT percentage as typed (15) to the fraction the API stores (0.1500).
 *
 * The column, the organisation setting and the API all speak fractions; only
 * the buyer speaks percentages. Four decimal places because `rate_field` has
 * four, so 7.5% survives the trip.
 */
export function vatFraction(percent: string): number {
  const value = num(percent);
  if (value <= 0) return 0;
  return Math.round((value / 100) * 10000) / 10000;
}

/**
 * Order totals, VAT included.
 *
 * Tax used to be absent here on the grounds that `tax_rate` defaulted to zero
 * and nothing could set it — true, and the reason every purchase order ever
 * raised carried `tax_total 0.00` and the VAT return had no input VAT to
 * offset. The buyer can now enter what the supplier charged.
 *
 * The rate is per order rather than per line because a supplier invoice quotes
 * one VAT figure at the bottom; it is *stored* per line, which is where the
 * column lives, so a future mixed-rate order needs no migration.
 *
 * Rounding mirrors `purchasing.services.recalculate_totals` exactly: the tax is
 * quantised **per line** and the quantised values summed. Summing the net first
 * and taxing once drifts by a paisa on some orders, and the server's answer is
 * the one that gets stored.
 */
export function orderTotals(
  lines: DraftLine[],
  shipping: string,
  vatPercent = "",
): OrderTotals {
  const rate = vatFraction(vatPercent);
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let unitCount = 0;

  for (const line of lines) {
    const totals = lineTotals(line);
    subtotal += totals.gross;
    discountTotal += totals.discount;
    taxTotal += quantize(totals.net * rate);
    unitCount += num(line.quantity);
  }

  const shippingValue = quantize(num(shipping));
  return {
    subtotal: quantize(subtotal),
    discountTotal: quantize(discountTotal),
    taxTotal: quantize(taxTotal),
    shipping: shippingValue,
    grandTotal: quantize(subtotal - discountTotal + quantize(taxTotal) + shippingValue),
    // A line left at 0 is not a line of the order (`isOrdered`).
    lineCount: orderedLines(lines).length,
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
    // 0 is allowed: it is how a variant brought in with the rest of its
    // product stays off the order (`isOrdered`). A half unit is not.
    if (!Number.isInteger(quantity) || quantity < 0) {
      problems.push({
        key: line.key,
        message: "Quantity must be a whole number. Leave it at 0 to keep the line off the order.",
      });
    }
    if (num(line.unitCost) < 0) {
      problems.push({ key: line.key, message: "Unit cost cannot be negative." });
    }
    const totals = lineTotals(line);
    if (totals.discount > totals.gross) {
      problems.push({ key: line.key, message: "Discount cannot exceed the line total." });
    }
    // The API refuses a variant named twice as a field error (D82); catching it
    // here saves the round trip and points at the line.
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

/**
 * The payload `POST /purchase-orders/` expects.
 *
 * `tax_rate` goes on every line because that is where the column is; the form
 * asks for it once. The server re-derives `tax_total` from these rates, so the
 * preview above is never what gets stored.
 */
export function toCreatePayload(lines: DraftLine[], vatPercent = "") {
  const rate = vatFraction(vatPercent);
  // Lines left at 0 are the variants the buyer is not ordering: never sent.
  return orderedLines(lines).map((line) => ({
    variant: line.variantId,
    quantity: Number(line.quantity),
    unit_cost: line.unitCost === "" ? "0" : line.unitCost,
    discount: line.discount === "" ? "0" : line.discount,
    tax_rate: rate.toFixed(4),
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
  /** Arrived and already sent back. */
  quantity_returned: number;
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


/* ------------------------------------------------------------------ returns */

export interface ReturnDraft {
  itemId: string;
  quantity: string;
}

/** Arrived and not yet sent back — the most a line can return. */
export function returnableOf(item: OrderItem): number {
  return Math.max(item.quantity_received - (item.quantity_returned ?? 0), 0);
}

/**
 * A blank return: every line that has something to send back, at zero.
 *
 * Unlike `defaultReceipt`, nothing is pre-filled. Receiving the whole delivery
 * is the ordinary case and a sensible default; returning the whole delivery is
 * not, and a form that offers it invites a mis-click that takes real stock off
 * a real shelf.
 */
export function blankReturn(items: OrderItem[]): ReturnDraft[] {
  return items
    .filter((item) => returnableOf(item) > 0)
    .map((item) => ({ itemId: item.id, quantity: "0" }));
}

export function validateReturn(drafts: ReturnDraft[], items: OrderItem[]): ReceiveProblem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const problems: ReceiveProblem[] = [];

  for (const draft of drafts) {
    const quantity = num(draft.quantity);
    if (quantity === 0) continue; // returning nothing on a line is allowed
    const item = byId.get(draft.itemId);
    if (!item) continue;

    if (!Number.isInteger(quantity) || quantity < 0) {
      problems.push({ itemId: draft.itemId, message: "Whole units only." });
      continue;
    }
    const returnable = returnableOf(item);
    if (quantity > returnable) {
      problems.push({
        itemId: draft.itemId,
        message: `Only ${returnable} of ${item.sku} arrived and can still go back.`,
      });
    }
  }
  return problems;
}

/** What the supplier will owe back: the cost they charged, times the units. */
export function returnCredit(drafts: ReturnDraft[], items: OrderItem[]): number {
  const byId = new Map(items.map((item) => [item.id, item]));
  return drafts.reduce((total, draft) => {
    const item = byId.get(draft.itemId);
    if (!item) return total;
    return total + num(draft.quantity) * num(item.unit_cost);
  }, 0);
}

/** Lines only; the credit is the server's to compute from the order (§13). */
export function toReturnPayload(drafts: ReturnDraft[]) {
  return drafts
    .filter((draft) => num(draft.quantity) > 0)
    .map((draft) => ({ item: draft.itemId, quantity: Number(draft.quantity) }));
}
