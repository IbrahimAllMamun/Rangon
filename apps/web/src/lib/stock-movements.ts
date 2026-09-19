/**
 * Pure helpers for the stock-movements screen (`/admin/inventory/movements`).
 *
 * Kept out of the page so a server component can call them and vitest can pin
 * them — see the note at the top of `lib/paging.ts` for why that matters.
 */
import type { LedgerDocument, StockMovementType } from "@/lib/api/types";

interface Family {
  /** The value in the page's `?family=` — readable in a shared link. */
  value: string;
  label: string;
  types: StockMovementType[];
}

/**
 * The ledger's eleven types, grouped by what a person is looking for.
 *
 * Damage and loss are both "written off"; a transfer is one movement seen from
 * two branches. The API filters by a list (`types=DAMAGE,LOSS`) for exactly
 * this, so the grouping lives here and not in a twelfth type.
 */
export const MOVEMENT_FAMILIES: Family[] = [
  { value: "", label: "All movements", types: [] },
  { value: "received", label: "Received", types: ["PURCHASE"] },
  { value: "sold", label: "Sold", types: ["SALE"] },
  { value: "returned", label: "Customer returns", types: ["RETURN"] },
  { value: "written-off", label: "Written off", types: ["DAMAGE", "LOSS"] },
  { value: "adjusted", label: "Adjusted", types: ["ADJUSTMENT"] },
  { value: "transferred", label: "Transfers", types: ["TRANSFER_IN", "TRANSFER_OUT"] },
  { value: "to-supplier", label: "Back to supplier", types: ["PURCHASE_RETURN"] },
  { value: "reserved", label: "Reservations", types: ["RESERVATION", "RESERVATION_RELEASE"] },
];

/**
 * The family a URL asked for, or "all" for anything unknown.
 *
 * Narrowed before it reaches an API path, so a hand-edited `?family=` shows
 * everything under the right name rather than an error or a wrong label.
 */
export function resolveFamily(value: string | undefined): Family {
  return MOVEMENT_FAMILIES.find((family) => family.value === value) ?? MOVEMENT_FAMILIES[0];
}

/** The reservation pair moves `reserved`, not `on_hand`. */
export function movesReserved(type: StockMovementType): boolean {
  return type === "RESERVATION" || type === "RESERVATION_RELEASE";
}

/** `+3` / `−2` — the sign spelled out, never left to colour (CLAUDE.md §11). */
export function signedQuantity(quantity: number): string {
  if (quantity > 0) return `+${quantity}`;
  if (quantity < 0) return `−${Math.abs(quantity)}`;
  return "0";
}

/**
 * Where a row's document can be opened, if the reader may open it.
 *
 * A transfer has no screen of its own yet, so it is named and not linked; a
 * link the reader's role cannot follow is a 403 dressed as navigation.
 */
export function documentHref(
  document: LedgerDocument | null,
  can: (permission: string) => boolean,
): string | null {
  if (!document) return null;
  switch (document.kind) {
    case "order":
      return can("orders.view") ? `/admin/orders/${document.id}` : null;
    case "return":
      return can("orders.view") ? `/admin/returns/${document.id}` : null;
    case "purchase_order":
      return can("purchases.view") ? `/admin/purchases/${document.id}` : null;
    case "stock_count":
      return can("inventory.view") ? `/admin/inventory/counts/${document.id}` : null;
    default:
      return null;
  }
}
