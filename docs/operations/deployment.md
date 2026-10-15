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

## What runs

The API (`api-nest`, apps/api-nest) answers every request, serves uploaded files, works the
background jobs and fires their schedule, all in one Node process; the jobs are rows in PostgreSQL
([ADR-0016](../architecture/decisions/0016-nest-jobs-on-pg-boss.md)), so Redis holds the cache and
the rate limits and nothing else. Django served until 2026-10-08 and was removed on 2026-10-14
([ADR-0023](../architecture/decisions/0023-django-is-gone.md)).

| What you want | How |
|---|---|
| The shop, as it normally runs | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` -- `db`, `redis`, `api-nest`, `web`, `nginx` |
| A migration, or any operator's command | `... run --rm api-nest node dist/cli.js <command>` ([operator-commands.md](operator-commands.md)). `run` starts a container beside the serving one and removes it afterwards |

One thing the API does not do:

- **`GET /api/v1/` and `GET /api/v1/pos/`**, Django's router index pages, are a 404. Nothing calls
  them.

**Errors are reported to Sentry when `SENTRY_DSN` is set**
([ADR-0019](../architecture/decisions/0019-nest-errors-to-sentry.md)): a request that ended in a
500, a background job that failed for good, and an exception that ends the process. Nothing
personal leaves with one -- no body, query string, header, cookie or user; the request id does,
which is the same id the client was shown and the log carries. `RANGON_ENV` names the environment
(`production` unless set) and `RANGON_RELEASE` the release (the image's `TAG` unless set). Two
things to know:

- It has been tested against a stand-in for Sentry, not against a Sentry project. **Send one
  event on purpose after the first deploy** and see it arrive before trusting it.

**Uploads in object storage (`USE_S3=1`)** ([ADR-0018](../architecture/decisions/0018-nest-s3-without-an-sdk.md))
come with three things to know that Django's boto used to hide:

- `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` must all be set; the NestJS API refuses to
  start without them and names the one missing. It does not look for an instance role or
  `~/.aws`.
- `S3_REGION` must be the bucket's own region (`us-east-1` if unset). A wrong one is a refused
  signature, where boto would have found the right one by itself. The compose files pass it
  through now; before, it was read from nowhere.
- A file's URL in a payload is `S3_ENDPOINT` + bucket + key (or the bucket's AWS address when
  `S3_ENDPOINT` is blank), exactly as Django built it. **`S3_PUBLIC_ENDPOINT` is read by
  nothing** ([D238](../roadmap.md#known-defects)): if `S3_ENDPOINT` is a private address such as
  `http://minio:9000`, every image URL names a host no browser can reach. Point `S3_ENDPOINT` at
  an address both the API and the browser can use.

It was proven against an S3 server, compared with Django, not against AWS itself.

## Images

Multi-stage builds, non-root user, pinned base images, no secrets baked in.

```text
api-nest:  node:22-bookworm-slim (deps → build) → slim runtime, compiled JavaScript and the
           migrations, appuser (uid 1001, the uid Django's image wrote uploads as)
web:       node:22-alpine (deps → build) → node:22-alpine runtime, Next.js standalone, nextjs user
```

