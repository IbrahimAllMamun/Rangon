# Open questions and unverified ground

Two lists: decisions only the owner can make, and things no one has proven yet.
Do not let either quietly become "done".

Last reviewed: **2026-09-19**, against `../docs/roadmap.md` as last updated 2026-09-18.

---

## 1. Decisions the owner owes

Each is implemented with a documented default so the system runs. Each is a
business call, not a technical one. Full detail in `../docs/business-rules.md`,
which carries **18** `DECISION REQUIRED` markers. Only one is changeable in the
app: VAT, on `/admin/settings`. The same page lists four more read-only — the
return window, the discount threshold, reservation expiry and change-of-mind
shipping — which stay in environment variables on purpose, so that changing them
is a deployment with a record rather than a click. The other thirteen live only
in the document.

**Two of the four blocking decisions are now closed by construction.** D-B was settled
on 2026-08-22 (a flat account list). D-A no longer blocks anything: phase 37 was
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
| 1 | **VAT: inclusive or exclusive, and the rate** (D-C, §3.4) | Exclusive at 0% | **Settle before the first real sale.** Editable at `/admin/settings` — both treatments are implemented, audited, and guarded by a confirmation once orders exist. Orders freeze the treatment they were priced under, so a late change does not rewrite history; it does mean reports spanning it mix two |
| 2 | Return window (§2.2) | 14 days | Drives what the API refuses |
| 3 | Discount needing manager approval (§3.3) | above 20% | Drives the POS elevation prompt |
| 4 | Reservation expiry for unpaid online orders (§1.5) | 60 minutes | Releases held stock |
| 5 | Shipping refunded on a change-of-mind return (§2.4) | No | Refund maths |
| 6 | Restocking fee (§2.4) | None (0%) | Refund maths |
| 7 | Where stock is deducted in the order lifecycle (§1.3) | at `PACKED` | Alternative is `CONFIRMED`; changes what "available" means online |
| 8 | Formal in-transit location for transfers (§1.6) | none in V1 | Multi-branch transfer accuracy |
| 9 | Whether coupons may stack (§3.3) | one per order | Discount maths |
| 10 | Dating a purchase in the VAT return (§3.4) | by when the order was raised | `PurchaseOrder` has an invoice number but no invoice date. Matters only if the filing needs the invoice's date |
| 11 | Overpaying a supplier (§6b.1b) | refused | Suppliers here are often paid an advance against future deliveries — a different instrument, see #13 |
| 12 | Paying a `DRAFT` or `CANCELLED` purchase order (§6b.1b) | refused | Payables excludes both, so a payment would be cash out against a liability that does not exist |
| 13 | A supplier advance with no purchase order (§6b.1b) | not offered from the purchase order screen | The service records it, but nothing allocates it against a later delivery; building that needs an allocation rule nobody has stated |
| 14 | Supplier minimum order quantity (§7a.4) | advisory — warns, still accepts | Enforcing it would be a service-layer refusal nobody has asked for |
| 15 | A single-SKU product created from a purchase order (§7a.6) | not possible — the buyer is sent to the full product form | Likely to matter for cosmetics |
| 16 | Supplier credit after returning goods from a paid order (§7b.5) | settled with the supplier off-system | Payables drops a negative outstanding, so the credit shows on the order and nowhere else |
| 17 | ~~**Does the business sell on credit?**~~ (D-A, §6b.2) | assumed no | **No longer blocking.** Phase 37 shipped 2026-08-31 derived from any order carrying a balance, and a credit sale is exactly that — so the answer changes how the shop is run, not what the code does |
| 18 | ~~Flat account list or a chart of accounts?~~ (D-B, §6b.1) | **built on the default: flat list** | Settled by construction 2026-08-22. Changing it is now a migration, not a choice — [ADR-0011](../docs/architecture/decisions/0011-append-only-cash-book.md) |
| — | Which payment gateway | none — COD only | Blocks prepaid online orders |
| — | Which courier, and API or manual | manual tracking | Shipping integration |

Rows 1–18 are the `DECISION REQUIRED` markers, in the order the table groups
them rather than the document's; the section numbers are business-rules.md's.
The two unnumbered rows are product choices that block whole features. Ask
before implementing any of them differently. Do not silently change a default
that historical data already depends on — especially #1, which is the only one
the app lets you change with a click.

---

## 2. Proven since — no longer open

These were on the "never run" list. Each has since been executed; the evidence,
with its date, is in `../docs/roadmap.md`.

| Was unproven | Now |
|---|---|
| `npm run build` (production Next build) | **Passes.** CI runs it on every push. `main` went fully green on 2026-09-12 (`ba9aa2f`), when the three CVEs the image scan gates on were closed |
| Vitest (`npm run test`) | **260 passed** on 2026-09-18, and in CI since 2026-08-28 |
| Playwright (`npm run test:e2e`) | **22 passed** on 2026-09-09, and a CI job since 2026-08-31 — against `next dev`, not a production build (§3) |
| Browser add-to-cart / checkout click-through | **Walked end to end** 2026-08-18: shop → product → add to cart → checkout → COD order `RGN-WEB-000018` (৳2,450 + ৳70 = ৳2,520), correct timeline, cart emptied, ledger still consistent |
| Admin write screens, signed in | **Driven in a real Chromium** 2026-08-28: 13 writes across customers, coupons, shipping and reviews, all landing |
| Backup restore | **Proven under real conditions** 2026-08-22 — the production database was destroyed and restored from a dump taken 14 minutes earlier |
| Query budgets | **All eleven in `docs/database/indexing.md` asserted in tests** since 2026-09-09; 20/20 passing 2026-09-14 |

