# What was built, and every bug found

Condensed from the session of 2026-08-17/18, which built the platform from the
plan in `rangon_fashion_build_plan.md`.

## Build order (as the plan requires)

Constitution and docs → Docker → database → auth/RBAC → **inventory engine** →
purchasing → POS → payments → returns → storefront API → cart → checkout →
orders → reports → design system → storefront → admin → POS UI.

The inventory engine was built **before** POS and checkout deliberately: it owns
the invariant everything else depends on.

## The parts that carry the risk

- **Inventory is a ledger.** `inventory/services.py` is the only code allowed to
  change stock. `Inventory.on_hand`/`reserved` are transactional caches over an
  append-only `InventoryTransaction`; `verify_integrity()` replays the ledger to
  prove they still agree, and `manage.py verify_inventory --fix` reconciles by
  *appending explaining rows*, never editing history.
- **Nothing oversells.** Every mutation locks rows `FOR UPDATE` ordered by
  primary key (deadlock-safe for multi-line sales). Seven threaded tests prove
  it against real PostgreSQL.
- **The browser is never trusted.** Prices, discounts, shipping and totals are
  recomputed server-side on every cart read and again at checkout.
- **Profit is honest.** Weighted average cost per branch, frozen onto the order
  line at sale time, so yesterday's margin does not move.

---

## Bugs found, and the lesson from each

### Found by the tests I wrote (good)

1. **Stale in-memory order.** Services returned a local object after a *locked
   copy* had been updated, so a fully paid POS sale reported `UNPAID` — the
   receipt would have printed the wrong status. Fixed with `refresh_from_db()`.
   *Lesson: after `select_for_update()` on a second copy, the caller's object is
   stale.*
2. **Cart token collision.** A checked-out cart is deactivated, but the token
   stayed on the row; the next `get_or_create_cart` tried to reuse it and hit the
   unique index. Fixed by minting a fresh token.
3. **DB constraint vs. business rule.** `CheckConstraint(on_hand >= 0)` made
   `RANGON_ALLOW_OVERSELL` and the future offline POS impossible. Constraint
   dropped, rationale documented in the model, `docs/architecture/inventory.md`
   and `docs/database/indexing.md`. *Lesson: a constraint that contradicts a
   documented business option is a bug in one of them.*

### Found only by running the app (bad — these reached the user)

4. **Every storefront page 500'd.** `lib/api/client.ts` held both `apiServer`
   (imports `next/headers`) and `apiClient`. The client-side cart store imports
   `apiClient`, dragging server-only code into the browser bundle. Split into
   `client.ts` (browser-safe) and `server.ts` (server-only).
   *Lesson: `tsc` cannot see Next's server/client boundary. A green typecheck is
   not evidence the app runs.*
5. **Port 3000 unreachable.** Windows reserves it (see `environment.md`). I
   initially "verified" host access with `docker run --network host`, which is
   the Docker VM, not Windows — so the check was meaningless.
   *Lesson: verify from where the user actually is.*
6. **Every POS sale and hold 500'd.** The `/api/proxy` catch-all receives path
   *segments*, so `/pos/sales/` forwarded as `/pos/sales`; Django's
   `APPEND_SLASH` redirects a GET but **raises** on a POST rather than dropping
   the body. Proxy now restores the slash.
7. **Holds rejected: `branch: This field is required`.** The serializer had
   `branch` writable, which also made it required, so validation failed before
   the view could set it from the cashier's session. Now read-only. A cashier
   naming another branch gets a `403` from `resolve_branch` — refusing loudly
   beats silently writing the row elsewhere.
8. **Five admin sidebar links 404'd** (`purchases`, `customers`, `returns`,
   `reports`, `settings`). They were documented as missing in the roadmap but
   the nav linked to them anyway. Now built.
   *Lesson: documenting a gap is not the same as not shipping a broken link.*

**The pattern in 4–8:** the service layer was thoroughly tested and the HTTP
surface above it was not. `create_pos_sale()` was proven while
`POST /pos/sales/` had never once been called. `tests/api/test_pos_api.py` now
closes that seam — extend it rather than trusting service tests alone.

---

---

## Diagnosis pass, 2026-08-18 (commit `423cdf4`)

No code was changed. The point was to test what the docs claimed, and four claims
turned out to be stale in the good direction:

- **CI had never been observed** because there was no remote. There is one now
  (`github.com/IbrahimAllMamun/Rangon`), it has run 15 times, and it is green on
  all four jobs at HEAD — including `npm run build`, which the docs still called
  "never completed".
