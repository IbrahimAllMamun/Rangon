# Domain Model

## Aggregates and their invariants

| Aggregate | Root | Invariant the root protects |
|---|---|---|
| Organisation | `Organization` | one active org in V1; branches belong to exactly one org |
| Catalog item | `Product` | a product has ≥1 variant; variant SKU/barcode unique org-wide |
| Stock position | `Inventory` (branch × variant) | `on_hand ≥ 0`, `reserved ≥ 0`, `available = on_hand − reserved`, cached columns equal the ledger sum |
| Purchase | `PurchaseOrder` | received quantity ≤ ordered quantity; receiving writes ledger rows exactly once |
| Sale | `Order` | totals equal the recomputed line maths; status transitions follow the machine; payments ≤ total; refunds ≤ captured |
| Return | `ReturnRequest` | returned qty ≤ sold qty − already returned qty; refund ≤ captured − refunded |
| Shipment | `Shipment` | belongs to one order; events are append-only |

## Entity relationships (text form)

```text
Organization 1─n Branch
Organization 1─n User            User n─1 Role            Role n─n Permission
Branch       1─n Inventory       Branch 1─n Order         Branch 1─n PurchaseOrder

Category  1─n Category (self, tree)      Category 1─n Product
Brand     1─n Product
Product   1─n ProductVariant             Product  1─n ProductImage
Product   n─n Attribute  (through ProductAttributeAssignment on the category)
ProductVariant 1─n VariantAttributeValue → AttributeValue → Attribute
ProductVariant 1─n Inventory             ProductVariant 1─n ProductImage (optional variant image)

Supplier  1─n PurchaseOrder
PurchaseOrder 1─n PurchaseOrderItem      PurchaseOrder 1─n PurchaseReceipt
PurchaseReceipt 1─n PurchaseReceiptItem → InventoryTransaction(PURCHASE)
Supplier  1─n SupplierPayment

Customer 1─n CustomerAddress             Customer 1─n CustomerNote
Customer 1─n Order                       Customer 1─n Cart          Customer 1─n Wishlist

Cart 1─n CartItem → ProductVariant

Order 1─n OrderItem → ProductVariant
Order 1─n Payment  1─n Refund
Order 1─n OrderEvent            (timeline, append-only)
Order 1─n Shipment 1─n ShipmentEvent
Order 1─n ReturnRequest 1─n ReturnItem → OrderItem
Order n─1 Coupon (optional)     Coupon 1─n CouponRedemption

ProductVariant 1─n InventoryTransaction  (ledger, append-only)
InventoryTransaction n─1 Branch
StockTransfer 1─n StockTransferItem → 2 InventoryTransaction rows

Review n─1 Product, n─1 Customer, n─1 Order (verification)
AuditLog → (actor, entity_type, entity_id)     Notification → User
```

## Product vs variant

A **Product** is the concept the customer browses ("Men's Polo Shirt"). A **ProductVariant** is the
sellable, stocked, barcoded SKU. Only variants have price, cost, barcode and stock.

```text
Product: Men's Polo Shirt
  ├── RGN-POL-BLK-M   Black / M   ৳1,290
  ├── RGN-POL-BLK-L   Black / L   ৳1,290
  ├── RGN-POL-WHT-M   White / M   ৳1,290
  └── RGN-POL-WHT-L   White / L   ৳1,350
```

## Dynamic attributes

Category-specific properties are **data, not columns**. `Attribute` (Size, Color, Shade, Volume,
Material, Capacity, Gender, Fit, …) has `AttributeValue` rows; a category declares which attributes it
uses and which are variant-defining; a variant records its values through `VariantAttributeValue`.

```text
Clothing  → Size*, Color*, Material, Gender, Fit
Shoes     → Size*, Color*, Material, Gender
Cosmetics → Shade*, Volume*, Batch, Expiry
Bags      → Color*, Capacity, Material
(* variant-defining)
```

Cosmetics batch/expiry are stored on the variant as first-class optional fields
(`batch_number`, `expiry_date`) because they drive expiry reporting, not just filtering.

## Order lifecycle

```text
                 ┌──────────────── CANCELLED ◄──────────┐
                 │                                      │
PENDING ──► CONFIRMED ──► PROCESSING ──► PACKED ──► SHIPPED ──► DELIVERED
   │                                        │                       │
   └── (reservation expiry) ────────────────┘                       ▼
                                                       RETURN_REQUESTED ──► RETURNED ──► REFUNDED
```

POS sales are created directly at `DELIVERED`. Channel is recorded on every order
(`POS | ONLINE | PHONE | SOCIAL | OTHER`).

## Inventory lifecycle

```text
PurchaseOrder(DRAFT→SENT) ──receive──► PURCHASE (+)  ──► on_hand ↑, average_cost recalculated
Online order created      ──────────► RESERVATION (+reserved)
Order PACKED              ──────────► RESERVATION_RELEASE (−reserved) + SALE (−on_hand)
POS sale                  ──────────► SALE (−on_hand)
Return RESTOCK            ──────────► RETURN (+on_hand)
Return DAMAGED/QUARANTINE ──────────► no ledger row (recorded on the return line)
Stock count difference    ──────────► ADJUSTMENT (±) with reason
Damage / theft            ──────────► DAMAGE / LOSS (−)
Branch transfer           ──────────► TRANSFER_OUT (−) at source + TRANSFER_IN (+) at destination
```

## Purchase lifecycle

```text
DRAFT → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED
             ↘ CANCELLED
```

Receiving is the only step that touches inventory, and it is idempotent per receipt.

## Payment lifecycle

```text
PENDING → AUTHORIZED → CAPTURED → (REFUNDED | PARTIALLY_REFUNDED)
        ↘ FAILED       ↘ VOIDED
```

Cash and card-terminal payments at the POS are created directly as `CAPTURED`. COD is created `PENDING`
and captured when the courier remits.

## Return lifecycle

```text
REQUESTED → APPROVED → RECEIVED → COMPLETED
          ↘ REJECTED
```

## User / permission model

```text
User ──► Role ──► Permission (code strings)
User ──► Organization, Branch (scope)
```

`OWNER` bypasses permission checks. Everyone else is checked against explicit codes and branch scope.
Customers are `User` rows with role `CUSTOMER` linked 1–1 to a `Customer` record.

## Multi-branch model

```text
Organization
  └── Branch (code, address, phone, register count)
        ├── Inventory (per variant)
        ├── Orders (POS orders belong to the selling branch; online orders to the fulfilling branch)
        └── PurchaseOrders / Transfers
```

V1 runs one branch, but nothing in the schema or the services assumes it.

## Online checkout lifecycle

```text
Cart (server-priced)
  → address selection (or guest address)
  → shipping method (zone-matched, server-priced)
  → payment method (COD | gateway)
  → review (server totals, final stock check)
  → POST /shop/checkout with Idempotency-Key
      → atomic: re-price, re-check stock, reserve, create order + payment, redeem coupon
  → COD: CONFIRMED   |   gateway: PENDING → provider → webhook → CAPTURED → CONFIRMED
  → confirmation page + notification
```
