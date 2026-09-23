# Rangon Fashion — Handover

What exists, what was proven to work, what is deliberately not built yet, and what to do next.
Status per phase: [roadmap.md](roadmap.md). Business behaviour: [business-rules.md](business-rules.md).

---

## 1. What this is

An omnichannel retail platform. One Django API owns the catalog, the inventory ledger, customers,
orders and payments — and, since phases 35–38, the money side: which account cash landed in,
expenses, what is owed each way, and net profit. Three surfaces sit on top of it — a public
storefront, a POS register, and a back office — and they share **one** stock figure. A sale at the
counter reduces what the website can sell, within the same database transaction.

```text
apps/api   Django 5 + DRF, 14 apps, PostgreSQL 16, Redis, Celery
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

The most recent result of each check that the
[roadmap's verification log](roadmap.md#verification-log) records, with the date it was produced.
Nothing here is newer than the log; the list of things still unproven is in
[roadmap.md](roadmap.md#still-unproven).

```text
pytest ................................ 1097 passed                        2026-09-18
ruff 0.8.4 check + format --check ..... clean, 201 files                   2026-09-18
frontend tsc --noEmit / next lint ..... clean                              2026-09-18
vitest ................................ 260 passed                         2026-09-18
storefront VAT notes, in a browser .... 8 of 8 checks, 0 CSP refusals      2026-09-18
query budgets ......................... 20/20 pass                         2026-09-14
seed_demo --reset ..................... 12 products, 72 variants           2026-09-14
playwright ............................ 22 passed                          2026-09-09
playwright, production build .......... not green — D40 and D41            2026-08-31
                                        (D41 fixed 2026-09-09; no production run recorded since)
admin write screens, signed in ........ 13 writes, all landing             2026-08-28
verify_inventory / verify_accounts .... consistent                         2026-08-28
backup restore ........................ proven after a real data loss      2026-08-22
browser purchase journey .............. add to cart -> checkout -> COD     2026-08-18
                                        order RGN-WEB-000018
