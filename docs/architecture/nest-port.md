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
| 4 | Catalogue, inventory and content admin (ledger, transfers, counts, image uploads) | In progress: part 1 (staff permissions, brands, categories), part 2 (attributes, values, size charts), part 3a (products), part 3b (variants), part 3c (product images), part 3d (the products CSV import), part 4a (inventory and the stock ledger), part 4b (transfers and counts), part 5a (site settings and social links) 2026-10-01 |
| 5 | POS: sales, held sales, registers, discounts; returns and refunds | |
| 6 | Purchasing, finance, customers admin, promotions, shipping admin | |
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
| `POST/PUT/PATCH/DELETE /api/v1/products/[<id>/]` | specifications and size chart through their services, each audited when it changes something; a draft cannot be published in the same payload; a chart must be one the category offers, unless the product's variants are built on it. A product ever sold or stocked is archived; any other is deleted with what only pointed at it (variants, links, images, specifications, cart lines, offers, carousel entries -- each of those a `home` revalidation job); a purchase order line refuses it (409), after the audit entry is written, as Django writes it first |
| `POST /api/v1/products/<id>/generate-variants/` | the cartesian product of the chosen values, combinations the product has skipped, SKUs and in-store barcodes from the `barcode` sequence; or one SKU with no options under the product's row lock, so a retried submit makes nothing. A negative cost reaches the database's check constraint: 409, as in Django |
| `POST /api/v1/products/<id>/publish/`, `unpublish/` | publishing needs an active variant priced above zero |

Then variants (part 3b):

| Endpoint | Notes |
|---|---|
| `GET/POST /api/v1/variants/`, `GET/PUT/PATCH/DELETE /api/v1/variants/<id>/` | paginated, ordered by the product (newest first), position and SKU; filtered by product and status; DRF's `SearchFilter` over SKU, barcode and product name -- every term must match one of them, terms split on whitespace and commas, a quoted phrase kept whole, a NUL refused with the details as a bare list. Unique SKU and barcode, a blank barcode stored as NULL, `DateField` with Python's `date.fromisoformat` and Django's fallback (ISO weeks, `2026-1-5`, any script's digits). Archive-or-delete as for products |
| `GET /api/v1/variants/lookup/?code=&branch=` | the barcode exactly, else the SKU in any case, with stock at the branch; not found is the view's own hand-written envelope, with no request id |
| `POST /api/v1/variants/<id>/barcode/` | the variant's in-store barcode, assigned under its row lock when it has none, audited |

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
| Form and multipart bodies | parsed by every view | parsed by the views that take uploads (product images); 415 elsewhere | The web app posts JSON everywhere else |
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
- A move of a content row (a social link now; navigation items and the home carousel when they
  are ported) that waited on the run's lock renumbers the run in the order PostgreSQL sorted it
  before the wait, so a move or reorder committed meanwhile is undone (D132).
- `?ordering=get_platform_display` on the social links is a 500 on the list, the detail, the edit
  and the move: `OrderingFilter` offers the `label` field's source, a model method (D133).
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
which business rule 1.4 says may never happen with overselling off. Phase 5 ports the POS; Django
must be fixed first.

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
