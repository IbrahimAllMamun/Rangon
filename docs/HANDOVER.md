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

## 3. What was actually executed, not just written

```text
migrations from an empty database ..... OK, all 12 apps
seed_demo --reset ..................... 12 products, 72 variants, 2 purchase orders, 40 orders
                                        (24 POS + 16 online, spread across every order status)
inventory integrity after seeding ..... 0 drift between the ledger and the cached columns
pytest ................................ 155 passed
  · 148 unit / service / API tests
  · 7 threaded concurrency tests against real PostgreSQL
ruff check + ruff format .............. clean
frontend tsc --noEmit ................. clean
API smoke test (live container) ....... health 200, ready 200, shop endpoints 200,
                                        staff endpoint correctly 401 for anonymous
```

Two real bugs were found by those tests and fixed:

1. Services returned a **stale in-memory order** after a locked copy had been updated, so a fully paid
   POS sale reported `UNPAID` to the caller and would have printed a wrong receipt.
2. A checked-out cart token **collided with its unique index** when the same browser started a second
   cart.

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
| Admin product/purchase/customer/returns/coupon/report screens | Every operation is available through the API and tested | `docs/api/endpoints.md` |
| Admin order detail page | Order list works; detail actions are API-only for now | `/api/v1/orders/{id}/…` |
| Offline POS | Explicitly V2 in the plan; needs an oversell exception report first | `architecture/offline-pos.md` |
| SMS notifications | Email + in-app work | `notifications/tasks.py` |
| ESC/POS driver | Browser print of an 80 mm receipt works | `@media print` in `globals.css` |

## 6. Decisions someone must confirm

Marked `DECISION REQUIRED` in [business-rules.md](business-rules.md). A sensible default is
implemented so the system runs; each one is a business call, not a technical one.

1. **VAT: inclusive or exclusive, and at what rate.** Currently exclusive at 0%. **Settle this before
   the first real sale** — it changes every historical total and every report.
2. Return window — assumed 14 days.
3. Discount needing manager approval — assumed above 20%.
4. Reservation expiry for unpaid online orders — assumed 60 minutes.
5. Shipping refunded on a change-of-mind return — assumed no.
6. Which payment gateway and which courier.

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

## 8. Next three tasks, in order

1. **`/admin/orders/[id]`** — the screen the shop touches daily. Every endpoint it needs already
   exists and is tested.
2. **Run the Playwright suite** (`apps/web/e2e/`) against a seeded stack and add it to CI.
3. **One real payment gateway**, end to end, with webhook signature verification and replay tests.

Then work down the go-live checklist. The two items that will bite hardest if left late are the **VAT
decision** and the **backup restore rehearsal** — a backup that has never been restored is not a
backup.
