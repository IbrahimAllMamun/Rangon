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

## Which API serves

Since 2026-10-08 the NestJS API (`api-nest`) serves production, and Django starts on demand
([ADR-0017](../architecture/decisions/0017-nest-api-serves-production.md)). It answers every
request the Django API answered, serves uploaded files, works the background jobs and fires the
schedule ([ADR-0016](../architecture/decisions/0016-nest-jobs-on-pg-boss.md)). Django still owns
the schema: every migration is Django's.

| What you want | How |
|---|---|
| The shop, as it normally runs | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` -- `db`, `redis`, `api-nest`, `web`, `nginx` |
| A migration, `collectstatic`, any management command | `... run --rm api python manage.py <command>`. `run` starts a container of a service `up` leaves alone, and removes it afterwards |
| The Django admin, `/api/docs/`, `/api/schema/` | `... --profile django up -d api worker`, and `... --profile django stop api worker` when done. Until then nginx answers those three paths 503 and says so |
| Django for everything again | add `-f docker-compose.django.yml`, then `up -d` and restart nginx: see [Back to Django](#back-to-django) |

One thing the NestJS API does not do:

- **`GET /api/v1/` and `GET /api/v1/pos/`**, the router's index pages, are a 404. Nothing calls
  them.

**Errors are reported to Sentry when `SENTRY_DSN` is set**
([ADR-0019](../architecture/decisions/0019-nest-errors-to-sentry.md)): a request that ended in a
500, a background job that failed for good, and an exception that ends the process. Nothing
personal leaves with one -- no body, query string, header, cookie or user; the request id does,
which is the same id the client was shown and the log carries. `RANGON_ENV` names the environment
(`production` unless set) and `RANGON_RELEASE` the release (the image's `TAG` unless set). Two
things to know:

- **Django reports nothing, DSN or no DSN** ([D241](../roadmap.md#known-defects)): its settings
  ask for `sentry_sdk`, which is not installed, and the import failure is swallowed. Running on
  Django -- `docker-compose.django.yml` -- is running without error reporting until that is
  fixed.
- It has been tested against a stand-in for Sentry, not against a Sentry project. **Send one
  event on purpose after the first deploy** and see it arrive before trusting it.

**Uploads in object storage (`USE_S3=1`) work on either API** since 2026-10-08
([ADR-0018](../architecture/decisions/0018-nest-s3-without-an-sdk.md)), with three things to
know that boto used to hide:

- `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` must all be set; the NestJS API refuses to
  start without them and names the one missing. It does not look for an instance role or
  `~/.aws`.
- `S3_REGION` must be the bucket's own region (`us-east-1` if unset). A wrong one is a refused
  signature, where boto would have found the right one by itself. The compose files pass it
  through now; before, it was read from nowhere.
- A file's URL in a payload is `S3_ENDPOINT` + bucket + key (or the bucket's AWS address when
  `S3_ENDPOINT` is blank), exactly as Django builds it. **`S3_PUBLIC_ENDPOINT` is read by
  nothing** ([D238](../roadmap.md#known-defects)): if `S3_ENDPOINT` is a private address such as
  `http://minio:9000`, every image URL names a host no browser can reach. Point `S3_ENDPOINT` at
  an address both the API and the browser can use.

It has been proven against an S3 server in the parity stack, not against AWS itself.

A management command that queues a background job (`seed_demo` does: saving a category asks
the storefront to revalidate) queues it for Celery, and no Celery worker is running. Start one
for the command (`--profile django up -d worker`), or run the command with
`-e CELERY_TASK_ALWAYS_EAGER=1` so the job runs inline.

## Images

Multi-stage builds, non-root user, pinned base images, no secrets baked in.

```text
api-nest:  node:22-bookworm-slim (deps → build) → slim runtime, compiled JavaScript, appuser
api:       python:3.12-slim (builder: wheels) → slim runtime, gunicorn, appuser
web:       node:22-alpine (deps → build) → node:22-alpine runtime, Next.js standalone, nextjs user
```

Both API images run as uid 1001: uploads are on one volume, written by either.

