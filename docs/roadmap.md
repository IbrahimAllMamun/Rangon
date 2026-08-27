# Roadmap & Status

Phase order follows §85 of the build plan. **Do not reorder casually** — the storefront must not be
built before the product/variant/inventory/order architecture is stable.

Legend: ✅ done and verified · 🟡 partial (gap stated) · ⬜ not started

**Verified** means it was actually executed. The evidence, and the date it was produced, is in
[§ Verification log](#verification-log). Anything not in that log is written but unproven — see
[§ Still unproven](#still-unproven) and say so rather than implying otherwise.

Last diagnosed: **2026-08-18**, against commit `423cdf4` on `main` (in sync with `origin/main`).
Phases 07 and 35 shipped after that diagnosis — see the 2026-08-22 entries in the verification log —
and phase 36 on 2026-08-27, whose verification is the 2026-08-27 entry.

| #   | Phase                                 | Backend | Frontend | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00  | Project constitution                  | ✅      | —       | `CLAUDE.md`, `docs/`, 8 ADRs, CI workflow (now running — see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 01  | Brand + design system                 | —      | ✅       | Tokens, primitives, three shells. Official logo vectors wired. Route-transition + pending-state system on`LogoLoader` — see [design-system.md](design-system.md#waiting-which-loader-and-when)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 02  | Architecture                          | ✅      | —       | `docs/architecture/*`, ERD, domain model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 03  | Database                              | ✅      | —       | 12 apps, UUID PKs, Decimal money, constraints, migrations apply clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 04  | Auth + RBAC                           | ✅      | ✅       | JWT in httpOnly cookies, 7 roles, branch scoping, audit log, sign-in page. Admin settings can now**edit** the organization and create/edit branches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 05  | Product catalog                       | ✅      | ✅       | Full CRUD API.**Admin create/edit shipped 2026-08-21** — `/admin/products/new` and `/admin/products/[id]`: details, attribute tick-lists, a variant matrix with per-row price/cost/SKU/barcode, opening stock, publish/unpublish, delete-or-archive, and per-colour photography                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 06  | Inventory engine                      | ✅      | 🟡       | Ledger, reservations, transfers, WAC,`verify_inventory`. The product form can now open stock and write a reasoned adjustment per variant. The inventory **screen** is still read-only, and there is no stock-count or transfer UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 07  | Suppliers + purchasing                | ✅      | ✅       | PO → receive → ledger → cost recalculation.**Admin screens shipped 2026-08-22** — `/admin/purchases/new` (supplier picker with inline create, debounced variant search, line table, live totals), `/admin/purchases/[id]` (send, cancel, partial receive, delivery history) and `/admin/suppliers` (list + inline create/edit). Receiving is the only step that writes stock, and it goes through `inventory.services`                                                                                                                                                                                                                                                                                                                                                                                  |
| 08  | POS                                   | ✅      | ✅       | Barcode-first register, split payment, hold/resume, receipt, F2/F4/F8 shortcuts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 09  | Payments                              | ✅      | ✅       | Generic model + provider registry;`manual` provider (cash/card/MFS/COD) shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 10  | Returns                               | ✅      | 🟡       | Full request→approve→receive→restock→refund + POS one-step return. Admin returns list built; approve/receive/refund still API-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | Customers                             | ✅      | 🟡       | Phone-first identity, addresses, notes, history. Admin customer list built; editing still API-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12  | Online store                          | ✅      | ✅       | Home, shop, product, cart, checkout, order tracking, account, policies. Browser journey verified end to end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 13  | Search + filters                      | ✅      | ✅       | Postgres trigram + indexed facets; facet UI with colour swatches; navbar type-ahead suggest (products / categories / popular searches) backed by a`SearchTerm` log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | Cart                                  | ✅      | ✅       | Server-authoritative, re-priced on every read, drawer + full page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 15  | Checkout                              | ✅      | ✅       | Idempotency keys, reservation, COD, server-side totals, error summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 16  | Online payments                       | 🟡      | 🟡       | Abstraction + COD complete.**No live gateway** — the card option is disabled in the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 17  | Orders                                | ✅      | ✅       | Status machine, timeline, admin list + detail with status changes, payment capture, refunds, printable A4 invoice and packing slip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 18  | Shipping                              | ✅      | 🟡       | Zones, methods, shipments, courier-ready interface. Checkout picks a method; no admin screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 19  | Coupons                               | ✅      | 🟡       | Full engine + API; cart can apply/remove. No admin coupon screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 20  | Wishlist + reviews                    | ✅      | ✅       | **Wishlist fixed 2026-08-21** — a heart control on the product card (`WishlistHeart`, top-right of the image, optimistic toggle) and a shared `useWishlist` store back the header count and `/wishlist`. **Reviews fixed 2026-08-21** — the section always renders and carries a star-rating form (`ReviewForm`) posting to `POST /shop/products/{slug}/reviews/`. D1 and D2 struck through below                                                                                                                                                                                                                                                                                                                                                                                                 |
| 21  | Dashboard                             | ✅      | ✅       | Server-aggregated KPIs, sales chart with a table alternative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 22  | Reports                               | ✅      | ✅       | 8 report endpoints + CSV export, with a reports screen (product performance + CSV download for all seven)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 23  | Offline POS                           | ⬜      | ⬜       | Deliberately V2 (plan §29). Design recorded in`architecture/offline-pos.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 24  | Barcode + printing                    | 🟡      | 🟡       | Keyboard-wedge scanning + barcode generation work; print CSS for 80 mm receipt and A4. No ESC/POS driver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 25  | Notifications                         | 🟡      | ✅       | Model, in-app feed API, Celery email tasks.**UI shipped 2026-08-21** — a polling bell in the admin header and `/admin/notifications` with all/unread filtering and mark-as-read. Still no SMS provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 26  | SEO                                   | 🟡      | 🟡       | Metadata, OG, sitemap, robots, canonicals, JSON-LD product + breadcrumbs. Product titles render the brand twice —[D4](#known-defects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 27  | Security                              | 🟡      | 🟡       | Controls implemented and documented; CI runs`pip-audit` + `npm audit` and Trivy-scans both images. CSP is now nonce-based and sent by the app itself (D16 fixed). **No independent penetration test**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 28  | Performance                           | 🟡      | 🟡       | Every list endpoint swept: three N+1s fixed (home 511→29, listing 363→13, purchase orders 156→15) plus a per-keystroke POS request storm; all guarded by growth tests. Production measured at 11–320 ms per page. Remaining: five documented budgets unasserted, product detail**exceeds** its documented 10, no load test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 29  | E2E testing                           | 🟡      | 🟡       | Playwright specs written for the four critical flows;**still not executed — blocked**, see [D7](#known-defects). The flows they cover were instead walked by hand in a browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 30  | Deployment                            | 🟡      | 🟡       | Compose prod stack;**CI now runs and is green at `HEAD`**, including the production build and image scans. Still **no live environment**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 31  | Backup/recovery                       | ✅      | —       | Scripts + runbook written, and **the restore has now been rehearsed for real** — 2026-08-22, against a production database that was actually destroyed. See the verification log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 32  | Production launch                     | ⬜      | ⬜       | Blocked on`docs/operations/go-live-checklist.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 33  | Dynamic navigation                    | ✅      | ✅       | Category-driven navbar with a one-table override,`/category/[...slug]` URLs (with a 308 redirect from the old `/shop?category=`), announcement bar, search suggest, admin editors for navigation overrides and banners. Phases N0–N6 done — [architecture/navigation.md](architecture/navigation.md#7-phases); decisions in [ADR-0009](architecture/decisions/0009-category-driven-navigation.md) and [ADR-0010](architecture/decisions/0010-radix-navigation-menu.md). Category reorder + icon (a category-scoped admin screen) not built — see navigation.md §7 N5                                                                                                                                                                                                                                                 |
| 34  | Colour-linked product media           | ✅      | ✅       | Images bind to a colour`AttributeValue` rather than a variant; selecting a colour moves the gallery without hiding any image; clicking another colour's thumbnail repairs the other axes. Phases B1–B3 all done — **B3 landed 2026-08-21** with the admin product form it was blocked on — [architecture/product-media.md](architecture/product-media.md#6-phases)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 35  | Financial accounts + cash book        | ✅      | ✅       | **F1 shipped 2026-08-22.** `finance` app: `Account` (cash/bank/MFS, per branch), append-only `AccountTransaction`, `AccountTransfer`. Balance is a reconciled cache with a `verify_accounts` command, exactly as `Inventory.on_hand` sits over `InventoryTransaction`; an opening balance is an `OPENING` row, not a column. Sales, refunds and supplier payments post inside their service's atomic block — **on capture, never on record**. `/admin/finance` (cash position, accounts, cash book, transfers, manual entries), per-tender account in the POS, account pickers on COD capture and refunds. 61 new tests incl. 4 threaded. [architecture/finance.md](architecture/finance.md) · [ADR-0011](architecture/decisions/0011-append-only-cash-book.md). **Unblocks 36–39**  |
| 36  | Expenses                              | ✅      | ✅       | **F2 shipped 2026-08-27.** `ExpenseCategory` + `Expense` posted through `finance.services.record_expense()` — document and `EXPENSE` cash-book movement in one transaction, so neither can exist without the other. Voiding posts a compensating `ADJUSTMENT`; nothing is deleted. `/admin/expenses` with a period filter, spend tiles, category-wise split, receipt upload and CSV. Nine categories seeded by migration. New permission `finance.expense` (owner/admin/manager/accountant, **not** cashier). 57 tests |
| 37  | Party ledger — receivable / payable  | ⬜      | ⬜       | **F3.** Derived from rows that already exist — **no balance column on `Customer`** — plus an `OPENING` entry type for shops migrating from paper. Ledger tabs and ageing buckets. **Conditional on decision D-A below**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 38  | Business report → net profit         | ⬜      | ⬜       | **F4.** `business_summary(period, branch)` over sales, gross margin from the frozen `unit_cost` (ADR-0006), purchases, damage, expenses, returns, discounts, VAT. Only figures we can compute honestly — Salary/Warranty/Service stay off until those features exist. **Blocked by the VAT decision**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 39  | Trade documents                       | ✅      | 🟡       | **Damage, stock count and transfer shipped 2026-08-27.** `/admin/inventory` gains a write-off panel and a Branch column; `/admin/inventory/transfers` and `/admin/inventory/counts` are new, with a count sheet that shows variance live. The count was **not** the form work this row promised — `counted_quantity` had no write path at all, so `apply` was a no-op; `record/` and `cancel/` were added and `apply/` now refuses an empty or already-applied sheet. Still open: quotation, cheque register, barcode label sheets |

Phases 35–39 come from a signed-in, read-only walk of all 56 screens of the **Bseba ERP**
(`erp.bseba.com`, Dostishop tenant) on 2026-08-21 — written up with a have-it / build-it / decline-it
verdict per feature in [planning/bseba-erp-feature-audit.md](planning/bseba-erp-feature-audit.md).

The finding: Rangon matches or beats that ERP on catalogue, purchasing, POS, returns, stock and
reports — and has a storefront it has no equivalent of — but **has no financial layer at all**. Rangon
records a payment *method* and never which account the money landed in; there are no expenses, no
receivable/payable, and therefore no net profit. That is what 35–39 close.

Deliberately declined, with reasons in the audit: the ERP's marketplace, EMI/instalments, investor
register and attendance/payroll. Also declined, because they break rules this codebase is built on:
typing `Stock QTY` on a product form (CLAUDE.md §3.2), setting sale price inside the goods-receipt
screen with no record of why, and the single-product-no-variants model.

Phases 33 and 34 were designed from external design input reviewed 2026-08-21 (the navbar specification
in `rangon_fashion_dynamic_navbar_design.md` and a read of the Dosti Shop codebase) and implemented
2026-08-21. The wider backlog drawn from that review — CSV import, media library, four-state variant
availability (now partly folded into the buy panel rewrite above), Quick View, Meta feed, and the rest —
is still open and tracked in
[planning/dostishop-feature-review.md](planning/dostishop-feature-review.md).

## Verification log

Everything below was executed on 2026-08-18 against commit `423cdf4`.

```text
migrations from empty database ........ OK (all 12 apps)
seed_demo --reset ..................... 12 products, 72 variants, 2 POs, 40 orders
ledger integrity (verify_inventory) ... consistent, 0 drift
pytest ................................ 172 passed (160 unit/service/API + 7 concurrency + 5 query budget)
ruff check + ruff format .............. clean
frontend typecheck (tsc --noEmit) ..... clean
vitest (npm run test) ................. 22 passed, 3 files (17 + 5 POS debounce)
production Next build ................. succeeds: `docker compose build web` completes, and CI
                                        runs `npm run build` on every push
storefront / admin / POS served ....... 21 routes checked from the Windows host:
                                        11 storefront 200, 10 admin/POS 307 -> /login (correct)
browser purchase journey .............. shop -> product -> add to cart -> checkout -> COD order
                                        RGN-WEB-000018, 2,450 + 70 = 2,520 BDT, timeline correct,
                                        cart emptied, ledger still consistent afterwards
live POS sale through the web proxy ... RGN-POS-000025 DELIVERED PAID (earlier session)
PRODUCTION STACK RUN LOCALLY ......... 2026-08-19: prod images (api 327MB, web 251MB), gunicorn +
                                        3 workers, DEBUG off, nginx single origin, Celery worker
                                        and beat. `scripts/smoke-test.sh` PASSED for the first time
                                        (7/7). Storefront, cart and add-to-cart verified in a browser.
                                        Page latency 12-70ms warm. Found D16 and D17 doing it.
production page latency ............... measured from the built image on the same machine and API:
                                        / 0.03s · /shop 0.29s · /checkout 0.012s · product 0.11s
                                        (the dev server is 10-80x slower and is not a fair measure)
API query counts after the N+1 sweep .. home 29 · listing 13 · purchase orders 15 · detail 13;
                                        every other list endpoint 4-7
```

Phases 33 (dynamic navigation) and 34 (colour-linked product media) were built and verified on
2026-08-21, against a working tree past `18e418b`:

```text
migrations (catalog 0002-0004, content 0001) .. applied clean, `makemigrations --check` clean
pytest ......................................... 220 passed (37 new: tests/api/test_navigation.py,
                                                  tests/api/test_product_media.py,
                                                  tests/api/test_search_suggest.py)
ruff check + ruff format ....................... clean
frontend eslint (npx eslint src) ............... clean
frontend typecheck (tsc --noEmit) .............. clean, twice (before and after the final fixes)
vitest .......................................... 22 passed, unchanged
browser walk, scripted Playwright container .... mcr.microsoft.com/playwright joined to the
                                                  compose network (the dev container itself cannot
                                                  run it, D7): desktop mega/dropdown menu opens and
                                                  navigates by mouse (hover+click) and by keyboard
                                                  (Tab/Enter) at 1280px; mobile drawer accordion at
                                                  375px; search suggest returns real products,
                                                  categories and a popular term; /category/men
                                                  renders breadcrumbs, subcategory chips, filters,
                                                  wishlist hearts; /shop?category=men 308s to
                                                  /category/men; product detail colour/capacity
                                                  selection and add-to-cart work
```

Two real bugs were caught and fixed by that browser walk, not by pytest or typecheck — worth recording
because they show why the walk matters:

1. `lib/navigation/navigation.ts` (server-only, imports `apiServer`/`next/headers`) was imported from
   the client component `primary-nav.tsx` for one pure helper (`resolveLayout`). Next's bundler correctly
   refused to build it. Fixed by splitting the helper into `lib/navigation/layout.ts`, which has no
   server-only import.
2. `NavigationMenu.Link asChild` around a `next/link` silently swallowed navigation on both mouse click
   and keyboard Enter — no console error, no failed request that Playwright's network listeners would
   catch by exception. Recorded in [navigation.md §7](architecture/navigation.md#a-radix-gotcha-worth-recording)
   with the fix (a plain `<Link>`, panel closed explicitly via controlled state).

Phase 35 (financial accounts and the cash book) was built and verified on 2026-08-22, on
`phase/35-finance-accounts`:

```text
migrations (finance 0001-0002, orders 0003, purchasing 0002) .. applied clean from the existing
                                                  database; `makemigrations --check` clean
pytest ......................................... 308 passed, up from 247 (61 new: 28 in
                                                  tests/test_finance.py, 29 in
                                                  tests/api/test_finance_admin.py, 4 threaded in
                                                  tests/test_concurrency.py)
ruff check + ruff format --check ............... clean (154 files)
frontend eslint (npx eslint src) ............... clean
frontend typecheck (tsc --noEmit) .............. clean, twice
vitest .......................................... 74 passed (5 new: ApiError.fieldErrors)
seed_demo --reset .............................. 12 products, 72 variants, 3 accounts opened
verify_accounts ................................ "Accounts are consistent with the cash book",
                                                  "Every money event names an account"
seeded cash book ............................... 30 rows — 27 SALE_PAYMENT + 3 OPENING — split by
                                                  method across the three accounts:
                                                  Counter Cash Drawer 65,450 · City Bank Current
                                                  515,780 · bKash Merchant 92,250
browser walk, signed in as owner ............... /admin/finance renders the cash position
                                                  (৳673,480 across 3), the accounts table and the
                                                  cash book with each row's reference and running
                                                  balance; a transfer of 25,000 drawer→bank wrote
                                                  ATR-000001 and two ledger rows with the total
                                                  unchanged; overdrawing the drawer was refused
                                                  with INSUFFICIENT_FUNDS and left both balances
                                                  untouched; /admin/finance/[id] filters by
                                                  movement type; the dashboard tiles follow the
                                                  transfer; the POS shows "Goes into Counter Cash
                                                  Drawer" for cash and "Goes into City Bank
                                                  Current" for card, and a split sale
                                                  RGN-POS-000025 (1,000 cash + 1,450 card) posted
                                                  each tender to its own account.
                                                  verify_accounts clean afterwards.
```

Two bugs were caught by that walk and by nothing else — the same lesson phases 33/34 recorded:

1. **`ApiError.fieldErrors()` rendered any business error's `details` as field errors.** Its docstring
   already said "from a VALIDATION_ERROR", but the code never checked the code. An
   `INSUFFICIENT_FUNDS` from the transfer form printed `e6622e4d-…`, `Counter Cash Drawer`,
   `65450.00`, `100000.00` as four separate field errors, each linked to a form field that does not
   exist, instead of the sentence the service wrote. This was **pre-existing and shared** — every
   admin form hit it for any non-validation error. Fixed in `lib/api/client.ts`, with five Vitest
   cases.
2. **The cash-book balance tile counted the filtered rows.** Filtering to "Transfers out" made an
   account with ten movements read "1 movement recorded" beside its unfiltered balance.

Two smaller polish fixes came from looking at it: `InsufficientFunds` now formats its figures
(`৳ 65,450.00`, not `65450.00`) because the message is shown verbatim on a money screen, and the
dashboard no longer labels the MFS tile `Mfs` via `humanise()`.

The concurrency cases are the ones worth naming, because they are the bugs a directly-written
`balance` column would have shipped with: six simultaneous sales into one drawer sum exactly (no lost
update); five concurrent withdrawals against a drawer that covers three succeed **exactly** three
times, the other two raising `INSUFFICIENT_FUNDS`; transfers in opposite directions between the same
pair of accounts do not deadlock; and a capture webhook replayed four times banks the money once.

Also fixed while reseeding: **`seed_demo --reset` has been broken since phase 33** made the category
tree nested. `Category.parent` is `PROTECT`, so `Category.objects.all().delete()` raised
`ProtectedError` on the top-level rows. It now deletes leaves first. This was pre-existing and
unrelated to phase 35 — it simply had not been run since.

### The backup was rehearsed the hard way, 2026-08-22

Not a drill. While updating the production stack for phase 35, the
`rangon-prod_postgres_data` volume was destroyed — along with every local image
except one, which is the signature of a `docker system prune -a --volumes` or a
`compose down -v`. The volume's `CreatedAt` timestamp (`22:58:00Z`) is 14 minutes
after the backup taken at `22:44:48Z`.

```text
before .......... 74 tables · 40 orders · 12 products · 6 users · 169 ledger rows
after the wipe .. 0 tables
pg_restore ...... exit 0
after restore ... 74 tables · 40 orders · 12 products · 6 users · 169 ledger rows
verify_inventory  consistent with the ledger
verify_accounts . consistent with the cash book
```

Three things this settles, and one it does not:

* **The dump format works.** `pg_dump -Fc` from the **db** container (never the
  api container — D14) restored cleanly with
  `pg_restore --no-owner --clean --if-exists`.
* **`backups/` is gitignored and lives on the host**, which is the only reason
  the file outlived the volume. A backup stored in a Docker volume would have
  gone with it.
* **Taking the backup before a deploy is not ceremony.** The 14-minute margin
  is the whole story.

What it does **not** settle: nothing is automated. No schedule, no off-machine
copy, no retention. A single host-local dump taken by hand is one disk failure
from being no backup at all. That remains open.

### CI is real now

`origin` is `github.com/IbrahimAllMamun/Rangon`. The workflow has run **14 times**; the most recent,
run #15 on `423cdf4`, is **green on all four jobs**:

| Job                 | Steps that passed                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Backend             | ruff check · ruff format --check ·`makemigrations --check` · mypy (non-blocking) · pytest incl. concurrency |
| Frontend            | `npm ci` · lint · typecheck · **`npm run build`**                                                    |
| Dependency audit    | `pip-audit` · `npm audit`                                                                                    |
| Build & scan images | API image · web image · Trivy HIGH/CRITICAL on both                                                             |

Runs #1–#13 failed or were cancelled while the workflow itself was being fixed (Trivy action version,
`NEXT_PUBLIC_SITE_URL`, requirements). Those were workflow bugs, now fixed — not product regressions.

**CI does not run the frontend tests.** Neither `npm run test` (Vitest) nor `npm run test:e2e`
(Playwright) appears in `ci.yml`. Vitest passes locally and takes seconds — it should be added.

Phase 05's admin product form, the review form (D2), the notification bell (D3) and the CSP nonce
(D16) were built and verified on 2026-08-21:

```text
pytest ......................................... 230 passed (10 new: tests/api/test_product_admin.py)
ruff check + ruff format ....................... clean
frontend typecheck (tsc --noEmit) .............. clean — and it fixed a PRE-EXISTING error: the
                                                 `Select` primitive had no `invalid` prop, which
                                                 `navigation-editor.tsx` was already passing
frontend eslint (npx eslint src) ............... clean
vitest .......................................... 39 passed (17 new: variant-matrix reconcile rules)
production Next build .......................... `docker compose build web` completes; the built
                                                 image contains .next/server/app/(admin)/admin/
                                                 products/new, products/[id] and notifications
CSP verified against the PRODUCTION image ...... Chromium (mcr.microsoft.com/playwright joined to
                                                 rangon-prod_frontend) against the prod stack on
                                                 nginx: exactly ONE Content-Security-Policy header,
                                                 carrying 'nonce-…' 'strict-dynamic' and NEITHER
                                                 'unsafe-inline' NOR 'unsafe-eval'. Six routes
                                                 (/ /shop /cart /wishlist /track /login) plus a
                                                 client-side navigation into a product page all
                                                 render real content — **0 CSP violations, 0 page
                                                 errors**. This is the exact configuration that used
                                                 to render a blank page.
browser walk, all 31 checks (dev stack) ....... apps/web/e2e/browser-walk.mjs: reviews section and
                                                 sign-in prompt for a guest; the review form and its
                                                 five-radio rating for a signed-in shopper; the
                                                 notification bell ("Notifications, 17 unread"), its
                                                 panel and the feed page with its unread filter;
                                                 then the product form end to end — 6 attribute
                                                 groups, 32 tickable values, a 2-row matrix, create,
                                                 redirect to the edit screen, photography section,
                                                 read-only stock with an Adjust action, and publish
                                                 flipping the state to live
```

The dev stack shows two CSP violations the production build does not: Turbopack's own chunk loader
emits a script tag without a nonce, which `'strict-dynamic'` then refuses. Production nonces every
preload link (verified in the served HTML), which is why the count there is zero. The middleware also
adds `'unsafe-eval'` only when `NODE_ENV !== "production"`, because the dev server compiles with
`eval()`.

### Phase 36 verified, 2026-08-27

Executed against a real stack (PostgreSQL 16, Django dev server, `next dev`), seeded with
`seed_demo --reset`:

```text
pytest ................................ 365 passed (was 308 before this phase; +57)
ruff check + ruff format .............. clean
tsc --noEmit .......................... clean
next lint ............................. clean
vitest ................................ 79 passed, 6 files
migrations from the existing database . OK (core 0003, finance 0003 + 0004)
makemigrations --check ................ no changes detected
seed_demo --reset ..................... OK, 9 demo expenses, 12 products, 72 variants
verify_accounts ....................... consistent; every money event names an account
verify_inventory ...................... consistent, 0 drift
browser walk-through .................. signed in as owner at /admin/expenses:
                                        recorded 850.50 -> drawer 65,450.00 fell to 64,599.50,
                                        voided it -> drawer back to 65,450.00 exactly,
                                        overspend refused with the server's own message,
                                        focus moved to the error summary
Playwright ............................ RAN. See below — D7 is environment-specific, not a code defect
```

**Playwright ran for the first time.** On a Linux host with a Chromium already present, the suite
executes: 17 tests (12 desktop + 5 mobile), and every one of them passes **in isolation**. Running
them all sequentially is a different matter — see [D18](#known-defects). Three real bugs in the
specs themselves were found by executing them, and are fixed:

- the shared `signIn()` helper matched two `Sign in` buttons (the login form's, and the storefront
  header's account menu), failing Playwright strict mode on **every** signed-in test;
- the dashboard spec matched two `Revenue` elements (a KPI tile and a table column header);
- the `mobile` project's `testIgnore: /pos|admin/` matched **file paths**, and all the flows live in
  one file, so it never excluded anything — POS and Admin were being run at a phone viewport they
  are explicitly not designed for (CLAUDE.md §10). Now an explicit `@desktop-only` tag.

`PW_CHROMIUM_PATH` was added to `playwright.config.ts` so an environment that already ships a
Chromium can point at it instead of downloading one.

### Phase 39 (part) verified, 2026-08-27

```text
pytest ................................ 385 passed (365 before; +20)
ruff check + ruff format .............. clean
tsc --noEmit / next lint .............. clean
vitest ................................ 79 passed
verify_inventory ...................... consistent after 2 write-offs, a count and 2 transfers
verify_accounts ....................... consistent
Playwright ............................ 2 new specs, passing
browser walk-through .................. write-off 10 -> 8 on the named SKU; count sheet snapshotted
                                        72 lines, variance computed live, saving moved no stock,
                                        applying wrote the adjustment (8 -> 5); transfer moved 3
                                        units DHK1 -> DHK2 with none invented on either side
```

**The roadmap was wrong about stock counts.** This row said "the apply flow exists — form work
only". In fact `counted_quantity` was exposed through a `read_only=True` nested serializer and
written by nothing, so `apply` — which filters on `counted_quantity__isnull=False` — matched zero
rows every time. There were also **no tests for stock counts at all**, at any level, which is why it
went unnoticed. Recorded as [D22](#known-defects).

Two smaller things found by running it: the endpoints doc had `inventory/transfers/` and
`inventory/counts/` when the real routes are top-level `/stock-transfers/` and `/stock-counts/`; and
the inventory table never rendered `branch_code`, so once a transfer existed the same SKU appeared
twice with nothing to tell the rows apart.

## Still unproven

Do not describe any of these as working.

| Area                                    | State                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playwright (`npm run test:e2e`) | **Now proven to run** — 17 tests, all passing individually, 2026-08-27. A full sequential run is still flaky ([D18](#known-defects)). `apps/web/Dockerfile.dev` is still alpine, so [D7](#known-defects) stands *for the dev container* |
| Vitest and Playwright in CI             | Neither is wired into`ci.yml`                                                                                                                   |
| Admin**write** screens, signed in | The organization and branch editors exist in code and the routes correctly redirect anonymous users, but no signed-in click-through has been done |
| Payment gateway                         | No live provider; the card option is visibly**disabled**, not faked                                                                         |
| ~~Backup restore~~                       | **Proven 2026-08-22, under real conditions** — a `pg_dump -Fc` taken 14 minutes earlier was the only surviving copy of the production database after its volume was destroyed, and `pg_restore` brought back all 74 tables, 40 orders, 12 products, 6 users and 169 ledger rows |
| Load / performance                      | Query budgets documented in`docs/database/indexing.md` but **not asserted in tests**; no load test                                        |
| Security                                | Controls implemented, audits and image scans automated;**no independent penetration test**                                                  |
| Deployment                              | Compose prod stack + green CI;**no live environment** — nothing has ever been deployed                                                     |

## Known defects

Found by diagnosis on 2026-08-18. None is a data-integrity or money bug; all are user-visible or
process gaps. D1, D2, D3, D5, D10, D11, D12, D13, D16 and D17 have since been fixed and are struck through.
**D16 no longer blocks deployment** — the CSP is nonce-based and verified against the production build.

| #        | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                 | Impact                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~D1~~  | ~~**Wishlist cannot be filled.**~~ **Fixed 2026-08-21** — `WishlistHeart` on the product card calls `POST`/`DELETE /shop/wishlist/`; a shared `useWishlist` Zustand store backs it, the header count, and `/wishlist`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `apps/web/src/components/commerce/wishlist-heart.tsx`, `apps/web/src/lib/store/wishlist.ts`       | —                                                                                                                                              |
| ~~D2~~  | ~~**Reviews cannot be written.**~~ **Fixed 2026-08-21** — the reviews section now renders unconditionally (hiding it at zero reviews made the form unreachable) and carries `ReviewForm`: a five-radio star group, headline and comment, posting to `POST /shop/products/{slug}/reviews/`. Eligibility stays on the server — the form submits and shows what the API says, rather than re-implementing the verified-purchase rule                                                                                                                                                                                                                                                                                                      | `apps/web/src/components/commerce/review-form.tsx`                                                  | —                                                                                                                                              |
| ~~D3~~  | ~~**Notifications have no UI.**~~ **Fixed 2026-08-21** — a bell in the admin header polls `GET /notifications/count/` every 60s (only while the tab is visible), opens a panel of the eight most recent, and links to `/admin/notifications` with all/unread filtering, per-item and bulk mark-as-read                                                                                                                                                                                                                                                                                                                                                                                                                                  | `apps/web/src/components/admin/notification-bell.tsx`, `app/(admin)/admin/notifications/page.tsx` | —                                                                                                                                              |
| D4       | **The brand appears twice in product titles.** `seed_demo` writes `seo_title = "<name> \| Rangon Fashion"` while the root layout applies `template: "%s \| Rangon Fashion"`, producing `Classic Oxford Shirt \| Rangon Fashion \| Rangon Fashion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `apps/api/core/management/commands/seed_demo.py:475` and `apps/web/src/app/layout.tsx:22`         | Any product with an`seo_title` gets a doubled suffix in the tab, the OG card and search results                                               |
| ~~D5~~  | ~~**The cart drawer dialog has no description.**~~ **Fixed 2026-08-18** — `Dialog.Description` added; the drawer now renders `aria-describedby`, verified in the browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/web/src/components/commerce/cart-drawer.tsx`                                                  | —                                                                                                                                              |
| D6       | **mypy reports 98 errors in 29 files.** CI runs it with a trailing `                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                       | echo ":⚠️:"`, so it never blocks. 60 are `arg-type`, mostly DRF's `request.user`typed`User \| AnonymousUser`where services want`User` |
| D7       | **Playwright cannot run in the dev container.** `apps/web/Dockerfile.dev` is `node:22-alpine`; Playwright ships no musl browser builds, and none are installed (`~/.cache/ms-playwright` is absent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `apps/web/Dockerfile.dev`                                                                           | Phase 29 is blocked until E2E runs on a glibc image (`mcr.microsoft.com/playwright`) or on the host                                           |
| ~~D21~~ | ~~**The image scan went red on a base-image CVE.**~~ **Fixed 2026-08-27** — `node:22-alpine` shipped openssl `3.5.7-r0` while Alpine 3.24 already carried the `3.5.8-r0` fix for CVE-2026-14456, so `Build & scan images` failed on every branch through no fault of any diff. The runtime stage now runs `apk upgrade --no-cache`, which is safe to do unconditionally because the gate sets `ignore-unfixed: true` — it only ever fails on a CVE whose fix is already published. Without this, the scan stays red until upstream rebuilds the base image |
| ~~D19~~ | ~~**CSV export 404'd on every report.**~~ **Fixed 2026-08-27** — `?format=csv` is DRF's format-negotiation parameter, and no renderer advertised `csv`, so all eight report endpoints answered 404 and the download links on `/admin/reports` had never worked. A `CSVRenderer` on `BaseReportView` fixes all of them |
| ~~D20~~ | ~~**Computed money left the API as JSON floats.**~~ **Fixed 2026-08-27** — `accounts/cash-position/` returned `661480.0` rather than `"661480.00"`, because it responds with plain selector dicts and DRF encodes `Decimal` as a number. CLAUDE.md §4 forbids float for money, and `CashPosition` in the web app's `types.ts` already declared these as strings. Now serialized through `DecimalField` |
| ~~D22~~ | ~~**A stock count could never be counted.**~~ **Fixed 2026-08-27** — `counted_quantity` was write-protected by a `read_only=True` nested serializer and set by nothing, so `apply` adjusted nothing and silently marked the sheet APPLIED. No test covered stock counts at any level. Added `record/` and `cancel/`, made `apply/` refuse an empty or non-COUNTING sheet, and wrote the first 20 tests the feature has had |
| D18      | **The E2E suite is order-coupled.** All 17 specs pass individually, but each full sequential run fails a *different* one — storefront checkout, a POS sale, an accessibility check. The config already says "these flows share one seeded database"; they also mutate it, and nothing resets between tests. Fixing it is phase 29 work: either reseed per describe-block or make each flow pick its own fixture. Found 2026-08-27, the first time the suite was ever executed |
| D8       | **Dev and prod web images share one tag.** Neither compose file sets `image:`, so `docker compose build web` (production `Dockerfile`) and the dev overlay (`Dockerfile.dev`) both produce `rangon-web:latest`. The production runtime deliberately deletes npm, so a later `up -d` without `--build` would start it with `npm run dev` and fail                                                                                                                                                                                                                                                                                                                                                                              | `docker-compose.yml`, `docker-compose.dev.yml`                                                    | A confusing, self-inflicted breakage after any production build. Also recorded in`.claude/environment.md`                                     |
| D9       | **Seed data has no product images.** Every storefront card and product page renders the "no image available" placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `seed_demo`                                                                                         | The photography-led storefront of`CLAUDE.md` §10 cannot actually be judged                                                                   |
| ~~D16~~ | ~~**The production CSP renders a blank page.**~~ **Fixed 2026-08-21** — `apps/web/src/middleware.ts` mints a per-request nonce and sends the policy itself; Next stamps that nonce onto every script it emits (42 of 42 in the production build), so `script-src` is `'self' 'nonce-…' 'strict-dynamic'` with **no** `unsafe-inline` and **no** `unsafe-eval`. Both nginx configs had their `add_header Content-Security-Policy` **removed** — `add_header` appends, and a browser enforces the intersection of every policy it receives, so a second header would have re-broken hydration. Verified in Chromium against the production image: home page hydrates, 19 product cards, zero CSP violations | `apps/web/src/middleware.ts`, `infrastructure/docker/nginx/**`                                    | —                                                                                                                                              |
| ~~D17~~ | ~~**Nginx sent `/api/proxy/*` and `/api/auth/*` to Django.**~~ **Fixed 2026-08-19** — those prefixes are Next.js route handlers (`/api/proxy/*` attaches the httpOnly token, `/api/auth/*` sets it at login), but the config routed all of `/api/` to the API, so they 404'd. Pages rendered while **every interactive feature was dead**: sign-in, cart, checkout, POS sales, admin actions. Caught by clicking "Add to cart" against the production build                                                                                                                                                                                                                                                                 | `infrastructure/docker/nginx/conf.d/rangon.conf`, `docs/operations/webuzo-deployment.md`          | Would have made the first real deployment look completely broken                                                                                |
| D14      | **`backup-db.sh` cannot run in the API container.** The API image ships `pg_dump` 15.19 against a PostgreSQL 16.15 server, which aborts with a version mismatch; the script also resolves the Docker-network host `db`. Verified 2026-08-18: it works from the `db` container (398 KB dump). Documented in [backups.md](operations/backups.md), not yet fixed in the image                                                                                                                                                                                                                                                                                                                                                             | `apps/api/Dockerfile`, `scripts/backup-db.sh`                                                     | The backup runbook names a container where it cannot work — and no backup has ever been taken                                                  |
| D15      | **Production Nginx config would not start.** `infrastructure/docker/nginx/conf.d/rangon.conf` uses `${RANGON_DOMAIN}` in `server_name` and the TLS certificate paths, but Nginx does not expand environment variables in config files and the file is mounted straight into `conf.d/` rather than `templates/`. Also, the `api_static` volume it serves `/static/` from is never populated by any service                                                                                                                                                                                                                                                                                                                       | `infrastructure/docker/nginx/`                                                                      | First deploy using the shipped prod stack fails to start. Sidestepped by the Webuzo topology, which drops that container                        |
| ~~D10~~ | ~~**N+1s on the three busiest list endpoints.**~~ **Fixed 2026-08-18** — `GET /shop/home/` **511 queries / 2.42 s**, `GET /shop/products/` **363 / 1.29 s**, `GET /purchase-orders/` **156 / 0.58 s**. Common cause: `ProductVariant.label` is a property that joins attribute values, so any serialiser rendering a variant label costs a query per row unless the queryset prefetches that far. Now **29**, **13** and **15**, guarded by growth-based tests                                                                                                                                                                                                                                  | `orders/api/shop_views.py`, `purchasing/api/views.py`                                             | Was the single largest source of slow page loads                                                                                                |
| ~~D12~~ | ~~**POS searched on every keystroke.**~~ **Fixed 2026-08-18** — the scan field fired `/pos/products/?q=` per character with no debounce. A keyboard-wedge scanner types a 13-character barcode in ~100 ms, so **one scan issued 13 parallel requests** at ~700 ms each; six saturated the browser's per-origin connection limit and the `lookup` that Enter fires queued behind them. Now debounced at 220 ms with request cancellation, so a scan issues **none**. Five Vitest cases cover it                                                                                                                                                                                                                              | `apps/web/src/components/pos/register.tsx`                                                          | The register appeared to freeze on every scan — the most severe user-facing defect found                                                       |
| ~~D13~~ | ~~**Admin product list paginated without ordering.**~~ **Fixed 2026-08-18** — Django warned `UnorderedObjectListWarning`; PostgreSQL may return unordered rows in any order, so page 2 could repeat or skip products page 1 already showed. Now `-created_at, pk`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/api/catalog/api/views.py`                                                                     | Correctness, not just speed                                                                                                                     |
| ~~D11~~ | ~~**Dev container ran a different Next than CI.**~~ **Fixed 2026-08-18** — `/app/node_modules` is an anonymous volume, so it kept a pre-upgrade install (15.1.4) while the lockfile, image and CI were all on 15.5.23; image rebuilds could not dislodge it. Recorded in [.claude/environment.md](../.claude/environment.md) §7                                                                                                                                                                                                                                                                                                                                                                                                           | `docker-compose.dev.yml`                                                                            | Local behaviour diverged from CI with no signal                                                                                                 |

## Still API-only (no UI)

Every endpoint below exists and is tested. What is missing is the screen.

- customer create/edit, addresses, notes
- return approve / reject / receive / complete
- coupon management, review moderation
- shipping zones, methods, shipments
- categories, brands, attributes
- users and roles

Recently built, so no longer on this list: **damage/write-off, stock counts and stock transfers** —
a write-off panel on `/admin/inventory`, plus `/admin/inventory/transfers` and
`/admin/inventory/counts`; **expenses** — `/admin/expenses`, with a period filter,
category-wise totals, receipt upload, CSV and a void flow; **financial accounts and the cash book** —
`/admin/finance` and `/admin/finance/[id]`, with account create/edit, transfers, manual cash-book
entries, a cash position on the dashboard, a per-tender account in the POS and account pickers on COD
capture and refunds; **organization settings and branch create/edit**
(`/admin/settings`); **product create/edit, variant-matrix generation, publish/unpublish and
per-colour image upload** (`/admin/products/new`, `/admin/products/[id]`); **stock adjustment**, which
the product form can now write per variant (the standalone inventory screen is still read-only); the
**notification feed** (`/admin/notifications`); and **purchase orders and suppliers** — create, send,
cancel, partial receive and supplier create/edit (`/admin/purchases/new`, `/admin/purchases/[id]`,
`/admin/suppliers`).

## Gaps to close before go-live

1. **Payment gateway.** Implement a real provider against
   `orders.payments.providers.base.PaymentProvider`, with signature verification and webhook replay
   tests. COD works today; the card option is visibly disabled rather than pretending to work.
2. **The remaining admin *write* screens.** Products and purchasing are done. Still API-only:
   customers, coupons, return approvals, shipping, and users/roles. The endpoints are complete and
   tested — this is form work, not backend work, and `product-form.tsx` and `purchase-order-form.tsx`
   are the patterns to copy.
3. **Unblock and run E2E** (D7), then wire **both** Vitest and Playwright into `ci.yml`.
4. ~~**Restore rehearsal.**~~ Done 2026-08-22, for real (see the verification log). What is
   still missing is **automation**: the dump that saved the database was taken by hand, stored only
   on this machine, on no schedule and with no retention. Schedule it, copy it off the host, and
   keep the restore drill.
5. **Load test** product listing, checkout and POS search at expected peak; add the
   `assertNumQueries` budgets from `docs/database/indexing.md` as real tests.
6. **Make mypy mean something** (D6) — fix the errors or annotate them deliberately, then drop the
   `|| echo` and let the step block.
7. **Independent security review.**
8. **SMS provider** for order notifications.
9. **Favicon raster + OG image** from the official symbol (the SVG favicon is wired), and real
   product photography for the seed (D9).
10. **Eleven owner decisions** are still open — `docs/business-rules.md` carries 11 `DECISION REQUIRED`
    markers (nine from the original build, plus D-A credit sales and D-B chart-of-accounts from the
    Bseba audit), and on top of those the payment-gateway and courier choices. VAT must be settled
    before the first real sale, because changing it rewrites every historical total — and it now also
    blocks phase 38.

## Decisions owed for phases 35–39

The money layer cannot be designed around an unanswered question, so these four are recorded here as
well as in [business-rules.md](business-rules.md). Each changes the shape of the code, not just the
schedule.

| #   | Decision                                                                     | Blocks                                              | Default if unanswered                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-A | **Does the business sell on credit?**                                  | Phase 37 entirely, and how orders relate to payment | Assume no. 35 is built; 36 is next.**Still owed** — it decides whether 37 happens at all                                                                                                  |
| D-B | ~~**A flat list of cash/bank/MFS accounts, or a real chart of accounts?**~~ | ~~Phase 35's schema~~                              | **Built on the default: a flat list**, 2026-08-22. Changing to a chart of accounts is now a migration, not a choice — see [ADR-0011](architecture/decisions/0011-append-only-cash-book.md) |
| D-C | **VAT: inclusive or exclusive, and at what rate?**                     | Phase 38**outright**                          | Already exclusive at 0%. Net profit cannot be computed until this is settled, and settling it later rewrites every historical total                                                              |
| D-D | **Build EMI, investors, marketplace or attendance at all?**            | Nothing — they are declined                        | No. See the audit for why each is a different product                                                                                                                                            |

D-C is the same VAT decision the go-live list has carried since 2026-08-18. It has now grown a second
consequence: it no longer only blocks the first real sale, it blocks the report the owner manages by.

## Suggested next task

Phase 36 shipped 2026-08-27; the three inventory screens of phase 39 shipped the same day.

**Return approve / reject / receive / refund.** Now the largest remaining "API-only" item, and the
one a shop hits weekly. Four actions on a list that already renders at `/admin/returns`. About an
afternoon, and `expense-forms.tsx` is the pattern for the reason-gated confirmations.

**Customers and coupons** are the other two write-screen gaps. Both are ordinary form work against
tested endpoints — but check first whether they have a write path at all, because phase 39 taught us
the roadmap's "form work only" is not always true.

**Phase 38 is one decision away.** Expenses were the missing input; the only remaining blocker is
**D-C, the VAT decision**. `finance.selectors.expense_totals()` was written to be the shape
`business_summary()` subtracts, so once VAT is settled 38 is mostly assembly. Getting D-C answered
is still the highest-value non-code action on this list.

**D18 — make the E2E suite survive a full run.** It executes now and every spec passes alone; the
flows share and mutate one seeded database. Reseed per describe-block, or give each flow its own
fixture. That plus wiring Vitest and Playwright into `ci.yml` closes phase 29.

**The rest of phase 39** — quotation, cheque register, barcode label sheets — is genuinely new
building rather than screens over existing services, so it is a bigger piece than the three that
just shipped.

The heavier follow-up is still the **payment gateway**: nothing prepaid can be sold until one
exists, and a gateway's settled takings need a `BANK` account to land in.

**Worth doing once, soon:** run `manage.py verify_accounts` against real data on first deploy. Any
payment taken before phase 35 carries no account, and that count is the size of the permanent gap.
