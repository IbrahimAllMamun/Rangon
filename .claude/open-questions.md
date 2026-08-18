# Open questions and unverified ground

Two lists: decisions only the owner can make, and things no one has proven yet.
Do not let either quietly become "done".

---

## 1. Decisions the owner owes

Each is implemented with a documented default so the system runs. Each is a
business call, not a technical one. Full detail in `../docs/business-rules.md`,
marked `DECISION REQUIRED`. They are also surfaced in the app at
`/admin/settings` so they are visible rather than buried.

| # | Decision | Current default | Why it matters |
|---|---|---|---|
| 1 | **VAT: inclusive or exclusive, and the rate** | Exclusive at 0% | **Settle before the first real sale.** Changing it rewrites every historical total and every report. Bangladeshi retail commonly quotes VAT-inclusive, so the default may well be wrong. |
| 2 | Return window | 14 days | Drives what the API refuses |
| 3 | Discount needing manager approval | above 20% | Drives the POS elevation prompt |
| 4 | Reservation expiry for unpaid online orders | 60 minutes | Releases held stock |
| 5 | Shipping refunded on a change-of-mind return | No | Refund maths |
| 6 | Restocking fee | None (0%) | Refund maths |
| 7 | Which payment gateway | none — COD only | Blocks prepaid online orders |
| 8 | Which courier, and API or manual | manual tracking | Shipping integration |

Ask before implementing any of these differently. Do not silently change a
default that historical data already depends on — especially #1.

---

## 2. Not verified — do not claim these work

| Area | State |
|---|---|
| `npm run build` (production Next build) | **Never completed.** Only the dev server has run. |
| Vitest (`npm run test`) | Config + one test file exist; never executed |
| Playwright (`npm run test:e2e`) | Specs for the four critical flows written; never executed |
| Browser add-to-cart / checkout click-through | Endpoints verified; the UI journey is not |
| Payment gateway | No live provider; the card option is visibly **disabled**, not faked |
| Backup restore | Scripts and runbook written; **never rehearsed**. A backup that has never been restored is not a backup. |
| Load / performance | Query budgets documented in `docs/database/indexing.md` but **not asserted in tests**; no load test |
| Security | Controls implemented and documented; **no independent penetration test** |
| Deployment | Compose prod stack + CI written; no live environment |
| CI | `.github/workflows/ci.yml` written; **never run** — no remote configured |

## 3. Known-missing UI (APIs exist and are tested)

Every admin section now has a working **list** view. Still API-only:

- product create/edit and variant-matrix generation
- creating and receiving purchase orders
- customer create/edit
- return approve / receive / refund
- coupon management, review moderation
- inventory adjust / stock count from the UI
- notification bell

## 4. Deliberately out of scope

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
  shipped a completely broken storefront once already.
