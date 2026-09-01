# Roadmap & Status

Phase order follows §85 of the build plan. **Do not reorder casually** — the storefront must not be
built before the product/variant/inventory/order architecture is stable.

Legend: ✅ done and verified · 🟡 partial (gap stated) · ⬜ not started

**Verified** means it was actually executed. The evidence, and the date it was produced, is in
[§ Verification log](#verification-log). Anything not in that log is written but unproven — see
[§ Still unproven](#still-unproven) and say so rather than implying otherwise.

Last updated: **2026-08-31**. Phases 37 and 38 shipped that day, VAT became an editable setting,
the last two API-only areas got their screens, and the E2E suite went into CI. The evidence for all
of it is the 2026-08-31 entry in the verification log.

**All 39 phases are now ✅ or deliberately V2.** What is left is not building: a payment gateway,
two defects that keep E2E off a production build, one owner decision, and a deployment.

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
| 10  | Returns                               | ✅      | ✅       | Full request→approve→receive→restock→refund + POS one-step return. **Admin screens shipped 2026-08-27** — `/admin/returns/[id]` drives approve / reject / receive / refund, with the per-line restock decision made at receipt and an account picker on the refund |
| 11  | Customers                             | ✅      | ✅       | Phone-first identity, addresses, notes, history. **Admin create/edit shipped 2026-08-28** — `/admin/customers/new` and `/admin/customers/[id]`: profile, addresses with a managed default, notes and order history. The endpoint audit that preceded it found four defects — see D24–D27 |
| 12  | Online store                          | ✅      | ✅       | Home, shop, product, cart, checkout, order tracking, account, policies. Browser journey verified end to end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 13  | Search + filters                      | ✅      | ✅       | Postgres trigram + indexed facets; facet UI with colour swatches; navbar type-ahead suggest (products / categories / popular searches) backed by a`SearchTerm` log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | Cart                                  | ✅      | ✅       | Server-authoritative, re-priced on every read, drawer + full page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 15  | Checkout                              | ✅      | ✅       | Idempotency keys, reservation, COD, server-side totals, error summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 16  | Online payments                       | 🟡      | 🟡       | Abstraction + COD complete.**No live gateway** — the card option is disabled in the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 17  | Orders                                | ✅      | ✅       | Status machine, timeline, admin list + detail with status changes, payment capture, refunds, printable A4 invoice and packing slip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 18  | Shipping                              | ✅      | ✅       | Zones, methods, shipments, courier-ready interface. Checkout picks a method. **Admin screens shipped 2026-08-28** — `/admin/shipping`: zones with nested methods, couriers, and a warning when no fallback zone exists. The endpoint audit found four defects — D32–D35 |
| 19  | Coupons                               | ✅      | ✅       | Full engine + API; cart can apply/remove. **Admin screens shipped 2026-08-28** — `/admin/coupons`, with a type-aware form and a state column that separates live from scheduled, expired and used up. The endpoint audit found a money race and three validation gaps — D28–D31 |
| 20  | Wishlist + reviews                    | ✅      | ✅       | **Wishlist fixed 2026-08-21** — a heart control on the product card (`WishlistHeart`, top-right of the image, optimistic toggle) and a shared `useWishlist` store back the header count and `/wishlist`. **Reviews fixed 2026-08-21** — the section always renders and carries a star-rating form (`ReviewForm`) posting to `POST /shop/products/{slug}/reviews/`. D1 and D2 struck through below **Moderation screen shipped 2026-08-28** — `/admin/reviews` with a status filter, approve/reject and a moderator note. The endpoint audit found three defects — D36–D38 |
| 21  | Dashboard                             | ✅      | ✅       | Server-aggregated KPIs, sales chart with a table alternative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 22  | Reports                               | ✅      | ✅       | 8 report endpoints + CSV export, with a reports screen (product performance + CSV download for all seven)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 23  | Offline POS                           | ⬜      | ⬜       | Deliberately V2 (plan §29). Design recorded in`architecture/offline-pos.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 24  | Barcode + printing                    | 🟡      | 🟡       | Keyboard-wedge scanning + barcode generation work; print CSS for 80 mm receipt and A4. No ESC/POS driver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 25  | Notifications                         | 🟡      | ✅       | Model, in-app feed API, Celery email tasks.**UI shipped 2026-08-21** — a polling bell in the admin header and `/admin/notifications` with all/unread filtering and mark-as-read. Still no SMS provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 26  | SEO                                   | 🟡      | 🟡       | Metadata, OG, sitemap, robots, canonicals, JSON-LD product + breadcrumbs. Product titles render the brand twice —[D4](#known-defects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 27  | Security                              | 🟡      | 🟡       | Controls implemented and documented; CI runs`pip-audit` + `npm audit` and Trivy-scans both images. CSP is now nonce-based and sent by the app itself (D16 fixed). **No independent penetration test**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 28  | Performance                           | 🟡      | 🟡       | Every list endpoint swept: three N+1s fixed (home 511→29, listing 363→13, purchase orders 156→15) plus a per-keystroke POS request storm; all guarded by growth tests. Production measured at 11–320 ms per page. Remaining: five documented budgets unasserted, product detail**exceeds** its documented 10, no load test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 29  | E2E testing                           | ✅      | ✅       | Playwright drives the four critical flows. **20/20 green** against `next dev`, reseeded, 2026-08-31 — and **now a CI job**. Against a production build 18/20 pass; the two that do not are [D40](#known-defects) and [D41](#known-defects), which is why the CI job runs against dev |
| 30  | Deployment                            | 🟡      | 🟡       | Compose prod stack;**CI now runs and is green at `HEAD`**, including the production build and image scans. Still **no live environment**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 31  | Backup/recovery                       | ✅      | —       | Scripts + runbook written, and **the restore has now been rehearsed for real** — 2026-08-22, against a production database that was actually destroyed. See the verification log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 32  | Production launch                     | ⬜      | ⬜       | Blocked on`docs/operations/go-live-checklist.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 33  | Dynamic navigation                    | ✅      | ✅       | Category-driven navbar with a one-table override,`/category/[...slug]` URLs (with a 308 redirect from the old `/shop?category=`), announcement bar, search suggest, admin editors for navigation overrides and banners. Phases N0–N6 done — [architecture/navigation.md](architecture/navigation.md#7-phases); decisions in [ADR-0009](architecture/decisions/0009-category-driven-navigation.md) and [ADR-0010](architecture/decisions/0010-radix-navigation-menu.md). Category reorder + icon (a category-scoped admin screen) not built — see navigation.md §7 N5                                                                                                                                                                                                                                                 |
| 34  | Colour-linked product media           | ✅      | ✅       | Images bind to a colour`AttributeValue` rather than a variant; selecting a colour moves the gallery without hiding any image; clicking another colour's thumbnail repairs the other axes. Phases B1–B3 all done — **B3 landed 2026-08-21** with the admin product form it was blocked on — [architecture/product-media.md](architecture/product-media.md#6-phases)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 35  | Financial accounts + cash book        | ✅      | ✅       | **F1 shipped 2026-08-22.** `finance` app: `Account` (cash/bank/MFS, per branch), append-only `AccountTransaction`, `AccountTransfer`. Balance is a reconciled cache with a `verify_accounts` command, exactly as `Inventory.on_hand` sits over `InventoryTransaction`; an opening balance is an `OPENING` row, not a column. Sales, refunds and supplier payments post inside their service's atomic block — **on capture, never on record**. `/admin/finance` (cash position, accounts, cash book, transfers, manual entries), per-tender account in the POS, account pickers on COD capture and refunds. 61 new tests incl. 4 threaded. [architecture/finance.md](architecture/finance.md) · [ADR-0011](architecture/decisions/0011-append-only-cash-book.md). **Unblocks 36–39**  |
| 36  | Expenses                              | ✅      | ✅       | **F2 shipped 2026-08-27.** `ExpenseCategory` + `Expense` posted through `finance.services.record_expense()` — document and `EXPENSE` cash-book movement in one transaction, so neither can exist without the other. Voiding posts a compensating `ADJUSTMENT`; nothing is deleted. `/admin/expenses` with a period filter, spend tiles, category-wise split, receipt upload and CSV. Nine categories seeded by migration. New permission `finance.expense` (owner/admin/manager/accountant, **not** cashier). 57 tests |
| 37  | Party ledger — receivable / payable  | ✅      | ✅       | **F3 shipped 2026-08-31.** `finance.selectors.party_ledger`, `GET /party-ledger/` and `/admin/finance/parties`: both sides derived from orders and purchase orders, ageing buckets, a net position, and every party expandable to the documents behind its balance. **No balance column on `Customer` or `Supplier`** — a stored balance drifts from the documents it summarises. Needed no answer to D-A: a credit sale is already an order with a balance |
| 38  | Business report → net profit         | ✅      | ✅       | **F4 shipped 2026-08-31**, unblocked by settling VAT. `reports.services.business_summary`, `GET /reports/business-summary/` and `/admin/reports/business`: revenue net of VAT, less refunds, less COGS plus the cost recovered from restocked returns, less expenses, to net profit — with a CSV of the statement |
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

### Returns verified, 2026-08-27

```text
pytest ................................ 405 passed (385 before; +20)
ruff / tsc / next lint / vitest ....... clean
verify_inventory / verify_accounts .... consistent
Playwright ............................ 1 new spec, passing
browser walk-through .................. RET-000001 rejected-without-a-reason refused, approved,
                                        received as DAMAGED with a condition note (stock stayed at
                                        18 — a damaged line never returns to sellable), refunded
                                        2,790.00 into a named account, and the REFUND movement
                                        appeared in the cash book
```

**Two gaps closed before the screen was built**, both found by checking the endpoints against the
documented behaviour rather than trusting the "form work only" label:

- The **restock decision could not be made at receipt**, though §2.1 puts it there. It was settable
  only at request time, so a screen would have asked "restock or damaged?" before anyone saw the
  item. `receive/` now takes per-line decisions.
- A **return refund could not name its account**, though an order refund could — and a return is
  exactly the case where which drawer the cash leaves matters.

Also fixed: `seed_demo --reset` died with `ProtectedError` whenever a stock count or transfer
existed, which phase 39 made ordinary. Recorded as [D23](#known-defects), with a regression test that
fails without the fix.

### Customer screens verified, 2026-08-28

Run on a Linux container without Docker — PostgreSQL 16 and the venv were built directly, so the
`docker compose` commands in the README were **not** the ones executed. What ran:

```text
pytest ................................ 427 passed (405 before; +22)
ruff check + ruff format .............. clean
tsc --noEmit .......................... clean
next lint ............................. clean
vitest ................................ 79 passed, 6 files
next build ............................ passes
```

**Four defects were found before a line of UI was written**, by checking the endpoints against the
documented behaviour. All four are proven: reverting the source with the new tests in place fails
**12 of the 22**, and each failure names its defect.

- [D24](#known-defects) — `customers.view` could write an address or a note. An `ACCOUNTANT` holds
  that code deliberately *without* update, and could still write. The action served GET and POST
  under one permission list.
- [D25](#known-defects) — addresses could be created but never edited or deleted. The storefront had
  full CRUD; the admin surface did not, so the edit screen had no endpoints to call.
- [D26](#known-defects) — nothing demoted the previous default address, on either surface. Checkout
  pre-fills from `addresses.first()` under `("-is_default", "-created_at")`, so with two defaults the
  pre-filled delivery address was arbitrary.
- [D27](#known-defects) — an edit could clear both phone and email, producing the unfindable customer
  phone-first identity exists to prevent.

D26 is the one that reached a customer: it is the storefront's own account page, and the wrong
address could have been pre-filled at checkout. Both surfaces now go through `customers.services`,
which holds the invariant under `select_for_update`.

~~**Not verified:** no signed-in browser click-through.~~ **Verified 2026-08-28** — see
[§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### Coupon screens verified, 2026-08-28

Same environment caveat as the customer pass: no Docker daemon, so PostgreSQL 16 and the venv were
built directly and the README's `docker compose` commands were **not** what ran.

```text
pytest ................................ 445 passed (428 before; +17)
ruff check + ruff format .............. clean
tsc --noEmit / next lint / next build . clean
vitest ................................ 79 passed, 6 files
makemigrations --check ................ one new migration, promotions/0002
```

**The audit found a money bug this time**, not just validation gaps — [D28](#known-defects). A coupon
limited to one use per customer could be redeemed twice by placing two orders concurrently:
`redeem()` holds the coupon row lock and re-checks the *total* limit, but the *per-customer* limit was
only ever checked in `validate_coupon`, which runs while the cart is priced — before the lock exists.
Both checkouts passed validation, both redeemed, no refusal.

It is proven rather than argued: `tests/test_concurrency.py` gained
`test_one_customer_cannot_spend_a_one_per_customer_coupon_twice`, which against the old code reports
*"a one-per-customer coupon was redeemed 2 times … refusals: []"*. The fix re-reads the per-customer
count inside the lock `redeem()` already takes, so the existing serialisation does the work.

`usage_limit_per_customer` defaults to **1**. The default configuration was the exposed one.

Three smaller gaps came from the same instance-blind validation as [D27](#known-defects): an edit
checked its payload rather than the resulting coupon ([D29](#known-defects), [D30](#known-defects)),
and free shipping was forced to carry a meaningless amount ([D31](#known-defects)).

~~**Not verified.**~~ **Verified 2026-08-28** — see [§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### Shipping screens verified, 2026-08-28

Same environment caveat: no Docker, so PostgreSQL 16 and the venv were built directly.

```text
pytest ................................ 464 passed (445 before; +19)
ruff check + ruff format .............. clean
tsc --noEmit / next lint / next build . clean
vitest ................................ 79 passed, 6 files
migration repair rehearsed ............ against a probe database holding the bad rows
```

**Shipping had no section in `business-rules.md` at all.** That is the finding behind the other four:
an area nobody wrote down is an area nobody checks, and it was the only area of the system with
neither documented rules nor a single API test. §8a now states the rules, reconstructed from the code
and asserted in `tests/api/test_shipping_admin.py`.

The money one is [D32](#known-defects): `free_over` accepted a negative number, and `price_for()`
returns 0 whenever `subtotal >= free_over` — so one mistyped minus sign makes **every order ship
free**, quietly, forever. [D33](#known-defects) is the durable one: `events` never used the serializer
that already existed, so `status: "BANANA"` was stored with a 201 into an append-only log, and because
that status drives `PACKED → SHIPPED → DELIVERED` the order also stopped progressing.

Unlike the previous migrations, `shipping/0002` **tightens** two constraints, so a database written
before today may hold rows that violate them and `AddConstraint` would fail outright. It repairs
first — clearing a negative `free_over` to NULL, widening a backwards `max_days` — and prints what it
changed rather than doing it silently. **Rehearsed rather than assumed:** a probe database was
migrated to `0001`, seeded with exactly the two bad rows the old API allowed, and migrated forward.
Both were repaired, both constraints then rejected fresh violations, and the probe was dropped.

~~**Not verified.**~~ **Verified 2026-08-28** — see [§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### Review moderation verified, 2026-08-28

```text
pytest ................................ 476 passed (464 before; +12)
ruff check + ruff format .............. clean
tsc --noEmit / next lint / next build . clean
vitest ................................ 79 passed, 6 files
```

I was wrong in the shipping entry to say `content` had no documented rules: reviews are covered in
detail by §6a. What the audit found instead is the opposite problem — **the documentation was right
and the code did not match it.**

§6a states that "a second, later order of the same product earns a second review". The code resolved
the eligible order as simply the most recent one, so a repeat buyer's second attempt always landed on
the order they had already reviewed and was refused ([D36](#known-defects)). They got one review
however many times they bought. `business-rules.md` opens by saying that where code and this document
disagree, "that is a bug in one of them — fix both in the same change"; here the document was the
correct half.

Also [D37](#known-defects) — `int()` on the raw rating, so `"excellent"` escaped as a 500 and `4.7`
was silently stored as `4` — and [D38](#known-defects): moderation wrote no audit entry at all, while
the neighbouring `content` app logs every navigation change. Since the review row holds only the
*latest* moderator and note, reversing a decision erased the previous one, and re-approving a rejected
review wiped the reason it was rejected.

~~**Not verified.**~~ **Verified 2026-08-28** — see [§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### The screens were finally used, 2026-08-28

Five verification entries above each ended "no signed-in browser click-through — Docker is
unavailable". **That reasoning was wrong**, and it was repeated four times before anyone checked it.
Docker is how this project *documents* running the stack; it is not what running it requires. The
container has PostgreSQL 16, Python, Node and a pre-installed Chromium, which is enough.

Run natively, the whole stack came up:

```bash
# postgres + redis (redis is not optional: the auth throttle is Redis-backed,
# and without it POST /auth/login/ returns 500)
pg_ctl -D <data> -o '-p 5432 -k /tmp' start
redis-server --daemonize yes --port 6379 --save ''

# api
DATABASE_URL=postgresql://rangon:rangon@127.0.0.1:5432/rangon \
DJANGO_SECRET_KEY=... DJANGO_DEBUG=1 python manage.py runserver 8000 --noreload

# web — API_INTERNAL_URL is the one that matters; it defaults to the compose
# hostname http://api:8000/api/v1, which does not resolve outside compose
API_INTERNAL_URL=http://127.0.0.1:8000/api/v1 npx next dev --port 4000
```

Then a real Chromium (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, the escape hatch
`playwright.config.ts` already provides for via `PW_CHROMIUM_PATH`) signed in as `owner@rangon.test`
and drove the screens:

```text
sign in as owner ....................... /admin
all five screens render signed in ...... 200, correct <h1>, no console errors
create a customer ...................... saved
add an address ......................... saved, and became the default automatically (D26)
add a note ............................. saved, attributed to owner@rangon.test
create a coupon ........................ WALK415942, 15% off
free shipping hides the amount field ... yes (D31), and saved with no value
create a shipping zone ................. saved; cities stored "sylhet, rajshahi" (D34)
a backwards estimate is refused ........ "The longest estimate cannot be shorter…" (D35)
create a shipping method ............... saved, renders "5–7 days"
reject a review with a note ............ note kept
re-approve it .......................... earlier note survived (D38)
the approved review reaches the shop ... count 1, average 4.0
verify_inventory / verify_accounts ..... consistent; every money event names an account
```

13 writes, all landing. The only failing request in the whole run was `401 GET /shop/wishlist` on the
anonymous login page, which is the correct answer for a signed-out wishlist check.

Five of the fixes were confirmed through the UI rather than only in tests: D26, D31, D34, D35 and
D38. **[D7](#known-defects) is also stale** — Playwright's Chromium runs here; the blocker was only
ever the *dev container's* Alpine base.

The lesson is the same one this file keeps recording, turned on itself: a constraint nobody has
tested is not a constraint. "Docker is unavailable, so this cannot be verified" was carried through
four passes and cost five screens their verification, and it took one `ls /opt/pw-browsers` to
disprove.

### E2E made repeatable, and a production-only defect found, 2026-08-28

Ran with `scripts/dev-stack-native.sh` (new) — one command for postgres, redis, api and web.

```text
vitest wired into ci.yml ............... 79 tests now actually protect something
playwright, 3 consecutive full runs .... 15/15, 15/15, 15/15 against next dev
                                         (the 2nd run used to fail, every time)
tsc --noEmit / next lint / vitest ...... clean
```

**[D18](#known-defects)'s diagnosis was wrong.** "The E2E suite is order-coupled" — it is not. Run in
any order against a fresh database, every spec passes. The suite was *not repeatable*, which looks
identical from the outside and is fixed differently: by restoring what the specs consume, not by
reordering anything. Two distinct causes, and the second only became visible after fixing the first:

1. The returns spec approves, receives and refunds the single seeded `REQUESTED` return. A second run
   finds none and waits 60s for a table row that will never appear. `e2e/global-setup.ts` reseeds.
2. Reseeding regenerates every id, but Next kept serving the cached product page, so "add to cart"
   posted a variant that no longer existed — a 200 in the logs and a cart drawer that never opened.

Cause 2 turned out to be a real defect in its own right, [D39](#known-defects): `/api/revalidate`
allowed a `products` tag that **nothing emits**, while the product page tagged `product:<slug>`, which
the endpoint **refused**. The one page the endpoint existed to keep fresh was the one page it could
not touch. That matters beyond tests — restoring a backup behind a running storefront has exactly the
same effect.

**The E2E job is not in CI, deliberately.** Wiring it up meant running the suite against a production
build for the first time, and `Admin › recording an expense…` fails there consistently while passing
consistently in dev ([D40](#known-defects)). The money is fine — the void posts its compensating
adjustment and `verify_accounts` is clean — but the screen is not, and it reproduces with the D39 fix
reverted, so it is pre-existing rather than collateral. Adding a CI job that is knowingly red would
turn every future build red for a defect unrelated to whatever the build is checking, and skipping the
spec to get green is what CLAUDE.md §9 forbids. **Vitest is wired in now; the E2E job is written and
waits on D40.**

Worth stating plainly: five verification passes ran the suite against `next dev` and called it
verified. One run against a production build found a defect none of them could. The gap between "it
works" and "it works the way it ships" was a whole class of bug wide.

### VAT settled, 37 and 38 shipped, D40 narrowed, 2026-08-31

Ran with `scripts/dev-stack-native.sh` (postgres, redis, api, web), plus a production build served
the way the image serves it — `node .next/standalone/server.js`, not `next start`, which Next itself
warns does not work with `output: "standalone"`.

```text
pytest ................................. 551 passed (up from 503)
ruff check + ruff format ............... clean
tsc --noEmit / next lint ............... clean
playwright, dev, reseeded .............. 20/20
playwright, production standalone ...... not green -- D40 and D41
```

**Verified in a browser, signed in as the owner**, not just typechecked:

```text
VAT card read "Not yet decided"; changing to inclusive 15% raised the
confirmation gate naming 40 seeded orders; "Change it anyway" saved it and
stamped who and when.
A ৳2,950 shelf price then priced as ৳2,950 to the customer with ৳384.78 of VAT
extracted -- through the storefront cart, not just the pricing service.
Business summary: 236,290 − 1,320 = 234,970 net revenue; − 117,800 COGS =
117,170 gross profit; − 197,035 expenses = a 79,865 loss.
Party ledger: ৳68,160 owed across 5 customers, ৳2,296,520 owed to suppliers;
expanding Tasnim Karim listed the three orders (4,250 + 10,150 + 8,400) that
add to her 22,800.
```

**Two defects the reports carried before anything was built over them.** The pattern this file has
been tracking held for an eighth pass:

1. *Revenue counted VAT as turnover.* `dashboard`, `profit_report` and `product_performance` all
   summed `line_total`, which under inclusive pricing contains the tax. Each would have overstated
   revenue, gross profit and margin by exactly the VAT the moment an owner chose inclusive — a defect
   that could not exist until the inclusive half was implemented, and would have shipped with it.
2. *[D20](#known-defects) was only ever fixed at one endpoint.* Every report answers with a plain
   selector dict, so `COERCE_DECIMAL_TO_STRING` never applied and money left as JSON floats on
   `/reports/profit/` and `/reports/dashboard/` too. The frontend types already said `string`. One
   existing test was pinning the bug.

**Two found by running it rather than typechecking it.** The party-ledger page passed a callback prop
from a server component to a client one — clean typecheck, clean lint, and the page failed outright
on first load. And a cashier could read the whole party ledger, because the first cut reused
`finance.view` (which cashiers hold, deliberately, to pick an account for a sale) instead of
`reports.financial`.

**D40 is not what it looked like, and it was two bugs.** Five hypotheses ruled out by experiment, and
then the suite started failing on `next dev` as well — which it had never done — at 18:18 UTC, which
is 00:18 in Dhaka. That was [D42](#known-defects): the screen built its window from the **UTC**
calendar date while the API widened it to the end of that day in the **shop's** timezone, so for the
six hours a day those disagree, an expense vanished from the screen that recorded it. Fixed. What is
left of D40 is the half that only appears in a production build: the money is right, the server is
right, and only `router.refresh()` fails to apply what it fetched.

Worth stating plainly, because it is the second time this pattern has shown up in this file: a defect
that "fails in production and passes in dev" was, for one of its two causes, really "fails after
18:00 UTC and passes before". Environment-shaped explanations are easy to reach for and hard to
disprove; this one held for three days.


## Still unproven

Do not describe any of these as working.

| Area                                    | State                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Playwright (`npm run test:e2e`)~~ | **Proven repeatable.** 20/20 against `next dev` with a reseed, 2026-08-31, and in CI from the same day. `apps/web/Dockerfile.dev` is still alpine, so [D7](#known-defects) stands *for the dev container* only |
| ~~Vitest and Playwright in CI~~         | **Both wired in.** Vitest since 2026-08-28; the Playwright job landed 2026-08-31 and runs the suite against `next dev` with a reseed. The gap that remains is that it does **not** run against a production build — [D40](#known-defects) |
| ~~Admin**write** screens, signed in~~ | **Proven 2026-08-28.** A real Chromium signed in as the owner and drove all five new screens: a customer created, an address and a note added, two coupons created, a zone and a method created, a review rejected and re-approved. 13 writes, all landing. The organization and branch editors are still only read-anonymously-redirected |
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
| D7       | **Playwright cannot run in the *dev container*.** `apps/web/Dockerfile.dev` is `node:22-alpine`; Playwright ships no musl browser builds. **Narrowed 2026-08-28** — this was being read as "Playwright cannot run here", which is false: a pre-installed Chromium drove the full signed-in walk-through (see the verification log). The defect is the Alpine dev image alone, and `playwright.config.ts` already carries the `PW_CHROMIUM_PATH` escape hatch |
| ~~D21~~ | ~~**The image scan went red on a base-image CVE.**~~ **Fixed 2026-08-27** — `node:22-alpine` shipped openssl `3.5.7-r0` while Alpine 3.24 already carried the `3.5.8-r0` fix for CVE-2026-14456, so `Build & scan images` failed on every branch through no fault of any diff. The runtime stage now runs `apk upgrade --no-cache`, which is safe to do unconditionally because the gate sets `ignore-unfixed: true` — it only ever fails on a CVE whose fix is already published. Without this, the scan stays red until upstream rebuilds the base image |
| ~~D19~~ | ~~**CSV export 404'd on every report.**~~ **Fixed 2026-08-27** — `?format=csv` is DRF's format-negotiation parameter, and no renderer advertised `csv`, so all eight report endpoints answered 404 and the download links on `/admin/reports` had never worked. A `CSVRenderer` on `BaseReportView` fixes all of them |
| ~~D20~~ | ~~**Computed money left the API as JSON floats.**~~ **Fixed 2026-08-27** — `accounts/cash-position/` returned `661480.0` rather than `"661480.00"`, because it responds with plain selector dicts and DRF encodes `Decimal` as a number. CLAUDE.md §4 forbids float for money, and `CashPosition` in the web app's `types.ts` already declared these as strings. Now serialized through `DecimalField` |
| ~~D22~~ | ~~**A stock count could never be counted.**~~ **Fixed 2026-08-27** — `counted_quantity` was write-protected by a `read_only=True` nested serializer and set by nothing, so `apply` adjusted nothing and silently marked the sheet APPLIED. No test covered stock counts at any level. Added `record/` and `cancel/`, made `apply/` refuse an empty or non-COUNTING sheet, and wrote the first 20 tests the feature has had |
| ~~D23~~ | ~~**`seed_demo --reset` died once a stock count or transfer existed.**~~ **Fixed 2026-08-27** — `StockCountItem` and `StockTransferItem` hold PROTECT references to `ProductVariant`, and `_reset()` deleted the catalogue first. Harmless while those documents were unreachable from the UI; phase 39 made them ordinary. This is the second time the same omission has bitten (phase 36's `Expense` was the first), so it now has a regression test that creates one of each protecting document and resets |
| ~~D18~~ | ~~**The E2E suite is order-coupled.**~~ **Diagnosis corrected and fixed 2026-08-28** — the specs are *not* order-coupled: run in any order against a fresh database they all pass. They were **not repeatable**, which looks identical from outside and is fixed differently. Two causes: (1) the returns spec *consumes* the single seeded `REQUESTED` return, so a second run finds none — `e2e/global-setup.ts` now restores the fixtures; (2) `seed_demo --reset` regenerates every id while Next keeps serving the cached product page, so "add to cart" posted a variant that no longer existed — see [D39](#known-defects). Three consecutive full runs now pass 15/15 against `next dev`, where the second used to fail |
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
| ~~D24~~ | ~~**`customers.view` could write.**~~ **Fixed 2026-08-28** — the `addresses` and `notes` actions each served GET *and* POST but declared one permission list, `customers.view`, so the write inherited the read's requirement. `ACCOUNTANT` holds `customers.view` deliberately without update, and could add an address or a note to any customer. `RolePermission` now accepts a per-method mapping and fails closed on an undeclared method; both actions declare `{"GET": [view], "POST": [update]}` |
| ~~D25~~ | ~~**A customer's addresses could be created but never edited or deleted.**~~ **Fixed 2026-08-28** — `CustomerViewSet` exposed `addresses` and `notes` as GET/POST only, and it is the only router registration, so no update or delete route existed on the admin surface. The *storefront* had full CRUD (`AccountAddressView`), making admin strictly weaker than the customer-facing page. Added `addresses/{id}/` (PATCH, DELETE) and `notes/{id}/` (DELETE) |
| ~~D26~~ | ~~**A customer could hold several default addresses.**~~ **Fixed 2026-08-28** — nothing demoted the previous default on either surface. `CustomerAddress` is ordered `("-is_default", "-created_at")` and checkout pre-fills from the first row, so the pre-filled delivery address was whichever row PostgreSQL returned. `customers.services` now owns the invariant under `select_for_update`, and both surfaces go through it |
| ~~D27~~ | ~~**An edit could leave a customer with no phone and no email.**~~ **Fixed 2026-08-28** — `CustomerSerializer.validate()` skipped its contact-detail check whenever `self.instance` was set, so a PATCH clearing both fields produced exactly the unfindable record phone-first identity exists to prevent. The check now runs against the resulting record, on create and update alike |

| ~~D28~~ | ~~**A once-per-customer coupon could be spent twice.**~~ **Fixed 2026-08-28** — `redeem()` re-checked the *total* usage limit under the coupon row lock but never the *per-customer* one, which is checked only in `validate_coupon` — and that runs while the cart is priced, before the lock exists. Two concurrent checkouts both passed validation and both redeemed. `usage_limit_per_customer` defaults to **1**, so the default configuration was the vulnerable one. Proven by a new threaded test that redeemed twice with zero refusals; the per-customer count is now re-read inside the existing lock |
| ~~D29~~ | ~~**An edit could invert a coupon's active window.**~~ **Fixed 2026-08-28** — `validate()` read `starts_at`/`ends_at` from the payload alone, so a PATCH sending only `ends_at` skipped the ordering check. No database constraint covered this, so the coupon was stored with a window `active_coupons` can never satisfy: it silently never applies. Rules are now checked against the resulting coupon |
| ~~D30~~ | ~~**Invalid coupon edits returned 409 instead of a field error.**~~ **Fixed 2026-08-28** — a PATCH changing only `value` skipped the percentage check (which reads `discount_type` from the payload), and a value of 0 was never checked at all. Both reached the database `CheckConstraint` and came back as a generic `CONFLICT` — data was safe and nothing leaked, but the form had no field to attach the message to |
| ~~D31~~ | ~~**A free-shipping coupon had to invent an amount.**~~ **Fixed 2026-08-28** — `value` is meaningless for `FREE_SHIPPING` (the discount is the shipping line being zeroed in `price_cart`), but the `value > 0` constraint applied to every row, so creating one meant submitting a number that would then mislead whoever read the coupon. Migration `0002` exempts the type; the serializer normalises the value to 0 and the form hides the field |

| ~~D32~~ | ~~**A negative `free_over` made every order ship free.**~~ **Fixed 2026-08-28** — `ShippingMethod.price_for()` returns 0 whenever `subtotal >= free_over`, so a negative threshold is satisfied by every order. The API accepted `-100.00` with a 201. A mistyped minus sign would have given away the shipping revenue on every sale, silently. Refused by the serializer and by a new database constraint |
| ~~D33~~ | ~~**A tracking update could write any status string.**~~ **Fixed 2026-08-28** — `ShipmentViewSet.events` read `request.data` directly and never used `ShipmentEventSerializer`, which existed and was only used to render the response. `status: "BANANA"` was stored with a 201. `ShipmentEvent` is append-only and its status drives `PACKED → SHIPPED → DELIVERED`, so the garbage was permanent *and* stopped the order progressing. Input now goes through the serializer |
| ~~D34~~ | ~~**A zone's city list could be a bare string.**~~ **Fixed 2026-08-28** — `cities` is a `JSONField`, so `"Dhaka"` passed. `ShippingZone.matches()` iterates the value, and iterating a string yields characters: the zone matched the city `"d"` and never `"Dhaka"`. It looks correct in the database and silently routes every order to the wrong zone. The serializer now requires a list and stores names normalised |
| ~~D35~~ | ~~**A delivery estimate could read backwards, and a malformed date 500'd.**~~ **Fixed 2026-08-28** — `min_days=5, max_days=2` was accepted and renders to a shopper as "5–2 days"; a non-date `occurred_at` reached the model and escaped as an unhandled `ValidationError` mid-transaction rather than a 400. Both refused now, the day order by a database constraint too |

| ~~D36~~ | ~~**A repeat buyer got one review, ever.**~~ **Fixed 2026-08-28** — §6a says "a second, later order of the same product earns a second review", but the code resolved the eligible order as simply the most recent one. A customer's second attempt therefore always landed on the order they had already reviewed and was refused, however many times they had bought the product. The most recent **unreviewed** eligible order is now chosen. Code and documentation disagreed; both were wrong to leave |
| ~~D37~~ | ~~**A non-numeric rating returned 500.**~~ **Fixed 2026-08-28** — `int(request.data.get("rating", 0))` raised `ValueError` on `"excellent"` and escaped unhandled; `4.7` was silently truncated to `4`, though §6a says ratings are whole numbers. Both are refused as validation errors now |
| ~~D38~~ | ~~**Moderation left no audit trail, and erased its own notes.**~~ **Fixed 2026-08-28** — approving or rejecting decides what the public sees, yet wrote no `AuditLog` entry, while the neighbouring `content` app logs every navigation change. The review row holds only the *latest* moderator and note, so reversing a decision erased the previous one — and `request.data.get("note", "")` wiped a rejection reason on re-approval. Each decision now writes an entry, and an omitted note keeps the existing one |

| ~~D39~~ | ~~**`/api/revalidate` could not bust the one page that needed it.**~~ **Fixed 2026-08-28** — the allow-list permitted `products`, which **nothing emitted**, while the product page tagged `product:<slug>`, which the endpoint **refused**. So the product page was the only page the endpoint could not invalidate: a merchandiser changing a price had no way to force it, and any operation that regenerates ids (a reseed, a restore from backup) left the storefront serving variant ids that no longer existed. The page now emits both tags and the endpoint admits the targeted form, bounded by a slug pattern so the allow-list stays an allow-list |
| D40      | **`router.refresh()` is lost on heavy admin pages in a production build.** Still not fixed, but re-characterised on 2026-09-01 with a harness that stamps a unique build id into the page and **refuses to report a result unless the served build is the one just built** — the guard caught a stale server on its very first run, which is what had been poisoning earlier sessions. **Two previous claims are now disproved:** it is *not* specific to the expenses screen (taxonomy and staff fail identically, 0/5 each), and `VoidExpenseButton` is *not* the cause (removing it changes nothing — that earlier result was a stale build). What it actually looks like is **probabilistic and cumulative**: on one verified build, a minimal admin page refreshed 6/6, the same page with one manager component 5–6/6, a full copy of the taxonomy page 1/6, and the real expenses and taxonomy pages 0/5. Every individual ingredient is innocent when tested alone — the admin layout, `currentUser()`, one or four `apiServer()` calls, a 2000-row payload, `redirect()`, `export const metadata`, refresh-after-`await`, refresh-after-POST, client components taking server data as props, `useState`, and refresh called from a child all pass 6/6. Removing `PendingRegion` from `AdminShell` changes nothing. So it is not one component: something interrupts or discards the refresh transition, and a heavier client tree widens the window. That is where the next attempt should look — the interrupting re-render — not at any single element |


| D41      | **The storefront checkout specs are unstable against a production build.** Found 2026-08-31, running the whole suite against the standalone server (`node .next/standalone/server.js`, which is what the image runs) for the first time. One run failed only `[mobile] customer can complete a cash-on-delivery order`; a later reseeded run failed the desktop checkout **and** the incomplete-address spec. Both pass at both viewports against `next dev`, reseeded, every time. **Not diagnosed** — and the inconsistency between runs is itself the finding: whatever this is, it is not deterministic, so a production-build CI job would be flaky as well as red. This is the second reason the E2E job runs against dev |
| ~~D42~~ | ~~**An expense recorded after midnight local time could not be seen.**~~ **Fixed 2026-08-31.** The expenses screen built its date window with `new Date().toISOString()` — the **UTC** date — and the API widens a bare `date_to` to the end of that day in the **shop's** timezone (`Asia/Dhaka`, UTC+6). The two agree for eighteen hours a day and disagree for the other six: at 00:18 in Dhaka the UTC date is still the previous day, so the window closed at 17:59 UTC — twenty minutes *before* the expense that had just been recorded. Between midnight and 06:00 local, an expense vanished from the screen that recorded it, on dev and production alike. Found by the E2E suite starting to fail on dev too, which it had never done, at 18:18 UTC. The window is now sent as exact instants, so there is no calendar day for the two ends to disagree about |

## Still API-only (no UI)

**Nothing.** The last two — categories/brands/attributes and users/roles — shipped 2026-08-31 as
`/admin/taxonomy` and `/admin/staff`.

The rule that got us here is worth keeping for whatever is built next: **check each endpoint against
the documented behaviour before building over it.** It has now paid for itself six times — a CSV
export that had never worked, a stock count that could not be counted, a restock decision in the
wrong place, the four customer defects D24–D27, a coupon redeemable twice under a race, and eleven
more in the two "safe" areas above. "Exists" is not "tested", and "rarely touched" is a reason
nothing has ever exercised the edges, not a reason they are sound.

Recently built, so no longer on this list: **return approve / reject / receive / refund** —
`/admin/returns/[id]`; **damage/write-off, stock counts and stock transfers** —
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
2. **The remaining admin *write* screens.** Customers, coupons, return approvals, shipping and
   review moderation all shipped 2026-08-28. Still API-only: **categories/brands/attributes** and
   **users/roles**. Neither is load-bearing — categories are seeded and rarely change, users are
   created by an owner at setup — but both are still form work over endpoints that already exist.
   `product-form.tsx` and `purchase-order-form.tsx` are the patterns to copy.
3. ~~**Unblock and run E2E**, then wire both Vitest and Playwright into `ci.yml`.~~ Done. Vitest
   landed 2026-08-28 and the Playwright job 2026-08-31. What is left is running the suite against a
   **production build** in CI, which waits on [D40](#known-defects).
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
    markers — plus the payment-gateway and courier choices. **VAT (D-C) is now settleable in the app**
    at `/admin/settings`, and both treatments are implemented, audited and guarded; the default is
    still exclusive at 0%, which is a placeholder rather than an answer, so it must still be decided
    before the first real sale. **D-A (credit sales) no longer blocks anything** — phase 37 is built
    in a way that works under either answer.

## Decisions owed for phases 35–39

The money layer cannot be designed around an unanswered question, so these four are recorded here as
well as in [business-rules.md](business-rules.md). Each changes the shape of the code, not just the
schedule.

| #   | Decision                                                                     | Blocks                                              | Default if unanswered                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-A | ~~**Does the business sell on credit?**~~ | ~~Phase 37 entirely~~ | **No longer blocking.** Phase 37 shipped 2026-08-31 built so the answer does not change it: receivable is derived from any order carrying a balance, and a credit sale *is* an order carrying a balance. Still worth answering for how the shop is run, but no code waits on it |
| D-B | ~~**A flat list of cash/bank/MFS accounts, or a real chart of accounts?**~~ | ~~Phase 35's schema~~                              | **Built on the default: a flat list**, 2026-08-22. Changing to a chart of accounts is now a migration, not a choice — see [ADR-0011](architecture/decisions/0011-append-only-cash-book.md) |
| D-C | **VAT: inclusive or exclusive, and at what rate?** | ~~Phase 38~~ — now nothing in code | **Implemented both ways and made settleable** at `/admin/settings` 2026-08-31, so phase 38 shipped. The default is still exclusive at 0%, which is a placeholder rather than an answer — settle it before the first real sale, because orders freeze the treatment they were priced under and a report spanning a change mixes two |
| D-D | **Build EMI, investors, marketplace or attendance at all?**            | Nothing — they are declined                        | No. See the audit for why each is a different product                                                                                                                                            |

D-C no longer blocks any code: both treatments are implemented, the setting is on `/admin/settings`,
every change is audited, and changing it once orders exist needs explicit confirmation. What it still
blocks is the *first real sale* — an order priced under the wrong treatment keeps the total it was
given, and no later setting change corrects it.

## Suggested next task

Phases 35–39 are complete. Every admin screen exists. The remaining work is no longer *building* —
it is the things that need a decision, a provider, or an environment.

**1. The payment gateway.** Nothing prepaid can be sold until one exists, and a gateway's settled
takings need a `BANK` account to land in. Implement against
`orders.payments.providers.base.PaymentProvider`, with signature verification and webhook replay
tests. This is the largest remaining gap between the software and a shop that can trade online.

**2. [D40](#known-defects) and [D41](#known-defects)**, which together keep the E2E suite off a
production build in CI. D40 is now narrowed to a single sentence — only `router.refresh()` fails to
apply, on one screen, in a production build — with five hypotheses ruled out by experiment. D41 is
not yet diagnosed at all, and is inconsistent between runs.

**3. Settle VAT.** No code waits on it any more; the first real sale does. Both treatments are
implemented and the setting is on `/admin/settings` with an audit trail and a confirmation guard —
but the default is still exclusive at 0%, which is a placeholder rather than an answer.

**4. Deployment.** Compose prod stack, green CI, images built and scanned — and nothing has ever
been deployed. Everything after this point (a real backup schedule, a load test, an independent
security review, `verify_accounts` against real data) needs an environment to be true of.

**Two habits to keep**, because both earned their place this pass:

- *Audit the endpoint before building the screen.* Eight passes, eight sets of defects, no
  exceptions. The eighth was over the two areas this file called "not load-bearing" and found
  eleven, five of them security-sensitive.
- *Run it, do not typecheck it.* Two defects this pass survived a clean `tsc` and a clean lint and
  died the moment a browser loaded the page: a function passed from a server component to a client
  one, and a serializer field typed as an object that is really a string. A green typecheck is not
  evidence the app works.

**The still-open backlog** from the Dostishop review — CSV import, a media library, four-state
variant availability, Quick View, a Meta feed, merchandising endpoints, abandoned-checkout capture —
is tracked in [planning/dostishop-feature-review.md](planning/dostishop-feature-review.md) and is
product work rather than gaps.
