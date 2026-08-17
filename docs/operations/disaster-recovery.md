# Disaster Recovery Runbook

Assume the reader is stressed and it is 2 a.m. Every procedure is copy-pasteable.

## 0. Triage

```bash
curl -fsS https://<host>/api/health/     # process alive?
curl -fsS https://<host>/api/ready/      # dependencies alive?
docker compose ps                        # which services are down?
docker compose logs --tail=200 api worker db
```

| Symptom | Likely cause | Go to |
|---|---|---|
| `health` ok, `ready` 503 | database or Redis unreachable | §3 / §4 |
| both fail, containers restarting | bad release | §5 |
| data visibly wrong/missing | bad migration or deletion | §1 |
| storefront up, images broken | object storage / CDN | §2 |
| POS cannot sell but admin works | permissions/JWT or POS route | §6 |

## 1. Restore the database

```bash
# 1. stop writes
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api worker beat

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
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api worker beat

# 6. verify the ledger
docker compose exec api python manage.py verify_inventory
```

Restoring over the live database destroys the evidence of what went wrong. Always restore beside it.

## 2. Restore media

```bash
aws s3 sync s3://<backup-bucket>/media/ s3://<live-bucket>/media/ --delete-after
```

If versioning is on, restore individual objects to a prior version instead of a bulk sync. Missing
images degrade the storefront but do not affect transactions — never take the shop offline for this.

## 3. Database unreachable

1. Is the instance running? Disk full? (`df -h`, provider console)
2. Connection limit reached? `select count(*) from pg_stat_activity;` — restart `api`/`worker` to drop
   leaked connections.
3. Credentials rotated without updating the secret? Check the secret version.
4. Network/security group change?

The application returns `503` from `/api/ready/` while the database is down; the load balancer stops
routing. Do not "fix" it by pointing production at the staging database.

## 4. Redis unreachable

Impact: Celery jobs queue up and caching/throttling degrade. **Sales, stock and checkout keep working** —
by design, nothing financially critical depends on Redis. Restart Redis, then check the worker drains.

## 5. Failed deployment

```bash
export TAG=<previous-good-sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api worker beat web
curl -fsS https://<host>/api/ready/
```

If the release contained a **backward-compatible** migration, rolling back the app is enough — the schema
may safely stay ahead. If it contained a destructive migration, restore from the pre-deploy backup (§1).
This is why `backup-db.sh pre-deploy-$TAG` is step 2 of every release.

## 6. Rotate secrets

```bash
# 1. new value in the secret manager (keep the old version)
# 2. restart consumers
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api worker beat web
# 3. verify, then disable the old version
```

Rotating `DJANGO_SECRET_KEY` invalidates sessions and password-reset links; rotating JWT signing keys
logs everyone out — announce it. Database password rotation must update the secret **before** the
database user's password is changed, or the app fails between the two steps.

## 7. Corrupted inventory data

```bash
docker compose exec api python manage.py verify_inventory --branch <code>   # report drift
docker compose exec api python manage.py verify_inventory --fix --reason "DR-<date> reconciliation"
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
