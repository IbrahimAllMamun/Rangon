# Deployment

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Compose file | `docker-compose.yml` + `.dev.yml` | `.prod.yml` | `.prod.yml` |
| Database | container | **own** managed/self-hosted instance | own instance, durable storage, PITR |
| Redis | container | own instance | own instance |
| Media | MinIO container | own bucket | own bucket + CDN |
| Secrets | `.env` file | secret manager | secret manager |
| Debug | on | off | off |

**Staging must never point at the production database.** Separate databases, separate buckets,
separate credentials, separate Redis (or at least separate DB numbers).

## Images

Multi-stage builds, non-root user, pinned base images, no secrets baked in.

```text
api:  python:3.12-slim (builder: wheels) → slim runtime, gunicorn, appuser
web:  node:22-alpine (deps → build) → node:22-alpine runtime, Next.js standalone, nextjs user
```

Tags are immutable and derived from the commit: `ghcr.io/<org>/rangon-api:<git-sha>`,
`…/rangon-web:<git-sha>`. `latest` may exist for convenience but is **never** what production
references.

## Pipeline

```text
push → lint (ruff, eslint) → typecheck (mypy, tsc) → unit + integration tests (containerised PG/Redis)
     → build images → Trivy scan (fail on HIGH/CRITICAL, fixed) → push immutable tags
     → deploy staging → migrate job → smoke tests → E2E (Playwright)
     → manual approval → deploy production → migrate job → smoke tests
```

Defined in `.github/workflows/ci.yml` and `deploy.yml`.

## Release procedure

```bash
# 1. pull the exact images CI built and scanned
export TAG=<git-sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull

# 2. back up the database FIRST (see backups.md)
./scripts/backup-db.sh pre-deploy-$TAG

# 3. run migrations as a one-off job — NOT in every replica at startup
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm api python manage.py migrate --noinput

# 4. roll out the application
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api worker beat web

# 5. verify
curl -fsS https://<host>/api/health/ && curl -fsS https://<host>/api/ready/
./scripts/smoke-test.sh https://<host>
```

Application containers do **not** run `migrate` on start (`RUN_MIGRATIONS_ON_START` is only enabled in
development). Two replicas migrating simultaneously is how schemas get corrupted.

## Zero-downtime schema changes (expand/contract)

1. **Expand** — add the nullable column/table; deploy code that writes both old and new.
2. **Backfill** — data migration in batches, off-peak.
3. **Switch** — deploy code that reads the new shape.
4. **Contract** — a later release makes it non-null / drops the old column.

Never combine a destructive schema change with the code that stops using it in one release: rollback
becomes impossible.

## Rollback

| What broke | Action |
|---|---|
| Application bug | redeploy the previous immutable tag: `TAG=<previous-sha> docker compose … up -d` |
| Config/secret | revert the secret-manager version, restart the affected service |
| Migration, backward-compatible | roll back the app only; the schema stays ahead — safe by design |
| Migration, destructive | restore from the pre-deploy backup ([disaster-recovery.md](disaster-recovery.md)) — this is why step 2 exists |

Rollback target time: application ≤ 10 minutes, database restore ≤ 60 minutes.

## Health checks

- `/api/health/` — liveness; process is up. No dependency calls, so a database blip does not trigger a
  restart loop.
- `/api/ready/` — readiness; checks PostgreSQL and Redis, returns `503` when not ready so the load
  balancer stops sending traffic. Neither endpoint returns versions, settings or error detail.
- Compose/orchestrator healthchecks are defined for `db`, `redis`, `api` and `web`.

## Scaling order

1. `api` replicas (stateless behind the proxy)
2. `worker` replicas
3. PostgreSQL vertical + read replica for reports
4. CDN in front of media and static assets

`beat` must stay at exactly **one** replica or scheduled jobs run twice.

## Reverse proxy

Nginx terminates TLS, redirects HTTP→HTTPS, sets security headers (HSTS, `X-Content-Type-Options`,
`Referrer-Policy`, CSP), gzip/brotli, request size limits, and routes `/api/*` → api, everything else →
web. If the hosting platform already provides a managed load balancer with TLS, drop the Nginx service
and record that decision here rather than running two proxies.

A worked example of exactly that: [webuzo-deployment.md](webuzo-deployment.md), where the panel's own
web server terminates TLS and the project's Nginx container is not used. It also records three defects
in the shipped prod stack that stop a first deploy: `${RANGON_DOMAIN}` is never substituted, the
`api_static` volume is never populated, and the prod overlay cannot build images.
