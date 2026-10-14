# CLAUDE.md — Rangon Fashion Retail Platform

Permanent project instructions. Read this file before modifying any code.
Source plan: [rangon_fashion_build_plan.md](rangon_fashion_build_plan.md) (authoritative product spec).
Roadmap and current status: [docs/roadmap.md](docs/roadmap.md).

**Before running anything, read [.claude/environment.md](.claude/environment.md).**
This machine reserves the port the storefront expects, its home directory is a git
repo, and several verification commands report success misleadingly. That file
lists the traps and the commands that actually work.
Session context and the bugs already found: [.claude/](.claude/README.md).

---

## 1. Project purpose

Rangon Fashion is an **omnichannel retail platform** for a fashion/general retailer selling clothing,
shoes, bags, cosmetics and accessories. One backend serves three surfaces:

| Surface | Audience | Path |
|---|---|---|
| Storefront | Public customers | `apps/web` route group `(storefront)` |
| Admin | Owner, managers, back-office | `apps/web` route group `(admin)` |
| POS | Cashiers at the counter | `apps/web` route group `(pos)` |

**The single most important rule:** POS, storefront and admin share the same catalog, inventory
ledger, customer database, order table and payment table. There is exactly one inventory system.

## 2. Tech stack

- **Backend:** TypeScript on Node 22, NestJS 11 on Fastify, Drizzle (schema and migrations), PostgreSQL 16,
  pg-boss (background jobs, in PostgreSQL), Redis (cache and rate limits) — `apps/api-nest/`
- **Frontend:** Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn-style components on Radix,
  TanStack Query, TanStack Table, Zustand (only for genuinely client-side state), React Hook Form, Zod
- **Infra:** Docker + Docker Compose, Nginx, GitHub Actions, S3-compatible object storage
- **Testing:** Jest for the API's units, the recorded proof (`scripts/nest-parity.sh replay`) for its
  answers and races, Vitest and Playwright for the web app

Do not swap a working technology for a newer one. Do not add a dependency without stating why in the PR
description or an ADR.

**The API was a Django project until 2026-10-14.** It was ported endpoint by endpoint to NestJS, proven
equal to Django by a harness that sent every case to both
([ADR-0013](docs/architecture/decisions/0013-nestjs-api-alongside-django.md)), served production from
[ADR-0017](docs/architecture/decisions/0017-nest-api-serves-production.md), and Django was then removed
([ADR-0020](docs/architecture/decisions/0020-django-is-removed-in-steps.md),
[ADR-0023](docs/architecture/decisions/0023-django-is-gone.md)). What that leaves behind, on purpose:

- **Django's names.** Tables are `<app>_<model>`; settings are `DJANGO_*`, and
  `DJANGO_SETTINGS_MODULE=config.settings.prod` is what makes the API run as production; background jobs
  are named after the Celery tasks they replaced. Keep them.
- **Django's behaviour, to the byte.** Error messages, field order, number formatting and Python's string
  forms were copied so that the two APIs answered alike; comments that say "as Django does" say why the
  code is the way it is. The recorded answers hold that behaviour. Change it deliberately, never in
  passing.
- **Defects copied from Django** so the comparison held, listed in
  [docs/architecture/nest-port.md](docs/architecture/nest-port.md) ("Django defects that are copied") and
  [ADR-0020](docs/architecture/decisions/0020-django-is-removed-in-steps.md) ("The copied defects"). Each
  is now an ordinary bug: fix it with its recorded answer changed in the same commit.

The history -- the port's method, its lessons, the plan that removed Django -- is in
[docs/nest-port-instructions.md](docs/nest-port-instructions.md) and
[docs/architecture/django-removal-plan.md](docs/architecture/django-removal-plan.md). It is history, not
instruction.

## 3. Architecture rules (non-negotiable)

1. **Single source of truth** — products, variants, customers, inventory, orders, payments and
   transactions live in PostgreSQL behind the API. The frontend is never authoritative.
2. **Inventory is ledger-driven** — never write `on_hand = on_hand - 1` from a controller, a job or a
   command. Every stock change goes through `StockService` (`apps/api-nest/src/inventory/stock.service.ts`)
   and writes an `inventory_inventorytransaction` row with a type, reference and actor. See
   [docs/architecture/inventory.md](docs/architecture/inventory.md).
3. **Financial records are immutable** — orders, payments, refunds, purchases, returns and inventory
   transactions are never hard-deleted or silently mutated. Use status changes, reversals, refunds and
   compensating adjustments.
4. **Backend owns business rules** — the frontend may hide a button; the API must still refuse the
   action. Never trust client-supplied prices, totals, discounts, stock levels or permissions.
5. **Everything important is auditable** — who / what / when / before / after / reason / reference
   (`common/audit.ts` writes `core_auditlog`).
6. **Multi-branch by design** — `Organization → Branch → Inventory`. Never assume one branch.
7. **Omnichannel by design** — every order has a `channel` (`POS`, `ONLINE`, `PHONE`, `SOCIAL`, `OTHER`).
8. **Modular monolith** — one NestJS application, clear module boundaries, no microservices.

