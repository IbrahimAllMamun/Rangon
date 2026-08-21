# Open questions and unverified ground

Two lists: decisions only the owner can make, and things no one has proven yet.
Do not let either quietly become "done".

Last reviewed: **2026-08-21** (after the product form / D2 / D3 / D16 build pass).

---

## 1. Decisions the owner owes

Each is implemented with a documented default so the system runs. Each is a
business call, not a technical one. Full detail in `../docs/business-rules.md`,
which carries **11** `DECISION REQUIRED` markers. Rows 1–11 are surfaced in the
app at `/admin/settings` so they are visible rather than buried; rows 12–13 are
new (from the Bseba audit) and are **not** on that screen yet — add them when
phase 35 starts, or they will stay buried in a document.

| # | Decision | Current default | Why it matters |
|---|---|---|---|
| 1 | **VAT: inclusive or exclusive, and the rate** | Exclusive at 0% | **Settle before the first real sale.** Changing it rewrites every historical total and every report. Bangladeshi retail commonly quotes VAT-inclusive, so the default may well be wrong. |
| 2 | Return window | 14 days | Drives what the API refuses |
| 3 | Discount needing manager approval | above 20% | Drives the POS elevation prompt |
| 4 | Reservation expiry for unpaid online orders | 60 minutes | Releases held stock |
| 5 | Shipping refunded on a change-of-mind return | No | Refund maths |
| 6 | Restocking fee | None (0%) | Refund maths |
| 7 | Where stock is deducted in the order lifecycle | at `PACKED` | Alternative is `CONFIRMED`; changes what "available" means online |
| 8 | Formal in-transit location for transfers | none in V1 | Multi-branch transfer accuracy |
| 9 | Whether coupons may stack | one per order | Discount maths |
| 12 | **Does the business sell on credit?** (D-A) | assumed no | Decides whether phase 37 (party ledger) is built at all, and how orders relate to payment |
| 13 | **Flat account list or a chart of accounts?** (D-B) | flat list | Phase 35's schema. A chart of accounts is an accounting product |
| 10 | Which payment gateway | none — COD only | Blocks prepaid online orders |
| 11 | Which courier, and API or manual | manual tracking | Shipping integration |

Rows 1–9 are the `DECISION REQUIRED` markers; 10 and 11 are product choices that
block whole features. Ask before implementing any of them differently. Do not
silently change a default that historical data already depends on — especially #1.

---

## 2. Verified on 2026-08-18 — no longer open

These were on the "never run" list. They have now been executed. The evidence is
in `../docs/roadmap.md`.

| Was unproven | Now |
|---|---|
| `npm run build` (production Next build) | **Passes.** CI runs it on every push, and `docker compose build web` completes locally |
| Vitest (`npm run test`) | **17 tests pass**, 2 files, ~25 s |
| Browser add-to-cart / checkout click-through | **Walked end to end**: shop → product → add to cart → checkout → COD order `RGN-WEB-000018` (৳2,450 + ৳70 = ৳2,520), correct timeline, cart emptied, ledger still consistent |
| CI (`.github/workflows/ci.yml`) | **Runs.** `origin` is `github.com/IbrahimAllMamun/Rangon`; 14 runs, and the most recent (#15, on `423cdf4`) is green on backend, frontend, dependency audit and image build + Trivy scan |

## 3. Not verified — do not claim these work

| Area | State |
|---|---|
| Playwright (`npm run test:e2e`) | **Still blocked** in the dev image (`node:22-alpine`, no musl browsers), but browser verification itself is no longer blocked: `apps/web/e2e/browser-walk.mjs` runs in `mcr.microsoft.com/playwright` joined to the compose network. The committed spec suite has still never been executed |
| Vitest / Playwright in CI | Neither is in `ci.yml`. The frontend job is `npm ci` → lint → typecheck → build |
| Admin write screens, signed in | **Partly closed.** The product form was walked signed-in through Chromium on 2026-08-21: create → variant matrix → opening stock → publish. The organization and branch editors still have no signed-in click-through |
| Payment gateway | No live provider; the card option is visibly **disabled**, not faked |
| Backup restore | Scripts and runbook written; **never rehearsed**. A backup that has never been restored is not a backup |
| Load / performance | Query budgets documented in `docs/database/indexing.md` but **not asserted in tests**; no load test |
| Security | Controls implemented; CI runs `pip-audit`, `npm audit` and Trivy. **No independent penetration test** |
| Deployment | Compose prod stack + green CI; no registry push, **no live environment** |
| `mypy` | Runs, reports **98 errors in 29 files**, and is non-blocking in CI. It currently proves nothing |

## 4. Known-missing UI (APIs exist and are tested)

Every admin section has a working **list** view, and `/admin/settings` can now
edit the organization and create/edit branches. Still API-only:

- product create/edit and variant-matrix generation
- creating and receiving purchase orders
- customer create/edit
- return approve / receive / refund
- coupon management, review moderation
- inventory adjust / stock count from the UI
- notification bell

### Three of these are worse than missing — they are dead ends

The customer can see them and cannot use them. Fix or hide:

- **Wishlist** — page and two nav links exist; nothing calls `POST /shop/wishlist/`
- **Reviews** — they render and feed the JSON-LD rating; no form to write one
- **Notifications** — model, feed API and email tasks exist; the word does not
  appear anywhere in `apps/web/src`

## 5. Deliberately out of scope

- **Offline POS** — V2 by the plan. It needs an oversell exception report first,
  because it is the one case where selling below zero is legitimate. Design
  notes already exist in `docs/architecture/offline-pos.md`.
- Loyalty, multi-branch transfers at scale, courier APIs, marketplace
  integrations, AI features. All listed as V2/V3 in the plan.

---

## Before saying "done"

`CLAUDE.md` §12 is the definition of done. The two lines most often skipped in
this project:

- **Tests written and passing** — and for anything with an HTTP surface, test
  the endpoint, not just the service beneath it.
- **Run it.** A green typecheck is not evidence the app works; that mistake
  shipped a completely broken storefront once already. The wishlist is the same
  mistake in a quieter form: it type-checks, renders, and does nothing.
