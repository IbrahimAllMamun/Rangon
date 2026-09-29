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
| O9 | In Footer & pages, tick Facebook and WhatsApp with addresses, move WhatsApp first, save | the storefront footer and the Contact page show WhatsApp then Facebook; the floating chat button opens that number; an address on another site is refused |
| O10 | Set the shop address and paste Google's "Embed a map" code | the address sits in full under the footer logo; the Contact page shows the map and an "Open in Google Maps" link |
| O11 | Edit the privacy policy with a heading, a list and a link, then unpublish it | the text reads the same on `/policies/privacy`; once unpublished that page is not found and its footer link is gone |
| O12 | Add a column and a link to the footer as a manager, then try as a cashier | the manager's change appears on the storefront; the cashier cannot open Footer & pages |
| O13 | Add three products to the homepage carousel, move the last one up, add a draft | the homepage shows the published three in that order under the hero; the draft waits in the list marked *Not shown* with the reason; a cashier cannot open the screen |

## Cashier

| # | Scenario | Pass when |
|---|---|---|
| C1 | Log in at the register | POS opens with branch + register context, focus in the barcode field |
| C2 | Scan 3 items with a USB scanner | each scan adds a line without touching the mouse |
| C2a | Press a line's **+** with the mouse, then scan; click an empty part of the screen, then scan | each scan adds its item, and the **+** is not pressed again — no click back into the field |
| C3 | Change a quantity, remove a line | totals recompute instantly and match the server on submit |
| C4 | Give 10% off the sale (F9) | allowed; 30% asks for a manager's email and password, and the sale records who approved it |
| C4a | Apply an in-store coupon at the register | the discount is the server's; an online-only or free-delivery coupon is refused with the reason |
| C4b | Apply a once-per-customer coupon to an anonymous sale | refused until a customer is attached (F3); the same customer's second use is refused |
| C4c | Void a sale that used a coupon | the coupon's use comes back, and the re-rung sale can spend it |
| C5 | Take split payment (cash + card) | two payment rows, correct change displayed, order `PAID` |
| C6 | Print the receipt | 80 mm layout, branch details, items, totals, order number, VAT line |
| C7 | Hold a sale, start another, resume the held one | both carts intact, no stock moved until each sale completes |
| C8 | Sell the last unit while the website sells it too | exactly one succeeds; the other sees "insufficient stock" |
| C9 | Process a return with a receipt | refund ≤ paid, stock restored on `RESTOCK`, not on `DAMAGED` |
| C10 | Attempt a refund without permission | blocked; manager elevation prompt appears and is audit-logged |

## Customer

| # | Scenario | Pass when |
|---|---|---|
| S1 | Browse the homepage on a phone | hero, the *Our picks* carousel (swipe; one card and part of the next), new arrivals load; no horizontal scroll of the page |
| S2 | Search "polo" | relevant products; typo "polo shrt" still finds it |
| S3 | Filter by size M + colour black + price range | facet counts correct, results respect every filter |
| S4 | Open a product, pick a variant | price, images and availability update; out-of-stock sizes disabled |
| S5 | Add to cart, change quantity | cart totals come from the server; editing the price client-side has no effect |
| S6 | Apply a coupon | discount computed server-side; expired/limit-reached coupons are refused with a clear reason |
| S7 | Checkout with COD | order `CONFIRMED`, stock reserved, confirmation page + email |
| S8 | Double-click "Place order" | exactly one order exists |
| S9 | Track the order — on a desktop from *Track order* beside the cart, on a phone from the menu | timeline shows every status change with timestamps |
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