migrations from an empty database ..... OK                                 2026-08-18
```

The E2E suite runs in CI against `next dev`, not against a production build. D41 was a race in the
spec rather than the build; D40 is the one reason left.

Two real bugs were found early by the backend tests and fixed:

1. Services returned a **stale in-memory order** after a locked copy had been updated, so a fully paid
   POS sale reported `UNPAID` to the caller and would have printed a wrong receipt.
2. A checked-out cart token **collided with its unique index** when the same browser started a second
   cart.

The defect register in [roadmap.md](roadmap.md#known-defects) now runs to D87. **Two are open, and
neither of them is a money or data-integrity bug:**

| # | Defect |
|---|---|
| D7 | Playwright cannot run in the Alpine *dev container*. The defect is that image alone — a glibc Chromium runs the suite |
| D9 | The seed has no product images, so every card shows a placeholder |

Closed on 2026-09-21: **D6** — mypy was 271 errors in 41 files, not the 98 this table used to quote,
because the CI step ran with `|| echo` and had never blocked. It is 0 errors now and the step
blocks. **D88** — every rate limit could be bypassed by varying `X-Forwarded-For`, and the audit
trail recorded whatever address the caller sent: measured at 40 unrefused password guesses against
a control refused at the eleventh. Both now resolve the caller through one helper that counts
trusted proxy hops from the right; `DJANGO_TRUSTED_PROXY_HOPS` must match the deployment, and
`docs/operations/security.md` has the table. **D89** and **D90** followed on 2026-09-22:
`Idempotency-Key` was accepted and silently ignored on every finance and inventory endpoint, so a
retried deposit credited the drawer twice and a retried write-off took the units off the shelf
twice; and everywhere the header *was* honoured, the race recovery raised
`TransactionManagementError` instead of returning the winner's row, so a double-tapped POS sale
answered 500.

Closed on 2026-09-23, from auditing three more rows of `security.md` the same way: **D91** — expense
receipts were served from `/media/` to anyone, signed in or not, under the uploader's own filename;
they are served only through an endpoint that checks who is asking now, and new ones get random
names. **D92** — signing out after thirty idle minutes answered 401 and left the refresh token alive
for fourteen days. **D93** — every report took `?branch=` at its word, and an unknown id meant every
branch. **D94** — staff holding `inventory.transfer` at one branch could send another branch's stock
to their own. **With `USE_S3=1`, the bucket's public-read policy must exclude `expenses/*`.**

**D40** and **D77** were the same defect and are worked around: `router.refresh()` fetched
the new payload and discarded it, so `refreshAfterWrite()` now verifies the server render actually
changed and reloads when it did not. The root cause is upstream and still unknown.

The money bugs the register records are all fixed — among them a coupon redeemable twice under a
race (D28), supplier payments that could land on another supplier's order, exceed what was owed or
go through twice (D61–D63), stock entering at zero cost (D72), one variant costed two ways depending
on the channel (D73), a product publishable at a price of zero (D75), and a return that refunded the
price but kept the VAT (D78).

## 4. The parts that carry the risk

### Inventory is a ledger, not a number

`inventory.services` is the only code that may change stock. Every movement appends an immutable
`InventoryTransaction` carrying type, quantity, reference, actor and reason, plus an
`on_hand_after` snapshot. `Inventory.on_hand`/`reserved` are caches maintained in the same
transaction, and `verify_integrity()` replays the ledger to prove they still agree. If they ever
drift, `manage.py verify_inventory --fix` reconciles by **appending explaining rows** — it never edits
history.

### Money is a ledger too

The cash book is the same shape. An account's balance is a cache over an append-only
`AccountTransaction` table, and `manage.py verify_accounts` replays it. Sales, refunds, expenses and
supplier payments post inside their own service's transaction — on capture, never on record — and a
mistake is corrected by a compensating row, never an edit. What customers and suppliers owe is derived
from orders and purchase orders; there is no balance column on either to drift. See
[architecture/finance.md](architecture/finance.md).

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

Weighted average cost per branch, moved only by receiving stock, a return to the supplier or an
explicit revaluation, and **frozen onto the order line** at sale time. Receiving more expensive stock
tomorrow does not change yesterday's margin. Both channels freeze the same figure — until 2026-09-17
online checkout froze `ProductVariant.cost` instead (D73) — and goods enter only by receiving a
purchase order or by the import, both of which carry the cost paid.

## 5. What is deliberately not built

Each row either waits on someone outside the codebase or was declined on the owner's decision. Every
API has a screen now except the customer-account endpoints, which are without one on purpose.

| Missing | Why it is safe to be missing | Where to look |
|---|---|---|
| Live payment gateway | COD works and is how this market buys; the card option is visibly **disabled**, not faked. Needs a provider account | `orders/payments/providers/base.py` |
| SMS gateway account | The layer shipped 2026-09-10 — provider interface, a `console` no-op default, a message log, an allowlist, wired to confirmed / shipped / refunded. What is left is an aggregator account and an approved sender ID | [operations/sms.md](operations/sms.md) |
| Offline POS | **Dropped 2026-09-09, owner's decision** — declined, not deferred. The POS needs connectivity, and an outage is covered by a paper pad and a re-key | `architecture/offline-pos.md` (design notes only) |
| Quotation and the cheque register | **Dropped 2026-09-09, owner's decision.** Both are wholesale instruments and this shop sells retail. A cheque is still recordable as a payment into a `BANK` account | [roadmap.md](roadmap.md) phase 39 |
| Customer accounts on the storefront | **Withdrawn 2026-09-15, owner's decision.** No shopper could create an account, so the wishlist, the account pages and the review form were gated on a login nobody could obtain. The endpoints are kept, unadvertised | [api/endpoints.md](api/endpoints.md#the-customer-account-endpoints-have-no-caller-deliberately) |
| ESC/POS driver | Browser print of an 80 mm receipt works | `@media print` in `globals.css` |

### The UI dead ends

Each looked shipped and was not: a rendered page with no way to reach the endpoint behind it.

| Feature | What happened |
|---|---|
| Notifications | Closed 2026-08-21 — a polling bell in the admin header and `/admin/notifications` |
| Wishlist and writing reviews | Closed 2026-08-21 with a heart on the product card and a form on the product page — then **removed 2026-09-15** with the account surface, because both needed a customer login. Reviews are read-only |
| Track your order | The footer's form 404'd on every submission until 2026-09-15 (D67), and no tracking number had ever been recorded, because nothing created a shipment. Both fixed that day; the Delivery panel that books a parcel has not yet been driven in a browser |

Worth keeping in mind when adding anything else: **a route that 404s gets noticed; a page that renders
and does nothing does not.** "The API is tested" and "the feature works" are different claims.

## 6. Decisions someone must confirm

[business-rules.md](business-rules.md) carries **18** `DECISION REQUIRED` markers. A sensible default
is implemented so the system runs; each one is a business call, not a technical one. The headline six
(the last of which is not a marker but blocks prepaid orders and shipping integration):

1. **VAT: inclusive or exclusive, and at what rate.** Currently exclusive at 0%, which is a
   placeholder. **Settle this before the first real sale.** It is editable at `/admin/settings`,
   audited, and asks for confirmation once orders exist — but every order keeps the treatment it was
   priced under, so a later change corrects nothing already sold, and a report spanning the change
   mixes two.
2. Return window — assumed 14 days.
3. Discount needing manager approval — assumed above 20%.
4. Reservation expiry for unpaid online orders — assumed 60 minutes.
5. Shipping refunded on a change-of-mind return — assumed no.
6. Which payment gateway and which courier.

The other thirteen markers are narrower but still open:

- **Stock and orders:** stock is deducted at `PACKED`, transfers have no formal in-transit location,
  there is no restocking fee, and one coupon per order.
- **Purchasing:** a supplier's minimum order quantity is advisory; a single-SKU product cannot be
  created from a purchase order; the VAT return dates a purchase by when it was raised, because a
  purchase order has no invoice date.
- **Paying suppliers:** no overpaying an order, no paying a draft or cancelled one, no advance
  without a purchase order from that screen, and a credit from returning goods on a paid order is
  settled with the supplier off-system.
- **Settled by construction:** selling on credit (D-A) no longer blocks any code, and the cash book
  was built on a flat account list (D-B).

Read them in full before implementing anything that depends on them. The same list, with the section
each lives in, is in [.claude/open-questions.md](../.claude/open-questions.md).

## 7. Where to look

| Question | File |
|---|---|
| What are the rules of this codebase? | `CLAUDE.md` |
| How does stock actually work? | `docs/architecture/inventory.md` |
| How does money actually work? | `docs/architecture/finance.md` |
| Why is it built this way? | `docs/architecture/decisions/` (11 ADRs) |
| What does the business do in case X? | `docs/business-rules.md` |
| What endpoints exist? | `docs/api/endpoints.md` + `/api/docs` |
| It is 2 a.m. and it is broken | `docs/operations/disaster-recovery.md` |
| Can we launch? | `docs/operations/go-live-checklist.md` |

## 8. Next four tasks, in order

The roadmap's Tier 0: the first real sale waits on each of these, and three of the four are not code.

1. **Deploy somewhere.** As the roadmap stands (reviewed 2026-09-14), nothing is deployed and no
   real order has been placed. A load test, a backup schedule, a security review and
   `verify_accounts` against real data all need an environment to be true of.
2. **Settle VAT.** An owner's answer, entered at `/admin/settings`. See §6.
3. **Real product photography** (D9). A clothing shop with no product images cannot sell, and every
   demo reads as broken without them.
4. **Automate the backup.** `scripts/backup-db.sh` takes `BACKUP_S3_BUCKET` and
   `BACKUP_RETAIN_DAYS`; nothing schedules it.

Then the Tier 2 backlog, which is down to a **media library**: D40 was worked around and CI's E2E
job now runs against a production build; the readers for the audit log and the stock ledger and
password self-service all shipped; and mypy (D6) is clean and blocking as of 2026-09-21. The payment
gateway and the SMS account wait on provider accounts — start the SMS sender-ID paperwork early,
because approval takes days to weeks.

The two items that will bite hardest if left late are the **VAT decision** and **backup
automation**. The restore has been rehearsed for real, on 2026-08-22 — but it worked only because a
dump taken by hand happened to be 14 minutes old.
