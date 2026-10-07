# The NestJS API port

The NestJS API (`apps/api-nest/`) is being built beside the Django API (`apps/api/`) on the same
PostgreSQL database, module by module, each module proven to answer exactly as Django does before
anything is routed to it. Why and how it was decided: [ADR-0013](decisions/0013-nestjs-api-alongside-django.md).

How to continue the port -- the rules, commands, method and lessons -- is in
[nest-port-instructions.md](../nest-port-instructions.md).

**Django remains the source of truth.** It owns the schema and every migration, and every path the
storefront, admin and POS use today is still served by it. Nothing routes to the Nest API yet.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation; storefront catalogue, content and feeds; rate limits | **Done** 2026-09-30, parity 202/202 |
| 2 | Accounts: login, refresh, logout, me, register, password change; customer orders and addresses; guest order tracking; review submission | **Done** 2026-09-30, parity 370/370 and two race checks |
| 3 | Cart, coupons, shipping options, checkout, payment webhook -- the first stock and money writes | **Done** 2026-10-01, parity 536/536 and twelve race checks |
| 4 | Catalogue, inventory and content admin (ledger, transfers, counts, image uploads) | **Done** 2026-10-01, parity 2739/2739 and 58 race checks |
| 5 | POS: sales, held sales, registers, discounts; returns and refunds; the staff order screens; the label sheet | **Done** 2026-10-06, parity 5015/5015 and 113 race checks |
| 6 | Purchasing, finance, customers admin, promotions, shipping admin; review moderation; staff accounts and the organisation | **Done** 2026-10-07, in ten parts: parity 10014/10014 and 205 race checks |
| 7 | Reports, audit log, notifications, background jobs (BullMQ for Celery); cutover | **In progress**: parts 1 and 2 of 5 (the audit log, notifications; and what DRF does before a view runs, on every view), parity 10771/10771 and 208 race checks |

Phase 1 endpoints, all compared by the parity harness:

| Endpoint | Notes |
|---|---|
| `GET /api/health/`, `/api/ready/` | not throttled, as plain Django views are not |
| `GET /api/v1/shop/products/` | search, filters, sorts and pagination exactly as `search_products`; logs search terms |
| `GET /api/v1/shop/products/<slug>/` | specs, size chart, reviews, bought-together |
| `GET /api/v1/shop/categories/[<slug>/]`, `brands/[<slug>/]` | |
| `GET /api/v1/shop/facets/`, `search/suggest/` | |
| `GET /api/v1/shop/home/`, `navigation/`, `site/`, `pages/[<slug>/]` | `site/` creates the settings row on first read |
| `GET /api/v1/shop/feed.xml`, `feed.csv` | cached 15 minutes; 503 without `RANGON_PUBLIC_URL` |

Phase 2 (write cases: the rows each API writes are compared too):

| Endpoint | Notes |
|---|---|
| `POST /api/v1/auth/login/` | Argon2 and PBKDF2 hashes, PBKDF2 upgraded on sign-in; `LOGIN`/`LOGIN_FAILED` audit rows; `last_login` and its address |
| `POST /api/v1/auth/refresh/` | rotation over SimpleJWT's `token_blacklist` tables; refused for a deactivated account or a changed password |
| `POST /api/v1/auth/logout/` | no authentication and no throttle, always 204 |
| `GET /api/v1/auth/me/` | |
| `POST /api/v1/auth/register/` | links the guest customer with the same mobile, else creates one; one transaction |
| `POST /api/v1/auth/password/change/` | the password validators, every session ended, a fresh pair for this one; throttled on the `auth` scope alone |
| `GET /api/v1/shop/account/orders/[<number>/]` | the newest 50, and one order with its lines, payments, customer timeline and parcels; Django's statements, so ties order alike |
| `GET /api/v1/shop/orders/<number>/?token=` | guest tracking: the order's customer signed in, or the link's token -- a blank one opens nothing (D113) |
| `GET/POST/PATCH/DELETE /api/v1/shop/account/addresses/` | one default per customer, held by locking the customer row -- the same lock Django takes, so the two APIs queue behind each other |
| `POST /api/v1/shop/products/<slug>/reviews/` | once per received purchase, pending moderation; the `search` throttle scope |

Phase 3, first the cart. Every cart endpoint writes (a read without a token creates a cart,
and a read drops a coupon that has stopped applying), so each case restores the fixture's carts
and compares the carts and lines each API leaves:

| Endpoint | Notes |
|---|---|
| `GET/POST/PATCH/DELETE /api/v1/shop/cart/` | re-priced from the database on every read (`checkout/pricing.ts`: Python's decimal context, half-up cents, VAT spread over lines with the drift on the last); a guest's cart by `X-Cart-Token`, a customer's merged on sign-in; the stock check here is advisory |
| `POST/DELETE /api/v1/shop/cart/coupon/` | every refusal `validate_coupon` has; a category restriction covers its descendants |
| `GET /api/v1/shop/shipping-options/?city=` | the city's zone, else the default; prices as JSON numbers, as DRF's encoder writes a bare Decimal |

Then checkout, the port's first stock and money write. Each case starts both APIs from the same
shelf, coupon counts, order-number sequence and call-back list (`parity/checkout-cases.ts`), and
compares every row each API writes: the order, its lines, the ledger, stock, payments, the
timeline, coupon redemptions, audit rows, staff notices, leads, carts, the sequence -- and the
Celery jobs each queued.

| Endpoint | Notes |
|---|---|
| `POST /api/v1/shop/checkout/` | one transaction, in Django's order. An `Idempotency-Key` is required; a retry with it returns the first order, found by a lookup and, under a race, by a savepoint that catches the unique violation. The row-locked `order:WEB` sequence numbers the order. Every stock row is locked `FOR UPDATE` in id order and every line checked before any is written, then one `RESERVATION` per line. The coupon is redeemed under its own row lock. Cash on delivery is confirmed with a pending manual payment, other methods wait for the provider. After commit: low-stock jobs, staff notices, then the customer's email and SMS jobs ([ADR-0014](decisions/0014-nest-enqueues-celery-jobs.md)). Throttled on the `checkout` scope, 20 an hour |
| `POST /api/v1/shop/checkout/lead/` | holds the number a shopper typed but did not use, at the server's price for the cart; always 204; the same `checkout` bucket |

Then the payment webhook. The one provider either API ships, `manual`, takes no webhooks, so
in production both answer every webhook with a 404. A webhook reaches the capture path only
through a gateway. So the parity stack installs a stand-in gateway, `paritypay`, in both APIs:
a Django app that `config.settings.parity` alone installs, from a directory only
`docker-compose.nest.yml` mounts (`parity/gateway/`), and its twin, which `parity/serve.ts`
registers before the Nest API listens. Like `StubPay` in Django's own tests, it stands in for a
gateway whose signature check has passed. No image contains either; the Nest image's own
command (`node dist/main.js`) never loads `parity/`.

| Endpoint | Notes |
|---|---|
| `POST /api/v1/shop/payments/<provider>/webhook/` | no authentication; throttled as any anonymous request. The body goes to the provider as bytes, never parsed by the view. The event is stored once per (provider, event id): a replay waits on the unique index and answers the first result. It acts only on a waiting payment made through the same provider (D100), captures only the amount that payment was for, and captures under the payment's row lock: the cash book posting, the order's payment status, the timeline and the audit row. An unknown provider or `manual` is a 404 |

Each webhook case compares the event row, the payment, the order's payment status, the cash-book
posting and balances, the timeline, the audit log and the (absent) jobs, with payloads compared as
jsonb's own text so that `3.0` and a 20-digit integer survive (`parity/payment-cases.ts`,
`fixture_payments.py`).

Invariants are also checked under concurrency on every parity run (`parity/concurrency.ts`), each
across both APIs where both serve the path:

| Race | Holds |
|---|---|
| 20 simultaneous "add as my default address" | exactly one default; fails on every run with the port's lock removed |
| 8 simultaneous refreshes of one token | one rotation |
| 10 shoppers for the last 7 units, 3 each | 2 sell, 8 are refused, 1 unit left, nothing oversold |
| 6 clicks with one `Idempotency-Key`, a returning shopper | six 201s, one order, one reservation |
| 6 clicks with one key, a first-time guest | one order and one reservation; the losers may get 409 (D114, copied) |
| 5 online checkouts (Nest) against 5 counter sales (Django) | no lost update; the stock row equals what the ledger says; no online over-reservation |
| A counter sale committed while a Nest checkout waits on the row | the checkout sees it -- the harness holds the lock and writes the sale, so this is deterministic, and it fails on every run with the port's `FOR UPDATE` removed |
| 6 checkouts for a coupon good once | one redemption, one discounted order |
| 8 copies of one webhook event | one event row, one capture, one posting, the balance moved once |
| 6 different capture events for one payment | one posting, one capture on the timeline and in the audit log |
| 3 captures and 3 failures for one payment | one outcome: captured with its posting, or failed with none; the losers 409 or find nothing to act on |
| A capture committed while a Nest webhook waits on the payment row | the webhook sees it and stops -- deterministic, and it fails on every run with the port's `FOR UPDATE` removed (as do the two before it, sometimes) |
| A reorder committed while a move of an attribute value waits on the values' lock (each API in turn) | the move swaps from the committed positions -- deterministic; with the port's `FOR UPDATE` removed it never waits and writes back a lost update |
| A value moved by someone else while its own move waits (each API in turn) | both leave the same duplicate position, from the position read before the lock (D118, copied) |
| 6 simultaneous single-version submits for one product, across both APIs | one SKU; the others answer `created: 0` |
| A single-version SKU committed while a submit waits on the product's lock (each API in turn) | the submit makes nothing -- deterministic; with the port's `FOR UPDATE` removed it never waits and makes a second SKU |
| 8 simultaneous barcode requests for one unlabelled SKU, across both APIs | one number, handed to all eight, one audit row; with the port's lock removed, four numbers |
| A label committed while a barcode request waits on the variant's lock (each API in turn) | the request hands that label back -- deterministic |
| A movement committed while a write-off waits on the inventory row (each API in turn) | the write-off is checked against the committed shelf and refused -- deterministic; with the port's `FOR UPDATE` removed it never waits, takes its units as well, and the row disagrees with its ledger |
| A movement committed while an adjustment waits on the row (each API in turn) | the adjustment writes the difference from the committed figure and lands on the count, its ledger agreeing; without the lock the ledger is the harness's units short |
| 6 simultaneous retries of one write-off with one `Idempotency-Key`, across both APIs | one ledger row, one unit off the shelf, every answer that row. The unique key holds this alone: it passes with the lock removed |
| 6 simultaneous write-offs of 2 from a shelf of 6, across both APIs | 3 taken, 3 refused, nothing below zero; with the lock removed, 5 taken and the ledger at -4 |
| A movement committed while a transfer waits on its source row (each API in turn) | the transfer is refused -- deterministic; with the port's `FOR UPDATE` removed it moves the units anyway and the source row disagrees with its ledger |
| 6 simultaneous transfers of 2 from a shelf of 6, across both APIs | 3 move with 3 numbers, 3 are refused, both ends agree with their ledgers. The `stock_transfer` number sequence's lock serialises transfers on its own, so this passes with the row lock removed: the check above is the proof |
| 6 simultaneous retries of one transfer with one `Idempotency-Key`, across both APIs | one document, one unit moved, every answer that document |
| A cancellation committed while an apply waits on the count's row (each API in turn) | the apply is refused and writes nothing -- deterministic; with the port's `FOR UPDATE` removed it never waits and applies the cancelled count |
| Two applies of one count at once, one per API | one applies, the other is refused, the adjustments are written once; with the lock removed, both proceed |
| 6 simultaneous creates of one page address, across both APIs | one page, one audit row; the other five are told the address is taken (409). The unique index holds this alone |
| The same title committed while an edit waits on the page's row (each API in turn) | the edit finds nothing to change: no save, no audit row -- deterministic; with the port's `FOR UPDATE` removed it never waits, saves and audits a change already made |
| The page made a standard one while a delete waits on its row (each API in turn) | the delete is refused and the page stays -- deterministic; with the port's `FOR UPDATE` removed it never waits and deletes it |
| 6 simultaneous carousel adds of one product, across both APIs | one row; the others 409. The unique index holds this alone |
| A carousel add while another add commits, the run at 23 (each API in turn) | the add waited on the run's lock, then counted the 23 it read before the wait and made 25 (D135, copied); with the port's `FOR UPDATE` removed it never waits |
| A carousel item removed while a remove waits on it (each API in turn) | 404 and no audit row -- deterministic; with the port's `FOR UPDATE` removed it never waits, audits and answers 204 |
| A carousel move, and a header item's move, while their run is reordered (each API in turn) | each renumbers the order it read before the wait (D132, copied); with the port's `FOR UPDATE` removed neither waits |
| A footer column added while a fourth is being added (each API in turn) | it goes in: five columns (D136, copied); no lock is involved |
| Two resumes of one held sale that both read it before either deletes it, one per API | both are handed the cart (D142, copied); no lock is involved -- the harness holds the row until both requests are queued behind it |
| A held sale resumed by someone else while an edit of it waits on its row (each API in turn) | the edit's `UPDATE` finds no row and the hold is inserted again, as `save()` does it (D142, copied) |
| 8 counter sales at once for the last 5 of a SKU, across both APIs | 5 sell, 3 are refused, the shelf at 0 and its ledger agreeing. Every counter sale takes the `order:POS` number sequence's lock first, so this passes with the stock lock removed |
| A sale committed while a counter sale of the whole shelf waits on the inventory row (each API in turn) | the waiting sale is refused -- deterministic; with the port's `FOR UPDATE` removed it sells units the shelf no longer has (0 on the shelf, the ledger at -1) |
| An online reservation committed while a counter sale of the whole shelf waits on the row (each API in turn) | the sale is refused: the unit is held for an online order (D115's rule, under the lock); with the lock removed it sells the reserved unit |
| 6 clicks with one `Idempotency-Key` on a counter sale, across both APIs | six 201s, one order, one unit sold |
| A coupon's last use taken while a counter sale waits on the coupon's row (each API in turn) | the sale is refused and nothing is written; with the port's `FOR UPDATE` removed it redeems the coupon a second time |
| 6 anonymous counter sales at once at a branch with no walk-in record, across both APIs | one walk-in record, all six sales on it: the unique index decides, and the loser reads the winner's row |
| A deposit committed while a counter sale's cash payment waits on the drawer's row (each API in turn) | the payment lands on the committed balance; with the port's `FOR UPDATE` removed the deposit is lost |
| A customer's totals changed while a sale to them waits on the customer's row (each API in turn) | the sale writes its own stale figures over them: the orders committed meanwhile are lost (D150, copied); no lock is involved |
| Two voids of one sale that both read it before either locks it, one per API | both go through: the unit goes back on the shelf twice, with one refund (D154, copied) |
| A drawer emptied while a void's refund waits on the account's row (each API in turn) | the void is refused whole -- nothing restocked, the sale standing; with the port's `FOR UPDATE` removed it pays the refund and overwrites the withdrawal |
| Two approvals of one return queued on its row (one per API, then both through each API) | one approves and the other is told it is approved already; with the port's `FOR UPDATE` removed both Nest approvals go through and the timeline says so twice |
| Two receipts of one return queued on its row (one per API, then both through each API); six at once across both APIs | one receives -- the goods go back once, each line's returned count moves once -- and the rest are told the return is no longer approved; with the port's `FOR UPDATE` removed the second Nest receipt gets as far as the line's own check |
| Two completions of one return queued on its row (one per API, then both through each API) | both answer 200 and the refund is paid once: one refund, one cash-book entry, one audit entry; with the port's `FOR UPDATE` removed the second Nest completion is a 409 |
| An order set back to DELIVERED while a completion waits on the order's row (each API in turn) | the refund is paid and the order's status left alone; with the port's `FOR UPDATE` removed the Nest completion acts on the status it read and is refused by the status machine, paying nothing |
| A sale cancelled while a return being opened on it waits on the order's row (each API in turn) | refused as a return on a cancelled order is; with the port's `FOR UPDATE` removed Nest gets as far as the status change before it is stopped |
| Two returns for one unit (D157), neither restocking, received at once through one API, queued on the order line | one is received and the other is refused: the unit comes back once; with the port's `FOR UPDATE` removed both Nest receipts go through |
| A drawer emptied while a completion's refund waits on the account's row (each API in turn) | the completion is refused whole: the return still RECEIVED, nothing refunded |
| 6 returns opened at once on one sale, across both APIs | six 201s and six numbers in a row, none shared; with the port's order lock removed most of the six are 500s |
| 6 counter returns of a sale's one unit at once, across both APIs | one 201: the unit and the money come back once, the sale REFUNDED |
| Two requests to pack one order queued on its row (one per API, then both through each API) | both answer 200, the order is packed once and its stock deducted once; with the port's `FOR UPDATE` removed the two Nest requests deduct the stock twice |
| Two requests to record one pending payment queued on its row (one per API, then both through each API) | both answer 201, the payment is captured once and the money entered once; with the port's `FOR UPDATE` removed the Nest pair capture it twice on the timeline -- and the webhook's own capture checks fail with them, the function being one |
| An order packed while a cancel of it waits on the order's row (each API in turn) | the cancel is refused by the status machine, nothing released or refunded; with the port's `FOR UPDATE` removed Nest cancels and refunds an order whose goods have left the shelf |
| An order refunded in full while a refund of it waits on the order's row (each API in turn) | refused, a 422; with the port's `FOR UPDATE` removed Nest pays it again |
| A shelf emptied while an order being packed waits on the stock row (each API in turn) | packing is refused whole: the order stays PROCESSING, nothing deducted |
| 6 refunds of an order's whole payment at once, across both APIs | one 201 and five 422s: refunded once; with the port's `FOR UPDATE` removed the order is refunded twice over |
| 6 clicks of one refund with one `Idempotency-Key`, across both APIs | six 201s naming one refund |
| An order packed through one API and cancelled through the other at once | one wins and the other is a 409; the stock and the money agree with whichever it was |
| 6 marks of one variant's labels at once, across both APIs | six rows, none lost: `mark_labels` takes no lock and needs none, the newest row being the state |
| 6 withdrawals of all a drawer holds at once, across both APIs | one 201 and five 409s; the drawer at nothing, equal to its ledger. With the port's `FOR UPDATE` removed from the account, three were paid and the ledger summed to minus twice the drawer |
| A drawer emptied while a withdrawal, and then a transfer out of it, waits on the account's row (each API in turn) | each is refused, nothing moved; with the lock removed Nest paid both |
| 6 clicks of one deposit, and of one transfer, with one `Idempotency-Key`, across both APIs; two deposits under one key queued on the account through each API | every request answers 201 with the one movement or transfer |
| 8 transfers between two accounts, four each way, at once across both APIs | all go through under eight numbers; the two accounts hold together what they held, each equal to its ledger. With the lock removed, four were 500s |
| 6 accounts opened as one branch's default cash account at once; 6 under one name | one default remains, one account of the name: the two unique indexes decide, no lock is involved |
| Two voids of one expense queued on its row (one per API, then both through each API) | one voids it and the other is told it is voided already; the money goes back once. With the port's `FOR UPDATE` removed both Nest voids go through and the money goes back twice |
| 6 expenses of all a drawer holds at once; an expense whose drawer is emptied mid-flight (each API in turn) | one is recorded; a refused one leaves no document |
| 6 clicks of one expense with one `Idempotency-Key`, across both APIs | six 201s, one expense, one movement |
| An offer withdrawn while its promotion to preferred waits on the offer's row (each API in turn) | the promotion is refused and the SKU keeps the supplier it preferred; with the port's `FOR UPDATE` removed it waits only at its `UPDATE`, and promotes the withdrawn offer |
| 6 promotions at once, three for each of a SKU's two offers, across both APIs | one preferred offer, every promotion audited. The unique index, not a lock, allows only one |
| 6 suppliers of one name at once, across both APIs | each one made has a code of its own; a loser is the unique index's 409. No lock is involved |
| An offer promoted while an edit of it waits at its `UPDATE` (each API in turn) | the edit writes back the preference it read, and the SKU prefers nobody (D184, copied); no lock is involved |
| A purchase order cancelled while a send of it waits on the order's row (each API in turn) | the send is refused and the order stays cancelled; with the port's `FOR UPDATE` removed Nest sends it |
| An order part received while a cancel of it waits on its row (each API in turn) | the cancel is refused; with the lock removed Nest cancels an order with goods on the shelf |
| An order cancelled while a delivery against it waits on its row (each API in turn) | nothing is received; with the lock removed Nest receives into the cancelled order and marks it part received |
| Part of a line received while a delivery of all of it waits on the line's row (each API in turn) | refused for what is still outstanding; with the port's `FOR UPDATE` removed from the lines Nest receives the whole line again |
| 6 deliveries of one whole line at once, across both APIs | one is received: the shelf up once and equal to its ledger, one receipt |
| Two returns of different lines queued on the order's row (one per API, then both through each API) | both go back, and the order's credit is the sum of the two; with the order's lock removed the Nest pair lose one credit |
| Part of a line sent back while a return of all of it waits on the line's row (each API in turn) | refused for what is left; with the lines' lock removed Nest returns units already gone, and credits them |
| A shelf emptied while a return waits on the shelf's row (each API in turn) | the return is refused whole: nothing credited, the line as it was |
| 6 clicks of one return with one `Idempotency-Key`, across both APIs | six 201s naming one return, one unit off the shelf |
| 6 orders raised at once, across both APIs | six numbers, none shared |
| Another supplier made a SKU's preferred one while its first delivery from this one is in flight (each API in turn) | the delivery is refused with a bare 409 (D187, copied); the unique index decides, no lock is involved |
| 6 payments of all a purchase order owes at once, across both APIs | one is recorded and five exceed what is outstanding (422); the order paid once, the account down once and equal to its ledger |
| All but 100.00 of an order paid while a payment of 500.00 waits on the order's row (each API in turn) | it exceeds what is outstanding; with the port's `FOR UPDATE` removed Nest pays 500.00 over the balance it read |
| An order cancelled while a payment against it waits on its row (each API in turn) | not paid; with the lock removed Nest pays a cancelled order |
| An account emptied while a supplier payment waits on the account's row (each API in turn) | refused whole: no payment left behind, the order as it was |
| 6 clicks of one supplier payment with one `Idempotency-Key`, against an order and as an advance, across both APIs | six 201s naming one payment, the money out once |
| 10 addresses added as a customer's default at once from the back office, across both APIs | one default: the customer's row lock, the one phase 2 proved for the storefront, as the back office reaches the same service |
| 6 customers under one new number at once, across both APIs | one is made; the rest are told the number is taken (400) or meet the unique index (409). No lock is involved |
| A lead recovered while a note on it waits at its `UPDATE` (each API in turn) | the note's save opens the lead again and forgets its order (D200, copied); no lock is involved |
| 6 coupons of one code at once, across both APIs | one is made; the rest are told the code is taken (400) or meet the unique index (409). No lock is involved |
| A coupon redeemed while an edit of it waits at its `UPDATE` (each API in turn) | the edit writes back the count it read, and the use is forgotten (D203, copied); no lock is involved |
| 6 bookings of one tracking number for one order at once, across both APIs | one parcel and one timeline entry; five are told the courier already has a parcel with that number: the order's row lock makes the check and the insert one step |
| 6 bookings of one tracking number across two orders at once, across both APIs | one parcel; five conflicts and no 500: only the unique index stands between two orders, and the savepoint around the insert turns its refusal into the named conflict |
| An order cancelled while a booking for it waits on its row (each API in turn) | no parcel; with the port's `FOR UPDATE` removed the booking never waits and the cancelled order gets one |
| An order taken off the packing bench while its parcel's DISPATCHED waits on the order's row (each API in turn) | the parcel does not leave; with the lock removed the update is decided on the status it read and fails only inside the status machine |
| A parcel delivered while a FAILED for it waits on the parcel's row (each API in turn) | its history is closed; with the lock removed the FAILED is recorded over the delivery |
| 6 DELIVERED for one parcel at once, across both APIs | one is recorded, five find the parcel delivered; the order delivered once and its customer told once. With the locks removed two of the six are 500s |
| 6 DISPATCHED for a packed order's parcel at once, across both APIs | six updates recorded, as nothing refuses a repeat (D209, copied); the order shipped once, `dispatched_at` stamped once, its customer told once |
| Both parcels of a split delivery updated at once while the order is marked delivered by hand, across both APIs | no deadlock and no 500: every path takes the order's row first; the order delivered once |
| A parcel delivered while an edit of its notes waits at its `UPDATE` (each API in turn) | the edit writes back the status it read and the delivery is gone (D207, copied); no lock is involved |
| 6 couriers of one code, and 6 methods of one code in one zone, at once, across both APIs | one is made; the rest are told it is taken (400) or meet the unique index (409). No lock is involved |
| 6 decisions on one review at once, three each way, across both APIs | six 200s and six audit entries; the review is left as one of them decided. No lock is involved |
| A review rejected with a reason while an approval of it with no note waits at its `UPDATE` (each API in turn) | the approval stands and the reason is gone: a decision writes back the note it read (D215, copied); no lock is involved |
| A profile's ID number changed while an edit of its title waits on the profile's row (each API in turn) | both changes stand; with the port's `FOR UPDATE` removed the edit writes back the ID number and the notes it read |
| 6 first saves of one profile at once, across both APIs | six 200s and one profile: each edit writes the account's own row first, and the rest wait on it |
| The second owner switched off while the first's deactivation waits at its `UPDATE` (each API in turn) | judged with two owners, it goes through: no active owner is left (D221, copied); the guard takes no lock |
| A password changed while an edit of the account's name waits at its `UPDATE` (each API in turn) | the edit puts back the password it read (D222, copied); no lock is involved |
| The VAT settled while an edit of the organisation's name waits at its `UPDATE` (each API in turn) | the edit puts back the VAT it read and the settlement is gone (D225, copied); no lock is involved |
| 6 deactivations of one account at once, across both APIs | six 200s and six audit entries; nothing refuses a repeat |
| 6 accounts under one email, and 6 branches under one code, at once, across both APIs | one is made; the rest are told it is taken (400) or meet the unique index (409). No lock is involved |
| 6 settlements of the VAT at once, three each way, across both APIs | six 200s and six audit entries; the mode left is one of the two |
| 6 requests to mark every notice read at once, across both APIs | six 200s; each notice is counted by exactly one of them, none is left unread. No lock is involved |
| A notice read while a request to mark everything waits on its row (each API in turn) | the request's `UPDATE` waits, looks at the row again, leaves it as it was read and counts the others. No lock is involved: it is the one statement that holds this. With the port made to read the unread first and write them by key, it stamps the notice again and counts it |

Two failure events for one payment can both act: `fail_payment` does not refuse a payment
already failed, so the timeline shows the failure twice. Copied, as harmless.

With the port's `FOR UPDATE` removed from the stock lock, the checkout check above (a counter sale
committed mid-flight) fails too: checkout now takes the same lock.

