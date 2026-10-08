# Disaster Recovery Runbook

Assume the reader is stressed and it is 2 a.m. Every procedure is copy-pasteable.

The API is `api-nest`, the NestJS one, since 2026-10-08; it also runs the background jobs. Django
(`api`) is started for a management command with `run --rm api ...` and is otherwise not running
([deployment.md](deployment.md#which-api-serves)). If Django is the one serving -- the stack was
started with `-f docker-compose.django.yml` -- read `api worker beat` wherever `api-nest` is
written below.

## 0. Triage

```bash
curl -fsS https://<host>/api/health/     # process alive?
curl -fsS https://<host>/api/ready/      # dependencies alive?
docker compose ps                        # which services are down?
docker compose logs --tail=200 api-nest db
```

| Symptom | Likely cause | Go to |
|---|---|---|
| `health` ok, `ready` 503 | database or Redis unreachable | §3 / §4 |
| both fail, containers restarting | bad release | §5 |
| data visibly wrong/missing | bad migration or deletion | §1 |
| storefront up, images broken | object storage / CDN | §2 |
| POS cannot sell but admin works | permissions/JWT or POS route | §6 |
| the API itself misbehaves and the previous release does not cure it | a fault in the NestJS API | §5a |

## 1. Restore the database

```bash
# 1. stop writes
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api-nest

# 2. fetch the backup
aws s3 cp s3://<backup-bucket>/rangon-prod-<timestamp>.dump ./restore.dump   # or provider CLI

# 3. restore into a NEW database first, never over the live one
createdb -h $POSTGRES_HOST -U $POSTGRES_USER rangon_restore
pg_restore -h $POSTGRES_HOST -U $POSTGRES_USER -d rangon_restore --no-owner --jobs 4 ./restore.dump

# 4. sanity check
psql -h $POSTGRES_HOST -U $POSTGRES_USER -d rangon_restore -c \
  "select (select count(*) from orders_order) orders,
          (select count(*) from inventory_inventorytransaction) ledger,
          (select max(created_at) from orders_order) latest_order;"

# 5. point the app at the restored database (DATABASE_URL), run migrations, start
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api python manage.py migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api-nest
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx

# 6. verify the ledger
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api python manage.py verify_inventory
```

A backup taken since the cutover carries the job queue too (the `pgboss` schema): jobs that were
waiting when it was taken are run again after the restore. An order confirmation may be sent a
second time; nothing that moves stock or money is retried.

Restoring over the live database destroys the evidence of what went wrong. Always restore beside it.

## 2. Restore media

```bash
aws s3 sync s3://<backup-bucket>/media/ s3://<live-bucket>/media/ --delete-after
```

If versioning is on, restore individual objects to a prior version instead of a bulk sync. Missing
images degrade the storefront but do not affect transactions — never take the shop offline for this.

## 3. Database unreachable

1. Is the instance running? Disk full? (`df -h`, provider console)
2. Connection limit reached? `select count(*) from pg_stat_activity;` — restart `api-nest` to drop
   leaked connections.
3. Credentials rotated without updating the secret? Check the secret version.
4. Network/security group change?

The application returns `503` from `/api/ready/` while the database is down; the load balancer stops
routing. Do not "fix" it by pointing production at the staging database.

## 4. Redis unreachable

Impact: caching and throttling degrade. Background jobs are not affected: since the cutover they
are queued in PostgreSQL, not Redis. (When Django serves, Celery's jobs queue up instead; restart
Redis, then check the worker drains.) By design, nothing financially critical depends on Redis --
that was measured for Django, **and has not been measured again for the NestJS API**: until it
is, treat a Redis outage as an outage and restart Redis first.

## 5. Failed deployment

```bash
export TAG=<previous-good-sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api-nest web
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx
curl -fsS https://<host>/api/ready/
```

If the release contained a **backward-compatible** migration, rolling back the app is enough — the schema
may safely stay ahead. If it contained a destructive migration, restore from the pre-deploy backup (§1).
This is why `backup-db.sh pre-deploy-$TAG` is step 2 of every release.

## 5a. The NestJS API is at fault: serve from Django

The same database, the same uploads, the other API. One more file, laid last:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.django.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.django.yml restart nginx
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/api/v1/     # 401: Django. 404: still the NestJS API
```

Nothing is lost by it. Leave `api-nest` running: it takes no requests, and the jobs it had queued
are its to finish. Coming back has an order to it -- [deployment.md](deployment.md#back-to-django).

## 6. Rotate secrets

```bash
# 1. new value in the secret manager (keep the old version)
# 2. restart consumers
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --force-recreate api-nest web
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx
# 3. verify, then disable the old version
```

Rotating `DJANGO_SECRET_KEY` invalidates sessions and password-reset links; rotating JWT signing keys
logs everyone out — announce it. Database password rotation must update the secret **before** the
database user's password is changed, or the app fails between the two steps.

## 7. Corrupted inventory data

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api python manage.py verify_inventory --branch <code>   # report drift
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api python manage.py verify_inventory --fix --reason "DR-<date> reconciliation"
```

`--fix` never edits the ledger. It writes explicit `ADJUSTMENT` rows that bring the cached columns back
in line, so the correction itself is auditable.

## 8. Complete environment rebuild

```bash
git clone <repo> && cd Rangon
# populate .env from the secret manager
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api python manage.py migrate
# restore data (§1) and media (§2)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
./scripts/smoke-test.sh https://<host>
```

## Contacts

| Role | Who | When |
|---|---|---|
| Owner / decision maker | _TBD_ | data loss, customer communication |
| Technical lead | _TBD_ | any of the above |
| Hosting provider | _TBD_ | infrastructure outage |
| Payment provider support | _TBD_ | settlement discrepancies |

Fill this table in before go-live.
