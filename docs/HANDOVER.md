# Rangon Fashion — Handover

What exists, what was proven to work, what is deliberately not built yet, and what to do next.
Status per phase: [roadmap.md](roadmap.md). Business behaviour: [business-rules.md](business-rules.md).

---

## 1. What this is

An omnichannel retail platform. One Django API owns the catalog, the inventory ledger, customers,
orders and payments. Three surfaces sit on top of it — a public storefront, a POS register, and a
back office — and they share **one** stock figure. A sale at the counter reduces what the website can
sell, within the same database transaction.

```text
apps/api   Django 5 + DRF, 12 apps, PostgreSQL 16, Redis, Celery
apps/web   Next.js 15, route groups (storefront) (admin) (pos)
docs/      constitution, architecture, ADRs, business rules, operations runbooks
```

## 2. Getting it running

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
docker compose exec api python manage.py migrate
docker compose exec api python manage.py seed_demo --reset
```

Storefront <http://localhost:3000> · POS `/pos` · Admin `/admin` · API docs
<http://localhost:8000/api/docs>. Demo logins are in the [README](../README.md) (all
`rangon12345`).

The storefront port is `WEB_PORT` in `.env`. On Windows it frequently cannot be 3000 — Windows
reserves the range — so the development machine used for this build serves it on **4000**. Keep
`WEB_PORT`, `NEXT_PUBLIC_SITE_URL`, `DJANGO_CORS_ALLOWED_ORIGINS` and `DJANGO_CSRF_TRUSTED_ORIGINS`
on the same origin or the cart and checkout break on CORS.

## 3. What was actually executed, not just written

Re-verified on **2026-08-18** against commit `423cdf4`. The full log, and the list of things still
unproven, is in [roadmap.md](roadmap.md).

```text
migrations from an empty database ..... OK, all 12 apps
seed_demo --reset ..................... 12 products, 72 variants, 2 purchase orders, 40 orders
                                        (24 POS + 16 online, spread across every order status)
inventory integrity ................... 0 drift between the ledger and the cached columns,
                                        re-checked after a live browser order
pytest ................................ 167 passed
  · 160 unit / service / API tests
  · 7 threaded concurrency tests against real PostgreSQL
