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

- **Backend:** Python 3.12, Django 5, Django REST Framework, PostgreSQL 16, Celery, Redis
- **Frontend:** Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn-style components on Radix,
  TanStack Query, TanStack Table, Zustand (only for genuinely client-side state), React Hook Form, Zod
- **Infra:** Docker + Docker Compose, Nginx, GitHub Actions, S3-compatible object storage
- **Testing:** pytest + pytest-django, Playwright for E2E

Do not swap a working technology for a newer one. Do not add a dependency without stating why in the PR
description or an ADR.

## 3. Architecture rules (non-negotiable)

1. **Single source of truth** — products, variants, customers, inventory, orders, payments and
   transactions live in PostgreSQL behind the Django API. The frontend is never authoritative.
2. **Inventory is ledger-driven** — never write `on_hand = on_hand - 1` from a view, a serializer or a
   management command. Every stock change goes through `inventory.services` and writes an
   `InventoryTransaction` row with a type, reference and actor. See
   [docs/architecture/inventory.md](docs/architecture/inventory.md).
3. **Financial records are immutable** — orders, payments, refunds, purchases, returns and inventory
   transactions are never hard-deleted or silently mutated. Use status changes, reversals, refunds and
   compensating adjustments.
4. **Backend owns business rules** — the frontend may hide a button; the API must still refuse the
   action. Never trust client-supplied prices, totals, discounts, stock levels or permissions.
5. **Everything important is auditable** — who / what / when / before / after / reason / reference.
6. **Multi-branch by design** — `Organization → Branch → Inventory`. Never assume one branch.
7. **Omnichannel by design** — every order has a `channel` (`POS`, `ONLINE`, `PHONE`, `SOCIAL`, `OTHER`).
8. **Modular monolith** — one Django project, clear app boundaries, no microservices.

## 4. Backend layering

```text
api/            DRF serializers, viewsets, permissions, routing   (thin)
services.py     business logic, transactions, invariants          (thick)
models.py       schema, constraints, tiny model-local helpers     (dumb)
selectors.py    read queries used by more than one caller
tasks.py        Celery jobs (never own a financial invariant)
```

Rules:
- A view must not open a `transaction.atomic()` block around business logic; the **service** owns the
  transaction boundary.
- A service must accept plain arguments/dataclasses, not `request` objects.
- Money crossing a boundary is `Decimal`, never `float`.
- Any operation touching stock or money runs inside `transaction.atomic()` with
  `select_for_update()` on the rows whose invariant is being protected.

## 5. Naming conventions

- Python: `snake_case` functions, `PascalCase` models, `UPPER_SNAKE` constants. Django apps are plural
  domain nouns (`orders`, `customers`) except singular engines (`inventory`, `catalog`, `purchasing`).
- Choice enums: Django `models.TextChoices`, values `UPPER_SNAKE` (`"RETURN_REQUESTED"`).
- DB tables: `<app>_<model>` (Django default). Explicit `db_index`/`constraints` names use
  `<table>_<columns>_<kind>`.
- TypeScript: `camelCase` values, `PascalCase` components/types, files `kebab-case.tsx`.
- API paths: plural, lowercase, hyphenated — `/api/v1/purchase-orders/`.
- Git branches: `phase/<n>-<slug>`, `feat/<slug>`, `fix/<slug>`.
- Commits: Conventional Commits (`feat(inventory): ...`, `fix(orders): ...`, `docs: ...`).

## 6. Database rules

- Primary keys: **UUIDv4** on every domain table (see [ADR-0003](docs/architecture/decisions/0003-uuid-primary-keys.md)).
- Human-facing identifiers (order number, purchase number, return number) come from
  `core.services.next_number()` — a row-locked sequence, never `count() + 1`.
- Money: `DecimalField(max_digits=14, decimal_places=2)`. Quantities: `IntegerField` (whole units) or
  `DecimalField(12, 3)` where fractional units are real. **Never `FloatField` for money.**
- All timestamps are timezone-aware (`USE_TZ = True`, stored UTC).
- Every table has `created_at` / `updated_at`; mutable business rows also carry `created_by`.
- Add `unique_together`/`UniqueConstraint` for real-world uniqueness (SKU, barcode, slug,
  branch+variant inventory).
- Indexes are added deliberately, with the query they serve named in the migration or in
  [docs/database/indexing.md](docs/database/indexing.md).
- Migrations only. No manual schema edits. Risky changes use expand/contract.

## 7. API conventions

- Versioned under `/api/v1/`. See [docs/api/conventions.md](docs/api/conventions.md).
- Errors always use the envelope:
  ```json
  { "error": { "code": "INSUFFICIENT_STOCK", "message": "Human readable.", "details": {} } }
  ```
  Raise `core.exceptions.BusinessError` subclasses; the DRF exception handler formats them.
- Never leak stack traces, SQL or secrets in a response.
- Mutating money/stock endpoints accept an `Idempotency-Key` header where a retry could double-charge
  or double-deduct.
- Pagination is cursor/limit-offset via `core.pagination`; list endpoints are always paginated.

## 8. Security requirements

- Argon2 password hashing; JWT access (short) + refresh (rotating, blacklisted on logout).
- Authorization enforced by DRF permission classes backed by `Role → Permission` codes
  (`products.create`, `sales.refund`, …). Object-level branch scoping in `accounts.permissions`.
- Validate and normalise all input with serializers; never build SQL by string concatenation.
- Rate limit auth, checkout and search endpoints (Redis-backed throttles).
- Secrets only from the environment. No secrets in the repo, in images or in frontend bundles.
- Uploads: validate content type, extension and size; store outside the app container.
- Follow OWASP ASVS-style review before launch — [docs/operations/security.md](docs/operations/security.md).

## 9. Testing requirements

- `pytest` for backend. Business-critical code needs tests: inventory ledger, POS sale, checkout,
  payments, returns/refunds, permissions, coupon maths, costing.
- Every service that changes stock or money needs at least one **invariant test** and one
  **failure-path test** (insufficient stock, duplicate submit, wrong permission).
- Concurrency tests for oversell, double-click checkout and duplicate webhooks are mandatory and live
  in `apps/api/tests/test_concurrency.py`.
- Frontend: type checks + component tests where logic is non-trivial. Playwright covers the four
  critical flows in [docs/testing/strategy.md](docs/testing/strategy.md).
- **Never delete or skip a failing test to make the suite green.** Fix the cause or mark it `xfail`
  with a linked issue and a written reason.

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
[ ] API endpoint + serializer           [ ] Docs updated (incl. business rules)
[ ] Frontend implementation             [ ] Audit-log requirement considered
[ ] Validation (server-side)            [ ] Accessibility checked
[ ] Authorization (server-side)         [ ] Security implication considered
```

## 13. Prohibited shortcuts

- Mutating stock outside `inventory.services`.
- Deleting or editing historical financial rows.
- Trusting a price, total, discount, stock level or role sent by the browser.
- `float` for money.
- Business logic in a serializer, a React component or a Celery task that owns an invariant.
- Skipping migrations, skipping tests, or committing with a failing suite.
- Inventing an unspecified business rule silently — mark it `DECISION REQUIRED` in
  [docs/business-rules.md](docs/business-rules.md), pick a documented default, and say so.
- Adding animation that slows the POS.
- Committing `.env` files or real secrets.

## 14. Development commands

See [README.md](README.md) for the full list. The common ones:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build   # whole stack
docker compose exec api python manage.py migrate
docker compose exec api python manage.py seed_demo --reset
docker compose exec api pytest
docker compose exec api ruff check . && docker compose exec api ruff format --check .
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