## 4. Backend layering

```text
<domain>/*.controller.ts   routes, request parsing, permission checks                  (thin)
<domain>/*.service.ts      business logic, transactions, invariants                     (thick)
database/schema.ts         the schema, copied from drizzle/schema.ts                    (generated)
jobs/                      background jobs on pg-boss (never own a financial invariant)
cli/                       the operator's commands: `node dist/cli.js <command>`
```

Rules:
- A controller must not open a transaction around business logic; the **service** owns the transaction
  boundary: `this.db.transaction(async (tx) => …)`.
- A service takes plain arguments, not the request.
- Money crossing a boundary is a `Decimal` (`decimal.js`) or a decimal string, never a JavaScript number.
- Any operation touching stock or money runs inside one transaction with `SELECT … FOR UPDATE` on the
  rows whose invariant is being protected; many rows are locked `ORDER BY id`, every line checked before
  any is written.
- A job decided inside a transaction is queued in it: `jobs.delayIn(tx, task, args)`, so it commits or
  rolls back with the work. A new job needs its queue in `jobs/queues.ts`.

## 5. Naming conventions

- TypeScript: `camelCase` values, `PascalCase` classes and types, files `kebab-case.ts`; one Nest module
  per domain (`orders`, `inventory`, `catalog` …).
- Choice values: `UPPER_SNAKE` strings (`"RETURN_REQUESTED"`).
- DB tables: `<app>_<model>`, as Django named them. Explicit index and constraint names use
  `<table>_<columns>_<kind>`.
- API paths: plural, lowercase, hyphenated — `/api/v1/purchase-orders/`, with the trailing slash.
- Git branches: `phase/<n>-<slug>`, `feat/<slug>`, `fix/<slug>`.
- Commits: Conventional Commits (`feat(inventory): ...`, `fix(orders): ...`, `docs: ...`).

## 6. Database rules

- Primary keys: **UUIDv4** on every domain table (see [ADR-0003](docs/architecture/decisions/0003-uuid-primary-keys.md)).
- Human-facing identifiers (order number, purchase number, return number) come from `nextNumber()`
  (`common/sequence.ts`) — a row-locked sequence, never `count() + 1`.
- Money: `numeric(14, 2)`. Quantities: `integer` (whole units) or `numeric(12, 3)` where fractional
  units are real. **Never a float for money**, in the database or in TypeScript.
- All timestamps are `timestamp with time zone`, stored UTC.
- Every table has `created_at` / `updated_at`; mutable business rows also carry `created_by`. No column
  has a database default: the API writes every column.
- Add unique constraints for real-world uniqueness (SKU, barcode, slug, branch+variant inventory).
- Indexes are added deliberately, with the query they serve named in the migration or in
  [docs/database/indexing.md](docs/database/indexing.md).
- **Migrations only**, written with Drizzle and read before they are committed
  ([docs/database/migrations.md](docs/database/migrations.md)): a foreign key is
  `DEFERRABLE INITIALLY DEFERRED`, as every existing one is. Applied by `node dist/cli.js migrate` as a
  release step, never as the API starts. No manual schema edits; risky changes use expand/contract.
  Never `drizzle-kit push`.

## 7. API conventions

- Versioned under `/api/v1/`. See [docs/api/conventions.md](docs/api/conventions.md).
- Errors always use the envelope:
  ```json
  { "error": { "code": "INSUFFICIENT_STOCK", "message": "Human readable.", "details": {} } }
  ```
  Throw a `BusinessError` subclass (`common/errors.ts`); the envelope filter formats it.
- Never leak stack traces, SQL or secrets in a response.
- Mutating money/stock endpoints accept an `Idempotency-Key` header where a retry could double-charge
  or double-deduct.
- List endpoints are always paginated (`common/pagination.ts`).

## 8. Security requirements

- Argon2 password hashing; JWT access (short) + refresh (rotating, blacklisted on logout).
- Authorization by `Role → Permission` codes (`products.create`, `sales.refund`, …): the catalogue is
  `auth/permission-catalogue.ts`, written to the database by `node dist/cli.js sync-permissions`, and
  enforced in `auth/permissions.ts`, branch scoping included.
- Validate and normalise all input before it reaches a service; never build SQL by string
  concatenation — parameters always.
- Rate limit auth, checkout and search endpoints (Redis-backed throttles, `auth/throttle.ts`).
- Secrets only from the environment. No secrets in the repo, in images or in frontend bundles.
- Uploads: validate content type, extension and size; store outside the app container.
- Follow OWASP ASVS-style review before launch — [docs/operations/security.md](docs/operations/security.md).

## 9. Testing requirements

- **Unit tests** (Jest, `apps/api-nest/test/unit/`) for logic that can be checked without a database:
  pricing, coupon maths, costing, parsers, permissions.