## 3. Not verified — do not claim these work

| Area | State |
|---|---|
| E2E against a **production build** | **Not green when last run**, 2026-08-31 — [D40](../docs/roadmap.md#known-defects) and D41. D41 was a race in the spec, not the build, and was fixed 2026-09-09; D40 is still open. No production-build run is recorded since. The CI job runs against `next dev` |
| Payment gateway | No live provider; the card option is visibly **disabled**, not faked |
| Load / performance | Every documented query budget is asserted (§2), but a budget is a query count, not a latency under concurrency. **No load test** |
| Security | Controls implemented, audits and image scans automated, passing clean as of 2026-09-12; **no independent penetration test** — and 2026-09-21 is the argument for one. Auditing a single control found every rate limit bypassable by a forged `X-Forwarded-For` and the audit trail writable by the caller ([D88](../docs/roadmap.md#known-defects)). Both were listed as implemented, and CI was green throughout. **`DJANGO_TRUSTED_PROXY_HOPS` must be set to match the deployment** — see `security.md` |
| Deployment | Compose prod stack + green CI; the roadmap records **no live environment and no real order** |
| Backup automation | The restore was rehearsed for real (2026-08-22), but the dump was taken by hand, stored on one machine, on no schedule and with no retention. The scripts themselves run where the docs say since D14 was fixed (2026-09-09); nothing schedules them |
| ~~`mypy`~~ | **Settled 2026-09-21 (D6).** It was 271 errors in 41 files, not 98 — the step ran with `\|\| echo` and had never blocked. Clean now, across 152 source files, and the step blocks |
| Two screens from 2026-09-15 | The supplier payment form on `/admin/purchases/[id]`, and the Delivery panel on `/admin/orders/[id]` with the customer's parcel view. Written, typechecked and unit-tested; **nobody has signed in and used either** |
| `router.refresh()` on the admin | [D77](../docs/roadmap.md#known-defects): after receiving stock the screen showed the un-received state in 3 runs out of 5. **Worked around with a full reload, not root-caused.** Anything else relying on `router.refresh()` is suspect |

## 4. Known-missing UI

**Four APIs have no screen, and one is deliberately without one.** From the roadmap's "Still
API-only (no UI)":

| Endpoint | State |
|---|---|
| `audit-logs/` | Everything writes audit rows and nothing reads them back. The trail is unreadable without database access |
| `inventory-transactions/` | The ledger itself. `/admin/inventory` shows the current figure, not the movements behind it |
| `permissions/` | `/admin/staff` assigns a role; no screen shows what a role can actually do |
| `auth/password/change/` | An owner or admin can reset anyone's password from `/admin/staff`, so nothing is stuck — but a cashier who suspects theirs is compromised has to ask one |
| `auth/register/` | **Deliberate.** On 2026-09-15 the owner had the storefront's account surface withdrawn — wishlist, account pages, review form — because no shopper could obtain a login. The endpoints are kept and unadvertised |

This section said **"None"** from 2026-08-31 until 2026-09-15, and it was wrong. The claim was
made by listing the screens that *had* been built, not by checking every endpoint against what
calls it. The 2026-09-15 audit that found five uncalled APIs (two now have screens:
`supplier-payments/` and `shipments/`) swept router registrations, and so missed
`auth/password/change/` and `permissions/`. Check endpoints against callers, not screens against
memory.

## 5. Deliberately out of scope

- **Offline POS** — **dropped 2026-09-09, owner's decision.** Declined, not
  deferred: the build is large (local queue, sync, conflict resolution on a
  ledger that must not oversell) and the outage it answers is covered by a
  paper pad at one counter. `docs/architecture/offline-pos.md` keeps the design
  notes as a record, not as a plan.
- **Quotation and the cheque register** (roadmap 39) — **dropped 2026-09-09,
  owner's decision.** Both are wholesale instruments and this shop sells retail.
  A cheque is still recordable as a payment into a `BANK` account; the declined
  part is the Pending → Deposited → Cleared / Bounced lifecycle.
- **Customer accounts on the storefront** — **withdrawn 2026-09-15, owner's
  decision.** The wishlist is gone and reviews are read-only; restore both the
  day customer accounts exist.
- Loyalty, multi-branch transfers at scale, courier APIs, marketplace
  integrations, AI features. All listed as V2/V3 in the plan. The roadmap's
  "Skip" table carries the rest, each with its reason.

---

## Before saying "done"

`CLAUDE.md` §12 is the definition of done. The two lines most often skipped in
this project:

- **Tests written and passing** — and for anything with an HTTP surface, test
  the endpoint, not just the service beneath it.
- **Run it.** A green typecheck is not evidence the app works; that mistake
  shipped a completely broken storefront once already, and a sign-in page that
  rendered nothing in a production build (D74) more recently. The wishlist was
  the same mistake in a quieter form: it type-checked, rendered, and did nothing.