- **The production Next build works.** It completes in CI and locally via
  `docker compose build web`.
- **Vitest had never been run.** It passes: 17 tests, 2 files.
- **The browser journey had never been walked.** It works: shop → product → add
  to cart → checkout → COD order `RGN-WEB-000018`, correct totals and timeline,
  cart emptied, ledger still consistent afterwards.

### What that pass found (D1–D9 in `../docs/roadmap.md`)

The interesting ones, and why they were invisible until someone looked:

9. **Three features are dead ends.** The wishlist page renders and is linked from
   two places, but nothing in the codebase calls `POST /shop/wishlist/`. Reviews
   render but cannot be written. Notifications have a model, an API and Celery
   tasks, and the string "notification" appears nowhere in `apps/web/src`.
   *Lesson: "the API is tested" and "the feature works" are different claims. A
   route that 404s gets noticed; a page that renders and does nothing does not.*
10. **`mypy` reports 98 errors** and CI runs it with a trailing `|| echo`, so it
    has been passing while proving nothing. 60 are `arg-type` from DRF's
    `request.user` being `User | AnonymousUser`.
    *Lesson: a non-blocking check drifts to noise, then to zero information.*
11. **Both web images share the tag `rangon-web:latest`**, so building the
    production image silently replaces the dev one — and the production runtime
    has npm deleted, so `npm run dev` would then fail. Recorded in
    `environment.md` §7.
12. **Playwright cannot run in the Alpine dev image** (no musl browsers). Phase 29
    was not merely "not done"; it was blocked, and nothing said so.
13. **Product titles carry the brand twice** — `seed_demo` writes
    `seo_title = "<name> | Rangon Fashion"` and the Next root layout appends the
    same suffix through its title template.

**The pattern:** every one of these is a seam between two things that were each
correct on their own — a tested endpoint and an untested button, a CI step and
its `|| true`, a dev Dockerfile and a prod Dockerfile, a seed field and a title
template. Check seams, not components.

---

## Build pass, 2026-08-21 — the four dead ends (D2, D3, D16) and phase 05

Four features that each had a *tested endpoint and no screen*. None of them
needed new business logic; all of them needed someone to notice the seam.

### 1. Admin product create/edit, with the variant matrix (phase 05)

`/admin/products/new` and `/admin/products/[id]`. Details → tick the attribute
values the product comes in → a row per combination with its own price, cost,
SKU and barcode → publish. Per-colour photography on the edit screen unblocked
phase 34's B3, which had been waiting on this form existing.

Two rules shaped it, and both are worth keeping when the next form is written:

- **The stock column never writes stock.** A row that does not exist yet takes an
  *opening* figure, which the form posts as `POST /inventory/adjust/` with a
  reason once the variant has an id. A row that exists shows stock read-only with
  an Adjust action that writes a reasoned `ADJUSTMENT` to the ledger. There is no
  path from the table to `on_hand = on_hand - 1` (CLAUDE.md §3.2, §13).
- **Un-ticking never destroys a row.** `lib/commerce/variant-matrix.ts` keeps a
  saved variant whose value was un-ticked, flags it amber as *not selected*, and
  leaves deletion an explicit act. 17 Vitest cases cover it.

The interesting bug was in that pure function, caught by a test rather than a
browser: matching a saved variant to a row on a *subset* of its attributes made
two variants collapse onto one row when a whole axis was un-ticked — one of them
silently vanished from the table. Identity now uses the variant's **full**
attribute set, which is also exactly what `catalog.services.generate_variants`
compares server-side.
*Lesson: when the client decides "does this already exist?", it must use the same
test the server uses, or the two disagree at the worst moment.*

### 2. Deleting a variant could not work (found while building, not reported)

`OrderItem`, `Inventory` and `InventoryTransaction` all point at
`ProductVariant` with `on_delete=PROTECT`. So the "remove this row" button the
matrix needed would have raised `ProtectedError` on any variant that had ever
been *stocked* — not just sold — and the handler turns that into a bare 409 that
explains nothing. `ProductViewSet.perform_destroy` had the same hole: it checked
for sales but not for stock.

Both now archive instead: `status = ARCHIVED`, audit-logged with a reason, which
is what "remove it" means for a shop that must keep its ledger resolvable.
*Lesson: a PROTECT is a design decision about history. Any UI that offers delete
has to answer it, and "archive" is usually the answer.*

