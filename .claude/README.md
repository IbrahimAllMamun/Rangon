# Working on Rangon with Claude Code — start here

This folder is **how to work on this repo**, not what the product does.
For the product, read in this order:

| Question | File |
|---|---|
| Rules this codebase must follow | `../CLAUDE.md` |
| What exists, what is verified, what is missing | `../docs/roadmap.md` |
| Handover summary for a human | `../docs/HANDOVER.md` |
| Business behaviour (and the decisions still owed) | `../docs/business-rules.md` |
| Why it is built this way | `../docs/architecture/decisions/` (8 ADRs) |

And in this folder:

| File | Why you care |
|---|---|
| `environment.md` | **Read before running anything.** This machine has traps that cost hours. |
| `session-history.md` | What was built, every bug found, and the lesson from each. |
| `open-questions.md` | Decisions the owner owes, and what is still unverified. |

---

## State as of 2026-08-18

Working, running, and verified against the live stack:

```text
Storefront   http://localhost:4000          (NOT :3000 — see environment.md)
Admin        http://localhost:4000/admin
POS          http://localhost:4000/pos
API          http://localhost:8000/api/v1/
API docs     http://localhost:8000/api/docs/
Mailpit      http://localhost:8025
MinIO        http://localhost:9001
```

Logins (dev seed, all `rangon12345`): `owner@`, `manager@`, `cashier@`, `stock@`,
`accounts@`, `customer@` — all `...@rangon.test`.

### Verified by actually executing it

```text
migrations from an empty database ..... OK, all 12 Django apps
seed_demo --reset ..................... 12 products, 72 variants, 2 POs, 40 orders
inventory ledger integrity ............ 0 drift
pytest ................................ 167 passed (160 + 7 threaded concurrency)
ruff check + ruff format .............. clean
tsc --noEmit .......................... clean
storefront / admin / POS .............. 200 from the Windows host
a real POS sale through the web proxy . RGN-POS-000025 DELIVERED PAID 2450.00
all 10 admin routes ................... 200, no dead sidebar links
```

### Never successfully run — do not claim these work

- `npm run build` (the **production** Next build). Only the dev server has run.
  The prod image build was attempted three times and never completed: BuildKit
  crashed once, and Windows bind-mount builds are pathologically slow.
- `npm run test` (Vitest). Config and one test file exist; never executed.
- `npm run test:e2e` (Playwright). Specs written for the four critical flows;
  never executed.
- Browser-side interaction: add-to-cart and completing a checkout as a shopper.
  The endpoints are verified; the click-through is not.

## Commit history

```text
18d1078  docs: correct verified test count, record live-stack checks
5c77f39  fix(pos): unbreak sales and holds, build the five 404ing admin pages
9fb2c1c  fix(docker): configurable storefront host port (Windows reserves 3000)
ce9df26  fix(web): split API module so client code cannot pull in next/headers
0d41804  feat(web): design system, storefront, admin and POS on brand assets
36fe40c  feat(api): backend platform
6a780e2  docs: constitution, architecture, operations
```

## Next three tasks

1. **Run the Playwright suite** against the seeded stack, fix what it finds, add to CI.
   It covers exactly the gap above (browser-side flows).
2. **Admin write screens** — product create/edit, receive a purchase, approve a
   return. Every endpoint exists and is tested; this is form work.
3. **One real payment gateway** end to end, with webhook signature verification
   and replay tests.