Each image is built from its own directory, and what the builder is sent is decided by the
`.dockerignore` in that directory (`apps/api-nest`, `apps/web`) -- not by the one at the top of the
repository, which no build reads. They are why an image built on a workstation is the image CI
builds: no local `node_modules`, `dist` or `.next` ([D240](../roadmap.md#known-defects)).

Tags are immutable and derived from the commit: `ghcr.io/<org>/rangon-api-nest:<git-sha>`,
`…/rangon-web:<git-sha>`. `latest` may exist for convenience but is **never** what production
references.

## Pipeline

```text
push → lint (eslint, prettier) → typecheck (tsc) → unit tests → migrations on a new and an adopted database
     → the API against its recorded answers → the browser suite → build images → Trivy scan (fail on HIGH/CRITICAL, fixed) → push immutable tags
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

# 3. migrate as a one-off job -- NOT in every replica at startup -- with the
#    new image, then make the roles match it
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm api-nest node dist/cli.js migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm api-nest node dist/cli.js sync-permissions

# 4. roll out the application, then have nginx look its upstreams up again:
#    it resolves them once, at start, and a recreated container has a new address
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api-nest web
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx

# 5. verify
curl -fsS https://<host>/api/health/ && curl -fsS https://<host>/api/ready/
./scripts/smoke-test.sh https://<host>
```

The API does **not** migrate on start. Two replicas migrating simultaneously is how schemas get
corrupted. [migrations.md](../database/migrations.md) says what `migrate` does to which database.

The NestJS API creates one thing in the database itself: the `pgboss` schema, its job queue's, the
first time it starts. The database role needs `CREATE` on the database for that (the role the
compose file creates owns the database, so it has it). `pg_dump` of the database carries it with
everything else.

### The release that removes Django

A deployment still running Django, or running the NestJS API with Django on demand, reaches this
release in two steps, never one:

1. **The last release that has Django** -- `c5f4e81`, the merge of PR #105 -- with its own release
   procedure: Django's `migrate` brings the database to the Django migrations this release's
   baseline stands for (`apps/api-nest/drizzle/django-head.json`). A deployment still on Django
   crosses the cutover there as that release's documents say
   ([upgrading-local-production.md](upgrading-local-production.md), step 6-once).
2. **This release**, with the procedure above. `migrate` adopts the database -- it records the
   baseline as applied and runs nothing of it -- then applies `0001`, which drops the tables only
   Django's framework used. Stop the old `api`, `worker` and `beat` containers if any are left:
   `up -d --remove-orphans`.

`migrate` refuses a database at fewer Django migrations than that, and says which: take it through
step 1 first. Nothing changes in the meantime, so the refusal is safe to meet.

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

There is no other API to go back to. The previous release's API image runs on a database `0001`
has migrated -- it never read the tables `0001` dropped -- so redeploying the previous tag is a
rollback as for any release. What cannot come back is that release's Django: it needs those tables.

## Health checks

- `/api/health/` — liveness; process is up. No dependency calls, so a database blip does not trigger a
  restart loop.
- `/api/ready/` — readiness; checks PostgreSQL and Redis, returns `503` when not ready so the load
  balancer stops sending traffic. Neither endpoint returns versions, settings or error detail.
- Compose/orchestrator healthchecks are defined for `db`, `redis`, `api-nest` and `web`.
- The API's own healthcheck asks for `http://localhost:3000/api/health/`, so `localhost` must be in
  `DJANGO_ALLOWED_HOSTS`.

## Scaling order

The prod overlay starts at one of everything, sized for one shop on one host:

| Service | Processes | Concurrency | Memory |
|---|---|---|---|
| `api-nest` | 1 Node process: the API, the job worker and the schedule | one event loop; 10 database connections, 4 more for the queue | ~90 MB after warm-up, ~110 MB at the higher of two readings (measured 2026-10-08) |

Raise these in order when a measurement says so, not before:

1. `api-nest` replicas (stateless behind the proxy; pg-boss gives each job, and each scheduled
   run, to one of them). If it is the jobs that crowd the requests rather than the reverse, split
   them instead: `RANGON_JOBS_WORKER=0` on `api-nest` and a second service of the same image
   started as `node dist/worker.js` (ADR-0016)
2. PostgreSQL vertical + read replica for reports
3. CDN in front of media and static assets

A job that talks to the network is stopped by that call's own timeout (`EMAIL_TIMEOUT`, 30 s by
default; the storefront revalidation call's 5 s), and pg-boss takes a job that has run ten minutes to
have died. Any new job that talks to the network must set one.

## Reverse proxy

Nginx terminates TLS, redirects HTTP→HTTPS, sets security headers (HSTS, `X-Content-Type-Options`,
`Referrer-Policy`, CSP), gzip/brotli, request size limits, and routes `/api/*` and `/media/*` → the
API (`RANGON_API_UPSTREAM`, set by the compose files), `/django-admin/`, `/api/docs/` and
`/api/schema/` → 404 (Django's, dropped), everything else → web. Most API traffic does not pass
through it at all: the web app calls the API over the private network (`API_INTERNAL_URL`), which
is why the compose files set the two together. If the hosting platform already provides a managed load balancer with TLS, drop the Nginx service
and record that decision here rather than running two proxies.

**Whatever the topology, `DJANGO_TRUSTED_PROXY_HOPS` must equal the number of proxies in front of
the API.** Every rate limit, and the audit trail's `ip_address`, count that many `X-Forwarded-For`
entries from the right; anything further left is written by the caller. One managed load balancer
instead of this Nginx is still 1. A CDN or tunnel in front of a proxy is 2. Set it too high, or
leave it at the default 0 behind a proxy, and the limits stop doing their job in one direction or
the other — [security.md](security.md#deploying-behind-a-proxy) has the table and the two rules, and
[D88](../roadmap.md#known-defects) is what happens without them. The API must also be unreachable
around the proxy, or a direct request carries no trusted entry at all.

The defects the 2026-09 Webuzo plan recorded in the shipped prod stack stand as they were: two are
fixed (the Nginx config is a `templates/default.conf.template` the image renders with `envsubst`, so
`${RANGON_DOMAIN}` is substituted at start; Django's static files went with Django), and the third
holds on purpose: the prod overlay sets `build: !reset null`, because production pulls images CI
built and scanned rather than building them on the server.

A deployment with no proxy of the project's own: [webuzo-deployment.md](webuzo-deployment.md), done
once with the demo shop. There Next.js is the only public process, behind the panel's web server,
and the API listens on 127.0.0.1 with `DJANGO_TRUSTED_PROXY_HOPS=0`: every request it sees comes from
Next.js.
