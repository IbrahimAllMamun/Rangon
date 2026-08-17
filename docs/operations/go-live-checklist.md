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
- [ ] Policy pages written: shipping, returns, privacy, terms
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
- [ ] Media in object storage with versioning
- [ ] Error tracking (Sentry DSN) receiving events
- [ ] Structured logs shipped somewhere searchable; request ids present
- [ ] Health and readiness endpoints wired to the load balancer
- [ ] Celery worker and **exactly one** beat replica running; scheduled jobs observed to fire
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
Celery queue depth, inventory drift report, POS lookup latency.