Each image is built from its own directory, and what the builder is sent is decided by the
`.dockerignore` in that directory (`apps/api`, `apps/api-nest`, `apps/web`) -- not by the one at
the top of the repository, which no build reads. They are why an image built on a workstation is
the image CI builds: no local `media/`, caches or `.env` in the Django image, no local
`node_modules` or `.next` in the web image ([D240](../roadmap.md#known-defects)).

Tags are immutable and derived from the commit: `ghcr.io/<org>/rangon-api-nest:<git-sha>`,
`…/rangon-api:<git-sha>`, `…/rangon-web:<git-sha>`. `latest` may exist for convenience but is **never** what production
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

# 3. run migrations as a one-off job — NOT in every replica at startup.
#    Django's, whichever API serves: `run` starts the `api` service for this
#    one command though `up` does not start it.
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm api python manage.py migrate --noinput

# 3b. refresh the static assets Nginx serves from the api_static volume --
#     the Django admin's, for when it is started.
#     The image collects them at build time, but a named volume is seeded from
#     the image only the first time it is created — so without this step every
#     later release serves the FIRST release's Django-admin and DRF assets.
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm api python manage.py collectstatic --noinput

# 4. roll out the application, then have nginx look its upstreams up again:
#    it resolves them once, at start, and a recreated container has a new address
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api-nest web
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx

# 5. verify
curl -fsS https://<host>/api/health/ && curl -fsS https://<host>/api/ready/
./scripts/smoke-test.sh https://<host>
```

Application containers do **not** run `migrate` on start (`RUN_MIGRATIONS_ON_START` is only enabled in
development). Two replicas migrating simultaneously is how schemas get corrupted.

The NestJS API creates one thing in the database itself: the `pgboss` schema, its job queue's, the
first time it starts. The database role needs `CREATE` on the database for that (the role the
compose file creates owns the database, so it has it). Nothing of Django's is in that schema, and
`pg_dump` of the database carries it with everything else.

### The first release that cuts over

A deployment that has been running Django moves to the NestJS API with the release that contains
[ADR-0017](../architecture/decisions/0017-nest-api-serves-production.md), in this order:

1. Back up, migrate and `collectstatic` as above.
2. Stop taking traffic for the minute this takes (`stop nginx`), so nothing new is queued.
3. Let Celery finish what it holds, then stop Django:
   `exec redis redis-cli -n 1 llen celery` answers `0` when the queue is empty (the broker is
   database 1 unless `CELERY_BROKER_URL` says otherwise). Then `stop beat worker api`.
4. `up -d` with the new files: `api-nest` starts, creates the `pgboss` schema, and begins firing
   the schedule beat fired. The old `api`, `worker` and `beat` containers are no longer part of
   what `up` manages; `rm` them.
5. Smoke test, and place one order: its confirmation email is the proof the jobs run.

Uploads need nothing: both images run as uid 1001, and the volume is the same.

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
| The NestJS API itself, in a way the previous tag does not cure | [back to Django](#back-to-django): the same data, the other API |
| Config/secret | revert the secret-manager version, restart the affected service |
| Migration, backward-compatible | roll back the app only; the schema stays ahead — safe by design |
| Migration, destructive | restore from the pre-deploy backup ([disaster-recovery.md](disaster-recovery.md)) — this is why step 2 exists |

Rollback target time: application ≤ 10 minutes, database restore ≤ 60 minutes.

### Back to Django

One more file, laid last, serves the whole stack from Django again:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.django.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.django.yml restart nginx
```

It starts `api`, `worker` and `beat`, points the web app and nginx at `api`, and tells
`api-nest` to stop firing the schedule, which beat now fires. Nothing is lost by it: both APIs
write the same tables, and a token, a cart or a session from one is good on the other. Rate-limit
budgets and the cached product feeds start afresh, as each API keeps its own.

`api-nest` stays up, taking no requests, because the jobs it queued before the switch are rows
only it works. When this answers `0` it can be stopped:

```bash
docker compose ... exec db psql -U rangon -d rangon -Atc \
  "SELECT count(*) FROM pgboss.job WHERE state IN ('created', 'retry', 'active')"
```

Forward again, **stop Django first**. Without the file `up` no longer manages `api`, `worker`
and `beat`, and it leaves them running -- beat among them, beside an `api-nest` that has just
begun firing the schedule again:

```bash
# 1. nothing left for Celery (the broker is database 1 unless CELERY_BROKER_URL says otherwise)
docker compose ... exec redis redis-cli -n 1 llen celery        # 0
# 2. stop Django, with the file still named
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.django.yml stop beat worker api
# 3. the stack without the file, and nginx's upstreams looked up again
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx
```

**Never run beat and a scheduling `api-nest` together**: every scheduled job fires twice. The
file exists so that going back cannot be done by changing one setting and forgetting another;
going forward has this one order to keep.

## Health checks

- `/api/health/` — liveness; process is up. No dependency calls, so a database blip does not trigger a
  restart loop.
- `/api/ready/` — readiness; checks PostgreSQL and Redis, returns `503` when not ready so the load
  balancer stops sending traffic. Neither endpoint returns versions, settings or error detail.
- Compose/orchestrator healthchecks are defined for `db`, `redis`, `api-nest`, `api` and `web`.
- Both APIs answer both paths alike. The NestJS API's own healthcheck asks for
  `http://localhost:3000/api/health/`, so `localhost` must be in `DJANGO_ALLOWED_HOSTS`, as it must
  for Django's.

## Scaling order

The prod overlay starts at one of everything, sized for one shop on one host:

| Service | Processes | Concurrency | Memory |
|---|---|---|---|
| `api-nest` | 1 Node process: the API, the job worker and the schedule | one event loop; 10 database connections, 4 more for the queue | ~90 MB after warm-up, ~110 MB at the higher of two readings (measured 2026-10-08) |

And what Django costs when it is started (measured 2026-09-30):

| Service | Processes | Concurrency | Memory |
|---|---|---|---|
| `api` | gunicorn master + 2 workers | 4 threads each, 8 requests | ~235 MB per replica |
| `worker` | 1 Celery process, `--pool=threads` | 4 tasks | ~100 MB per replica |
| `beat` | 1 | — | ~98 MB |

Measured on the local prod stack after warm-up traffic. The method is in the roadmap's verification
log, 2026-09-30.

Raise these in order when a measurement says so, not before:

1. `api-nest` replicas (stateless behind the proxy; pg-boss gives each job, and each scheduled
   run, to one of them). If it is the jobs that crowd the requests rather than the reverse, split
   them instead: `RANGON_JOBS_WORKER=0` on `api-nest` and a second service of the same image
   started as `node dist/worker.js` (ADR-0016)
2. PostgreSQL vertical + read replica for reports
3. CDN in front of media and static assets

What follows is Celery's, and applies when Django is the one serving.

`beat` must stay at exactly **one** replica or scheduled jobs run twice. For the same reason it is not
folded into the worker with `celery worker -B`: that forks a separate beat process anyway (so it
saves little), Celery documents it as development-only, and a second worker replica would then
schedule every job twice.

The worker's thread pool **does not enforce `CELERY_TASK_TIME_LIMIT`** — only prefork does. A task
that blocks on the network is stopped by that call's own timeout instead (`EMAIL_TIMEOUT`, 30 s by
default; the storefront revalidation call's 5 s). Any new task that talks to the network must set
one.

## Reverse proxy

Nginx terminates TLS, redirects HTTP→HTTPS, sets security headers (HSTS, `X-Content-Type-Options`,
`Referrer-Policy`, CSP), gzip/brotli, request size limits, and routes `/api/*` and `/media/*` → the
API that serves (`RANGON_API_UPSTREAM`, set by the compose files), `/django-admin/`, `/api/docs/` and
`/api/schema/` → Django when it is running, everything else → web. Most API traffic does not pass
through it at all: the web app calls the API over the private network (`API_INTERNAL_URL`), which
is why the compose files set the two together. If the hosting platform already provides a managed load balancer with TLS, drop the Nginx service
and record that decision here rather than running two proxies.

**Whatever the topology, `DJANGO_TRUSTED_PROXY_HOPS` must equal the number of proxies in front of
the API** (both read the one setting). Every rate limit, and the audit trail's `ip_address`, count that many `X-Forwarded-For`
entries from the right; anything further left is written by the caller. One managed load balancer
instead of this Nginx is still 1. A CDN or tunnel in front of a proxy is 2. Set it too high, or
leave it at the default 0 behind a proxy, and the limits stop doing their job in one direction or
the other — [security.md](security.md#deploying-behind-a-proxy) has the table and the two rules, and
[D88](../roadmap.md#known-defects) is what happens without them. The API must also be unreachable
around the proxy, or a direct request carries no trusted entry at all.

A worked example of exactly that: [webuzo-deployment.md](webuzo-deployment.md), where the panel's own
web server terminates TLS and the project's Nginx container is not used. It also recorded three defects
in the shipped prod stack that stopped a first deploy. Two are fixed as of 2026-09-09: the Nginx
config is now a `templates/default.conf.template` the image renders with `envsubst`, so
`${RANGON_DOMAIN}` is substituted at start, and `api_static` is mounted on the `api` service and
refreshed by step 3b above. The third stands: the prod overlay sets `build: !reset null` on purpose,
because production pulls images CI built and scanned rather than building them on the server.
