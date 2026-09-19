/**
 * Pure helpers for the audit log screen (`/admin/audit`).
 *
 * Kept out of the page so a server component can call them and vitest can pin
 * them — see the note at the top of `lib/paging.ts`.
 */
import type { AuditEntry } from "@/lib/api/types";

/**
 * `core.models.AuditAction`, for the filter. Rows carry their own
 * `action_label` from the API, so an action added there and not here still
 * reads correctly — it is only missing from this dropdown.
 */
export const AUDIT_ACTIONS: { value: string; label: string }[] = [
  { value: "CREATE", label: "Create" },
  { value: "UPDATE", label: "Update" },
  { value: "DELETE", label: "Delete" },
  { value: "LOGIN", label: "Login" },
  { value: "LOGIN_FAILED", label: "Login failed" },
  { value: "LOGOUT", label: "Logout" },
  { value: "PERMISSION_ELEVATION", label: "Permission elevation" },
  { value: "STOCK_ADJUSTMENT", label: "Stock adjustment" },
  { value: "STOCK_TRANSFER", label: "Stock transfer" },
  { value: "PURCHASE_RECEIVED", label: "Purchase received" },
  { value: "SALE_CREATED", label: "Sale created" },
  { value: "ORDER_STATUS_CHANGED", label: "Order status changed" },
  { value: "ORDER_CANCELLED", label: "Order cancelled" },
  { value: "PAYMENT_RECORDED", label: "Payment recorded" },
  { value: "EXPENSE_RECORDED", label: "Expense recorded" },
  { value: "EXPENSE_VOIDED", label: "Expense voided" },
  { value: "REFUND_ISSUED", label: "Refund issued" },
  { value: "DISCOUNT_OVERRIDE", label: "Discount override" },
  { value: "PRICE_OVERRIDE", label: "Price override" },
  { value: "SETTINGS_CHANGED", label: "Settings changed" },
  { value: "USER_CHANGED", label: "User changed" },
  { value: "PRODUCT_IMPORT", label: "Product import" },
];

/** `PurchaseOrder` → "Purchase order". The API stores the model's class name. */
export function entityName(type: string): string {
  if (!type) return "—";
  const words = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Record types with a screen of their own, and what it takes to open one. */
const ENTITY_SCREENS: Record<string, { path: string; permission: string }> = {
  Order: { path: "/admin/orders", permission: "orders.view" },
  ReturnRequest: { path: "/admin/returns", permission: "orders.view" },
  PurchaseOrder: { path: "/admin/purchases", permission: "purchases.view" },
  Product: { path: "/admin/products", permission: "products.view" },
  Customer: { path: "/admin/customers", permission: "customers.view" },
  Account: { path: "/admin/finance", permission: "finance.view" },
  StockCount: { path: "/admin/inventory/counts", permission: "inventory.view" },
};

/**
 * Where the audited record can be opened, if it has a screen and the reader may
 * open it. A payment or a refund is recorded against its own id, which no
 * screen takes, so it is named and not linked — a guessed link on a trail
 * people rely on is worse than none.
 */
export function entityHref(
  entry: Pick<AuditEntry, "entity_type" | "entity_id">,
  can: (permission: string) => boolean,
): string | null {
  const screen = ENTITY_SCREENS[entry.entity_type];
  if (!screen || !entry.entity_id || !can(screen.permission)) return null;
  return `${screen.path}/${entry.entity_id}`;
}

export interface FieldChange {
  field: string;
  /** `null` where the side has no value — shown as a dash, not as "null". */
  before: string | null;
  after: string | null;
}

function show(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * The before/after pairs of one entry, in the order the service wrote them.
 *
 * Most entries carry only what changed (`audit.diff`), but some carry a full
 * snapshot on one side, so a key present on one side only is still a row.
 */
export function changedFields(
  oldValues: Record<string, unknown> | null | undefined,
  newValues: Record<string, unknown> | null | undefined,
): FieldChange[] {
  const before = oldValues ?? {};
  const after = newValues ?? {};
  const fields = [...Object.keys(before), ...Object.keys(after).filter((key) => !(key in before))];
  return fields.map((field) => ({
    field,
    before: show(before[field]),
    after: show(after[field]),
  }));
}
