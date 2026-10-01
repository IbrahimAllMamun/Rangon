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
| 4 | Catalogue, inventory and content admin (ledger, transfers, counts, image uploads) | In progress: part 1 (staff permissions, brands, categories), part 2 (attributes, values, size charts), part 3a (products) 2026-10-01 |
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

Two failure events for one payment can both act: `fail_payment` does not refuse a payment
already failed, so the timeline shows the failure twice. Copied, as harmless.

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

The parity stack now sets `WEB_REVALIDATE_URL` on both APIs (nothing listens), so the
`content.tasks.revalidate_storefront` jobs a write queues are compared like checkout's. Seeding
unsets it: the demo seed saves categories, and its signals would otherwise ping the URL inline.

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
| Form and multipart bodies | parsed | 415 | Nothing sends them: the web app posts JSON |
| Two concurrent refreshes of one token | both succeed, each minting a pair | the second is refused (401) | `get_or_create` lets both pass; the port blacklists with `ON CONFLICT DO NOTHING` and refuses the loser. A fix for Django too |
| `bcrypt_sha256$` password hashes | verified | read as a wrong password, and logged | No version of this project wrote one: Argon2 was first in PASSWORD_HASHERS from the first migration |
| `OPTIONS` without CORS headers | DRF's view metadata | 405 | Nothing calls it |
| `USE_S3=1` | S3 URLs | refuses to start | django-storages' URL building is not ported; a wrong image URL is worse than a refusal |
| Celery broker down when a checkout commits | 500, though the order is placed (D116) | 201, the failure logged | Raising after the commit tells a shopper an order failed when it did not; the harness cannot see this, as its broker is up |
| Format-suffix URLs (`/api/v1/brands.json`, `/brands/<id>.json`, `/brands.api`) | served by `DefaultRouter`, `.api` as the browsable HTML API | not routed: 404, or a slash redirect and then 404 | No client appends a suffix; the web app calls the plain paths |

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
- `request.data.get` on a JSON body that is not an object is a 500 on `move` too.
- Renaming a product without sending its slug gives it a new one, `-2` and so on: the product
  serializer makes a slug on every save that names the product (D120).
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