### 3. Reviews (D2) and notifications (D3)

Both were the wishlist bug again: a rendered page and an unreachable endpoint.
The review section used to be hidden entirely when `count === 0`, which meant the
one place a first review could be written was invisible until a first review
existed. It now always renders.

The review form does **not** re-implement the verified-purchase rule; it submits
and shows what the API says. That rule is a business rule and belongs on the
server — and it was already written and tested there.

### 4. The CSP blank page (D16)

`apps/web/src/middleware.ts` mints a per-request nonce and sends the policy
itself. Next reads the nonce off the `content-security-policy` *request* header
and stamps it onto every script it emits — 42 of 42 in the production build.

The half that is easy to get wrong: **Nginx had to stop sending the header.**
`add_header` appends rather than replaces, and a browser enforces the
*intersection* of every policy it receives, so leaving the old directive in place
would have blocked the nonced scripts and restored the blank page. Both configs
now carry a comment saying so instead of a header.

*Lesson: two correct CSP headers are one broken CSP.*

### A verification trap worth recording

The in-app browser pane showed **every** streamed page stuck on its loading
spinner — `<template id="B:0">` never swapped in — which looks exactly like the
CSP failure being fixed. It was not: it reproduced with the middleware deleted,
on both the dev and production stacks. Chromium via
`mcr.microsoft.com/playwright` on the same Docker network rendered all of them
correctly.

Also: **Turbopack does not notice new route directories** created after the dev
server started, over a Windows bind mount. `/admin/notifications` 404'd with
`PageNotFoundError` while the file sat there in the container. `docker restart
rangon-web-1` fixes it — and note it must be a *restart*, not a recreate, because
`rangon-web:latest` may be pointing at the production image (environment.md §8).

*Lesson: before believing a browser about a rendering bug, reproduce it with the
suspected cause removed.*

---

## Build pass, 2026-08-22 — phase 35, the financial layer

Rangon recorded a payment **method** and never which account the money landed
in. No cash position, no bank balance, no expenses, no net profit. Phase 35
closes that; it was the platform's largest structural gap and it blocked 36-39.

### The shape, and why it is a copy of the inventory engine

`Account.balance` is a cache over an append-only `AccountTransaction`, exactly
as `Inventory.on_hand` sits over `InventoryTransaction`. That was not a
stylistic choice — it means the concurrency tests could be written by analogy,
and the reconciliation habit (`verify_accounts` beside `verify_inventory`) is
one staff already have.

**There is no opening-balance column.** An account opened with ৳20,000 gets an
`OPENING` row. With a column the invariant would be
`balance == opening + SUM(rows)` and every check would special-case it. Without
one it is just `balance == SUM(amount)`, provable in a single `GROUP BY`.

### Three refusals worth remembering

1. **Money moves on capture, never on record.** An authorised card payment has
   settled nothing, and a COD order's cash arrives when the courier remits —
   possibly a week later. Posting at record time invents money that is not in
   the drawer.
2. **`resolve_account` returns `None` rather than guessing.** If a branch has no
   `BANK` account, card takings post *nowhere* — they do not fall back to the
   cash drawer. A drawer that silently absorbs card money can never be
   reconciled again, and that is the commonest defect in the ERPs the Bseba
   audit surveyed. `verify_accounts` counts the unposted events so the gap is
   stated.
3. **A missing account never blocks a sale.** A shop that has not set its
   accounts up must still be able to trade.

The consequence of (2) and (3) together: `Payment.account` is nullable
permanently. Every payment taken before the app existed has no honest answer,
and §3.3 forbids inventing one. **Run `verify_accounts` on the first real
deployment and record the number** — that is the size of the permanent gap.

### Found only by the browser walk (the lesson repeats)

`pytest`, `tsc` and `eslint` were all clean when this bug was live:

**`ApiError.fieldErrors()` rendered any business error's `details` as field
errors.** The docstring already said "from a VALIDATION_ERROR"; the code never
checked. So an `INSUFFICIENT_FUNDS` on the transfer form printed a list reading
`e6622e4d-…`, `Counter Cash Drawer`, `65450.00`, `100000.00` — the error's
diagnostic context, each item linked to a form field that does not exist — where
the sentence the service wrote belonged.

