# ADR-0013 — A NestJS API beside Django, on the same database, ported module by module

**Status:** Accepted · 2026-09-30 · phases 1 (storefront catalogue and content) and 2 (accounts, customer orders, addresses, tracking, reviews) done

## Context

On 2026-09-29 the owner asked whether an Express or NestJS backend would use fewer resources than
Django, then asked for a NestJS version of the API **built alongside** the Django one, not replacing
it, aiming at **full API parity, phased**, on **Django's own database**.

Two constraints came with that from CLAUDE.md:

- Rule #1, one source of truth: products, stock, orders and money live in one PostgreSQL behind one
  set of business rules. A second API with its own database would be a second catalogue and a second
  inventory, so the only acceptable shape is two APIs over the *same* tables.
- The Django API is ~31k lines guarded by 1,637 tests, with every stock and money path under
  `select_for_update` and `Decimal`. A port that is "roughly the same" would change what the
  storefront shows in ways nobody notices until a customer does.

## Decision

**NestJS 11 on Fastify, Drizzle over `pg`, in `apps/api-nest/`, reading the tables Django
creates, and proven equal to Django by comparing live responses rather than by review.**

1. **Django owns the schema.** Migrations stay Django's. The Nest API's `src/database/schema.ts` is
   introspected from a Django-migrated database (`npm run db:pull`) and never migrated; the
   foreign-key blocks are stripped because they exist only for Drizzle's migrations.
2. **Parity is measured, not asserted.** `docker-compose.nest.yml` runs both APIs on one database;
   `apps/api-nest/parity/run.ts` sends the same requests to both and fails on any difference in
   status, media type, `Location`/`Allow`/`WWW-Authenticate`, request-id echo or JSON value. Fixtures
   add the cases the demo seed lacks. A deliberate difference must be listed, with its reason, in
   `parity/known-differences.ts` and in `docs/architecture/nest-port.md`.
3. **Where Django leaves order to the query plan, the Nest API sends Django's statement.** Django
   drops `Meta.ordering` from GROUP BY queries and several listings order on columns with ties, so
   two correct-looking queries can return one page in two orders. Those statements are copied from
   Django's own SQL (captured in the parity stack), aliases and join order included.
4. **Python's behaviour is reproduced where a response depends on it**: `int()`/`Decimal()` parsing
   of query strings, DRF's query re-encoding in pagination links, `isoformat()` with microseconds,
   ROUND_HALF_EVEN, `str.split()` whitespace, `csv`'s quoting, ElementTree's serialisation.
5. **Tokens work both ways.** Access tokens are SimpleJWT's HS256 tokens over the same signing key,
   with the same claims and refusals, including revocation on password change.
6. **Ported in phases, reads before writes.** A module that writes stock or money is ported only
   with its row locks, idempotency and concurrency tests, and proven by parity *and* by
   `apps/api/tests/test_concurrency.py`-style tests against the shared database. Until then that path
   stays Django's.
7. **Passwords are Django's.** Hashes are read and written in Django's encodings with Django's
   parameters (Argon2id, m=102400, t=2, p=8, a 22-character salt), so an account created or
   rehashed by one API signs in on the other. Argon2 comes from **`@node-rs/argon2`** (2.2.1), the
   one dependency phase 2 adds: Node 22 has no Argon2 of its own (`crypto.argon2` arrives in 24.7),
   the package ships prebuilt binaries with no dependencies of its own, and unlike the older `argon2`
   package it takes a caller's salt -- which Django's 22-character salt needs. Checked: for the same
   password and salt it produces Django's hash byte for byte. PBKDF2 is `node:crypto`.
8. **NestJS 11, not 12.** 12.0 shipped on 2026-09-14 and is ESM-only; 11.2 is still patched
   (11.2.6, 2026-09-23). Move once 12 has settled.

## Consequences

- **Two codebases for the same rules while the port runs.** A business-rule change during the port
  must land in both, or in Django only with the Nest route disabled. The parity harness is what makes
  a forgotten half visible.
- **Rate-limit budgets are per API.** Each keeps its own buckets in Redis. Route each path to exactly
  one API in production, and a client never sees two budgets for the same endpoint.
- **Nothing routes to the Nest API yet.** It runs beside Django in the parity stack only. Cutover is
  per path, at the proxy, once that path's module is ported and green; see the port document for the
  order.
- **Measured on 2026-09-30** (same machine, same database, one API at a time, 8 concurrent clients,
  Django as production runs it -- 2 gunicorn workers x 4 threads): the Nest API served the storefront
  endpoints at **4-8x the requests per second** with p95 latency 3-9x lower, in **114 MB** against
  Django's **248 MB**. Part of the gap on some endpoints is query count (Django's category list is an
  N+1 the port does not copy), not the framework. The earlier estimate that "the framework is not
  where request time goes" was wrong for these endpoints under concurrency.

## Alternatives considered

- **Express.** Rejected for a port of this size: nothing enforces the layering CLAUDE.md requires,
  and Nest's guards, filters and modules map onto DRF's permission classes, exception handler and
  apps directly.
- **A separate database.** Rejected: a second catalogue and inventory is exactly what rule #1
  forbids.
- **Rewrite everything, then switch.** Rejected: no path could be proven until all of them were, and
  the stock and money paths would be the last and riskiest to arrive.
- **Keep Django and tune it.** Done first (roadmap, 2026-09-30); it cut memory by a quarter. The
  owner chose to build the port as well.
