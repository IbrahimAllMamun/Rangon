# Roadmap & Status

Phase order follows §85 of the build plan. **Do not reorder casually** — the storefront must not be
built before the product/variant/inventory/order architecture is stable.

Legend: ✅ done and verified · 🟡 partial (gap stated) · ⬜ not started

**Verified** means it was actually executed. The evidence, and the date it was produced, is in
[§ Verification log](#verification-log). Anything not in that log is written but unproven — see
[§ Still unproven](#still-unproven) and say so rather than implying otherwise.

Last diagnosed: **2026-08-18**, against commit `423cdf4` on `main` (in sync with `origin/main`).

| # | Phase | Backend | Frontend | Notes |
|---|---|---|---|---|
| 00 | Project constitution | ✅ | — | `CLAUDE.md`, `docs/`, 8 ADRs, CI workflow (now running — see below) |
| 01 | Brand + design system | — | ✅ | Tokens, primitives, three shells. Official logo vectors wired. Route-transition + pending-state system on `LogoLoader` — see [design-system.md](design-system.md#waiting-which-loader-and-when) |
| 02 | Architecture | ✅ | — | `docs/architecture/*`, ERD, domain model |
| 03 | Database | ✅ | — | 12 apps, UUID PKs, Decimal money, constraints, migrations apply clean |
| 04 | Auth + RBAC | ✅ | ✅ | JWT in httpOnly cookies, 7 roles, branch scoping, audit log, sign-in page. Admin settings can now **edit** the organization and create/edit branches |
| 05 | Product catalog | ✅ | 🟡 | Full CRUD API. Admin has a **read-only** product list; no create/edit form yet |
| 06 | Inventory engine | ✅ | 🟡 | Ledger, reservations, transfers, WAC, `verify_inventory`. Admin list is read-only; no adjust/count UI |
| 07 | Suppliers + purchasing | ✅ | 🟡 | PO → receive → ledger → cost recalculation. Admin purchase list built; creating/receiving is still API-only |
| 08 | POS | ✅ | ✅ | Barcode-first register, split payment, hold/resume, receipt, F2/F4/F8 shortcuts |
| 09 | Payments | ✅ | ✅ | Generic model + provider registry; `manual` provider (cash/card/MFS/COD) shipped |
| 10 | Returns | ✅ | 🟡 | Full request→approve→receive→restock→refund + POS one-step return. Admin returns list built; approve/receive/refund still API-only |
| 11 | Customers | ✅ | 🟡 | Phone-first identity, addresses, notes, history. Admin customer list built; editing still API-only |
| 12 | Online store | ✅ | ✅ | Home, shop, product, cart, checkout, order tracking, account, policies. Browser journey verified end to end |
| 13 | Search + filters | ✅ | ✅ | Postgres trigram + indexed facets; facet UI with colour swatches |
| 14 | Cart | ✅ | ✅ | Server-authoritative, re-priced on every read, drawer + full page |
| 15 | Checkout | ✅ | ✅ | Idempotency keys, reservation, COD, server-side totals, error summary |
| 16 | Online payments | 🟡 | 🟡 | Abstraction + COD complete. **No live gateway** — the card option is disabled in the UI |
| 17 | Orders | ✅ | ✅ | Status machine, timeline, admin list + detail with status changes, payment capture, refunds, printable A4 invoice and packing slip |
| 18 | Shipping | ✅ | 🟡 | Zones, methods, shipments, courier-ready interface. Checkout picks a method; no admin screens |
| 19 | Coupons | ✅ | 🟡 | Full engine + API; cart can apply/remove. No admin coupon screens |
| 20 | Wishlist + reviews | ✅ | 🟡 | **Both are dead ends in the UI** — the wishlist page and its nav links exist but nothing can add to it, and reviews render without a way to write one. See [Known defects](#known-defects) D1/D2 |
| 21 | Dashboard | ✅ | ✅ | Server-aggregated KPIs, sales chart with a table alternative |
| 22 | Reports | ✅ | ✅ | 8 report endpoints + CSV export, with a reports screen (product performance + CSV download for all seven) |
| 23 | Offline POS | ⬜ | ⬜ | Deliberately V2 (plan §29). Design recorded in `architecture/offline-pos.md` |
| 24 | Barcode + printing | 🟡 | 🟡 | Keyboard-wedge scanning + barcode generation work; print CSS for 80 mm receipt and A4. No ESC/POS driver |
| 25 | Notifications | 🟡 | ⬜ | Model, in-app feed API, Celery email tasks. **No UI at all** — no bell, no feed screen. No SMS provider |
| 26 | SEO | 🟡 | 🟡 | Metadata, OG, sitemap, robots, canonicals, JSON-LD product + breadcrumbs. Product titles render the brand twice — [D4](#known-defects) |
| 27 | Security | 🟡 | 🟡 | Controls implemented and documented; CI runs `pip-audit` + `npm audit` and Trivy-scans both images. **No independent penetration test** |
| 28 | Performance | 🟡 | 🟡 | Every list endpoint swept: three N+1s fixed (home 511→29, listing 363→13, purchase orders 156→15) plus a per-keystroke POS request storm; all guarded by growth tests. Production measured at 11–320 ms per page. Remaining: five documented budgets unasserted, product detail **exceeds** its documented 10, no load test |
| 29 | E2E testing | 🟡 | 🟡 | Playwright specs written for the four critical flows; **still not executed — blocked**, see [D7](#known-defects). The flows they cover were instead walked by hand in a browser |
| 30 | Deployment | 🟡 | 🟡 | Compose prod stack; **CI now runs and is green at `HEAD`**, including the production build and image scans. Still **no live environment** |
| 31 | Backup/recovery | 🟡 | — | Scripts + runbook written; **restore never rehearsed** |
| 32 | Production launch | ⬜ | ⬜ | Blocked on `docs/operations/go-live-checklist.md` |

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
production page latency ............... measured from the built image on the same machine and API:
                                        / 0.03s · /shop 0.29s · /checkout 0.012s · product 0.11s
                                        (the dev server is 10-80x slower and is not a fair measure)
API query counts after the N+1 sweep .. home 29 · listing 13 · purchase orders 15 · detail 13;
                                        every other list endpoint 4-7
```

### CI is real now

`origin` is `github.com/IbrahimAllMamun/Rangon`. The workflow has run **14 times**; the most recent,
run #15 on `423cdf4`, is **green on all four jobs**:

| Job | Steps that passed |
|---|---|
| Backend | ruff check · ruff format --check · `makemigrations --check` · mypy (non-blocking) · pytest incl. concurrency |
| Frontend | `npm ci` · lint · typecheck · **`npm run build`** |
| Dependency audit | `pip-audit` · `npm audit` |
| Build & scan images | API image · web image · Trivy HIGH/CRITICAL on both |

Runs #1–#13 failed or were cancelled while the workflow itself was being fixed (Trivy action version,
`NEXT_PUBLIC_SITE_URL`, requirements). Those were workflow bugs, now fixed — not product regressions.

**CI does not run the frontend tests.** Neither `npm run test` (Vitest) nor `npm run test:e2e`
(Playwright) appears in `ci.yml`. Vitest passes locally and takes seconds — it should be added.

## Still unproven

Do not describe any of these as working.

| Area | State |
|---|---|
| Playwright (`npm run test:e2e`) | Specs written; **cannot run in the dev container** — see [D7](#known-defects) |
| Vitest and Playwright in CI | Neither is wired into `ci.yml` |
| Admin **write** screens, signed in | The organization and branch editors exist in code and the routes correctly redirect anonymous users, but no signed-in click-through has been done |
| Payment gateway | No live provider; the card option is visibly **disabled**, not faked |
| Backup restore | Scripts and runbook written; **never rehearsed**. A backup that has never been restored is not a backup |
| Load / performance | Query budgets documented in `docs/database/indexing.md` but **not asserted in tests**; no load test |
| Security | Controls implemented, audits and image scans automated; **no independent penetration test** |
| Deployment | Compose prod stack + green CI; **no live environment** — nothing has ever been deployed |

## Known defects

Found by diagnosis on 2026-08-18. None is a data-integrity or money bug; all are user-visible or
process gaps. D5, D10, D11, D12 and D13 have since been fixed and are struck through.

| # | Defect | Where | Impact |
|---|---|---|---|
| D1 | **Wishlist cannot be filled.** `/wishlist` renders and is linked from the account page and the mobile nav, but nothing anywhere calls `POST /shop/wishlist/`. There is no save/heart control on the product card or the product page | `apps/web/src/components/commerce/` | The page is permanently empty for every customer — a visibly dead feature |
| D2 | **Reviews cannot be written.** The product page renders reviews and JSON-LD ratings, and `POST /reviews/` exists and is tested, but there is no submit form | `apps/web/src/app/(storefront)/product/[slug]/page.tsx` | Review counts can never grow, and moderation has nothing to moderate |
| D3 | **Notifications have no UI.** The model, the in-app feed API and the Celery email tasks exist; the string "notification" does not appear anywhere in `apps/web/src` | frontend | Staff cannot see low-stock or order alerts in the app |
| D4 | **The brand appears twice in product titles.** `seed_demo` writes `seo_title = "<name> \| Rangon Fashion"` while the root layout applies `template: "%s \| Rangon Fashion"`, producing `Classic Oxford Shirt \| Rangon Fashion \| Rangon Fashion` | `apps/api/core/management/commands/seed_demo.py:475` and `apps/web/src/app/layout.tsx:22` | Any product with an `seo_title` gets a doubled suffix in the tab, the OG card and search results |
| ~~D5~~ | ~~**The cart drawer dialog has no description.**~~ **Fixed 2026-08-18** — `Dialog.Description` added; the drawer now renders `aria-describedby`, verified in the browser | `apps/web/src/components/commerce/cart-drawer.tsx` | — |
| D6 | **mypy reports 98 errors in 29 files.** CI runs it with a trailing `|| echo "::warning::"`, so it never blocks. 60 are `arg-type`, mostly DRF's `request.user` typed `User \| AnonymousUser` where services want `User` | `apps/api` (worst: `orders/api/pos_views.py` 13, `inventory/api/views.py` 12) | Type checking currently proves nothing, and any real narrowing bug hides in the noise |
| D7 | **Playwright cannot run in the dev container.** `apps/web/Dockerfile.dev` is `node:22-alpine`; Playwright ships no musl browser builds, and none are installed (`~/.cache/ms-playwright` is absent) | `apps/web/Dockerfile.dev` | Phase 29 is blocked until E2E runs on a glibc image (`mcr.microsoft.com/playwright`) or on the host |
| D8 | **Dev and prod web images share one tag.** Neither compose file sets `image:`, so `docker compose build web` (production `Dockerfile`) and the dev overlay (`Dockerfile.dev`) both produce `rangon-web:latest`. The production runtime deliberately deletes npm, so a later `up -d` without `--build` would start it with `npm run dev` and fail | `docker-compose.yml`, `docker-compose.dev.yml` | A confusing, self-inflicted breakage after any production build. Also recorded in `.claude/environment.md` |
| D9 | **Seed data has no product images.** Every storefront card and product page renders the "no image available" placeholder | `seed_demo` | The photography-led storefront of `CLAUDE.md` §10 cannot actually be judged |
| ~~D10~~ | ~~**N+1s on the three busiest list endpoints.**~~ **Fixed 2026-08-18** — `GET /shop/home/` **511 queries / 2.42 s**, `GET /shop/products/` **363 / 1.29 s**, `GET /purchase-orders/` **156 / 0.58 s**. Common cause: `ProductVariant.label` is a property that joins attribute values, so any serialiser rendering a variant label costs a query per row unless the queryset prefetches that far. Now **29**, **13** and **15**, guarded by growth-based tests | `orders/api/shop_views.py`, `purchasing/api/views.py` | Was the single largest source of slow page loads |
| ~~D12~~ | ~~**POS searched on every keystroke.**~~ **Fixed 2026-08-18** — the scan field fired `/pos/products/?q=` per character with no debounce. A keyboard-wedge scanner types a 13-character barcode in ~100 ms, so **one scan issued 13 parallel requests** at ~700 ms each; six saturated the browser's per-origin connection limit and the `lookup` that Enter fires queued behind them. Now debounced at 220 ms with request cancellation, so a scan issues **none**. Five Vitest cases cover it | `apps/web/src/components/pos/register.tsx` | The register appeared to freeze on every scan — the most severe user-facing defect found |
| ~~D13~~ | ~~**Admin product list paginated without ordering.**~~ **Fixed 2026-08-18** — Django warned `UnorderedObjectListWarning`; PostgreSQL may return unordered rows in any order, so page 2 could repeat or skip products page 1 already showed. Now `-created_at, pk` | `apps/api/catalog/api/views.py` | Correctness, not just speed |
| ~~D11~~ | ~~**Dev container ran a different Next than CI.**~~ **Fixed 2026-08-18** — `/app/node_modules` is an anonymous volume, so it kept a pre-upgrade install (15.1.4) while the lockfile, image and CI were all on 15.5.23; image rebuilds could not dislodge it. Recorded in [.claude/environment.md](../.claude/environment.md) §7 | `docker-compose.dev.yml` | Local behaviour diverged from CI with no signal |

## Still API-only (no UI)

Every endpoint below exists and is tested. What is missing is the screen.

- product create/edit, variant-matrix generation, publish/unpublish
- purchase order create → send → receive
- customer create/edit, addresses, notes
- return approve / reject / receive / complete
- coupon management, review moderation
- inventory adjust / write-off / stock count / stock transfer
- shipping zones, methods, shipments
- suppliers, categories, brands, attributes
- users and roles
- notification feed

Recently built, so no longer on this list: **organization settings and branch create/edit**
(`/admin/settings`).

## Gaps to close before go-live

1. **Payment gateway.** Implement a real provider against
   `orders.payments.providers.base.PaymentProvider`, with signature verification and webhook replay
   tests. COD works today; the card option is visibly disabled rather than pretending to work.
2. **Admin *write* screens.** Every admin section has a list view and settings can now be edited, but
   creating and editing products, purchase orders, customers, coupons and return approvals is still
   API-only. The endpoints are complete and tested — this is form work, not backend work.
3. **Unblock and run E2E** (D7), then wire **both** Vitest and Playwright into `ci.yml`.
4. **Fix the dead-end features** (D1, D2, D3) — or hide the entry points until they work. Shipping a
   wishlist that cannot be filled is the same class of mistake as the admin links that used to 404.
5. **Restore rehearsal.** A backup that has never been restored is not a backup.
6. **Load test** product listing, checkout and POS search at expected peak; add the
   `assertNumQueries` budgets from `docs/database/indexing.md` as real tests.
7. **Make mypy mean something** (D6) — fix the errors or annotate them deliberately, then drop the
   `|| echo` and let the step block.
8. **Independent security review.**
9. **SMS provider** for order notifications.
10. **Favicon raster + OG image** from the official symbol (the SVG favicon is wired), and real
    product photography for the seed (D9).
11. **Nine owner decisions** are still open — `docs/business-rules.md` carries 9 `DECISION REQUIRED`
    markers, plus the payment-gateway and courier choices. VAT must be settled before the first real
    sale, because changing it rewrites every historical total.

## Suggested next task

Admin product create/edit. It is the last screen that forces someone into the API to do everyday work:
adding a product, generating its variant matrix and setting prices. `POST /products/`,
`POST /products/{id}/generate-variants/` and `POST /products/{id}/publish/` are built and tested — this
is a form, not new business logic.

If you want a smaller win first, D1 and D2 are each an afternoon: one button and one form against
endpoints that already exist and are already tested.
