# User Acceptance Scenarios

Run these manually against a seeded environment before each release
(`seed_demo --reset`, logins in the README).

## Store owner

| # | Scenario | Pass when |
|---|---|---|
| O1 | Add a product with 3 sizes × 2 colours | 6 variants generated, each with its own SKU and barcode |
| O2 | Create a purchase order for 50 units and receive 30 | stock +30, PO `PARTIALLY_RECEIVED`, average cost updated |
| O3 | Receive the remaining 20 at a higher unit cost | PO `RECEIVED`, average cost is the weighted blend, not the latest cost |
| O4 | View inventory | on hand, reserved, available and stock value are consistent with the ledger |
| O5 | View today's sales | POS and online totals both appear, split by channel |
| O6 | View gross profit | uses frozen `unit_cost`; changing a price now does not change yesterday's profit |
| O7 | Create a cashier, then deactivate them | new cashier can log in; deactivated one cannot, immediately |
| O8 | Try to delete a paid order | refused; only cancel/refund is offered |

## Cashier

| # | Scenario | Pass when |
|---|---|---|
| C1 | Log in at the register | POS opens with branch + register context, focus in the barcode field |
| C2 | Scan 3 items with a USB scanner | each scan adds a line without touching the mouse |
| C3 | Change a quantity, remove a line | totals recompute instantly and match the server on submit |
| C4 | Apply a 10% line discount | allowed; a 30% discount asks for manager elevation |
| C5 | Take split payment (cash + card) | two payment rows, correct change displayed, order `PAID` |
| C6 | Print the receipt | 80 mm layout, branch details, items, totals, order number, VAT line |
| C7 | Hold a sale, start another, resume the held one | both carts intact, no stock moved until each sale completes |
| C8 | Sell the last unit while the website sells it too | exactly one succeeds; the other sees "insufficient stock" |
| C9 | Process a return with a receipt | refund ≤ paid, stock restored on `RESTOCK`, not on `DAMAGED` |
| C10 | Attempt a refund without permission | blocked; manager elevation prompt appears and is audit-logged |

## Customer

| # | Scenario | Pass when |
|---|---|---|
| S1 | Browse the homepage on a phone | hero, categories, new arrivals load; no horizontal scroll |
| S2 | Search "polo" | relevant products; typo "polo shrt" still finds it |
| S3 | Filter by size M + colour black + price range | facet counts correct, results respect every filter |
| S4 | Open a product, pick a variant | price, images and availability update; out-of-stock sizes disabled |
| S5 | Add to cart, change quantity | cart totals come from the server; editing the price client-side has no effect |
| S6 | Apply a coupon | discount computed server-side; expired/limit-reached coupons are refused with a clear reason |
| S7 | Checkout with COD | order `CONFIRMED`, stock reserved, confirmation page + email |
| S8 | Double-click "Place order" | exactly one order exists |
| S9 | Track the order | timeline shows every status change with timestamps |
| S10 | Request a return | request created; admin sees it; refund only after approval and receipt |
| S11 | Review a purchased product | allowed and marked verified; review is hidden until moderated |
| S12 | Review a product never purchased | refused |
| S13 | Keyboard-only navigation of checkout | every control reachable, focus always visible |

## Cross-channel integrity

| # | Scenario | Pass when |
|---|---|---|
| X1 | Sell one unit at POS, refresh the storefront | available stock drops by one on the website |
| X2 | Receive stock, check POS and storefront | both see the new quantity from the same ledger |
| X3 | `verify_integrity()` after a full day of mixed activity | zero drift between cached columns and the ledger |