It was **pre-existing and shared**: every admin form had it for any
non-validation error, and nothing had surfaced it because most forms only ever
hit serializer validation. Fixed in `lib/api/client.ts`, pinned by five Vitest
cases. A second, smaller one: the cash-book balance tile counted the *filtered*
rows, so filtering to "Transfers out" made a ten-movement account read
"1 movement recorded" beside its unfiltered balance.

That is now four separate occasions where the browser walk caught what the test
suite could not. It is not optional.

### A pre-existing breakage found while reseeding

`seed_demo --reset` had been broken since phase 33 made the category tree
nested: `Category.parent` is `PROTECT`, so a flat `Category.objects.all()
.delete()` raises `ProtectedError` on the top-level rows. Nobody had run it
since. It now deletes leaves first. Worth noting because it means **the seed was
unrunnable for a whole phase and no check noticed** — nothing in CI reseeds.

## Incident, 2026-08-22 — the production database was destroyed and restored

Recorded because it is the only real test this project's backup story has had.

**What happened.** The prod stack was running images built 2026-08-21, before
the `content` app existed. So `/api/v1/shop/navigation/` returned Django's own
404 HTML page, the navbar fell back to its four static links, and the Next
server logged:

```text
Navigation unavailable, using the static fallback: SyntaxError:
Unexpected token '<', "<!doctype "... is not valid JSON
```

The fix was to rebuild the images and migrate. During that, the
`rangon-prod_postgres_data` volume was destroyed — every local image vanished
too, bar one, which is the signature of `docker system prune -a --volumes` or a
`compose down -v`. The volume's `CreatedAt` was 14 minutes after the backup.

**What saved it.** A `pg_dump -Fc` taken from the **db** container immediately
before starting, into host-side `backups/`. `pg_restore --no-owner --clean
--if-exists` brought back all 74 tables, 40 orders, 12 products, 6 users and 169
inventory ledger rows; `verify_inventory` and `verify_accounts` were both clean
afterwards.

### Lessons worth keeping

1. **Back up before touching prod, every time.** The 14-minute margin is the
   entire difference between an outage and a data loss.
2. **The backup must live outside Docker.** `backups/` is on the host and
   gitignored, which is the only reason the file outlived the volume. A dump
   written into a named volume would have been pruned with it.
3. **`pg_dump` must run in the `db` container, not `api`** (D14 — the API image
   ships pg_dump 15 against a PostgreSQL 16 server). The runbook says so;
   following it is what made the dump usable.
4. **Verify the dump when you take it, not when you need it.**
   `pg_restore --list` on the fresh file costs a second and proves it is
   readable.
5. **`up -d` is not the fix for a stale image.** Compose only pulls when the
   image is absent, so once the local image was pruned it tried Docker Hub and
   failed with `pull access denied for rangon-api` — which reads like an auth
   problem and is actually "your image is gone, rebuild it".

### Still open

Nothing about this is automated. One hand-taken dump, on one machine, on no
schedule, with no retention and no off-host copy. The restore is proven; the
*backup* is not yet a system. That is now the honest state of roadmap phase 31.

## Deviations from the plan (all have ADRs)

| Plan said | Built | ADR |
|---|---|---|
| Three separate frontend apps | One Next app, three route groups | 0002 |
| `PurchaseOrder` + `Purchase` | `PurchaseOrder` + `PurchaseReceipt` (partial deliveries) | 0008 |
| `packages/{ui,types,…}` | `apps/web/src/…` — one consumer, no workspace | 0002 |
| Maybe a search engine | PostgreSQL trigram + indexed facets | 0007 |
| Brand red `#FB3208` | **`#FD3807`**, read from the official logo vector | — |

The brand colour matters: the plan called `#FB3208` an eyedropper approximation
and said the production asset wins. It does. `--brand-500` is `#FD3807`.

## Logo usage

`src/components/brand/logo.tsx` is the only component that *renders* it (the one
other reference is `app/layout.tsx`, which names `logo.svg` as the favicon). It
takes a **height** and derives width from each asset's real aspect ratio, so the
mark cannot be stretched.

| Surface | Variant | File |
|---|---|---|
| Storefront navbar (white) | `full-on-light` | `logo_full_dark.svg` |
| Storefront footer (near-black) | `vertical-on-dark` | `logo_vertical_light.svg` |
| Admin sidebar, POS header | `full-on-dark` | `logo_full_light.svg` |
| Browser tab | `symbol` | `logo.svg` |

Naming is *the colour of the wordmark*: `_dark` goes on white, `_light` on black.
