# Open questions and unverified ground

Two lists: decisions only the owner can make, and things no one has proven yet.
Do not let either quietly become "done".

Last reviewed: **2026-08-31** (after phases 37 and 38, and the VAT settings).

---

## 1. Decisions the owner owes

Each is implemented with a documented default so the system runs. Each is a
business call, not a technical one. Full detail in `../docs/business-rules.md`,
which carries **11** `DECISION REQUIRED` markers. Rows 1–11 are surfaced in the
app at `/admin/settings` so they are visible rather than buried; rows 12–13 are
new (from the Bseba audit). **Row 13 is now settled by construction.** Row 12 is
still owed and is **not** on `/admin/settings` — it should be added there before
phase 37 is scoped, or it will stay buried in a document.

**Two of the four blocking decisions are now closed by construction.** D-B was settled
in 2026-08-22 (a flat account list). D-A no longer blocks anything: phase 37 was
built so receivable is derived from any order carrying a balance, and a credit
sale *is* an order carrying a balance — so the answer changes how the shop is
run, not what the code does.

**D-C, VAT, is now a setting rather than a deployment.** Both treatments are
implemented, `/admin/settings` edits it, every change is audited, and changing it
once orders exist needs explicit confirmation. It still has to be *decided*: the
default is exclusive at 0%, which is a placeholder, and an order priced under the
wrong treatment keeps the total it was given.

Still owed, and only the live data can give it: **run `manage.py verify_accounts`
on the first real deployment and record what it reports as unposted.** Every
payment taken before phase 35 carries no account and cannot be backfilled
honestly. That count is a permanent, known gap — write it down when it is first
measured, not later.

| # | Decision | Current default | Why it matters |
|---|---|---|---|
| 1 | **VAT: inclusive or exclusive, and the rate** | Exclusive at 0% | **Settle before the first real sale.** Now editable at `/admin/settings` — both treatments are implemented, audited, and guarded by a confirmation once orders exist. Orders freeze the treatment they were priced under, so a late change does not rewrite history; it does mean reports spanning it mix two |
| 2 | Return window | 14 days | Drives what the API refuses |
| 3 | Discount needing manager approval | above 20% | Drives the POS elevation prompt |
| 4 | Reservation expiry for unpaid online orders | 60 minutes | Releases held stock |
| 5 | Shipping refunded on a change-of-mind return | No | Refund maths |
| 6 | Restocking fee | None (0%) | Refund maths |
| 7 | Where stock is deducted in the order lifecycle | at `PACKED` | Alternative is `CONFIRMED`; changes what "available" means online |
| 8 | Formal in-transit location for transfers | none in V1 | Multi-branch transfer accuracy |
| 9 | Whether coupons may stack | one per order | Discount maths |
| 12 | ~~**Does the business sell on credit?** (D-A)~~ | assumed no | **No longer blocking.** Phase 37 shipped 2026-08-31 derived from any order carrying a balance, and a credit sale is exactly that — so the answer changes how the shop is run, not what the code does |
| 13 | ~~Flat account list or a chart of accounts?~~ (D-B) | **built on the default: flat list** | Settled by construction 2026-08-22. Changing it is now a migration, not a choice — [ADR-0011](../docs/architecture/decisions/0011-append-only-cash-book.md) |
| 10 | Which payment gateway | none — COD only | Blocks prepaid online orders |
| 11 | Which courier, and API or manual | manual tracking | Shipping integration |

Rows 1–9 are the `DECISION REQUIRED` markers; 10 and 11 are product choices that
block whole features. Ask before implementing any of them differently. Do not
silently change a default that historical data already depends on — especially #1,
which is the only one the app now lets you change with a click.

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
| E2E against a **production build** | **Not green.** [D40](../docs/roadmap.md) and D41. Against `next dev`, reseeded, the suite is 20/20 and runs in CI |
| Payment gateway | No live provider; the card option is visibly **disabled**, not faked |
| Load / performance | Query budgets documented in `docs/database/indexing.md` but **not asserted in tests**; no load test |
| Security | Controls implemented, audits and image scans automated; **no independent penetration test** |
| Deployment | Compose prod stack + green CI; **no live environment** — nothing has ever been deployed |
| Backup automation | The restore was rehearsed for real (2026-08-22), but the dump was taken by hand, stored on one machine, on no schedule and with no retention |
| `mypy` | Runs, reports errors, and is non-blocking in CI. It currently proves nothing |

## 4. Known-missing UI

**None.** The last two API-only areas — categories/brands/attributes and users/roles — got their
screens on 2026-08-31 (`/admin/taxonomy`, `/admin/staff`). Every wishlist/reviews/notifications dead
end was closed on 2026-08-21.

Auditing those endpoints first found eleven defects in them, five security-sensitive, in the two
areas the roadmap had called "not load-bearing". Keep the habit for whatever is built next.

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