PostgreSQL sorts a locking `SELECT ... ORDER BY ... FOR UPDATE` before it waits on the lock, so
a request that queued gets the committed rows in the order they had before. The move checks are
built on that, as Django's `move` meets it too.

The concurrent stock race alone could not prove the lock: the `order:WEB` sequence's row lock
already serialises online checkouts, and with the port's `FOR UPDATE` removed it still passed.
Hence the mid-flight check.

Phase 4 opens the staff API. First the check every staff endpoint makes before anything else,
`accounts.permissions.RolePermission`, ported as `auth/permissions.ts`: an owner or superuser
passes; anyone else needs every code the action requires, read from their role's permissions;
an action the view declares nothing for is refused (it fails closed); an action serving a read
and a write is scoped by HTTP method. A request with no handler for its method is checked the
way DRF checks it -- with no action, so the method's own name is looked up -- which is why a
manager's `PUT /brands/` is a 403 and an owner's a 405, both carrying the view's `Allow`. The
branch rules (`resolve_branch`, `branch_queryset`) are ported beside it, for the inventory
endpoints to use.

A staff viewset is a `@StaffView(base, requirements)` controller whose handlers name their
action (`@Action('list')`), routed as DRF's `DefaultRouter` routes it: a list route, a detail
route whose key is `[^/.]+`, and one route per `@action`. `common/filtering.ts` is the two
default filter backends: django-filter over `filterset_fields` (every parameter validated
before any filters, errors in the view's field order, a foreign key checked against its
table) and `OrderingFilter` (allowed terms replace the view's order). Both apply to a detail
lookup too, as `get_object` applies them.

| Endpoint | Notes |
|---|---|
| `GET/POST /api/v1/brands/`, `GET/PUT/PATCH/DELETE /api/v1/brands/<id>/` | `products.*` codes; unpaginated; `is_active`/`is_featured` filters, `ordering=name`. Unique name and slug (DRF's `UniqueValidator`, run first, then every other validator); a slug made on create only, from the name, Bengali transliterated (`common/slugs.ts`); a missing file is stored as `""`. A brand with products is not deleted (`PROTECT`: 409) |
| `GET/POST /api/v1/categories/`, `GET/PUT/PATCH/DELETE /api/v1/categories/<id>/` | `?tree=true` lists the roots with their active children nested, and narrows detail lookups to roots; each annotated row counts its published products, and an unannotated one (a new category, a nested child) has no `product_count` at all. `validate_parent` refuses a cycle. A partial update's response leaves out `parent_name` for a root: DRF skips a field's default when the serializer is partial. Every save and delete queues the storefront revalidation job, and a delete takes the category's navigation items (and their children) with it, one job each. With children or products, 409 |
| `GET /api/v1/categories/<id>/attributes/` | the attributes a category uses, inherited down the tree; the nearest category's link wins |

Then the attribute admin (part 2):

| Endpoint | Notes |
|---|---|
| `/api/v1/attributes/[<id>/]` | `products.*`; unpaginated; each attribute with its values and the number of variants built on it. No `ordering_fields`, so `OrderingFilter` allows every field the serializer reads from the model -- `values` among them, which Django orders by through a join, one result per value. A lookup drops the ordering (`QuerySet.get()` clears it), so it never repeats. A Size attribute with charts stays a Size; a variant axis stays one while variants use it, and a specification cannot become one while products state it. Deleting is refused in words for variants, specifications or charts; otherwise its values, its category links and its images' colour go with it |
| `/api/v1/attribute-values/[<id>/]` | filtered by `attribute`; unique per attribute (DRF's `UniqueTogetherValidator`, which on an update fills a missing half from the row and skips the check when nothing changed); a swatch is a hex colour or nothing. Deleting is refused while variants, specifications or charts use the value; an image grouped under it keeps the photograph and loses the colour (`SET_NULL`) |
| `POST /api/v1/attribute-values/<id>/move/` | the direction is read before the value; every value of the attribute is locked `ORDER BY position, value FOR UPDATE`, then swapped with its neighbour, or the whole run renumbered where the two share a position. No requirement is declared for `move`, so only an owner or superuser may (D117, copied); the value's own position is the one read before the lock (D118, copied) |
| `/api/v1/size-charts/[<id>/]` | `save_size_chart` and `delete_size_chart`: the finished chart is validated (a Size attribute, a unique name in any case, 1-12 distinct headings, every row one of the attribute's sizes, once, one figure per column), rows are replaced, each save and delete is audited, and a save queues the `products` revalidation job after its commit. A chart in use is not deleted (409, in words) |

Then products (part 3a):

| Endpoint | Notes |
|---|---|
| `GET /api/v1/products/` | paginated (25, up to 100), newest first with the key breaking ties; filters on status, published, featured, category and brand; `never_ordered=true` (drafts no purchase order names); `search` matches what the storefront search finds over every product (an exact SKU or barcode outright, else ranked text or a similar name) or a name or SKU containing the text, or a barcode equal to it |
| `GET /api/v1/products/<id>/` | variants with stock at the branch asked for (`resolve_branch`) and whether that branch ever received each at a cost; specifications grouped by attribute; images with their colour. A variant's attribute links have no ordering of their own, so they are read with Django's statement |
| `POST/PUT/PATCH/DELETE /api/v1/products/[<id>/]` | specifications and size chart through their services, each audited when it changes something; a draft cannot be published in the same payload; a chart must be one the category offers, unless the product's variants are built on it. A product ever sold, stocked or labelled (a `LabelPrint` row, added 2026-10-03) is archived; any other is deleted with what only pointed at it (variants, links, images, specifications, cart lines, offers, carousel entries -- each of those a `home` revalidation job); a purchase order line refuses it (409), after the audit entry is written, as Django writes it first |
| `POST /api/v1/products/<id>/generate-variants/` | the cartesian product of the chosen values, combinations the product has skipped, SKUs and in-store barcodes from the `barcode` sequence; or one SKU with no options under the product's row lock, so a retried submit makes nothing. A negative cost reaches the database's check constraint: 409, as in Django |
| `POST /api/v1/products/<id>/publish/`, `unpublish/` | publishing needs an active variant priced above zero |

Then variants (part 3b):

| Endpoint | Notes |
|---|---|
| `GET/POST /api/v1/variants/`, `GET/PUT/PATCH/DELETE /api/v1/variants/<id>/` | paginated, ordered by the product (newest first), position and SKU; filtered by product and status; DRF's `SearchFilter` over SKU, barcode and product name -- every term must match one of them, terms split on whitespace and commas, a quoted phrase kept whole, a NUL refused with the details as a bare list. Unique SKU and barcode, a blank barcode stored as NULL, `DateField` with Python's `date.fromisoformat` and Django's fallback (ISO weeks, `2026-1-5`, any script's digits). Archive-or-delete as for products |
| `GET /api/v1/variants/lookup/?code=&branch=` | the barcode exactly, else the SKU in any case, with stock at the branch; not found is the view's own hand-written envelope, with no request id |
| `POST /api/v1/variants/<id>/barcode/` | the variant's in-store barcode, assigned under its row lock when it has none, audited |

**Added to Django after phase 4 closed:** `GET/POST /api/v1/products/<id>/labels/` (2026-10-03,
the label sheet; [business-rules §1.10](../business-rules.md#110-barcode-labels-which-variants-are-printed)).
Ported as part 7 of phase 5, below; `src/database/schema.ts` was re-introspected for
`inventory_labelprint` then. A variant or product with a mark is history when it is deleted, in
the port as in Django, so the two agree on `DELETE`.

Then product images (part 3c), the first endpoint that takes a form:

| Endpoint | Notes |
|---|---|
| `GET/POST /api/v1/product-images/`, `GET/PUT/PATCH/DELETE /api/v1/product-images/<id>/` | an upload is a multipart form (`http/multipart.ts`: Django's `MultiPartParser` -- the boundary rule, file names unescaped, cut to their last path part and stripped of unprintable characters, a file with no name skipped), read by the serializer with DRF's form rules (a missing boolean is false, a blank optional field absent, a blank relation null). The image passes DRF's `ImageField` -- no file, not a file, empty -- then Pillow's identification (`common/images.ts`), then Django's extension list, then `validate_image_upload` (10 MB; JPEG, PNG, WebP or AVIF by the decoded type and by name). The colour must be a variant-defining one the product comes in, re-checked on every edit. The file is stored as `FileSystemStorage` stores it (`common/storage.ts`: `products/%Y/%m/` on the shop's clock, `get_valid_filename`, a random suffix when the name is taken) under `MEDIA_ROOT`, which the two processes share; the first image of a product becomes its primary one. A create answers with `Location` set to the image's URL, as DRF's `get_success_headers` does for any payload with a `url`. The list is Django's statement, joins and all: an ordering that ties falls to the plan |

Then the products CSV import (part 3d):

| Endpoint | Notes |
|---|---|
| `POST /api/v1/products/import/` | `products.create` and `inventory.adjust`; multipart only (`parser_classes=[MultiPartParser]`: JSON or a urlencoded body is a 415). The upload is DRF's `FileField`, within 5 MB, decoded as `utf-8-sig`. `dry_run` defaults to true -- in a form too, as DRF's `default` replaces a boolean's empty form value -- and answers 200 with the plan; `dry_run=false` imports in one transaction at the branch `resolve_branch` allows and answers 201, or 400 with the same body when a row is wrong. The file is read with Python's `csv.DictReader` (`common/pycsv.ts`, ported from CPython's `_csv.c` state machine and checked against 20,000 generated files) and its cells with Python's `Decimal` and `int`. Rows group into products by slug, else by name in any case; missing categories and brands are created (a category queues the navigation revalidation job at once, as its signal does, even when the import then fails); an existing SKU is re-priced with every column saved back; a new one gets its size and colour options and its opening stock through `receive_stock`. Every quirk is copied: a price that cleans to nothing drops its row without a word (D130), the preview names a missing category once per product that uses it (D129), and a `NaN`, a stray carriage return, a NUL or a cell past its column is a 500 (D131) |

The parity stack mounts `apps/api/media` into the Nest container as its `MEDIA_ROOT`. Each API
stores its own copy of an upload; when the name is taken the second gets a random suffix, which
the harness takes off before comparing names and URLs.

The parity stack now sets `WEB_REVALIDATE_URL` on both APIs (nothing listens), so the
`content.tasks.revalidate_storefront` jobs a write queues are compared like checkout's. Seeding
unsets it: the demo seed saves categories, and its signals would otherwise ping the URL inline.

Then the inventory admin (part 4a). Every stock movement now goes through one service,
`inventory/stock.service.ts`, as `inventory.services` has it: the inventory rows locked
`FOR UPDATE` in id order (created first when the branch never held the variant), every line
checked under the lock, the cached row and its ledger row written together, low-stock jobs queued
after the commit. Checkout's reservation, ported in phase 3 with its own copy of the lock, uses it
too. A variant that does not exist still gets an inventory row inside the transaction -- Django
creates its foreign keys `DEFERRABLE INITIALLY DEFERRED` -- so an adjustment to 0 fails at the
commit (409) and anything that reads the SKU first fails there (404), as in Django (D122).

| Endpoint | Notes |
|---|---|
| `GET /api/v1/inventory/`, `GET /api/v1/inventory/<id>/` | `inventory.view`; a branch-bound user sees their own branch. `filter=low-stock`, `out-of-stock` or `expiring` (ordered by expiry), `category` (a slug), `search` (SKU or product name containing it, barcode equal to it), django-filter on branch and variant, and `ordering` on `on_hand` or `updated_at` -- which replaces the order whole, so rows that tie come back as the plan gives them. The statement is therefore Django's, every column of all five tables. Each row says whether its branch has ever received the variant at a cost (`received`); `stock_value` is `average_cost * on_hand` with Python's signs, so nothing times a shortfall is `-0.00` |
| `PUT/PATCH /api/v1/inventory/<id>/` | `inventory.adjust`. Only `reorder_point` and `bin_location`, taken from the body as sent, with no serializer: `int()` and `str()` on the way to the database, and the answer read from the values as set. A reorder point sent as a string is saved, then fails the response (D121, copied) |
| `POST /api/v1/inventory/adjust/` | `inventory.adjust`; `resolve_branch`. The count is written as the difference, at the row's average cost, and audited; upwards only where the branch has received the variant (`NOT_RECEIVED`). 200 and a sentence when the shelf already holds the figure. A count past 2^53 is exact, as in Python, until PostgreSQL refuses it |
| `POST /api/v1/inventory/write-off/` | `inventory.adjust`; damage or loss, with a reason. Idempotent on `Idempotency-Key`: looked up before the lock, again under it, then claimed by the ledger row in a savepoint (D89, D90). A replay answers the first row -- whatever its branch or variant -- and is audited again with the replay's figures, as Django does it |
| `GET /api/v1/inventory/low-stock/` | `inventory.view`; `get_queryset()` at or below the reorder point, without the list's django-filter and ordering. An empty result is a bare `[]`, any other the paginated envelope (D123, copied) |
| `GET /api/v1/inventory/valuation/` | `reports.financial`; units, value at cost and at retail, in total and per branch (in the plan's order: Django's statement), as JSON numbers -- bare Decimals through DRF's encoder |
| `POST /api/v1/inventory/verify-integrity/` | `settings.manage`; replays the ledger against the cached columns, everywhere or at one branch; the issues in the plan's order (Django's statement) |
| `GET /api/v1/inventory-transactions/[<id>/]` | `inventory.view`; the ledger, newest first. The shop's date window (`core.dates`, below), a family of movement types (`types=DAMAGE,LOSS`, unknown ones refused in code-point order), a search over SKU and product name, django-filter on branch, variant, type and reference type, `ordering=created_at`. Each row names the document that caused it -- an order, a return, a purchase order (for a receipt or a supplier return), a count or a transfer -- one query per kind on the page; a reference that is not a UUID in its canonical spelling opens nothing |

`core.dates.parse_moment` is `common/dates.ts`: CPython's `date.fromisoformat`, then
`datetime.fromisoformat`, both ported byte for byte from `_datetimemodule.c`
(`common/isoformat.ts`) and checked against 96,000 generated strings. Their quirks are Django's:
`2026010112` is a day, any character of any byte length separates the date from the time, and
`+05:99` is an offset of 6:39. A naive value is made aware in Asia/Dhaka as zoneinfo does it
(`fold=0`: a time the clocks skipped in June 2009 takes the offset from before), and the result
goes to PostgreSQL as the text psycopg sends -- `str()` of the aware datetime, local mean time
`+06:01:40` for the year 1 included -- so the database reads the same instant from the same text.

`fixture_inventory.py` adds a second active branch, PAR3 (which does not fulfil online orders, so
checkout still ships from DHK1), a manager bound to it, and stock moved there by Django's own
services: a transfer, a write-off whose key stays claimed, a count, opening stock for two unnamed
variants (their labels come from their attributes), a row with no history, and references that
open nothing. The phase 3 checkout races set one SKU's stock at every branch; they now set it at
the default branch only.

Two more port bugs were found porting the import, each fixed in its own commit: `pyDecimal`
(behind DRF's `DecimalField`) allowed only single underscores between ASCII digits, where
CPython's `Decimal()` strips whitespace, then drops every underscore and reads any script's digits
(`১২৯০` is 1290); and the multipart parser skipped a part with `filename=""`, which Django reads as a
text field (`TYPE = FILE` only for a non-empty name).

Three port bugs were found on the way and fixed in their own commit. Django resolves a path
before the method, and the router puts a list-level action before `<pk>`: `DELETE
/variants/lookup/` is the lookup route's 405, where the port's detail route answered 404
(`RouteRegistry.resolve` now ranks a literal segment first, and the auth guard hands such a
request to the no-route answer). DRF's `DateField` takes `2026010112`, which the port refused.
And the zone offset of an instant before the year 100 was read in the wrong century.

Then transfers and counts (part 4b), both through `StockService` (`transfer`,
`apply_stock_count`). Neither view names `ordering_fields`, so `OrderingFilter` takes every field
the serializer reads: a branch orders by its name, and `items` by the lines through a join that
returns each document once per line, as Django returns it. Lines have no ordering of their own,
so they are read with Django's statements.

| Endpoint | Notes |
|---|---|
| `GET/POST /api/v1/stock-transfers/`, `GET /api/v1/stock-transfers/<id>/` | `inventory.view` to read, `inventory.transfer` to create; a branch-bound user sees transfers from or to their branch (D94). The source is the acting branch (`resolve_branch`), the target any active one. Idempotent on `Idempotency-Key`: looked up first, then claimed by the document, numbered `TRF-`, in a savepoint. Every source row is locked and checked; then per line the item, `TRANSFER_OUT` at the source's average cost, `receive_stock` at the target (which locks that row, moves its average and sets the variant's latest cost), and the receipt renamed `TRANSFER_IN`; audited; low-stock jobs for the source. A transfer naming a variant twice is a bare 409 (D128, copied); `received_at` stays empty though the status is `RECEIVED` |
| `GET/POST /api/v1/stock-counts/`, `GET/PUT/PATCH/DELETE /api/v1/stock-counts/<id>/` | `inventory.view`, `inventory.count`. A create validates `branch` as any branch, then acts on the one `resolve_branch` allows, numbers the count `SC-` and writes a line per inventory row of that branch, in the order PostgreSQL returns them. An edit may move a count to any branch whatever its state, and writes every column back from the row as read (D126, copied); only an owner or superuser may delete one, an applied one included (D127, copied) |
| `POST /api/v1/stock-counts/<id>/record/` | the figures, while the count is being counted: one per variant, each on the sheet |
| `POST /api/v1/stock-counts/<id>/cancel/` | any count not yet applied, one already cancelled included |
| `POST /api/v1/stock-counts/<id>/apply/` | `apply_stock_count`: the count locked together with its branch's row (`select_for_update()` over a `select_related` join locks both), its status read under the lock; the whole sheet refused when a line counts up stock the branch never received; each line through `adjust`, in the order Django's statement returns them |

Then the content admin, starting with the site settings and the social links (part 5a). The
settings are one row, made on first read when no migration made it (its save queues the `site`
revalidation job, as every save of it does once committed); the social links are one row per
platform, made by migration, with no create or delete. Every pasted address goes through
`content.validators` (`content/validators.ts`), which decide with Python's `urlsplit`,
`hostname` and `port` -- ported line by line from `Lib/urllib/parse.py`, IPv6, IPvFuture and NFKC
checks included (`common/pyurl.ts`) -- with the Unicode `\b` and `\s` of Python's `re`, and with
`html.unescape` over CPython's own HTML5 entity table (`common/html-entities.ts`, generated from
it). The ports were compared with CPython on 30,000 generated addresses, and the validators on
48,000 inputs, before they were committed.

| Endpoint | Notes |
|---|---|
| `GET/PATCH /api/v1/site-settings/` | `settings.view` to read, `content.site_manage` to write. No other method: `RolePermission` runs before the method is looked up, so `PUT` or `DELETE` is a 403 for all but an owner or superuser, who get the 405. A partial write: text trimmed (the email as typed, checked by `EmailField`; `null` refused), the opening hours cleaned to at most seven rows of `days` and `hours` (`partial` reaches the rows, so a row may leave a column out), the map embed reduced to Google's `https://www.google.com/maps/embed` address -- from Google's `<iframe>` code too -- and the map link kept to Google Maps. The row is locked, every field compared with Python's `==`, and only a change saves (the whole row) and is audited `SETTINGS_CHANGED` with what changed |
| `GET /api/v1/social-links/`, `GET /api/v1/social-links/<id>/` | `settings.view`; unpaginated, by position then platform; `POST` is a 403, or a 405 for an owner or superuser. `ordering` takes the serializer's fields as `OrderingFilter` offers them -- `label` as its source, `get_platform_display`, which the database cannot order by: a 500 on every route of the viewset, the edit and the move included (D133, copied) |
| `PATCH /api/v1/social-links/<id>/` | `content.site_manage`. The body is validated before the link is looked up (a bad body for a missing link is a 400), then the row is locked and the address normalised for its platform: the platform's own domain or a subdomain, always `https://`, no credentials, no port; a WhatsApp number becomes `https://wa.me/<digits>`, Bengali digits and the country code included. A link cannot be shown without an address. A change saves `url`, `is_visible` and `updated_at`, and is audited |
| `POST /api/v1/social-links/<id>/move/` | `content.site_manage`; `direction` `up` or `down` in any case (`str()` of what was sent, so a number is refused with the same 400; a body that is not an object is a 500). The run is locked in its order and renumbered 0..n, audited when it moved; the `site` revalidation job is queued every time, past the top too. A move that waits on the lock renumbers in the order PostgreSQL sorted before the wait, undoing a reorder committed meanwhile (D132, copied) |

Then the site pages (part 5b), and with them the page sanitiser: every body goes through
`content.rich_text.sanitize`, which calls nh3. nh3 is ammonia over html5ever, with rust-url and
idna deciding which links stay, and the port follows that pipeline from its source
([ADR-0015](decisions/0015-nest-ports-the-page-sanitiser.md)). `common/html5ever.ts` is html5ever's
tree builder, driven by parse5's tokenizer. html5ever already follows the 2025 standard's
`<select>` parsing, which parse5's own tree builder does not. `content/rich-text.ts` is ammonia's
clean and html5ever's serializer. `common/rust-url.ts` decides whether rust-url parses a link,
with its departures from the URL standard and idna's Punycode and Bidi checks. Compared with nh3
on 150,000 generated fragments and 520,000 generated links before it was committed: no difference.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/site-pages/`, `GET /api/v1/site-pages/<slug>/` | `settings.view`; unpaginated, the standard pages first, then by title. `OrderingFilter` takes every serializer field the table holds (`path` is a property and `updated_by_name` a method, so both are ignored), on the detail too. `PUT` is a 403, or a 405 for an owner or superuser |
| `POST /api/v1/site-pages/` | `content.site_manage`. `SitePageCreateSerializer`'s errors come in DRF's field order (the parent's fields first, then `slug` and `title`). The address is Django's `slugify` of the slug, else the title, cut at 64; nothing ASCII in it is a 400 (D134, copied), a standard page's address too. The titles' whitespace is collapsed, the body sanitised and refused past 100,000 characters once clean. The insert is its own transaction; a taken address is the unique index's violation, a 409 naming the slug. Audited after the commit, with the `site`, `pages` and `page:<slug>` revalidation job queued between them |
| `PATCH /api/v1/site-pages/<slug>/` | `content.site_manage`. The body is validated before the page is looked up, the fields cleaned before the lock. The page is locked by slug, every field compared, and only a change saves (every column) and is audited; the revalidation job follows the commit |
| `DELETE /api/v1/site-pages/<slug>/` | `content.site_manage`; a standard page is a 400. Locked, audited, then deleted with the navigation items that link to it and those nested under them (`CASCADE`): the page first, then the items. Each item queues the navigation revalidation job as it goes; the page's own job follows the commit |

Last, the merchandising (part 5c): the navbar's overrides and the footer's columns and links
(`NavigationItemViewSet`), the announcement bar and homepage hero (`StorefrontBannerViewSet`) and
the homepage carousel (`HomeCarouselViewSet`). The publish windows are DRF's `DateTimeField`
(`common/datetime-field.ts`): Django's `parse_datetime` -- CPython's `fromisoformat`, then
Django's own pattern, any script's digits -- and DRF's `enforce_timezone` in Asia/Dhaka, compared
with DRF on 68,000 generated strings. DRF 3.15 accepts every wall-clock time, one the clocks
skipped or showed twice in 2009 included, with zoneinfo's first offset; a naive time in the first
hours of the year 1 overflows, uncaught (D137, copied). A value the request set answers as DRF
validated it, and one read back as the database holds it.

| Endpoint | Notes |
|---|---|
| `GET/POST /api/v1/navigation-items/`, `GET/PUT/PATCH/DELETE /api/v1/navigation-items/<id>/` | `settings.view` to read, `content.navigation_manage` to write. Unpaginated, by placement, position and label (`select_related` of the parent, category and page, as Django sends it); django-filter on placement, type, `is_active` and parent; `ordering` on position, label and `created_at`. Writes are `NavigationItemSerializer`: `validate_parent` (two levels at most), the window, then `NavigationItem.clean()` on a copy -- the type's category, page, URL and label, the link through `validate_link_url` (checked, saved as sent), and the footer's rules: a column holds links, at most four columns, counted with no lock (D136, copied). Forms and multipart are read, as the image takes an upload (`navigation/`). `Location` on a create is the answer's `url` -- DRF's `get_success_headers` reads the field by that name, here the item's link. A partial update's answer leaves out `category_name` and `page_title` when empty, as DRF will not fall back to a default then. Saves and deletes queue the navigation, categories and footer revalidation at once (one per row a delete takes with it); updates are audited for the label, URL, badge, position, active flag and layout only |
| `POST /api/v1/navigation-items/<id>/move/` | among its siblings (placement and parent), the run locked and renumbered 0..n, then `navigation` and `site` revalidated. D132, copied |
| `GET/POST /api/v1/storefront-banners/`, `GET/PUT/PATCH/DELETE /api/v1/storefront-banners/<id>/` | the same permissions; highest priority first, then newest; django-filter on placement and `is_active`, `ordering` on priority and `created_at`. `StorefrontBanner.clean()`: an announcement needs its message, a hero its title; the URL is not checked. Forms and multipart, the image under `banners/`; `Location` is the answer's `url`. Each save and delete queues `navigation` and `home` at once |
| `GET/POST /api/v1/home-carousel/`, `DELETE /api/v1/home-carousel/<id>/`, `POST /api/v1/home-carousel/<id>/move/` | `settings.view` to read, `content.navigation_manage` to write; no detail read (405, or 403 for all but an owner or superuser). The list never filters, so `ordering` is ignored. Each row carries its product's primary image (the flagged one, else the first) and the range of its sellable variants' prices, and why it is hidden from the homepage. An add locks the run, refuses a missing or archived product, one already there (409, or the unique index's 409 under a race) and a 25th -- counted from the run as read before any wait (D135, copied). A remove locks the item and its product (`select_for_update` over a join). Adds and removes queue `home` after the commit; a move queues it at once, D132 copied |

## Phase 5: the counter

Phase 5 ports `orders/api/pos_views.py` and, with it, what a counter sale leans on: returns and
refunds (`ReturnRequestViewSet`, `OrderViewSet`'s payments and refunds). Its parts, in order:

1. the register's reads and held sales (below);
2. the quote and the manager's approval (`pos/quote/`, `pos/elevate/`: `price_sale`, the discount
   threshold, coupons at the counter, Django's signed approval token);
3. the sale (`pos/sales/`: `sell` under the stock lock with D115's rule and the short-order flags,
   payments into their accounts, the receipt);
4. voiding a sale, and refunds;
5. returns, at the counter and in the back office;
6. the staff order screens `OrderViewSet` serves, which no phase had named;
7. the label sheet added to Django after phase 4 closed (`products/<id>/labels/`).

Every POS view asks for `sales.create` as a flat list, so a method the view does not serve is a
403 for a role without it and a 405 for one with it. All of them name the `pos` throttle scope.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/pos/session/` | what the register needs to open, in one answer: the branch `resolve_branch` allows (`?branch=`), the cashier with every permission code in code-point order (`*` alone for an owner or superuser), the shop's name, currency, receipt footer and VAT number, the branch's newest twenty held sales, and its active accounts by kind and name |
| `GET /api/v1/pos/lookup/?code=` | a scan: the catalogue's own exact lookup (barcode, else SKU in any case, the code stripped), with stock at the branch. Not found is the view's hand-written 404, which quotes the code as sent and is answered before the branch is looked at |
| `GET /api/v1/pos/products/?q=&category=` | the grid: sixty active SKUs of active products, by product name and position (Django's statement, so ties come back alike); `q` in the SKU or product name, or equal to the barcode; `category` an exact slug. Each with its label, price, what the branch can sell (`available`, which can be negative) and the product's primary image |
| `GET/POST /api/v1/pos/holds/`, `GET/PUT/PATCH/DELETE /api/v1/pos/holds/<id>/` | parked carts, unpaginated, newest first, of the branch the request acts on -- a hold at another branch is a 404, and an owner reads one with `?branch=`. `ordering` takes what `OrderingFilter` offers by default: every serializer field by its source (`customer__name`, `created_by__email`; `branch` and `customer` order by the related model's own ordering). A create reads `branch` from the body, though the serializer has it read only, after the serializer has passed; the hold's label is whatever was sent, blank included. `payload` is DRF's `JSONField`: any JSON but `null`, floats and long integers stored as Python writes them, a float past a double refused. An edit finds the hold before it reads the body, and writes every column back. On a PATCH the answer leaves out `customer_name` for a hold with no customer and `created_by_email` for one whose cashier is gone: DRF skips a read-only field with a default on a partial update when its source is missing. No lock anywhere (D142, copied) |
| `POST /api/v1/pos/holds/<id>/resume/` | the payload as stored, and the hold deleted. The body is never read |

Then the two questions a register asks before a sale (part 2). Both are answered by
`price_sale` (`pos/sale-pricing.service.ts`), which the sale itself will use: the lines priced from
the database at the branch's average cost (`checkout/pricing.ts`, shared with checkout), a coupon
checked as checkout checks it and then by the counter's own three rules, the cashier's discount
turned into money, and the discount threshold. A manager's approval travels as Django's
`signing.dumps` token (`common/signing.ts`: `TimestampSigner`'s format and key derivation), so
either API honours what the other approved -- two cases ask one API to approve and the other to
price.

| Endpoint | Notes |
|---|---|
| `POST /api/v1/pos/quote/` | the basket priced exactly as the sale would record it; writes nothing. `PosBasketSerializer`: lines of a variant, a quantity of at least 1 (any size: a Python int) and a line discount; a customer; the sale's discount as an amount or a percentage, never both; a coupon code; an approval token; a branch. An unknown variant, a line discount past its line and a discount past the sale are 400s. A coupon or a discount that cannot go through is not: it comes back in `issues` (`coupon` or `discount`, with the refusal's code, message and details) beside figures priced without the coupon and with the discount. A coupon for free delivery, one not sold in store and one limited per customer on a sale with no customer are the counter's own refusals; the walk-in record is no customer. The cashier's discount -- lines plus the sale's -- is measured against the goods before any discount: none at all without `sales.discount`, and above `RANGON_DISCOUNT_APPROVAL_PERCENT` (20) only for a holder of `sales.discount_override` or with an approval: for this cashier and this permission, at most five minutes old, by a manager still active, still holding the permission and not bound to another branch, and for no more than the percentage approved. Nothing checks that a SKU is active, or in stock (D146, copied) |
| `POST /api/v1/pos/elevate/` | a manager's own email and password, checked as `authenticate()` checks them (an old hash is upgraded, whoever it belongs to), behind the `auth` throttle scope: ten a minute per cashier. The approver must hold the permission asked for -- any string; an owner or superuser holds them all. A discount must name its percentage. Audited as `PERMISSION_ELEVATION` at the cashier's branch; the answer carries the signed approval and its 300 seconds |

Then the sale itself (part 3). `create_pos_sale` is one transaction (`pos/pos-sales.service.ts`),
in Django's order: the key looked up; the basket priced strictly, so the first refusal is the
answer; the total compared with the one the register showed; the customer, or the branch's
walk-in record, made on first use under its unique index; the order numbered `RGN-POS-` and
inserted in a savepoint, so a retry that loses the race for its key answers with the winner's
sale; the lines; stock out through `StockService.sell`, under the row lock; the online orders
left short, where the owner lets the counter into reserved stock; the coupon redeemed under its
row lock (`CouponsService.redeem`, moved out of checkout and shared with it); each payment
captured and posted to the account it lands in (`orders/order-payments.service.ts`); the
customer's totals; a call-back lead closed; the timeline and the audit log. Low-stock jobs are
queued after the commit. The answer is the staff's `OrderDetailSerializer`
(`orders/staff-order.service.ts`), which the back office's order screens will share.

| Endpoint | Notes |
|---|---|
| `POST /api/v1/pos/sales/` | `sales.create`; 201 with the order. `PosSaleSerializer`: the quote's basket, with payments (a method, an amount of zero or more, a tendered amount, a reference, an active account), a register, a note and the total expected. A payment of nothing is skipped; cash tendered short is refused, and tendered over is change; an account the cashier names must be this branch's, open and of the kind the method's money moves through, else the branch's default for that kind, else none at all -- the sale stands and the payment names no account. Too little paid is a 400 after everything else was done, which the transaction undoes; too much is recorded as paid (D151, copied). Stock: `_check_can_reduce` and then the counter's own rule (business rule 1.4, D115) -- units reserved for online orders are refused, with how many are held, unless the organisation's `counter_sells_reserved` is on; then they are sold, and each online order left short, newest first, gets a `STOCK_SHORT` entry the customer does not see and an `ORDER_STOCK_SHORT` warning to everyone at the branch who may view orders. Each line is checked against the shelf as locked, so one SKU on two lines can oversell (D149, copied). An `Idempotency-Key` already used answers 201 with the order that holds it, whoever made it and whatever the basket -- after the body has been validated and the branch resolved; an empty one is stored and then answers every later sale (D147, copied) |
| `GET /api/v1/pos/sales/<id>/` | `sales.view`; any order by id, whatever its branch or channel (D152, copied). `?ordering=` takes the sale serializer's field names: one that is not a field of an order is a 500 (D148, copied), and any other changes nothing |
| `GET /api/v1/pos/sales/<id>/receipt/` | the same lookup; the order, `document_type: RECEIPT`, the organisation's name, address, phone, email, VAT number and receipt footer, the order's branch, and the cashier's name |
| `POST /api/v1/pos/sales/<id>/void/` | `sales.cancel`; the same lookup, so any branch's sale (D152). `void_sale`: an online order is a 409, a sale already cancelled answers as it is, and a reason is required -- read with `request.data.get` and `.strip()`, so a body that is not an object, or a reason that is not a string, is a 500. Then one transaction: the order locked; every line back on the shelf at the row's average cost (`RETURN`, reference `order_void`); what was paid and not yet refunded sent back through `refund_order` -- one refund against the largest captured payment, in its method and out of its account, or the branch's own for the method, refused when a drawer does not hold that much (`INSUFFICIENT_FUNDS`, with the balance as `format_money` prints it) or is closed; the coupon's use released under its lock; the order `CANCELLED`, with the reason, on the timeline and in the audit log. The status is not read again under the lock (D154), a line is restocked whether or not it was returned (D155), and a sale paid two ways is refunded one way (D153); all copied |

Then returns (part 5), in the back office step by step and at the counter in one
(`orders/returns.service.ts`). A return is its own record -- the order and its payments are never
edited -- and moves REQUESTED, APPROVED, RECEIVED, COMPLETED, or to REJECTED before the goods are
back. Every step takes the return's row first; opening one and paying its refund take the order's
row, and receiving takes each order line's. What comes back is worked out once, when the return is
opened (`returnShares`): the line's total less its share of any whole-order discount, plus its VAT
where VAT sat on top, for the units returned -- rounded once for the request, the last line
carrying the odd paisa -- with shipping added when the shop was at fault, and never more than is
left to refund on the order. Goods go back on the shelf at RECEIVED, only for lines to RESTOCK,
through `StockService.restockReturn`; money goes back at COMPLETED through `refundOrder`, the same
one a void uses.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/returns/` | `orders.view`; paginated, newest first, the returns of orders at the user's branch (every branch for an owner, an administrator or staff with no branch). Filters `status`, `reason`, `order`; `ordering` takes every serializer field by its source (`order__number`, `order__customer__name`; `order` orders by the order's own default, newest placed first) -- and `items`, which lists a return once per line (D159, copied). Each return with its lines, read in no stated order (D161, copied) |
| `GET /api/v1/returns/<id>/` | the same scope and filters: another branch's return, or one the filters exclude, is a 404; a filter value that is not a choice is a 400 |
| `POST /api/v1/returns/` | `sales.refund`; 201. `CreateReturnSerializer`: an order, a reason, lines of an order line, a quantity of at least 1 and a restock decision (RESTOCK unless said), a comment. The order is any order by id, whatever its branch (D156, copied); one not there is a 404. `request_return`: the order locked; a cancelled or refunded order, and an online order whose goods have not left, are 409s; no lines is a 400; past the return window (`RANGON_RETURN_WINDOW_DAYS`, 14, from delivery or else from placing) it takes `sales.refund_override` or is a 403; the order's lines locked; a line not on the order, more units than are still returnable, and a final-sale product are 400s. A line's returnable count moves only when goods are received, so a second return for the same unit is opened too (D157, copied); one line asked for twice is the unique index's 409. A DELIVERED or SHIPPED order goes to RETURN_REQUESTED. The staff who refund at the order's branch are notified after the commit |
| `POST /api/v1/returns/<id>/approve/` | `sales.refund`; REQUESTED to APPROVED, anything else a 409. The comment is `request.data.get("comment")`, unvalidated: a number or a list is stored as Python prints it, `null` is the column's 409, a body that is not an object is a 500 (D162, copied) |
| `POST /api/v1/returns/<id>/reject/` | `sales.refund`; a REQUESTED or APPROVED return to REJECTED, anything else a 409. An order waiting on a return goes back to DELIVERED, whatever other returns it has and whatever it was before (D163, copied) |
| `POST /api/v1/returns/<id>/receive/` | `sales.refund`; the body is validated before the return is looked for. `ReceiveReturnSerializer`: optionally one decision per line -- a restock decision, a condition note of up to 255 characters -- a line named twice a 400. Only an APPROVED return, else a 409. The decisions are written in one statement that leaves each line's `updated_at` as it was, as `bulk_update` does; a line not on the return is a 400. RESTOCK lines go back on the shelf under a `RETURN` referring to the return; every line's returned count moves under the line's row lock, and the table's own check refuses a unit coming back twice (a 409). The timeline entry records how many lines were restocked and the decision for each SKU |
| `POST /api/v1/returns/<id>/complete/` | `sales.refund`; the body is validated before the return is looked for. `CompleteReturnSerializer`: an amount of at least 0.01 (the return's own unless given, and any amount up to what is left to refund on the order), a method the ledger knows or blank, any account. A COMPLETED return answers as it is; only a RECEIVED one is completed, else a 409. The order locked, then `refund_order` keyed by the `Idempotency-Key` header, or by the return when there is none: a retry pays once, and a key another refund holds completes the return with nothing paid (D160, copied). An order waiting on the return, with every line back, goes RETURNED and then REFUNDED, whatever was refunded. Audited as `REFUND_ISSUED` on the return |
| `POST /api/v1/pos/returns/` | `sales.refund`, `pos` scope; 201. The same body as opening a return, its comment dropped: requested, approved, received and refunded in one transaction, by the same four steps. The refund's method is `request.data.get("refund_method", "CASH")`, unvalidated: a blank or `null` is the method of the largest payment, and one the ledger does not know -- `BITCOIN`, a number, a list -- is recorded against no account and moves no balance; past 20 characters it is a 500 (D158, copied) |

Then the back office's orders (part 6): `OrderViewSet`, every channel's orders read and acted on.
The reads are `orders/staff-order.service.ts`, whose `OrderDetailSerializer` the counter already
answers with. The writes are `orders/staff-order-actions.service.ts`, over three shared pieces:
`OrderLifecycle` (`lifecycle.transition` with the stock side of its two edges -- PACKED turns the
order's reservation into a sale through `StockService.consumeReservation`, CANCELLED gives the
reservation and the coupon's use back through `releaseReservation` and `CouponsService.release`),
`OrderPayments.capture` (`capture_payment`, moved out of the webhook's service so that a gateway's
event and a member of staff capture through one function and one lock) and `refundOrder`.

Every route runs the viewset's queryset and filters, so an order at another branch, or one the
query string excludes, is a 404 on a write as on a read.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/orders/` | `orders.view`; `OrderListSerializer`, paginated, newest placed first, the orders of the user's branch. `search` matches the number or the customer's name in any case, or the digits of a phone number once country and trunk prefixes are taken off (`880` alone matches nobody); `date_from` and `date_to` are days in Dhaka, read as Django's `DateField` reads one -- a value that is not a date is a 400 naming it. Filters `channel`, `status`, `payment_status`, `branch`, `customer`; `ordering` by `placed_at` or `grand_total`. A NUL in `search` is a 500 (D172, copied) |
| `GET /api/v1/orders/<id>/`, `.../timeline/`, `.../invoice/`, `.../packing-slip/` | `orders.view`; the order with its lines, payments, refunds and events; its events alone; the order with `document_type: INVOICE` and the organisation; the same as `PACKING_SLIP` with no prices on the lines |
| `POST /api/v1/orders/<id>/status/` | `orders.update_status`; the body is validated first (`to_status`, any string; a reason of up to 255 characters). `transition`: the order locked; an order already there answers as it is; an edge the status machine does not have is a 409 with both ends. PACKED locks the stock rows, releases what the order holds and deducts each line at the row's average cost -- a line already sold for this order is skipped -- and a shelf that cannot cover it is a 409 that leaves the order where it was. CANCELLED is refused once stock has left the shelf, releases the reservation and the coupon's use, and keeps the reason; it asks for no `sales.cancel` and refunds nothing (D166, copied). SHIPPED and DELIVERED tell the customer after the commit: an in-app notice, then the email and SMS jobs |
| `POST /api/v1/orders/<id>/cancel/` | `sales.cancel`; `cancel_order`: only a PENDING, CONFIRMED or PROCESSING order, else a 409; cancelled through the status machine, then whatever was paid and not refunded goes back through `refund_order`, in one transaction. The reason is `request.data.get("reason")` as sent: Python slices it, so a string or a list passes and anything else is a 500 (D168, copied). An order paid and refunded in full cannot be cancelled: the refund of nothing is a 400 (D169, copied). The answer carries the payment status and totals from before the refund (D170, copied) |
| `POST /api/v1/orders/<id>/payments/` | `sales.payment_record`; 201 with the order. `RecordPaymentSerializer`: a method, an amount of zero or more, a reference, an open account. A pending payment of the same method and amount is captured -- its account set first, in a statement of its own, when the body names one -- under the payment's row lock, into the account it lands in; anything else is recorded as a new captured payment. Nothing compares the amount with what the order owes, no order is refused, and the route takes no `Idempotency-Key`: the same request twice is the money twice (D167, copied) |
| `POST /api/v1/orders/<id>/refunds/` | `sales.refund`; 201 with the refund. `RefundRequestSerializer`: an amount, a reason, a method the ledger knows, an open account. `refund_order` under the order's row lock, keyed by the `Idempotency-Key` header: never more than was paid and not yet refunded (a 422), through the largest captured payment (D153), out of the account the method's money moves through. A key another refund holds answers with that refund, whichever order it is on (D171, copied) |

Last, the barcode label sheet (part 7), which Django gained after phase 4 closed
(`catalog/admin/labels.service.ts`: `inventory.labels` and `ProductViewSet.labels`). Nothing in
it moves stock and it takes no lock: a tick is a new `inventory_labelprint` row, and the newest
row for a branch and a variant is the state.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/products/<id>/labels/?branch=` | `products.view`; the product through the viewset's declared filters only (the list's `search` and `never_ordered` do not apply here), at the branch `resolve_branch` allows. Every variant as `ProductVariantSerializer` writes it, with its stock at the branch, and two more fields: `label_status` -- null for a variant never marked, else whether its labels are printed, how many, the stock when it was marked, when (`isoformat()`, so `+00:00`) and by whom (the name, or the email of someone with none, or nothing when the account is gone), and the units purchased in since a printed mark -- and `suggested_labels`: one per unit on hand, or per unit delivered since a printed mark, never more than are on hand, never more than 500, and none for a shelf below zero |
| `POST /api/v1/products/<id>/labels/` | `products.update`; 200 with the sheet as it then stands. `LabelMarksSerializer`: a branch (in the body; the query string's is not read), and 1 to 200 marks of a variant, `printed` and a count of 0 to 500. `mark_labels`: each variant once, every one the product's own, else a 400 naming the strays; all the marks written or none; `on_hand` read from the branch's stock row, never from the request; an un-mark records no count |

## Phase 6: the back office

Phase 6 ports what is left of the staff API outside reports: money, buying, customers, coupons
and delivery. Its parts, in order:

1. accounts, the cash book and transfers (below);
2. expenses and their categories, and the party ledger;
3. suppliers and supplier products;
4. purchase orders: raising, receiving (stock in at its cost) and cancelling;
5. supplier payments;
6. customers, and the call-back list (`abandoned-checkouts`);
7. coupons;
8. shipping: zones, methods, couriers and shipments;
9. review moderation;
10. staff accounts and the organisation (`branches`, `users`, `roles`, `permissions`,
    `organization`, `organization/tax`), which no phase had named.

`CashBookService` (`finance/cash-book.service.ts`) is now the whole of `finance.services`' money
movement: `move` is `record_movement` for every transaction type -- the account locked, an
`Idempotency-Key` looked for before the lock and again under it, a retry that loses the race for
its key answered with the winner's movement -- and `transfer` is `transfer`, both accounts locked
lowest id first. A sale's payment, a refund, a void and a return already posted through it; they
now post through the same `move`.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/accounts/` | `finance.view`; paginated, by branch name, kind and name; the accounts of the user's branch. Filters `branch`, `kind`, `is_active`; DRF's `SearchFilter` over the name, the account number and the bank's name; `ordering` by `name`, `balance` or `created_at` |
| `POST /api/v1/accounts/` | `finance.manage`; 201. `AccountSerializer`: a branch (one the user may act on), a name of up to 120 characters that no other account at the branch has, a kind, an account number, a bank, the default and overdraft switches, notes, an opening balance. The account is opened with nothing and the opening balance posted as an `OPENING` movement, so a balance is the sum of its ledger from the first row; a negative one needs the overdraft switch. A new default takes the place of the branch's old one for the kind in the same transaction. `is_active` is validated and not used: an account opens active (D175, copied). Audited as `SETTINGS_CHANGED` |
| `GET /api/v1/accounts/<id>/`, `PUT`, `PATCH` | `finance.view`; `finance.manage` to edit. A PUT is read as a PATCH is. The descriptive fields only: `branch`, `opening_balance` and `balance` are dropped. Making an account the default demotes the kind's other default; changing a default's kind to one that has a default is the index's 409 (D176, copied). Only what changed is audited. There is no DELETE: an account is closed with `is_active` |
| `GET /api/v1/accounts/<id>/transactions/` | `finance.view`; the account's cash book, paginated, newest first. `date_from`, `date_to` and `transaction_type` go to the lookup as sent: a date is read as a model `DateTimeField` reads one, so a bare day is its midnight in Dhaka at either end -- `date_to=2026-09-15` leaves that day out (D177, copied) -- and a value that is not one is a 400 naming it |
| `GET /api/v1/accounts/cash-position/` | `finance.view`; the open accounts' total, by kind and one by one, for the branch asked for (or the user's own, unless they may cross branches), and money in, out and net over `core.dates`' window -- transfers and opening balances left out of both sides |
| `POST /api/v1/accounts/record-movement/` | `finance.adjust`; 201 with the movement. A deposit, a withdrawal or a correction, never a type a sale or a payment makes; the amount positive, except a correction's, which is signed and not zero; a withdrawal and a correction need a reason; the account at a branch the user may act on, open, and not paid out past what it holds unless it may go overdrawn. Once per `Idempotency-Key`. A deposit that takes the balance past the column is a 500 (D173, copied). Audited as `PAYMENT_RECORDED` |
| `POST /api/v1/accounts/verify-integrity/` | `settings.manage`; 200. Every account's cached balance beside the sum of its ledger, and the ones that differ, for the body's `branch` or for all. The body is read with `request.data.get`: one that is not an object is a 500 (D174, copied) |
| `GET /api/v1/account-transactions/`, `GET .../<id>/` | `finance.view`; the whole cash book the user may see, by the account's branch. Filters `account`, `transaction_type`, `reference_type`; the same `date_from` and `date_to`; `ordering` by `occurred_at` or `amount` |
| `GET /api/v1/account-transfers/`, `GET .../<id>/` | `finance.view`; transfers out of an account at the user's branch, newest first |
| `POST /api/v1/account-transfers/` | `finance.transfer`; 201. Two different accounts, both at branches the user may act on, both open, and an amount the source holds. The transfer's row is written first, under its `ATR-` number and its key, so a retry claims the key or loses it before any money moves; then `TRANSFER_OUT` and `TRANSFER_IN` in the same transaction. Audited as `PAYMENT_RECORDED` |

Then what the money is spent on (part 2): `finance/expenses.service.ts` and
`finance/party-ledger.service.ts`. An expense is a document and a movement written in one
transaction -- the document first, under its `EXP-` number and its key, so a retry claims the key
or loses it before any money leaves -- and it is never edited or deleted: a void puts the money
back with a compensating `ADJUSTMENT`, under the expense's own row lock. The expense routes are
the first outside uploads to read a form as well as JSON, since a receipt is attached as a file.

| Endpoint | Notes |
|---|---|
| `GET/POST /api/v1/expense-categories/`, `GET/PUT/PATCH .../<id>/` | `finance.view`; `finance.manage` to write. Paginated, by name, each with the count of its recorded expenses; filter `is_active`, search over name, code and description. A category is made with a name and a code -- the code normalised (`RENT`, `TEA_MONEY`) or made from the name -- neither already used, the name in any case. An edit, by PUT or PATCH alike, takes a name, a description and the active switch; the code is the key expenses were filed under and is dropped. No DELETE: a category is retired |
| `GET /api/v1/expenses/`, `GET .../<id>/` | `finance.view`; paginated, newest spent first, the expenses of the user's branch. `date_from` and `date_to` are `core.dates`' window, and a value that is not a date is a 400 on every route of the viewset; voided expenses are listed unless `include_void=false`; filters `branch`, `category`, `account`, `status`; search over number, note and the category's name. A receipt is named by the route that serves it, never by where it is stored |
| `POST /api/v1/expenses/` | `finance.expense`; 201, JSON or a form. A category still in use, an account of the branch spending the money, an amount above zero, a moment not in the future, a note, a receipt -- an image or a PDF by its stated type and its extension, up to 10 MB, stored under a random name that keeps only the extension. `record_expense`: once per `Idempotency-Key`; the `EXPENSE` movement refused if the account is closed or cannot cover it, taking the document with it. Audited as `EXPENSE_RECORDED` |
| `GET /api/v1/expenses/<id>/attachment/` | `finance.view`, through the same queryset as reading the expense; the file, typed by its extension, `inline` under the expense's number, `private, no-store`, `nosniff`. No receipt, or a file that is gone, is a 404 |
| `POST /api/v1/expenses/<id>/void/` | `finance.expense`; a reason is required and validated before the expense is looked for. The expense locked; one already voided is a 400; the money back as an `ADJUSTMENT` naming the expense; the row marked void. An expense whose account has since been closed cannot be voided (D179, copied). Audited as `EXPENSE_VOIDED` |
| `GET /api/v1/expenses/summary/` | `finance.view`; what was spent in the window at the branch asked for (or the user's own), voided expenses left out, and each category's total, count and share |
| `GET /api/v1/party-ledger/` | `reports.financial`; who owes the business and whom it owes, derived each time: orders that are real trade with a balance, by customer, aged from the day placed; purchase orders committed and not settled by money or credit, by supplier, aged from the due date. Days are calendar days in Dhaka. Each side with its total, its ageing in four buckets and its parties, the largest debt first |

Then who the shop buys from (part 3): `purchasing/suppliers.service.ts` and
`purchasing/supplier-products.service.ts`. Neither moves stock or money. A supplier is a plain
`ModelViewSet`; an offer -- one supplier's price for one SKU -- is reference data too, and of a
SKU's offers one is the preferred one, which the purchase order form suggests. That flag moves
only through `set-preferred`.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/suppliers/`, `GET .../<id>/` | `purchases.view`; paginated, by name, each with the count of its orders sent and not yet received in full (`outstanding_orders`, an annotation: a supplier just made answers without it). Filter `status`, `SearchFilter` over name, code and phone, `ordering` by `name` or `created_at` |
| `POST /api/v1/suppliers/`, `PUT`/`PATCH .../<id>/` | `purchases.create`. `SupplierSerializer`: a name; a code no other supplier has, or one made from the name as `unique_supplier_code` makes it -- the ASCII letters and digits, hyphenated, upper-cased, cut at 24, `SUPPLIER` when nothing is left, numbered `-2`, `-3` until free -- on a create only; a phone kept as typed unless it is a mobile, which is stored canonically (`ContactPhoneField`: the length is checked after that); an email; terms and a lead time of 0 to 32767 days; a status. An edit writes every column back from the row as read. Nothing is audited (D183, copied) |
| `DELETE /api/v1/suppliers/<id>/` | `settings.manage`; refused once the supplier was ordered from or paid (`PROTECT`: the bare 409); otherwise its price list goes with it |
| `GET /api/v1/supplier-products/`, `GET .../<id>/` | `purchases.view`; paginated, the preferred offers first, then the cheapest -- an order with many ties, so the statement carries Django's joins in the order its query holds them: each filter and then the search names its tables first, and `select_related` adds the rest. Filters `supplier`, `variant`, `product` (a `UUIDFilter`: stripped, read as `uuid.UUID` reads it, "Enter a valid UUID."), `is_preferred`, `is_active`; `SearchFilter` over the supplier's code for the item, the SKU, the product's name and the supplier's; `ordering` by `last_cost`, `last_purchased_at` or `created_at`. Each offer with its supplier's name, code and status, the SKU, its label, and the lead time that applies -- its own, else the supplier's |
| `POST /api/v1/supplier-products/`, `PUT`/`PATCH .../<id>/` | `purchases.create`. A supplier and a SKU, each a `PrimaryKeyRelatedField`, the pair not already quoted (`UniqueTogetherValidator`, in the shop's words, as a non-field error; on an edit a missing half is read from the row and an unchanged pair is not checked); the supplier's own code, a cost, a lead time, a minimum order quantity, the active switch, notes. `is_preferred` is read only. A cost below zero and a minimum of nothing pass the serializer and are the table's check constraints' 409 (D180, copied). An edit writes every column back as read, the preference included (D184, copied) |
| `DELETE /api/v1/supplier-products/<id>/` | `purchases.create`; the preferred offer too, which leaves the SKU preferring nobody |
| `POST /api/v1/supplier-products/<id>/set-preferred/` | `purchases.create`; 200 with the offer. The body is never read. `set_preferred_supplier`: the offer locked by its supplier and SKU; a withdrawn offer refused; the incumbent locked and demoted, this one promoted, and an `UPDATE` audit entry naming both suppliers -- written even when the offer was preferred already. The supplier's own status is not looked at (D182, copied) |

Then the orders themselves (part 4): `purchasing/purchase-orders.service.ts`, with
`purchasing/purchase-documents.ts` for `PurchaseOrderSerializer` and what nests in it. An order
is raised as a draft, sent, received in one delivery or several, and what is faulty goes back
for a credit; nothing is edited. Every step takes the order's row first; a delivery and a return
then take the order's lines, and the shelf through the stock service. Receiving is
`StockService.receiveStock`, which transfers and the import already used; a return is the new
`returnToSupplier` -- the shelf must hold the units, overselling or not, and what is left is
valued at what it cost: `((on_hand * avg) - (qty * cost)) / (on_hand - qty)`, never below
nothing, an emptied shelf keeping its last average.

An order's lines, a receipt's and a return's have no ordering of their own (D161's kind), so
they are read with the statements Django's prefetch sends, `IN (...)` in the page's order.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/purchase-orders/` | `purchases.view`; paginated, newest raised first, the orders of the user's branch. `date_from` and `date_to` are `core.dates`' window on the day raised, and a value that is not a date is a 400 on every route of the viewset; filters `status`, `supplier`, `branch`, `payment_status`; `ordering` by `created_at` or `expected_at`. Each order with its lines (SKU, product, label, ordered, received, returned, outstanding), its receipts newest first and its returns, and `outstanding`: the total less what was paid and what was credited, which goes below zero |
| `GET /api/v1/purchase-orders/<id>/` | the same, and `unpublished_products`: the products on the order a shopper cannot see yet, each with whether it could be published -- an active variant priced above zero, as `publish_product` asks |
| `GET /api/v1/purchase-orders/<id>/receipts/` | `purchases.view`; the order's deliveries, newest first, unpaginated |
| `POST /api/v1/purchase-orders/` | `purchases.create`; 201. `CreatePurchaseOrderSerializer`: a supplier that exists (an inactive one too), a branch (`resolve_branch`), lines of a variant, a quantity of at least 1, a cost of at least 0, a discount, and VAT as a fraction of 0 to 1; a date expected, an invoice number, shipping, notes. `_check_lines`: at least one line, no discount past its line, no SKU twice. Numbered `PO-` from the row-locked sequence; each line's total and the order's worked out from the rows as stored, tax rounded half up per line. A variant is any UUID: one that does not exist fails at the commit, a bare 409, and a quantity past an integer is a 500 (D190, D191, copied). Nothing is audited |
| `POST /api/v1/purchase-orders/<id>/send/` | `purchases.create`; 200. The body is never read. Under the order's lock: only a draft, else a 409; `ordered_at` stamped; audited |
| `POST /api/v1/purchase-orders/<id>/cancel/` | `purchases.create`; 200. Under the lock: a draft or a sent order with nothing received and nothing paid, each refusal a 409 in its own words. The reason is `request.data.get("reason", "")` as sent, written to the audit entry as a `TextField` takes it: a number or a list as Python prints it, `null` the column's 409, a body that is not an object a 500 (D189, copied) |
| `POST /api/v1/purchase-orders/<id>/receive/` | `purchases.receive`; 201 with the receipt and the order. The body is validated before the order is looked for: lines of an order line, a quantity of at least 1 and optionally the cost on the delivery note; a line named twice is a 400. Under the order's lock a cancelled or closed order is a 409 -- a draft is received (D186, copied); a receipt numbered `GRN-`; the order's lines locked; each line checked against what is outstanding, put on the shelf at its cost (the branch's average moves, the SKU's latest cost is set), its received count raised, and the supplier's price list updated -- the first supplier a SKU is received from becomes its preferred one, and a withdrawn offer is brought back. Then the order RECEIVED or PARTIALLY_RECEIVED, and a `PURCHASE_RECEIVED` audit entry. No `Idempotency-Key` (D188, copied) |
| `POST /api/v1/purchase-orders/<id>/return/` | `purchases.receive`; 201 with the return and the order. Lines of an order line and a quantity, a reason from the list, notes. Under the order's lock: a return already made under this `Idempotency-Key` answers as it is -- whichever order it is on, and before anything else is checked (D192, copied); a draft or cancelled order is a 409. The lines locked with their variants; the return claimed under its `PRN-` number in a savepoint; each line checked against what was received and not sent back, taken off the shelf through the ledger at the order line's cost (D185, copied), a `STOCK_ADJUSTMENT` audit entry each; the order credited with the sum and its payment badge refreshed -- credit counts only towards settling in full. Low-stock jobs follow the commit |

Then paying for them (part 5): `purchasing/supplier-payments.service.ts`. A payment is money
out of one of the business's own accounts -- `CashBookService.recordSupplierPayment`, the same
`record_for_reference` a sale's payment and a refund post through -- and, against an order,
what was paid on it. It is recorded once and never edited or deleted.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/supplier-payments/` | `purchases.view`; paginated, newest paid first. A branch-bound user sees the payments against their branch's orders and those out of their branch's accounts (D95): an OR across two outer joins, which Django's query holds before the supplier's -- and the account's branch with them, when the ordering asks for the account. Filters `supplier`, `purchase_order`, `method`. The view names no `ordering_fields`, so `OrderingFilter` takes every serializer field by its source: `supplier` and `supplier__name` by the supplier's name, `purchase_order` by the order's own ordering (newest raised first), `purchase_order__number`, `account` by the account's (its branch's name, kind, name), `account__name`; `supplier_name`, `purchase_number` and `account_name` are not names it knows. There is no detail route |
| `POST /api/v1/supplier-payments/` | `purchases.pay`; 201. `SupplierPaymentSerializer`: a supplier, optionally an order and an account, a method (cash, bank, cheque, mobile wallet, other), a reference, a moment, notes -- and an amount DRF does not require, the column having a default: a body without one is a 500 (D194, copied). Paying an order is acting on its branch (`resolve_branch`, a 403); `branch` is read from the body as sent and resolved even when the order's branch is the one used (D197, copied). `record_supplier_payment`: an amount above zero; a payment already made under this `Idempotency-Key` answers as it is, looked for before any lock and again under the order's; the order locked -- it must be this supplier's, not a draft or cancelled, and owe at least this much after what was paid and credited (`PAYMENT_EXCEEDS_OUTSTANDING`, a 422); the payment's row claimed in a savepoint; the money out of the account named -- which must be the paying branch's, open and of the method's kind -- or the branch's own for the method, or none at all, the payment standing with no account; refused when the account cannot cover it, taking the payment with it. Then the order's paid total and badge, and a `PAYMENT_RECORDED` audit entry at the paying branch |

Then the people (part 6): `customers/customers-admin.service.ts` for `CustomerViewSet`, over the
`AddressesService` the storefront's account already used -- so the back office and a customer
editing their own addresses hold one default per customer under the same row lock -- and
`orders/leads-admin.service.ts` for the call-back list.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/customers/`, `GET .../<id>/` | `customers.view`; paginated, newest first, each with its addresses (the default first, then the newest) and whether it has a storefront login. `search` matches the name or the email in any case, or the phone by the digits that identify a subscriber -- `+8801911...` finds the number stored as `8801911...`, and a country code or a trunk `0` alone adds no clause -- and applies on every route, as it is `get_queryset` that reads it: a NUL in it is a 500 (D201, copied). Filters `customer_type`, `is_active`; `ordering` by `name`, `created_at`, `total_spent` or `last_order_at`. `tags` is whatever JSON was stored, a float kept a float |
| `POST /api/v1/customers/`, `PUT`/`PATCH .../<id>/` | `customers.create`; `customers.update` to edit. `CustomerSerializer`: a name; a phone made canonical before `UniqueValidator` sees it, so two spellings of one number collide in words; an email, unique as typed and stored lower-cased -- another customer's email in another case is the index's bare 409 (D198, copied); a type, the active switch, a birthday, notes, tags. A customer must be left with a phone or an email, judged on the record as it would be saved. The walk-in flag, the totals and the points are read only. An edit writes every column back as read |
| `DELETE /api/v1/customers/<id>/` | `customers.update`; 204. The customer is deactivated, never deleted: its orders stay |
| `GET /api/v1/customers/lookup/?phone=` | `customers.view`; the counter's search. Not the list's queryset: active customers who are not a branch's walk-in record whose number holds the digits typed, by name, ten at most, each with no more than a name, a number, an email, a type, a count of orders and the last one's date. Fewer than three identifying digits answers `{"results": [], "min_length": 3}` |
| `GET /api/v1/customers/<id>/orders/` | `customers.view`; the customer's last hundred orders, newest placed first, as the order list writes them, whatever their branch |
| `GET/POST /api/v1/customers/<id>/addresses/`, `PATCH/DELETE .../addresses/<address>/` | a requirement per method: `customers.view` to read, `customers.update` to write, and a method the action does not serve is a 403 for all but an owner or superuser. The customer comes from the URL, never the body. `add_address`, `update_address`, `delete_address`: the first address is the default whatever was asked, the only address stays it, and a deleted default hands the flag to the newest left -- each audited. An address key that is not a UUID is Django's own `ValidationError`, a 400 under `non_field_errors` |
| `GET/POST /api/v1/customers/<id>/notes/`, `DELETE .../notes/<note>/` | the same per-method rule. Staff commentary, the pinned first; a note is added and deleted, audited both ways, never edited |
| `GET /api/v1/abandoned-checkouts/`, `GET .../<id>/` | `customers.view`; the call-back list, paginated, last seen first, the leads of the user's branch. Filters `status`, `branch`; the view names no `ordering_fields`, so every serializer field orders by its source (`branch__code`, `recovered_order__number`) |
| `PUT`/`PATCH /api/v1/abandoned-checkouts/<id>/` | `customers.update`; only the note is writable, and a PUT with nothing is accepted. The save writes every column back as read (D200, copied). A PATCH's answer leaves out `recovered_order_number` for a lead with no order, as DRF skips a defaulted read-only field then |
| `POST /api/v1/abandoned-checkouts/<id>/lost/` | `customers.update`; 200. `mark_lost`: the lead LOST whatever it was -- a recovered one too (D199, copied) -- with `str(request.data.get("note", "")).strip()` as its note when that says anything: `null` is the note "None", a body that is not an object a 500 |

Then coupons (part 7): `promotions/coupons-admin.service.ts`, the screen that makes and edits
what `checkout/coupons.service.ts` has priced and redeemed since phase 3.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/coupons/`, `GET .../<id>/` | `content.coupons_manage`, for reading too; paginated, newest first. Filters `is_active`, `discount_type`; `ordering` by `created_at` or `used_count`. Each coupon with whether its total limit is used up, the categories it is restricted to (in the category's own order) and the products (newest first), and `channels` as stored -- a list, or whatever JSON an older row holds |
| `POST /api/v1/coupons/`, `PUT`/`PATCH .../<id>/` | `CouponSerializer`: a code no other coupon has, compared as typed and stored trimmed and upper-cased -- another coupon's code in lower case is the index's bare 409 (D202, copied); a type; a value, a minimum order and a cap; a window; a total limit and one per customer, null for none; categories and products, each a `ManyRelatedField` (a list of keys, the first that fails being the field's error; a JSON object is read by its keys, as Python iterates one); channels, cleaned to the sales channels named, once each in the enum's order, or refused; the active switch. `validate` judges the coupon as it would be left: the window must end after it starts -- two bounds from one request compared by wall clock, a stored one by instant; free delivery carries no value, whatever was sent; any other needs a value above zero, a percentage at most 100. Nothing stops a minimum or a cap below zero (D204, copied). An edit writes every column back as read, `used_count` among them (D203, copied), then sets each restriction that was sent |
| `DELETE /api/v1/coupons/<id>/` | 204. A coupon ever redeemed -- a released redemption counts -- is switched off and kept; any other is deleted with its restrictions, and the carts and orders that named it are left without one (`SET_NULL`) |
| `GET /api/v1/coupons/<id>/redemptions/` | every use, newest first, unpaginated: the order's number, the customer's name, the discount, and when a cancelled order gave the use back |

Then shipping (part 8): `shipping/shipping-settings.service.ts` -- zones, methods and couriers,
three plain `ModelViewSet`s -- and `shipping/shipments.service.ts`, `ShipmentViewSet` over
`shipping.services`: a parcel booked against an order, and the tracking updates that move the
order. What a shopper is offered at checkout was phase 3's reading of the same rows.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/shipping-zones/`, `GET .../<id>/` | `settings.view`; unpaginated, by position then name. Each zone with its methods (by position, then price) and its `cities` as stored. The view names no `ordering_fields`, so `ordering` takes every serializer field by its source: `methods` joins them and lists a zone once per method |
| `POST /api/v1/shipping-zones/`, `PUT`/`PATCH .../<id>/` | `settings.manage`. A name no other zone has; `cities` a list of names, stored trimmed, lower-cased and once each -- a bare string, an object or a list holding anything but strings is refused; a zone whose stored cities are not clean keeps them through an edit of anything else. A second fallback zone is accepted (D212, copied) |
| `DELETE /api/v1/shipping-zones/<id>/` | 204. Its methods go with it, and the orders and parcels that named one are left without a method (`SET_NULL`), in Django's order: methods read, orders and parcels updated, methods deleted, the zone deleted |
| `GET /api/v1/shipping-methods/`, `GET .../<id>/` | `settings.view`; unpaginated, by position then price. Filters `zone` (a key that must exist) and `is_active`, which a detail route applies too: a retired method read with `?is_active=true` is a 404. `ordering` by any model field, `zone` (its position, then name) or `zone__name`; `eta_label` is "Collect in store", "1 day", "2 days" or "1–3 days" |
| `POST /api/v1/shipping-methods/`, `PUT`/`PATCH .../<id>/` | `settings.manage`. A zone, a name, a slug of a code; `(zone, code)` unique, judged before anything else in `validate` ("The fields zone, code must make a unique set."); a price and a free-over not below zero; the days read forwards, judged on the method as it would be left -- but on a create only when both are sent, so one alone that crosses the other's default meets the check constraint, a bare 409 (D205, copied). The answer carries the money validated, not stored: a price of "-0" is answered "-0.00" and kept as 0.00 |
| `DELETE /api/v1/shipping-methods/<id>/` | 204; the orders and parcels that named it are left without one |
| `GET /api/v1/couriers/`, `GET .../<id>/` | `settings.view`; unpaginated, by name; `ordering` by any field |
| `POST /api/v1/couriers/`, `PUT`/`PATCH .../<id>/` | `settings.manage`. A name and a slug of a code, each unique; a phone kept as typed unless it is a mobile, which is stored canonically (`ContactPhoneField`); a tracking page of up to 255 characters, not checked for its placeholder (D211, copied); an integration, "manual" unless sent |
| `DELETE /api/v1/couriers/<id>/` | 204, or a bare 409 while a parcel names it (`PROTECT`) |
| `GET /api/v1/shipments/`, `GET .../<id>/` | `orders.view`; paginated, newest first, scoped to the branches the user may see through the order (D68's fix). Filters `order`, `status`, `courier`; `ordering` by any serializer field's source -- `order` is by the order's `placed_at`, newest first, `events` joins the history and lists a parcel once per update. Each parcel with its history, oldest first, and `tracking_url`: the courier's page with the number in it, filled as Python's `str.format` fills it (below) |
| `POST /api/v1/shipments/` | `orders.fulfil`; 201. `ShipmentSerializer`, its `order` narrowed to the orders the user may see; `status`, `dispatched_at` and `delivered_at` are not writable. `create_shipment`: the number trimmed, the cost quantized; a negative cost and a number with no courier are 400s before any lock; then the order's row lock; only a CONFIRMED, PROCESSING, PACKED or SHIPPED order ("A delivered order cannot be shipped."); a number its courier already has is a 409 naming the courier, from the check or -- inside a savepoint -- from the unique index; the parcel PENDING, and "Shipment created (courier)" on the order's timeline |
| `PUT`/`PATCH /api/v1/shipments/<id>/` | `orders.fulfil`; a plain save with none of those rules (D206, copied): every column written back as read (D207), no timeline entry. A PATCH's answer leaves out `courier_name` for a parcel with no courier, as DRF skips a defaulted read-only field then |
| `DELETE /api/v1/shipments/<id>/` | `orders.fulfil`; 204. The parcel and its history deleted, a delivered one too (D208, copied) |
| `POST /api/v1/shipments/<id>/events/` | `orders.fulfil`; 201. The parcel is found before the body is read. A status of the six (IN_TRANSIT when none is sent), a message, a place, a time (now when none is sent, stamped before the row is). `record_event`: the order's row lock, then the parcel's; a DELIVERED or RETURNED parcel takes no more; a PENDING parcel's first movement needs its order PACKED, SHIPPED or DELIVERED ("Pack RGN-... before its parcel leaves: the order is still confirmed."); the update appended, the parcel's status and its first `dispatched_at` and `delivered_at` set, "STATUS: message" on the order's timeline; a DISPATCHED moves a PACKED order to SHIPPED and a DELIVERED moves a SHIPPED or PACKED one to DELIVERED, through `OrderLifecycle.transition`, and the customer is told once the transaction commits |

A courier's tracking page is filled by `common/python.ts`'s `pyFormatNamed`: `{tracking_number}`,
a conversion (`!r`), a string format spec (`:>12`, `:.3`, `:*^11s`, one built from the number
itself), an index (`[0]`) and doubled braces. What Python raises decides the answer, in the back
office and on the customer's order page alike: a KeyError or an AttributeError -- a placeholder
the template is not given, an attribute a string does not have -- is what DRF reads as "this
read-only field is not there", so the parcel is answered without a `tracking_url`; a ValueError
or an IndexError -- `{0}`, `{}`, a brace left open -- is a 500 (D211, copied).

Then review moderation (part 9): `engagement/review-moderation.service.ts`,
`ReviewModerationViewSet`. What a shopper writes, and what a product page shows of it, were
phases 2 and 1.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/reviews/`, `GET .../<id>/` | `content.review_moderate`, for reading too; paginated, newest first. Filters `status`, `product` (a key that must exist) and `rating` -- django-filter's `NumberFilter`: anything Python's `Decimal` reads, no larger than 1e50, cut to a whole number by the column's lookup, so `rating=4.9` lists the fours (D216, copied) and a number the column cannot hold matches nothing. `ordering` by `created_at` or `rating`. A detail route applies the filters too |
| `POST /api/v1/reviews/<id>/approve/`, `.../reject/` | `content.review_moderate`; 200. The review is found before the body is read. No rule about what the review was: an approved one can be approved again, or rejected. The status, the moderator and the time are stamped; the note is `str(request.data.get("note", "")).strip()` when that says anything and otherwise the note the review had -- `null` is the note "None", a list or an object is its Python repr, a body that is not an object is a 500, and so is a note of more than 255 characters or one holding a NUL (D214, copied). Then the audit entry, `SETTINGS_CHANGED`, with the status and note before and after and the note, or "Review approved"/"Review rejected", as its reason. No lock, and the two writes are not one transaction (D215, copied) |

Last, staff accounts and the organisation (part 10), in `accounts/`: `branches.service.ts`,
`staff-users.service.ts` (`UserViewSet`, `UserWriteSerializer`, and `create_staff_user`,
`update_staff_user`, `save_staff_profile`, `set_user_status` and `check_can_lose_access` of
`accounts.services`), `roles.service.ts` and `organization-admin.service.ts`. Signing in, `me`,
registration and a user's own password were phase 2.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/branches/`, `GET .../<id>/` | `settings.view`; paginated, by name; `ordering` by any field. No filter and no search |
| `POST /api/v1/branches/`, `PUT`/`PATCH .../<id>/` | `settings.manage`. A name and a code; an address, a phone (a mobile stored canonically, anything else as typed), an email (kept as typed), the default flag, whether it fulfils online orders, its tills, its status. A new branch joins `get_organization()`. The code is unique within the organisation, which the serializer has no field for: a code taken -- or no organisation to join -- is the index's bare 409 (D224, copied). A second default branch is accepted, and the default one can be switched off |
| `DELETE /api/v1/branches/<id>/` | 204, or a bare 409 while staff, stock, a transfer, a count, labels, a purchase order, an account, an expense, a cart, an order or a lead names it (`PROTECT`). A branch nothing names goes with its parked sales and its notices, and the audit log lets go of it, in Django's order |
| `GET /api/v1/users/`, `GET .../<id>/` | `users.view`; paginated, by email; every account whose role is not CUSTOMER, one with no role included. Filters `status`, `branch`, `role`; `ordering` by `email` or `date_joined`. `search_fields` is declared and no search backend is installed: `?search=` does nothing (D217, copied). `role_code` and `role_name` are left out of an account with no role, as DRF skips a read-only field whose source is missing; `profile` is there only for a reader who holds `users.manage` -- absent, not null -- and is the same eleven blank fields for an account nobody has filled one in for |
| `POST /api/v1/users/` | `users.manage`; 201. An email no account has, compared as typed and stored lower-cased (another's in other letters is a bare 409: D218, copied); names; a phone; a branch, closed or not; a password of ten characters that Django's validators pass -- with no account to compare it with, so the email itself will do (D219); a role of the seven the code names, CASHIER unless sent; a nested profile. A password is asked for last, once everything else has passed. `create_staff_user`: always ACTIVE, whatever status was sent (D219), in the one organisation; the profile saved when it says anything; one audit entry, `USER_CHANGED`, naming the email as typed, the role, the branch and which profile fields were recorded |
| `PUT`/`PATCH /api/v1/users/<id>/` | `users.manage`. `update_staff_user`, in one transaction: a status other than ACTIVE is refused for your own account and for the last active owner; so is a new role for an owner who is you or the last one; then the account saved whole -- every column written back as read (D222, copied) -- a new password ending every session the account holds; the profile; and one audit entry of what changed, with `password_reset`, `sessions_ended` and `profile_updated` naming fields and never values. Nothing changed, nothing logged -- but the row is still written |
| The profile, in both | Eleven optional fields. A birth date not in the future (by the shop's clock), an ID number of letters, digits, spaces and hyphens, a joining date not before a birth date sent with it. The ID number's uniqueness is a `UniqueValidator` on a nested serializer that never has an instance: an ID number resent with an edit is refused as taken -- by its own profile (D220, copied). `save_staff_profile` takes the profile's row lock, writes only when a field sent differs from what is stored -- a payload of blanks makes no row -- and answers another's ID number with a 400 naming `profile.national_id` |
| `DELETE /api/v1/users/<id>/`, `POST .../<id>/deactivate/` | `users.manage`; both 200 with the account: staff are never deleted. Found, then the two guards, then `request.data.get("reason", "")`: a body that is not an object is a 500, a reason that is not a string is stored as Python prints it (D223, copied). INACTIVE, and one audit entry. The answer has no profile, for anyone: the view serializes without its request |
| `POST /api/v1/users/<id>/activate/` | `users.manage`; 200. No guard, the body unread, the reason always "Status changed to ACTIVE" |
| `GET /api/v1/roles/`, `GET .../<id>/`, `GET /api/v1/permissions/` | `users.view`; unpaginated. Each role with the codes it holds, by group then code, and `holds_every_permission` for the owner's. `ordering` by any field; `permissions` joins them and lists a role once per permission |
| `GET /api/v1/organization/` | anyone signed in, a customer too. The oldest active organisation with its branches by name, or 404 `{"detail": "No organisation configured."}`, written by hand |
| `PATCH /api/v1/organization/` | `settings.manage`, checked in the view: a refusal is an envelope with no `request_id`. Its name, legal name, status, email, phone, address, VAT number, currency, footer, and whether the counter sells reserved stock -- which only an owner or a superuser may change. The save writes every column back as read (D225, copied), asks the storefront to drop what it cached as `site`, and is audited with the whole organisation before and after. The answer, a partial serializer's, leaves out `tax_settled_by_name` while nobody has settled the VAT. With no active organisation -- one switched off through this route -- the save creates one, with a blank slug (D225, copied) |
| `GET /api/v1/organization/tax/` | `settings.view`, checked in the view. The mode, the rate, who settled it and when -- a hand-built answer whose time is DRF's encoding of a raw datetime: UTC, with `Z` -- and how many orders exist |
| `PATCH /api/v1/organization/tax/` | `settings.manage`. A mode, a rate between 0 and 1 to four places, `confirm`, a reason. `update_tax_settings`: a change while orders exist is a 409 `TAX_CHANGE_NEEDS_CONFIRMATION` unless confirmed; settling, changed or not, stamps who and when and is audited; a change asks the storefront to drop its priced pages (`products`, `home`, `categories`), and the save itself `site` |

## Phase 7: reports, the log, notices, jobs and the cutover

Phase 7 ports what is left and then moves the traffic. Its parts, in order:

1. the audit log (`audit-logs`), which part 10 of phase 6 left out -- and, found on the way,
   content negotiation on every view (below);
2. notifications (`notifications/`: the list, a notice, the unread count, marking read);
3. reports (`reports/`: the eleven views over `reports.services`, with their CSV exports);
4. the background jobs: what Celery's worker and beat run today, on BullMQ
   ([ADR-0014](decisions/0014-nest-enqueues-celery-jobs.md) names `CeleryService.delay` as the
   one place to swap);
5. the cutover, path by path at the proxy.

### Content negotiation

DRF settles the format of a response in `APIView.initial`, before it authenticates, checks a
permission, throttles or looks for the method's handler. Six phases of cases never sent a
`format` or an `Accept` a JSON renderer would refuse, so the port had none of it; the audit
log's cases asked for `?format=csv` and found a 404 where the port answered 200. It is
`http/negotiation.ts` now, called by the authentication guard and by the answer for a path
that has no handler for the method, on every DRF view -- the feeds, sign-out and the payment
webhook among them, the two health checks (plain Django views) not:

- `?format=` naming a format no renderer of the view has is a 404, the envelope's, whoever asks
  and whatever the method: an anonymous `PUT /brands/?format=xml` is a 404, not a 401. A blank
  one is no format; of two, the last counts; `JSON` is not `json`.
- An `Accept` no renderer satisfies is a 406. `core.handlers` has no code for DRF's
  `NotAcceptable`, so it is answered as `SERVER_ERROR`, "Unexpected error." (D227, copied).
  The header is read as `rest_framework.utils.mediatypes` reads it -- Django's
  `parse_header_parameters`, a `*` on either side matching anything, the most specific type the
  client named tried first, `q` ignored (`application/json;q=0` is accepted) -- and compared with
  DRF's own answers on 1,504 combinations of renderers, formats and headers. A request with no
  `Accept` takes anything; one with an empty `Accept` takes nothing.
- A format is looked at before the header: `?format=xml` with nothing acceptable is the 404.
- A refusal here spends nothing from a rate limit (a scenario in `parity/throttle.ts`).

The product feeds are DRF views with JSON's renderer alone, so a client that asks for one by its
own type -- `Accept: application/xml` for `feed.xml`, `text/csv` for `feed.csv`, or
`feed.csv?format=csv` -- is refused, where `*/*` or no header is served (D227, copied).

Outside production Django also has the browsable API's renderer (`text/html`, `?format=api`).
The port lists it for the same settings and answers what negotiates it in JSON: see "Deliberate
differences".

### A method the view does not serve

`APIView.initial` also authenticates, checks the view's permissions and counts the request
against its throttles before DRF looks for the method's handler. The port answered such a
request from its exception filter, which knew a staff view's requirement and nothing else.
Measured against Django, three things differed, on views ported in phases 2 to 6:

- a view that asks for a signed-in user and is not a staff view (`auth/me/`,
  `auth/password/change/`, the customer's orders and addresses, `organization/` and its VAT)
  answered an anonymous `DELETE` with a 405, where Django's is a 401 -- and the customer's views
  answered staff with a 405 for Django's 403;
- a view with no authentication classes (sign-out, the payment webhook, the feeds) refused a bad
  token on a method it does not serve, where Django never reads the token: a 401 for a 405;
- no 405 spent anything from a rate limit: 62 anonymous `PUT /shop/categories/` were 62 405s,
  where Django's are 60 and then two 429s.

`auth/view-registry.ts` now collects, once, from every controller, what the view at each route
pattern asks of any request -- whether it authenticates, who may call it, how it is throttled:
the same metadata the guards read from the handler Fastify chose. The exception filter runs
the checks in DRF's order -- format, authentication, permission, throttles -- and then answers
405. The throttles are `Throttles` (`auth/throttle.ts`), which the guard and the filter share.

And one smaller thing: an empty `Content-Type` header on a request with no body is nothing to
parse, for Django; Fastify refused the header (415). It is dropped before Fastify reads it.

### The audit log (part 1)

`accounts/audit-log.service.ts`. Read-only: the log is written by `core.audit.record`
(`common/audit.ts`, ported in phase 2) and never changed.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/audit-logs/` | `audit.view`, a flat requirement: every method needs it, so a `POST` is a 403 for a manager and a 405 for an accountant. Paginated, newest first with the key breaking ties. A reader bound to a branch sees that branch's entries and those that name no branch -- the catalogue, settings, staff accounts, sign-ins (D85's rule); an owner, an administrator, a superuser or staff with no branch sees them all. `date_from` and `date_to` are `core.dates`' window on the moment written, read before anything else: one that is not a date is a 400 whatever the filters say. `search` is trimmed and looked for, in any case, in what was touched, why and by whom (`entity_label`, `reason`, `actor_label`), `%`, `_` and a backslash as themselves; a NUL in it reaches PostgreSQL and is a 500 (D228, copied). django-filter on `action` (one of the choices), `entity_type` and `entity_id` (trimmed, exact), `actor` and `branch` (keys that must exist). `ordering=created_at` replaces the order whole, so two entries of one instant come back as the plan leaves them: the statement is therefore Django's, every column of the log, the account and the branch -- with the account's columns PostgreSQL hashes the log against the accounts, without them it drops the join, and the tie falls the other way. A filter on the actor makes that join an inner one, written last, as Django writes it |
| `GET /api/v1/audit-logs/<id>/` | the same queryset, so the window, the search and the filters apply -- and refuse -- here too; an ordering does nothing. Each entry: who (`actor`, and `actor_email`, the label kept when the account is gone), `action` and its label (an action the choices do not name is shown as it is), the branch and its code, the record's type, key and label, `old_values` and `new_values` as stored -- read from jsonb's own text, so `1.0` stays a float and an integer past 2^53 stays exact -- the reason, the address as `inet` prints it, the request id, and the moment in the shop's time |

`fixture_audit.py` dates six entries in March 2025, where a window finds them and nothing the
run writes: at two branches and at none, by an owner, a manager, an account since deleted and
nobody, two of them at one instant, with values that are a float, a 23-digit integer, Bengali,
a list and a bare string, and addresses in IPv4, IPv6 and IPv4 written as IPv6. It adds an
accountant with no branch, `parity.auditor@rangon.test`: `audit.view` with nothing to be scoped
to.

### Notifications (part 2)

`notifications/`: `NotificationViewSet` on a `DefaultRouter` of its own, and
`notifications.services.mark_read`. `IsAuthenticated` alone -- staff and customers read their
own. The rows are written by `notify_staff` and `notify_customer` (`checkout/notices.service.ts`,
phase 3) and sent by the worker.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/notifications/` | the reader's own notices, newest first, paginated. `unread=true`, spelt exactly so, leaves the read ones out. The view names no `ordering_fields`, so `OrderingFilter` takes the serializer's fields that are columns -- `id`, `notification_type`, `level`, `title`, `body`, `link`, `data` (jsonb's own order), `read_at`, `created_at` -- and ignores `is_read`, a property of the model. An ordering replaces the view's, so ties fall to the plan: the statement is Django's, every column. A notice addressed to nobody (`user` null) is in nobody's list |
| `GET /api/v1/notifications/<id>/` | the same queryset, `unread=true` included: a read notice asked for among the unread is a 404, as someone else's is. `data` is read from jsonb's own text |
| `GET /api/v1/notifications/count/` | `{"unread": n}`; no filter applies |
| `POST /api/v1/notifications/mark-read/` | 200 `{"updated": n}`. `request.data.get("ids")` handed to `pk__in` as it is: anything falsy -- absent, `null`, `[]`, `""`, `0`, `{}` -- marks every unread notice of the reader's; a list is read item by item as `UUIDField` reads a key (a string in any of `uuid.UUID`'s spellings, a whole number as `UUID(int=...)`, a null as nothing), the first that is no key a 400 naming it; a string is its characters and an object its keys; a number or `true` cannot be iterated, a 500, as a body that is not an object is (D229, copied). One `UPDATE ... WHERE read_at IS NULL`, every row stamped with one moment and `updated_at` left alone: a notice already read, someone else's, or one that is not there counts for nothing. A list of nothing but nulls sends no statement |

`fixture_notifications.py` writes for two readers nothing else in the run ever notifies -- the
accountant with no branch from `fixture_audit.py` (staff notices reach a branch's staff, owners
and administrators) and a customer account with no customer record -- seven notices and three,
read and unread, two at one instant, with data that is an object, a list and a bare string,
and one notice addressed to nobody.

## Running it

```bash
scripts/nest-parity.sh reset
```

Starts both APIs on one fresh database (project `rangon-nest`, ports 8610 Django and 8620 Nest,
loopback only), seeds the demo data and applies the parity fixtures. Then:

```bash
scripts/nest-parity.sh run
```

Every case to both APIs; exits non-zero on any difference not listed below. `PARITY_ONLY=feed`
runs the cases whose name contains `feed`; `PARITY_VERBOSE=1` prints each case's status and side
effects, to check a case exercises what its name says. The rate limits, which the parity stack turns off, are
compared on their own (eight scenarios, checkout's shared bucket among them):

```bash
docker compose -p rangon-nest -f docker-compose.nest.yml --profile throttle run --rm throttle-check
```

The parity stack runs Django with `CELERY_TASK_ALWAYS_EAGER=0` and no worker, so the jobs each API
queues stay on the broker for the harness to compare. The seed runs eagerly. Both APIs there carry
the stand-in payment gateway described above; the throttled pair does not.

**Always pass `-p rangon-nest`** when calling compose directly: `.env` sets
`COMPOSE_PROJECT_NAME=rangon`, and without `-p` these containers join the development project.

Inside `apps/api-nest/` (Node is not needed on the host; run these in `node:22-bookworm-slim`):

```bash
npm run typecheck      # the API and the harness
npm run lint
npm test               # unit tests: Python/DRF compatibility, JWT, pagination, throttling
npm run db:pull        # re-introspect after a Django migration (DATABASE_URL to a migrated DB)
```

## How a module is ported

1. **Capture Django's SQL** for every endpoint in the module, in the parity stack, with
   `CaptureQueriesContext`. Where the response order depends on the plan -- a GROUP BY (Django drops
   `Meta.ordering` there), a sort on a column with ties, an unordered prefetch -- send the same
   statement, aliases and join order included. `catalog/product-search.ts` shows how the ORM's
   alias rules are reproduced.
2. **Read the serializer, not the model.** Key names, `None` versus `""`, which datetime format
   (`common/datetime.ts`: DRF's `Z` for a raw datetime, the local zone through a serializer field,
   `+00:00` where the view calls `isoformat()`), which Decimal becomes a JSON number (a bare Decimal
   in a dict) and which a string (a serializer field).
3. **Use the Python helpers** in `common/python.ts` wherever Python parses or formats something a
   client sees. Read a body with `requestData()` (`http/request-body.ts`), which parses it when the
   view first asks, as DRF does, and validate it with `common/drf.ts`, which gives DRF's messages
   in DRF's order.
4. **Add parity cases and fixtures** for every branch: missing, inactive, unpublished, empty, a tie,
   a malformed parameter. A module is done when its cases pass and a spot check shows they exercise
   what they claim to. For an endpoint that writes, give the case a `reset` (both APIs start from
   the same rows) and `effects` (queries whose rows, read after each request, must match); see
   `parity/accounts-cases.ts`. Tell the rows a request wrote by id, against a snapshot taken
   before the first case, never by time: the demo seed dates some of today's sales later today,
   so "created after the case began" also catches seeded rows (`resetCheckout`).
5. **Writes** additionally need the service's transaction boundary, its `SELECT ... FOR UPDATE`, its
   idempotency handling and concurrency tests against the shared database, before any parity run.
   Drive the race across *both* APIs (`parity/concurrency.ts`): while paths are cut over one at a
   time, a Django request and a Nest request will contend for the same rows. Then remove the lock
   and check the test fails. If it still passes, something else is serialising the requests (for
   checkout, the order-number sequence's lock), so write a check that makes the conflict happen
   on purpose: the harness takes the row lock itself, starts the request, writes the competing
   change while the request waits, and then checks the result.

## Deliberate differences

Each is also listed in `apps/api-nest/parity/known-differences.ts` where the harness sees it.

| Where | Django | Nest | Why |
|---|---|---|---|
| 401 message | the Python `repr` of SimpleJWT's error dict | the words inside it | Status and code match; a repr is not a message |
| Rate-limit budgets | its own buckets | its own buckets | Route each path to one API and a client sees one budget |
| Cached feeds | its own cache keys | its own cache keys | Both expire on the same schedule |
| Session cookies | `SessionAuthentication` accepts a Django admin session | not read | The web app authenticates with bearer tokens only; a Django admin session reaching `auth/me/` is not a client |
| Malformed JSON body | 400 `JSON parse error - ` and Python's `json` wording | the same, with V8's wording | Status, code and prefix match |
| Form and multipart bodies | parsed by every view | parsed by the views that take uploads (product images, navigation items, banners); 415 elsewhere | The web app posts JSON everywhere else |
| Image formats Pillow knows beyond JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF and ICO (PSD, TGA, QOI ...) | identified, then refused as "Upload a JPEG, PNG, WebP or AVIF image." | refused as "Upload a valid image." | Both 400 on the same field; reading forty formats to refuse them by another name is not worth it. A file Pillow opens but these readers judge corrupt (or the reverse) is the same kind of difference |
| Multipart limits (`DATA_UPLOAD_MAX_NUMBER_FIELDS`, `_FILES`, base64 transfer encoding) | enforced, decoded | not enforced, not decoded | Browsers send neither; the proxy caps the body at 12 MB |
| A body over 64 MB | read | 413 | Django sets no limit; the proxy caps bodies at 12 MB |
| Two concurrent refreshes of one token | both succeed, each minting a pair | the second is refused (401) | `get_or_create` lets both pass; the port blacklists with `ON CONFLICT DO NOTHING` and refuses the loser. A fix for Django too |
| `bcrypt_sha256$` password hashes | verified | read as a wrong password, and logged | No version of this project wrote one: Argon2 was first in PASSWORD_HASHERS from the first migration |
| `OPTIONS` without CORS headers | DRF's view metadata | 405 | Nothing calls it |
| `USE_S3=1` | S3 URLs | refuses to start | django-storages' URL building is not ported; a wrong image URL is worse than a refusal |
| Celery broker down when a checkout commits | 500, though the order is placed (D116) | 201, the failure logged | Raising after the commit tells a shopper an order failed when it did not; the harness cannot see this, as its broker is up |
| Format-suffix URLs (`/api/v1/brands.json`, `/brands/<id>.json`, `/brands.api`) | served by `DefaultRouter`, `.api` as the browsable HTML API | not routed: 404, or a slash redirect and then 404 | No client appends a suffix; the web app calls the plain paths |
| The browsable API: `?format=api`, or an `Accept` of `text/html` (or `text/*`), under any settings but production's | DRF's HTML page | the JSON answer | The port has no HTML pages. Under production's settings Django has no such renderer either and both refuse: 404 and 406 |
| `Accept: application/json; indent=4` | the JSON indented, as `JSONRenderer` honours the parameter | compact | The same document; the harness compares parsed bodies and sees no difference |
| A path Django resolves to no view (a converter refuses a segment: `/shop/products/not a slug/`) with a `format` no renderer has, or an `Accept` none satisfies | the resolver's HTML 404, before any view negotiates | the JSON 404 (or 406): the port checks a segment in its handler, after the negotiation | A request wrong twice over; a 404 either way for a format |
| A courier's tracking page that reads an attribute of the number (`{tracking_number.upper}`) | the Python object found is printed, a method with its memory address, different at every request | every attribute is one a string does not have: the parcel is answered without `tracking_url`, as Django answers `{tracking_number.real}` | An address in memory cannot be matched, and no tracking page is written that way |

**Before cutting over an upload path:** both processes write `MEDIA_ROOT`, and the production
images run as different users (`appuser`, uid 1001, and `node`, uid 1000). The shared volume needs
a common group with group-writable directories, or one uid for both. The parity stack runs Django
with `FILE_UPLOAD_DIRECTORY_PERMISSIONS = 0o777` for the same reason.

One Django quirk is *not* copied because the harness cannot see it: gunicorn writes a body on
`HEAD` responses. The Nest API sends none, as HTTP requires. Nor is a second, which the harness
does not compare: `CsrfViewMiddleware` replaces a malformed `csrftoken` cookie on every response
(a fresh `Set-Cookie`), on any path. The Nest API reads that cookie only where Django checks it,
on an unsafe request to a plain view, and sets none; the web app authenticates with bearer tokens.

Django defects that *are* copied, so the two agree until Django is fixed (fix Django first, then
the port):

- A JSON body that is not an object is a 500 on login, refresh, logout, the address edit and the
  review (`request.data.get` on a list).
- First and last names of 80 characters each overflow the customer's 160-character name at
  registration, also a 500.
- Registering with a guest customer's email and no mobile is a 409 rather than a link to that
  customer.
- The cart's quantity is `int(request.data.get("quantity"))`: `"5.0"`, `null` or a list is a
  500, and `2.9` is quietly 2. A coupon code that is not a string, and a cart token longer than
  the column's 64 characters, are 500s too.
- A first-time guest's double-click at checkout can get 409 (D114). The guest customer is created
  before the order's savepoint, so two simultaneous requests with the same new mobile both insert
  one, and the loser's unique violation aborts its whole transaction. One order is placed; the
  other click is refused rather than answered with it.
- A manager or administrator cannot reorder attribute values: the viewset declares no requirement
  for `move`, so `RolePermission` refuses everyone but an owner or superuser (D117).
- A move of an attribute value swaps from the value's position as read before the lock, so two
  moves at once can leave two values on one position (D118).
- A size chart PATCH whose nested row names no size is a 500: `partial` reaches the nested rows,
  and the view then reads a key the row never had (D119).
- `request.data.get` on a JSON body that is not an object is a 500 on `move` (attribute values and
  social links) and `verify-integrity` too.
- Renaming a product without sending its slug gives it a new one, `-2` and so on: the product
  serializer makes a slug on every save that names the product (D120).
- An inventory row's reorder point and bin are saved with no serializer: a reorder point sent as
  a string is saved and then fails the response, a 500 for a change that committed; `null` is a
  409 from the database; a body that is not an object is a 500 (D121).
- Adjust and write-off take any UUID as the variant, so one that does not exist fails where it
  is first read -- 404 -- or, for an adjustment to 0, at the commit -- 409 (D122).
- The low-stock list is a bare `[]` when empty and the paginated envelope otherwise (D123).
- An `Idempotency-Key` longer than the column's 80 characters is a 500 (D124).
- A NUL in the inventory list's `search` or `category`, or in the ledger's `search`, is a 500:
  those views filter on the raw parameter, where `SearchFilter` would refuse it (D125).
  The POS scan and grid do the same with `code` and `q` (D144).
- A stock count may be edited onto any branch, whatever its status or the user's branch, and an
  edit writes every column back from the row as read (D126).
- An owner or superuser may delete a stock count, an applied one too; the ledger's adjustments
  then name a document that is gone (D127).
- A transfer that names one variant twice is a bare 409 from the database (D128).
- The import's preview names a category or brand it would create once per product that uses
  it (D129).
- An import row whose price cleans to nothing (`Tk`, `৳`, `,`) is dropped without an error
  (D130).
- An import file with a `NaN`, a carriage return inside an unquoted cell, a NUL or a cell longer
  than its column answers 500, and an infinite price passes the preview and fails the import with
  an error that names no row (D131).
- A move of a content row (a social link, a navigation item, a carousel product) that waited on
  the run's lock renumbers the run in the order PostgreSQL sorted it before the wait, so a move or
  reorder committed meanwhile is undone (D132).
- `?ordering=get_platform_display` on the social links is a 500 on the list, the detail, the edit
  and the move: `OrderingFilter` offers the `label` field's source, a model method (D133).
- A page whose title spells nothing in ASCII -- one in Bengali -- cannot be created without an
  address: `create_page` makes it with Django's `slugify`, which drops every other script, where
  the catalogue transliterates (D134).
- A carousel add that waited on the run's lock counts the run it read before the wait, so two
  adds at once can take it past 24 products (D135).
- The footer's four columns are counted with no lock: two new columns at once can make five
  (D136).
- A naive publish window in the first hours of 1 January of the year 1 is a 500: DRF's
  `valid_datetime` converts it to UTC, which overflows, and nothing catches it (D137).
- Held sales take no lock: two registers resuming one hold at once are both handed the cart, and
  an edit that read a hold before a resume deleted it puts it back (D142).
- The register's `pos` rate of 1200 a minute is never reached: the `user` rate of 600 counts the
  same requests and refuses first (D143).
- A held sale's payload with a `\u0000` or half a surrogate pair is a 500 from PostgreSQL, and so is
  a NUL in the scan's `code` or the grid's `q` (D144).
- A quote for a quantity so large that an amount passes 26 whole digits is a 500: `quantize`
  raises `decimal.InvalidOperation`, which nothing catches (D145).
- The counter scans, prices and sells a SKU that is archived or whose product is a draft, with no
  word of it: `price_sale` never asks whether a variant is sellable (D146).
- An empty `Idempotency-Key` on a counter sale is stored, and every later sale with an empty one
  answers 201 with the first (D147).
- `?ordering=lines` (or `note`, `coupon_code`, `approval_token`, `manual_discount_percent`,
  `expected_total`) on a sale or its receipt is a 500 (D148).
- One SKU on two lines of a counter sale is checked twice against the same shelf figure and
  deducted twice: `on_hand` can go below zero, and reserved units can be sold without the owner's
  switch (D149).
- A customer's order count and spend are written from the figures read when the sale was priced,
  over whatever was committed meanwhile (D150).
- A counter sale records an overpayment as paid, and a sale discounted to nothing as `UNPAID`, or
  `PARTIALLY_PAID` if anything was paid (D151).
- A sale and its receipt are read, and a sale voided, by id whatever the branch (D152).
- A void sends the whole refund back through the largest payment: a sale paid in cash and by card
  is refunded in cash from the drawer, and the card payment stays captured (D153).
- Two voids of one sale that both read it before either locks it both go through, and the goods
  go back on the shelf twice (D154).
- A void restocks every line at its sold quantity, units already returned included, and leaves the
  customer's totals as they were; a reason that is not a string is a 500 (D155).
- A return is opened, and at the counter refunded, on any order by id, whatever its branch
  (D156).
- A second return may be opened for a unit already on an open return; it can be approved and never
  received. One line asked for twice in a request is the unique index's 409 (D157).
- The counter's `refund_method` is taken as sent: one the ledger does not know is recorded against
  no account and moves no balance (D158).
- `?ordering=items` on the returns list shows a return once per line, inside a count of returns
  (D159).
- A return completed with an `Idempotency-Key` another refund holds is COMPLETED with nothing
  paid (D160).
- A return's lines are read in no stated order; the port sends the same statements, and the
  harness compares a return's lines by the order line each is for, and the ledger entries of one
  request by SKU (D161).
- Approve and reject store whatever `comment` holds: Python's `str()` of a number or a list, a 409
  for `null`, a 500 for a body that is not an object (D162).
- Rejecting a return sends its order to DELIVERED and stamps `delivered_at` now, whatever other
  returns the order has and whatever status it came from (D163).
- A return is taken on a PACKED order: the goods go back on the shelf and the order can still be
  shipped (D164).
- A return past the window that the override lets through writes no audit entry of its own
  (D165).
- The status route cancels an order for anyone who may change a status, with no `sales.cancel`
  and no refund: a paid order is left CANCELLED and PAID (D166).
- Recording a payment takes no `Idempotency-Key`, compares nothing with what is owed and refuses
  no order; an account the money cannot land in is refused after it has been saved on the pending
  payment (D167).
- A cancel's reason is taken as sent: anything but a string or a list is a 500 (D168).
- An order paid and refunded in full cannot be cancelled (D169).
- A cancel answers with the payment status and totals from before its own refund (D170).
- A refund asked for with an `Idempotency-Key` another refund holds answers with that refund,
  whichever order it belongs to (D171).
- A NUL in the order list's `search` is a 500, on every route of the viewset (D172).
- A deposit or correction that takes a balance past the column's fourteen digits is a 500
  (D173).
- The integrity check reads its body with `request.data.get`: a list or `null` is a 500 (D174).
- An account's `is_active` is accepted when it is opened and not used: it opens active (D175).
- Changing a default account's kind to one that already has a default is the index's 409 (D176).
- `date_to` on the cash book is read as a moment, so a bare day ends at its own midnight and that
  day's movements are left out; the cash position's window includes the day (D177).
- A receipt is stored before the expense is known to be good, and is judged by its stated type
  and its name alone: a refused expense leaves its file behind, and a file's content is never
  looked at (D178).
- An expense cannot be voided once its account is closed: the compensating movement is refused
  (D179).
- An offer with a cost below zero, or a minimum order quantity of 0, passes the serializer and is
  the database's check constraint: a bare 409 naming no field (D180).
- A supplier's code is unique by its exact spelling, and one typed by hand is stored as typed:
  `sup-001` sits beside `SUP-001`, and `pnm 01` is a code. Two suppliers of one name created at
  once race for one derived code, and the loser is a bare 409 (D181).
- An offer can be recorded for an archived SKU, and an INACTIVE supplier's offer can be made the
  preferred one: `set_preferred_supplier` asks whether the offer is active, not the supplier
  (D182).
- Suppliers and offers are created, edited and deleted with no audit entry; only `set-preferred`
  writes one. Deleting the preferred offer, or its supplier, leaves the SKU preferring nobody
  (D183).
- An offer's edit writes back every column as it read them, `is_preferred` among them: an edit
  that read the offer before it was promoted demotes it again, and the SKU prefers nobody (D184).
- A return to a supplier is credited, and leaves the shelf, at the order line's cost, not at the
  cost on the delivery it came in on: goods received at 190.00 against an order at 200.00 go
  back for 200.00 each (D185).
- A draft purchase order can be received without ever being sent: it goes straight to RECEIVED
  and `ordered_at` stays empty (D186).
- A SKU's first delivery from one supplier, racing another supplier's becoming its preferred one,
  is refused with a bare 409: `record_supplier_product` reads "nobody is preferred" and then
  meets the unique index (D187).
- A delivery takes no `Idempotency-Key`: a retried part delivery is received twice, up to what is
  outstanding (D188).
- A purchase order's cancel takes its reason as sent: `null` is a bare 409, a body that is not an
  object a 500, and a number or a list is stored as Python prints it (D189).
- A purchase order line's quantity past PostgreSQL's integer is a 500, as is one large enough for
  the line to pass Decimal's 28 digits (D190).
- A purchase order names any UUID as a SKU: one that does not exist fails at the commit, a bare
  409 naming no line; an archived SKU and an inactive supplier are accepted without a word
  (D191).
- A return made with an `Idempotency-Key` another return holds answers 201 with that return,
  whichever order it is on and whatever this order's status; a key past 80 characters is a 500
  (D192).
- A return to a supplier checks `on_hand`, not what is available: units reserved for customers'
  orders can be boxed up and sent back, leaving `available` below zero (D193).
- A supplier payment with no `amount` is a 500: the serializer does not require the field and
  the view reads it (D194).
- A supplier payment may be dated in the future, and its cash-book entry with it; an expense may
  not (D195).
- A supplier payment made with an `Idempotency-Key` another payment holds answers 201 with that
  payment, whatever supplier, order or amount was sent; a key past 80 characters is a 500 (D196).
- A supplier payment's `branch` is read from the body unvalidated: a value that is not a UUID is
  a 400 under `non_field_errors`, a number is looked up as one, and a branch that is not
  available refuses a payment against an order whose own branch is the one that pays (D197).
- A customer's email is checked for uniqueness as typed and stored lower-cased: another
  customer's email in another case passes the serializer and is a bare 409 (D198).
- A lead already recovered can be written off as LOST, and one written off can be written off
  again; `lost` reads its note with `request.data.get`, so `null` is stored as "None" and a body
  that is not an object is a 500 (D199).
- A note on a lead saves every column back as it was read: a lead recovered meanwhile is opened
  again and its order forgotten (D200).
- A NUL in the customer list's `search` is a 500, on every route of the viewset (D201).
- A coupon's code is checked for uniqueness as typed and stored upper-cased: another coupon's
  code in lower case passes the serializer and is a bare 409 (D202).
- A coupon's edit writes back every column as read, `used_count` among them: a redemption
  committed while the edit is in flight is forgotten, and a coupon good once can be used again
  (D203).
- A coupon's minimum order value and its cap may be below zero. A negative cap replaces any
  larger discount -- every discount -- so the coupon adds to the bill (D204).
- A new shipping method judges its delivery days only when both are sent: one alone that
  crosses the other's default meets the check constraint, a bare 409 (D205).
- A parcel's edit is a plain save with none of the booking's rules: a number with no courier, a
  cost below zero, the parcel moved to another order -- a cancelled one too -- are all accepted,
  a number its courier has already used is the index's bare 409, and nothing is written to the
  order's timeline (D206). It writes every column back as read, so a parcel delivered while the
  edit is in flight is set back to the status the edit read (D207).
- A parcel can be deleted, delivered or not, and its append-only history goes with it; no audit
  entry is written (D208).
- A tracking update's status becomes the parcel's whatever the parcel's was: PENDING after
  DISPATCHED, an update dated before the last one. Nothing refuses a repeat, so six clicks are
  six rows of history (D209).
- Only DISPATCHED ships an order. A packed order's parcel whose first update is IN_TRANSIT --
  what an update with no status means -- FAILED or RETURNED is on its way while the order stays
  PACKED; a DELIVERED then takes the order from PACKED to DELIVERED, never shipped. A parcel
  RETURNED leaves its order SHIPPED (D210).
- A courier's tracking page is not checked when it is written. One naming any placeholder but
  `{tracking_number}` silently drops `tracking_url` from every parcel of that courier; `{0}`,
  `{}` or an unbalanced brace makes every read of such a parcel a 500, the shipment list and
  the customer's order page among them (D211).
- A second fallback zone is accepted, and a parcel can be booked with a courier or a method
  that is switched off (D212).
- Zones, methods and couriers are made, repriced and deleted with no audit entry, and deleting
  a zone or a method takes it off every past order and parcel that used it (D213).
- A moderator's note is read with `request.data.get`: `null` is stored as "None", a list or an
  object as its Python repr, a body that is not an object is a 500, and a note longer than the
  column, or holding a NUL, is a 500 from the database. Nothing asks what the review was: one
  already approved can be approved again (D214).
- A decision with no note writes back the note it read, with no lock: a reason given meanwhile
  is lost. The row and its audit entry are two transactions (D215).
- `?rating=4.9` lists the four-star reviews: the number filter's Decimal is cut to a whole
  number by the integer column's lookup (D216).
- `?search=` on the staff list does nothing: the view declares `search_fields`, and no search
  backend is installed (D217).
- A staff account's email is checked for uniqueness as typed and stored lower-cased: another
  account's email in other letters is a bare 409 (D218).
- A new staff account is always ACTIVE, whatever status was sent; its password is not compared
  with its email; and the role CUSTOMER makes an account the staff list then hides (D219).
- An ID number resent with an edit of the profile it belongs to is refused as already taken
  (D220).
- The two guards -- not yourself, not the last owner -- read with no lock: of two owners, each
  can be switched off while the other's deactivation is in flight. An administrator holds
  `users.manage` and may make anyone an owner, themselves included, reset an owner's password,
  and demote themselves: only an owner's own demotion is refused (D221).
- A staff account's edit writes back every column as read: a password changed meanwhile is put
  back as it was (D222).
- Deactivating reads its reason with `request.data.get`: a body that is not an object is a 500,
  a reason that is not a string is stored as Python prints it; and an account already off is
  switched off again, with another audit entry (D223).
- A branch's code taken is a bare 409; a second default branch is accepted and the default one
  can be switched off; no branch change is audited (D224).
- The organisation can be switched off through its own edit, after which it cannot be read and
  the next edit creates a second one with a blank slug. The edit writes back every column as
  read: a VAT settlement committed meanwhile is undone (D225).
- The VAT routes answer `tax_settled_at` in UTC with a `Z` where every serializer answers the
  shop's time, and both organisation views refuse with an envelope that has no `request_id`
  (D226).
- A response no renderer of the view can give the client -- an `Accept` of `image/png`, or of
  `application/xml` for the XML feed -- is a 406 that `core.handlers` has no code for:
  `SERVER_ERROR`, "Unexpected error.". The product feeds negotiate as JSON views, so asking for
  one by its own media type, or as `feed.csv?format=csv`, is refused (D227).
- A NUL in the audit log's `search` reaches PostgreSQL: a 500, on the list and on an entry
  (D228).
- Marking notices read hands the body's `ids` to the lookup as it came: a body that is not an
  object, or `ids` that is a number or `true`, is a 500; a string is read letter by letter and
  refused for its first; a whole number in the list is a key (D229).
- A notice written for a customer with no account names nobody and no permission: no list
  holds it (D230).
- A product's `published` may be set on a draft when the payload does not also name the status:
  the serializer refuses only the pair.
- The review endpoint does not enforce its own permissions. `shop_urls.py` builds it with
  `as_view({"post": "reviews"})`, which drops the action's `[IsAuthenticated, IsCustomer]` (only a
  router applies them), so anonymous and staff callers reach the view and are refused by its
  customer check: 400, where 401 and 403 were meant.

One defect found by porting was a security hole, and was fixed in Django first rather than copied:
D113, a blank guest token opened any counter order to anyone with its sequential number.

One found while writing the checkout races is outside the port: a counter sale checks `on_hand`,
not `available`, so the POS can sell units reserved for online orders (D115). Measured: an online
order reserves all 13 of a variant and the counter then sells all 13, leaving `available` at -13 --
which business rule 1.4 says may never happen with overselling off. Fixed in Django on 2026-10-02 by
the owner's decision: the counter checks `available` unless the owner's `counter_sells_reserved`
is on, and then flags the online orders left short. Phase 5 ports that rule with the POS.

A courier's tracking-URL template is filled as Python's `str.format` fills it, format specs
included since phase 6 part 8 (until then one was a 500 where Django would pad). The one
exception is an attribute of the number, listed under "Deliberate differences".

## Performance, measured 2026-09-30

Same machine, same database, one API at a time, 400 requests per endpoint with 8 concurrent
clients (`parity/bench.ts`); Django as production runs it, 2 gunicorn workers x 4 threads.

| Endpoint | Django req/s | Nest req/s | Django p95 ms | Nest p95 ms |
|---|---|---|---|---|
| `/api/health/` | 362 | 2113 | 34.7 | 7.3 |
| `/shop/categories/` | 64 | 517 | 247.4 | 29.0 |
| `/shop/products/` | 23 | 103 | 468.0 | 119.2 |
| `/shop/products/?q=shirt` | 35 | 140 | 388.9 | 67.7 |
| `/shop/products/<slug>/` | 17 | 95 | 904.9 | 99.8 |
| `/shop/home/` | 5 | 40 | 1739.1 | 258.9 |
| `/shop/navigation/` | 68 | 249 | 184.6 | 39.2 |

Memory after the run: Django 248 MB (master 28, two workers 110 each), Nest 114 MB (one process).
The machine was swapping; absolute numbers are this machine's, the ratios are the finding. Part of
the gap on `categories/` is that Django issues 8 queries there (an N+1) where the port issues 2.
