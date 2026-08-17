# Orders

One `Order` table serves every channel. `channel` distinguishes them; `branch` records where the sale
happened or will be fulfilled from.

## Fields that matter

```text
Order
  number            RGN-POS-000123 / RGN-WEB-000456   (row-locked sequence, never count()+1)
  channel           POS | ONLINE | PHONE | SOCIAL | OTHER
  status            PENDING…REFUNDED (see machine below)
  payment_status    UNPAID | PARTIALLY_PAID | PAID | REFUNDED | PARTIALLY_REFUNDED
  branch, customer, created_by (staff, null for self-service online)
  subtotal, discount_total, coupon_discount, manual_discount,
  tax_total, shipping_total, grand_total, paid_total, refunded_total   (all Decimal(14,2))
  currency, coupon, shipping_address (snapshot JSON), billing_address (snapshot JSON)
  register (POS), idempotency_key (online), notes, placed_at, cancelled_at, cancel_reason

OrderItem
  order, variant, sku, product_name, variant_label      ← name/SKU snapshotted at sale time
  quantity, unit_price, unit_cost, line_discount, tax_amount, line_total
  fulfilled_quantity, returned_quantity
```

Addresses and product names are **snapshots**: renaming a product later must not rewrite history.

## Status machine

```python
ALLOWED = {
  PENDING:          {CONFIRMED, CANCELLED},
  CONFIRMED:        {PROCESSING, CANCELLED},
  PROCESSING:       {PACKED, CANCELLED},
  PACKED:           {SHIPPED, DELIVERED},          # DELIVERED direct = counter pickup
  SHIPPED:          {DELIVERED, RETURN_REQUESTED},
  DELIVERED:        {RETURN_REQUESTED},
  RETURN_REQUESTED: {RETURNED, DELIVERED},         # back to DELIVERED if the return is rejected
  RETURNED:         {REFUNDED},
  REFUNDED:         set(),
  CANCELLED:        set(),
}
```

`orders.services.lifecycle.transition(order, to_status, actor, reason="")`:
validates the edge, applies the stock side effect for that edge, writes an `OrderEvent`, writes an audit
entry, and dispatches notifications after commit. Anything else raises
`INVALID_STATUS_TRANSITION`.

Stock side effects by edge:

| Edge | Inventory |
|---|---|
| create (ONLINE) | `RESERVATION` |
| `PROCESSING → PACKED` | `RESERVATION_RELEASE` + `SALE` (atomic) |
| `→ CANCELLED` before `PACKED` | `RESERVATION_RELEASE`, coupon usage released |
| create (POS) | `SALE` immediately, order created at `DELIVERED` |
| return `RECEIVED` with `RESTOCK` | `RETURN` |

## Services

```text
orders/services/pos.py        create_pos_sale(), hold_sale(), resume_sale(), void_sale()
orders/services/checkout.py   price_cart(), validate_cart(), place_order()
orders/services/lifecycle.py  transition(), cancel_order()
orders/services/payments.py   record_payment(), capture(), refund()
orders/services/returns.py    request_return(), approve(), reject(), receive(), complete_refund()
orders/services/pricing.py    line/order maths, rounding, coupon application, tax
```

`pricing.py` is the only place order maths lives; POS and online checkout both call it, so a POS
receipt and a web invoice can never disagree about how a total is computed.

## Timeline

`OrderEvent(order, event_type, message, data, actor, created_at)` is append-only and drives both the
admin timeline and the customer's tracking page. Event types include `CREATED`, `STATUS_CHANGED`,
`PAYMENT_RECORDED`, `PAYMENT_CAPTURED`, `REFUND_ISSUED`, `SHIPMENT_CREATED`, `SHIPMENT_EVENT`,
`RETURN_REQUESTED`, `NOTE_ADDED`, `CANCELLED`.

## Idempotency

`POST /api/v1/shop/checkout/` requires an `Idempotency-Key` header. The key is stored on the order under
a unique constraint; a repeat call inside the retention window returns the existing order with `200`
instead of creating a second one. A double-clicked checkout button therefore cannot produce two orders,
and `tests/test_concurrency.py::test_double_click_checkout_creates_one_order` proves it.

## Documents

- **Receipt** (POS, 80 mm thermal-friendly print CSS)
- **Invoice** (A4)
- **Packing slip** (A4, no prices)

All three render from the same order data in `apps/web/src/components/documents/`, printed through the
browser print dialog with `@media print` rules. A native ESC/POS driver is a future addition behind
`lib/printing/driver.ts`.