ruff check + ruff format .............. clean
frontend tsc --noEmit ................. clean
vitest (npm run test) ................. 17 passed, 2 files
production Next build ................. succeeds (CI on every push, and `docker compose build web`)
CI (GitHub Actions) ................... green on all four jobs at HEAD (14 runs, latest #15)
API smoke test (live container) ....... health 200, ready 200, shop endpoints 200,
                                        staff endpoint correctly 401 for anonymous
browser purchase journey .............. add to cart -> checkout -> COD order RGN-WEB-000018
```

Three of those lines were "never run" until this diagnosis: the Vitest suite, the production Next
build, and the browser click-through. CI itself had never been observed either — a remote now exists
and the workflow is green.

Two real bugs were found earlier by the backend tests and fixed:

1. Services returned a **stale in-memory order** after a locked copy had been updated, so a fully paid
   POS sale reported `UNPAID` to the caller and would have printed a wrong receipt.
2. A checked-out cart token **collided with its unique index** when the same browser started a second
   cart.

Nine further defects were found by the 2026-08-18 diagnosis. None touches money or stock; they are
dead-end UI, one SEO duplication, one dialog accessibility warning, 98 non-blocking mypy errors, and
two build/tooling traps. They are listed as D1–D9 in [roadmap.md](roadmap.md#known-defects).

## 4. The parts that carry the risk

### Inventory is a ledger, not a number

`inventory.services` is the only code that may change stock. Every movement appends an immutable
`InventoryTransaction` carrying type, quantity, reference, actor and reason, plus an
`on_hand_after` snapshot. `Inventory.on_hand`/`reserved` are caches maintained in the same
transaction, and `verify_integrity()` replays the ledger to prove they still agree. If they ever
drift, `manage.py verify_inventory --fix` reconciles by **appending explaining rows** — it never edits
history.

### Nothing oversells

Every stock mutation locks the affected rows with `SELECT … FOR UPDATE`, ordered by primary key so
multi-line sales cannot deadlock. Proven by `tests/test_concurrency.py`, which runs real threads:

| Scenario | Result |
|---|---|
| Stock = 1, two simultaneous web checkouts | exactly one order, one `INSUFFICIENT_STOCK` |
| Stock = 1, POS sale and web checkout at once | exactly one succeeds |
| Double-clicked checkout, same idempotency key | one order |
| Same payment webhook delivered 3× | captured once |
| Six multi-line sales locking in opposite orders | no deadlock |
| Return completed 3× concurrently | one refund |

### The browser is never trusted

Prices, discounts, shipping and totals are recomputed server-side on every cart read and again at
checkout. A client-supplied total that disagrees is rejected with `PRICE_CHANGED`. Coupon codes are
claims, not amounts. Registration always creates a `CUSTOMER` regardless of what the payload asks for.

### Profit is honest

Weighted average cost per branch, recalculated only on receipt, and **frozen onto the order line** at
sale time. Receiving more expensive stock tomorrow does not change yesterday's margin.

## 5. What is deliberately not built

Backend APIs are complete and tested for all of these; what is missing is the admin **screens**.

| Missing | Why it is safe to be missing | Where the API is |
|---|---|---|
| Live payment gateway | COD works; the card option is visibly **disabled**, not faked | `orders/payments/providers/base.py` |
| Admin purchase/customer/returns/coupon screens | Every operation is available through the API and tested. **Products are done** — create, edit, variant matrix, photography and publish at `/admin/products` — as are organization and branch settings at `/admin/settings` | `docs/api/endpoints.md` |
| Offline POS | Explicitly V2 in the plan; needs an oversell exception report first | `architecture/offline-pos.md` |
| SMS notifications | Email + in-app work | `notifications/tasks.py` |
| ESC/POS driver | Browser print of an 80 mm receipt works | `@media print` in `globals.css` |

### The three UI dead ends are closed (2026-08-21)

All three looked shipped and were not: a rendered page with no way to reach the endpoint behind it.

| Feature | Fixed by |
|---|---|
| Wishlist | `WishlistHeart` on the product card, backed by a shared `useWishlist` store |
| Reviews | `ReviewForm` on the product page; the section now renders even at zero reviews, because hiding it made the only way to write the first one invisible |
| Notifications | A polling bell in the admin header and `/admin/notifications` |

Worth keeping in mind when adding anything else: **a route that 404s gets noticed; a page that renders
and does nothing does not.** "The API is tested" and "the feature works" are different claims.

## 6. Decisions someone must confirm

[business-rules.md](business-rules.md) carries **9** `DECISION REQUIRED` markers. A sensible default
is implemented so the system runs; each one is a business call, not a technical one. The headline six
(the last of which is not a marker but blocks prepaid orders and shipping integration):

1. **VAT: inclusive or exclusive, and at what rate.** Currently exclusive at 0%. **Settle this before
   the first real sale** — it changes every historical total and every report.
2. Return window — assumed 14 days.
3. Discount needing manager approval — assumed above 20%.
4. Reservation expiry for unpaid online orders — assumed 60 minutes.
5. Shipping refunded on a change-of-mind return — assumed no.
6. Which payment gateway and which courier.

The remaining four markers are narrower but still open: the point in the order lifecycle where stock
is deducted (currently `PACKED`), whether transfers need a formal in-transit location, the restocking
fee (currently none), and whether coupons may stack (currently one per order). Read them in full
before implementing anything that depends on them.

## 7. Where to look

| Question | File |
|---|---|
| What are the rules of this codebase? | `CLAUDE.md` |
| How does stock actually work? | `docs/architecture/inventory.md` |
| Why is it built this way? | `docs/architecture/decisions/` (8 ADRs) |
| What does the business do in case X? | `docs/business-rules.md` |
| What endpoints exist? | `docs/api/endpoints.md` + `/api/docs` |
| It is 2 a.m. and it is broken | `docs/operations/disaster-recovery.md` |
| Can we launch? | `docs/operations/go-live-checklist.md` |

## 8. Next four tasks, in order

1. **Purchase order create → send → receive.** The largest everyday job still done through the API.
   `POST /purchase-orders/`, `/send/` and `/receive/` are built and tested; receiving is what puts
   stock on the shelf through the ledger. `components/admin/product-form.tsx` is the pattern.
2. **Return approve / reject / receive / refund** — four buttons on a list that already renders.
3. **Unblock E2E and widen CI.** Playwright cannot run in the Alpine dev image; move it to a
   glibc-based runner, then add both `npm run test` and `npm run test:e2e` to `ci.yml` — today CI
   builds and type-checks the frontend but runs none of its tests.
4. **One real payment gateway**, end to end, with webhook signature verification and replay tests.

Then work down the go-live checklist. The two items that will bite hardest if left late are the **VAT
decision** and the **backup restore rehearsal** — a backup that has never been restored is not a
backup.
