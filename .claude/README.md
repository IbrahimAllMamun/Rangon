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

## State as of 2026-09-21

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

Each line is the most recent result the roadmap's verification log records, with its date. These are
from the five 2026-09-21 passes — the defect audit, the D40 workaround, the CI E2E move, the D6 fix
and D88 — each of which ran its checks itself rather than quoting an older entry.

```text
pytest ................................. 1177 passed              2026-09-21
ruff 0.8.4 check + format --check ...... clean, 211 files         2026-09-21
tsc --noEmit ........................... clean                    2026-09-21
vitest (TZ=UTC) ........................ 282 passed, 24 files     2026-09-21
query budgets + concurrency ............ 38 passed                2026-09-21
mypy ................................... clean, 152 source files  2026-09-21  <- D6 fixed; the
                                         step blocks now (no `|| echo`)
playwright, PRODUCTION standalone ...... 42 passed / 42           2026-09-21  <- after the D40
                                         workaround
verify_inventory / verify_accounts ..... consistent               2026-09-21
migrations from an empty database ...... OK                       2026-09-21
```

All of the above were run natively on Linux, per §8 below: PostgreSQL 16 and Redis on the host,
Django on 8000, and — for the browser pass — `next build` followed by the standalone `server.js`
the production image runs, on 4000. That recipe works as written.

Use the pinned ruff. A newer one on `PATH` reports findings 0.8.4 does not — see the 2026-09-18 log
entry.

### Never successfully run — do not claim these work

- ~~**The E2E suite against a production build.**~~ **42/42 on 2026-09-21**, and **CI runs it that
  way now** — the job builds the app and serves the standalone `server.js`, so the suite drives the
  artefact that ships rather than `next dev`. It was 40/42 earlier the same day, both failures D40.
  Three things that recipe needs, each of which fails confusingly without it: `next start` cannot
  serve an `output: "standalone"` build (run `server.js` directly); `.next/static` and `public` must
  be copied in beside it; and `server.js` binds `process.env.HOSTNAME`, which a runner sets to its
  own hostname, so override it to `0.0.0.0`. The run also needs `DJANGO_THROTTLE_ANON` raised, or
  storefront specs collect 429s from the shared `anon: 60/min` bucket — every request comes from one
  address.
- **A live payment gateway.** The card option is visibly disabled, not faked.
- **Anything deployed.** The roadmap records no live environment and no real order; "deploy
  somewhere" is still Tier 0 #1.
- **A load test**, and **an independent security review**.
- **Two screens from 2026-09-15, in a browser:** the supplier payment form on
  `/admin/purchases/[id]`, and the Delivery panel on `/admin/orders/[id]` with the customer's parcel
  view. Written, typechecked and unit-tested; nobody has signed in and used either.
- ~~**`router.refresh()` on the admin.**~~ **Worked around 2026-09-21, not root-caused.** It
  discards the payload it fetched, the more reliably the heavier the page (`/admin/expenses`
  measured 0/5, 0/5, 2/5 and 0/8 on one build). D40 and D77 are one defect. Every admin write that
  moves stock or money now goes through `refreshAfterWrite()`, which checks the layout's
  `data-render-id` moved and reloads only when it did not — 8/8 where the bare call was 0/8. **If
  you add a new admin write screen, call that helper, not `router.refresh()`.** The root cause is
  upstream and still open.

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

Tier 2 is down to a **media library**, and that waits on Tier 0 #3 (real photos), so **the written
backlog has no unblocked work left**: D40 was worked around, the readers for `audit-logs/` and
`inventory-transactions/` and password self-service all shipped, and **D6** closed 2026-09-21.
That is what produced **D88** the same day — with nothing to build, a control was audited instead,
and every rate limit turned out to be bypassable with one header. The **payment gateway** and the **SMS account** wait on
provider accounts; COD works today, so only prepaid waits on the gateway.

Details and the lesson from each session are in `session-history.md`; the decisions the owner still
owes are in `open-questions.md`.