- **The recorded proof** (`scripts/nest-parity.sh replay`, [docs/architecture/recorded-proof.md](docs/architecture/recorded-proof.md))
  holds the API to some 12,000 recorded answers — status, body, every row written, every job queued —
  and runs the race checks across two API processes. A new endpoint or rule gets cases in
  `apps/api-nest/parity/*-cases.ts`; a deliberate change to an answer is recorded with
  `PARITY_ACCEPT` in the same commit, and the reviewer reads that change.
- Every service that changes stock or money needs at least one **invariant case** and one
  **failure-path case** (insufficient stock, duplicate submit, wrong permission).
- Race checks for oversell, double-click checkout and duplicate webhooks are mandatory and live in
  `apps/api-nest/parity/*-concurrency.ts`. A race check is proven by removing the lock it guards: it
  must fail.
- Frontend: type checks + component tests where logic is non-trivial. Playwright covers the four
  critical flows in [docs/testing/strategy.md](docs/testing/strategy.md).
- **Never delete or skip a failing test or case to make the suite green.** Fix the cause, or record
  the new answer deliberately with a written reason.

## 10. UI conventions

The design system is defined in [docs/design-system.md](docs/design-system.md) and implemented as
tokens in `apps/web/src/styles/tokens.css`. Highlights:

- Brand red `#FD3807` (read from the official logo vector) is the **only** primary action colour.
  Generic SaaS blue is forbidden as a CTA.
- Structure comes from black / white / neutral grey; red is reserved for action, emphasis, identity.
- Semantic colours (`success #16A34A`, `warning #D97706`, `error #DC2626`, `info #2563EB`) are separate
  from the brand red — brand red is not the error colour.
- Inter for UI, Space Grotesk for display headings only.
- 4px spacing grid; radius `md` for controls, `lg` for cards, `xl` for storefront modules.
- Lucide icons only. Never emoji as UI icons.
- Storefront = generous whitespace, photography-led, mobile-first. Admin = dense, tabular, keyboard
  friendly. POS = high contrast, barcode-first, minimal motion.
- Never re-create the logo with HTML text or a font; always use the asset in `public/brand/logo/`.
- Reuse existing components in `src/components/ui` and `src/components/*`; do not invent a per-page
  visual language.

Per the source plan, consult the `ui-ux-pro-max` skill before adding a **new major page or design-system
component**, and `frontend-animation` before adding motion. Motion budget: fast 120–160 ms,
normal 180–240 ms, slow 300–400 ms, and always honour `prefers-reduced-motion`.

## 11. Accessibility

Target WCAG 2.2 AA: semantic HTML, labelled controls, visible focus rings, accessible dialogs/menus,
keyboard operability (POS must be fully keyboard-driven), 4.5:1 text contrast, errors associated with
their field, never colour alone, reduced-motion support. Bengali/Unicode text must render correctly
(`৳ 1,290`).

## 12. Definition of done (every feature)

```text
[ ] Database changes + migration        [ ] Loading / empty / error states
[ ] Service-layer business logic        [ ] Tests written and passing
[ ] API endpoint + controller           [ ] Docs updated (incl. business rules)
[ ] Frontend implementation             [ ] Audit-log requirement considered
[ ] Validation (server-side)            [ ] Accessibility checked
[ ] Authorization (server-side)         [ ] Security implication considered
```

## 13. Prohibited shortcuts

- Mutating stock outside `StockService`.
- Deleting or editing historical financial rows.
- Trusting a price, total, discount, stock level or role sent by the browser.
- `float` for money.
- Business logic in a controller, a React component or a job that owns an invariant.
- Skipping migrations, skipping tests, or committing with a failing suite or replay.
- Changing a recorded answer in passing: a changed answer is a decision, recorded with `PARITY_ACCEPT`.
- Inventing an unspecified business rule silently — mark it `DECISION REQUIRED` in
  [docs/business-rules.md](docs/business-rules.md), pick a documented default, and say so.
- Adding animation that slows the POS.
- Committing `.env` files or real secrets.

## 14. Development commands

See [README.md](README.md) for the full list. The common ones:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build   # whole stack
scripts/demo-snapshot.sh restore rangon-db-1                                 # demo data, into an empty database
docker compose exec api-nest node dist/cli.js migrate                        # this build's schema
docker compose exec api-nest npm test && docker compose exec api-nest npm run typecheck
docker compose exec api-nest npm run lint && docker compose exec api-nest npm run format:check
scripts/nest-parity.sh replay                                                # every case against its recorded answer
docker compose exec web npm run lint && docker compose exec web npm run typecheck
```

## 15. Working method for agents

1. Read `CLAUDE.md`, then `docs/roadmap.md`, then the architecture/business-rule doc for the area.
2. Inspect existing code before writing new code; prefer extending a service over duplicating it.
3. Implement the smallest coherent unit; keep working functionality working.
4. Write tests, run lint + type checks + the relevant suite, fix failures.
5. Update docs when behaviour or architecture changes.
6. Commit a coherent change with a Conventional Commit message.
7. Report: what was implemented, files changed, DB changes, API changes, tests added, tests run,
   known limitations, next recommended task.

Do not claim a feature is complete unless it is implemented **and** tested.
