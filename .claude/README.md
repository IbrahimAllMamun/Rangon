# Working on Rangon with Claude Code — start here

This folder is **how to work on this repo**, not what the product does.
For the product, read in this order:

| Question | File |
|---|---|
| Rules this codebase must follow | `../CLAUDE.md` |
| What exists, what is verified, what is missing | `../docs/roadmap.md` |
| Handover summary for a human | `../docs/HANDOVER.md` |
| Business behaviour (and the decisions still owed) | `../docs/business-rules.md` |
| Why it is built this way | `../docs/architecture/decisions/` (11 ADRs) |

And in this folder:

| File | Why you care |
|---|---|
| `environment.md` | **Read before running anything.** This machine has traps that cost hours. |
| `session-history.md` | What was built, every bug found, and the lesson from each. |
| `open-questions.md` | Decisions the owner owes, and what is still unverified. |

---

## State as of 2026-09-18

That is the roadmap's last update. **Every phase is ✅ or declined (❌) with the reason written
down, except six that are 🟡 or ⬜ for a stated reason:** 16 (no payment gateway), 24 (no ESC/POS
driver), 25 (no SMS account), 28 (no load test), 30 (no live environment) and 32, the launch
itself. The full picture, with evidence and dates, is in `../docs/roadmap.md`. What follows is only
what you need before touching anything.

```text
Storefront   http://localhost:4000          (NOT :3000 — see environment.md)
Admin        http://localhost:4000/admin
POS          http://localhost:4000/pos
API          http://localhost:8000/api/v1/
API docs     http://localhost:8000/api/docs/
```

Logins (dev seed, all `rangon12345`): `owner@`, `manager@`, `cashier@`, `stock@`,
`accounts@`, `customer@` — all `...@rangon.test`.

`scripts/dev-stack-native.sh up` brings up postgres, redis, api and web without Docker. Many
verification passes ran that way; others ran the suite in a container, and the log entries usually
say which.

### Last recorded run of each check

Each line is the most recent result the roadmap's verification log records, with its date. Nothing
here is newer than the log.

```text
pytest ................................. 1097 passed              2026-09-18
ruff 0.8.4 check + format --check ...... clean, 201 files         2026-09-18
tsc --noEmit / next lint ............... clean                    2026-09-18
vitest ................................. 260 passed               2026-09-18
query budgets .......................... 20/20 pass               2026-09-14
playwright ............................. 22 passed                2026-09-09
playwright, production standalone ...... NOT green — D40 and D41  2026-08-31
                                         (D41 fixed 2026-09-09; no production run recorded since)
verify_inventory / verify_accounts ..... consistent               2026-08-28
migrations from an empty database ...... OK                       2026-08-18
```

Use the pinned ruff. A newer one on `PATH` reports findings 0.8.4 does not — see the 2026-09-18 log
entry.

### Never successfully run — do not claim these work

- **The E2E suite against a production build.** D41 turned out to be a race in the spec, not the
  build, and was fixed 2026-09-09. **D40 is still open** and is now the only recorded reason the CI
  job runs against `next dev`. No production-build run is recorded since.
- **A live payment gateway.** The card option is visibly disabled, not faked.
- **Anything deployed.** The roadmap records no live environment and no real order; "deploy
  somewhere" is still Tier 0 #1.
- **A load test**, and **an independent security review**.
- **Two screens from 2026-09-15, in a browser:** the supplier payment form on
  `/admin/purchases/[id]`, and the Delivery panel on `/admin/orders/[id]` with the customer's parcel
  view. Written, typechecked and unit-tested; nobody has signed in and used either.
- **`router.refresh()` on the admin.** D77 — receiving stock left the screen showing the
  un-received state in 3 runs out of 5 — is worked around with a full reload, not explained. Anything
  else that relies on `router.refresh()` is suspect until someone finds out why.

### The two habits that keep finding things

1. **Audit the endpoint before building the screen.** It has paid on every pass that tried it. On
   2026-09-15 alone: `supplier-payments/` turned out to answer 400 to every request and to carry
   three money bugs (D61–D65), and `shipments/` had no branch scope at all (D68–D71).
2. **Run it, do not typecheck it.** The sign-in page was a white screen in a production build —
   32 CSP refusals on `/login`, and `/checkout` just as dead (D74, 2026-09-17). The "New supplier"
   button had never worked, because nested forms submit natively (D76). The VAT note on the product
   page showed the *previous* setting, behind a 60-second cache nothing busted (2026-09-18). All
   three survived a clean `tsc`, a clean lint and a green suite, and were found only by a real
   browser.

## What to do next

From the roadmap's "What to build next", in order. The first four are Tier 0 — the first real sale
waits on them — and three of the four are not code:

1. **Deploy somewhere.** A load test, a backup schedule, a security review and `verify_accounts`
   against real data all need an environment to be true of.
2. **Settle VAT.** It is a setting at `/admin/settings` now, but the default (exclusive at 0%) is a
   placeholder, and an order keeps the treatment it was priced under.
3. **Real product photography** (D9). Every card and product page shows "no image available".
4. **Automate the backup.** The restore was proven 2026-08-22 only because a hand-taken dump was 14
   minutes old. Nothing schedules `scripts/backup-db.sh`.

Then the Tier 2 backlog: **D40**, a **media library**, a **reader for `audit-logs/` and
`inventory-transactions/`**, **password self-service**, and **D6** (mypy). The **payment gateway**
and the **SMS account** wait on provider accounts; COD works today, so only prepaid waits on the
gateway.

Details and the lesson from each session are in `session-history.md`; the decisions the owner still
owes are in `open-questions.md`.
