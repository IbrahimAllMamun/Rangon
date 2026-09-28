/**
 * What a stock correction may do, decided before the API has to refuse it.
 *
 * An adjustment carries no cost: it writes units in at the branch's weighted
 * average. On a branch that has never received the variant that average is
 * the column default of 0.00, so a correction *upwards* there would put stock
 * on the books at nothing — D72, and the reason the product form lost its
 * opening-stock box. `inventory.services._check_can_raise` refuses it with
 * `NOT_RECEIVED`; this lets the screen say so while the figure is being typed
 * (business-rules.md § 4.0a).
 *
 * `received` is `undefined` when the API did not say. The screen then offers
 * the correction and lets the server decide, rather than guessing either way.
 */

export const NEVER_RECEIVED_NOTE =
  "Never received here, so this can only be lowered. Stock comes in by receiving a purchase order.";

export function upwardRefusal(received: boolean | undefined, delta: number): string | null {
  if (delta <= 0 || received !== false) return null;
  return "This has never been received here, so there is no cost to count it in at. Receive it on a purchase order instead.";
}

/** A new purchase order with these variants already on it. */
export function purchaseOrderFor(variantIds: string[]): string {
  const ids = variantIds.filter(Boolean);
  return ids.length
    ? `/admin/purchases/new?variants=${ids.map(encodeURIComponent).join(",")}`
    : "/admin/purchases/new";
}
