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
