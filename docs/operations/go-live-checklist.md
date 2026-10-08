# Production Readiness Checklist

From plan §42, extended with what this build actually needs. Nothing ships until every box is ticked or
consciously waived in writing.

## Functionality

- [ ] Authentication, roles and permissions verified per role against `docs/architecture/permissions.md`
- [ ] Products, variants, attributes and images verified for clothing, shoes, cosmetics and bags
- [ ] Barcode scan works with the shop's actual scanner hardware
- [ ] Inventory ledger verified: `verify_inventory` reports zero drift after a full test day
- [ ] Purchase → receive → stock increase → weighted average cost verified with real supplier figures
- [ ] POS sale, split payment, hold/resume, void and receipt verified on the real counter setup
- [ ] Online browse → cart → checkout (COD) → order verified on a real phone, real network
- [ ] Online payment gateway verified with a real (small) live transaction, including refund
- [ ] Shipping zones and charges match what the shop actually charges
- [ ] Returns and refunds verified for POS and online, including a `DAMAGED` (non-restocked) line
- [ ] Reports reconciled against a day of real trading, by a human, line by line
- [ ] Audit log shows a full trail for a test day

## Business configuration

- [ ] VAT decision made and applied (see `docs/requirements.md` ❓1) **before** the first real sale
- [ ] Return window, restocking fee, discount-approval threshold and reservation expiry confirmed
- [ ] Branch details, register names and receipt footer text set
- [ ] Policy pages written and signed off by the owner: shipping, returns, privacy, terms
      (Admin → Footer & pages → Pages; the seeded copy states the software's defaults, not the shop's
      own terms)
- [ ] Footer checked: the storefront address, phone, email and opening hours are right (Admin →
      Footer & pages → Contact & map), and the Contact page map points at the shop
- [ ] Social profiles filled in and ticked, in the order wanted; WhatsApp number set if the floating
      chat button should appear
- [ ] Managers hold `content.site_manage` (Admin → Staff, role matrix). `migrate` grants new
      permission codes, so this is only missing if the deploy skipped its migrate job; running
      `python manage.py migrate` fixes it. Do not use `seed_demo` for this, because it writes demo
      data (docs/architecture/permissions.md)
- [ ] Currency, phone format and address format verified for Bangladesh

## Brand

- [ ] Real logo assets replace the placeholders in `apps/web/public/brand/`
- [ ] Favicon and app icons generated from the real symbol
- [ ] OG/social image produced
- [ ] Product photography shot at a consistent 4:5 ratio and adequate resolution

## Technical

- [ ] `DEBUG=False`, real `DJANGO_SECRET_KEY`, correct `ALLOWED_HOSTS` and CORS list
- [ ] HTTPS with a valid certificate and auto-renewal; HSTS enabled
- [ ] Secrets in a secret manager; no `.env` on the production host
- [ ] Database on durable storage, private network, least-privilege user
- [ ] Nightly backups running **and a restore rehearsed** (`docs/operations/backups.md` table has a row)
- [ ] Media in object storage with versioning (`USE_S3=1`; either API since 2026-10-08, [ADR-0018](../architecture/decisions/0018-nest-s3-without-an-sdk.md)). `S3_ENDPOINT` must be an address the browser can reach too, `S3_REGION` the bucket's own, and the bucket's public-read policy must not cover `expenses/*` ([deployment.md](deployment.md#which-api-serves))
- [ ] Error tracking (Sentry DSN) receiving events: set `SENTRY_DSN`, deploy, and **see one event arrive** -- the NestJS API reports since 2026-10-08 ([ADR-0019](../architecture/decisions/0019-nest-errors-to-sentry.md)), and has not yet been pointed at a real Sentry project. Django reports nothing either way ([D241](../roadmap.md#known-defects))
- [ ] Structured logs shipped somewhere searchable; request ids present
- [ ] Health and readiness endpoints wired to the load balancer
- [ ] Background jobs running, and the schedule fired in **exactly one** place: `api-nest` itself, or -- when Django serves -- the Celery worker and one beat replica, never both. Scheduled jobs observed to fire (`SELECT name, state, completed_on FROM pgboss.job ORDER BY created_on DESC LIMIT 5`)
- [ ] Images built by CI, scanned, deployed by immutable tag
- [ ] Rollback rehearsed once on staging
- [ ] Full test suite green, including concurrency tests
- [ ] Playwright E2E green against staging
- [ ] Load test of product list, checkout and POS search at expected peak

## People

- [ ] Cashiers trained; a printed one-page POS cheat sheet at the counter
- [ ] Manager trained on returns, refunds, adjustments and reports
- [ ] Owner shown the dashboard, profit report and audit log
- [ ] Someone owns the "what to do when it breaks" runbook and has read it
- [ ] Contact table in `docs/operations/disaster-recovery.md` filled in

## Day-one watchlist

Sales per channel, failed payments, `INSUFFICIENT_STOCK` errors, 5xx rate, checkout completion rate,
job queue depth (`pgboss.job` rows in `created` or `retry`; Celery's queue when Django serves), inventory drift report, POS lookup latency.
