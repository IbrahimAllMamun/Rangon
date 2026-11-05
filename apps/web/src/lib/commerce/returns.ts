/**
 * A customer bringing goods back is always a return (business rules 2.4):
 * what each returned unit is decided to be, why it came back, and the request
 * the order page and the counter send for it.
 */

export type ReturnDecision = "RESTOCK" | "DAMAGED";

/**
 * What staff choose for each returned line. Only RESTOCK puts it back into
 * sellable stock; a damaged item goes back to the supplier, who credits it
 * (Purchases → Damaged returns). Quarantine is still read on old returns but
 * is not offered: the shop's goods either go back on the shelf or back to the
 * supplier.
 */
export const RETURN_DECISIONS: { value: ReturnDecision; label: string; hint: string }[] = [
  { value: "RESTOCK", label: "Back on the shelf", hint: "Sellable again: stock goes up." },
  {
    value: "DAMAGED",
    label: "Damaged, back to the supplier",
    hint: "Not sellable. Waits in Damaged returns until it goes back to the supplier for credit.",
  },
];

/** The API's reasons (`RETURN_REASONS`), in the words staff read. */
export const RETURN_REASONS: { value: string; label: string }[] = [
  { value: "WRONG_SIZE", label: "Wrong size" },
  { value: "DEFECTIVE", label: "Faulty" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRONG_PRODUCT", label: "Wrong product" },
  { value: "CUSTOMER_CHANGED_MIND", label: "Changed their mind" },
  { value: "OTHER", label: "Other" },
];

/** Reasons that are the shop's fault: the goods cannot go back on the shelf by default. */
const SHOP_FAULT = new Set(["DEFECTIVE", "DAMAGED"]);

/** What a reason suggests for the goods, before anyone has looked at them. */
export function defaultDecision(reason: string): ReturnDecision {
  return SHOP_FAULT.has(reason) ? "DAMAGED" : "RESTOCK";
}

export interface ReturnableLine {
  id: string;
  returnable_quantity: number;
}

export interface LineChoice {
  quantity: number;
  decision: ReturnDecision;
}

export interface ReturnLineRequest {
  order_item: string;
  quantity: number;
  restock_decision: ReturnDecision;
}

/**
 * The lines a return asks for: every line with a whole quantity above nothing
 * and no more than can still come back. A quantity beyond that is clamped
 * rather than sent: the API would refuse it, and the screen shows the limit.
 */
export function returnLines(
  lines: readonly ReturnableLine[],
  choices: Readonly<Record<string, LineChoice | undefined>>,
): ReturnLineRequest[] {
  const out: ReturnLineRequest[] = [];
  for (const line of lines) {
    const choice = choices[line.id];
    if (!choice) continue;
    const quantity = Math.min(Math.floor(choice.quantity), line.returnable_quantity);
    if (!(quantity > 0)) continue;
    out.push({ order_item: line.id, quantity, restock_decision: choice.decision });
  }
  return out;
}

/** An order's goods can come back once they have left the shop. */
export function canReturn(order: { status: string; items: readonly ReturnableLine[] }): boolean {
  const left = ["SHIPPED", "DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(order.status);
  return left && order.items.some((item) => item.returnable_quantity > 0);
}

/** An order number as a receipt's barcode carries it (`RGN-POS-000123`). */
export const ORDER_NUMBER = /^RGN-(POS|WEB)-\d+$/i;
