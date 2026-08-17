# ADR-0008 — `PurchaseOrder` + `PurchaseReceipt` instead of `PurchaseOrder` + `Purchase`

**Status:** Accepted · 2026-08-17 · Deviates from plan §13

## Context

The plan lists `PurchaseOrder`, `Purchase`, `PurchaseItem` as separate entities. In practice a purchase
order and a purchase invoice hold nearly identical data, and the event that matters to inventory is
**goods actually received**, which may happen in several partial deliveries.

## Decision

```text
PurchaseOrder   (supplier, branch, number, status, expected_date, invoice_number, financial totals)
  └── PurchaseOrderItem   (variant, quantity_ordered, quantity_received, unit_cost, discount, tax)
PurchaseReceipt (purchase_order, number, received_at, received_by, notes)
  └── PurchaseReceiptItem (purchase_order_item, quantity, unit_cost) → InventoryTransaction(PURCHASE)
SupplierPayment (supplier, purchase_order, amount, method, reference, paid_at)
```

`PurchaseOrder.status`: `DRAFT → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED`, or `CANCELLED`.

## Consequences

- Partial deliveries are first-class, which is how apparel suppliers actually deliver.
- Inventory is touched in exactly one place (`inventory.services.receive_purchase`) and receipt
  processing is idempotent per receipt, so a double-clicked "Receive" cannot double-add stock.
- Payment status is derived from `SupplierPayment` rows rather than a mutable flag.
- Cost: one more table than the plan sketched, and "purchase invoice" is a field on the order rather than
  its own entity. Documented here so the deviation is not mistaken for an omission.
