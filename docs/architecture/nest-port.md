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
| 6 | Purchasing, finance, customers admin, promotions, shipping admin | In progress: part 1 (accounts, the cash book, transfers), part 2 (expenses, the party ledger), part 3 (suppliers and their price lists) 2026-10-06 |
| 7 | Reports, audit log, notifications, background jobs (BullMQ for Celery); cutover | |

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

A courier's tracking-URL template is filled as Python's `str.format` fills it, except that a
format spec (`{tracking_number:>12}`) is refused -- a 500 where Django would pad. No template uses one.

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
