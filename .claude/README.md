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

## State as of 2026-08-18 (diagnosis pass on `423cdf4`)

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
inventory ledger integrity ............ 0 drift (re-checked after a live browser order)
pytest ................................ 167 passed (160 + 7 threaded concurrency)
ruff check + ruff format .............. clean
tsc --noEmit .......................... clean
vitest ................................ 17 passed, 2 files
production Next build ................. passes in CI and via `docker compose build web`
GitHub Actions CI ..................... green on all four jobs at HEAD (14 runs, latest #15)
storefront / admin / POS .............. 11 storefront 200, 10 admin/POS 307 → /login
a real POS sale through the web proxy . RGN-POS-000025 DELIVERED PAID 2450.00
a real browser purchase ............... RGN-WEB-000018 CONFIRMED UNPAID 2520.00 (COD)
all 10 admin routes ................... no dead sidebar links
```

### Never successfully run — do not claim these work

- `npm run test:e2e` (Playwright). Specs for the four critical flows exist, but the
  dev image is `node:22-alpine` and Playwright has no musl browsers. Needs a glibc
  image or a host run.
- A signed-in pass over the admin **write** screens (organization + branches). The
  code is there and anonymous access correctly redirects; nobody has used them.
- Anything deployed. There is no environment, and CI builds images without pushing.

### Known defects found on 2026-08-18

Nine, none of them touching money or stock. Full table in `../docs/roadmap.md`:
dead-end wishlist / reviews / notifications UI, a doubled brand suffix in product
titles, a cart dialog with no description, 98 non-blocking mypy errors, Playwright
blocked by Alpine, both web images sharing one tag, and a seed with no product
images.

## Commit history

```text
423cdf4  subtle change                                  ← CI green from here
d312a24  fixed ci.yml error
c347068  requirements updated
93772f0  feat(web): LogoLoader route transition, editable settings
03c9a45  docs: add .claude/ with the working context for this repo
18d1078  docs: correct verified test count, record live-stack checks
5c77f39  fix(pos): unbreak sales and holds, build the five 404ing admin pages
9fb2c1c  fix(docker): configurable storefront host port (Windows reserves 3000)
ce9df26  fix(web): split API module so client code cannot pull in next/headers
0d41804  feat(web): design system, storefront, admin and POS on brand assets
36fe40c  feat(api): backend platform
6a780e2  docs: constitution, architecture, operations
```

(23 commits total; the ones between `03c9a45` and `423cdf4` are small frontend
fixes and CI-workflow repairs.)

## Next four tasks

1. **Admin product create/edit** — the last screen that forces someone into the API
   for everyday work. Every endpoint exists and is tested; this is form work.
2. **Close the dead ends** — a save button, a review form, a notification bell.
   Small, and each has a tested endpoint waiting.
3. **Unblock Playwright** (glibc runner), then put both `npm run test` and
   `npm run test:e2e` into CI. CI currently runs no frontend tests at all.
4. **One real payment gateway** end to end, with webhook signature verification
   and replay tests.
