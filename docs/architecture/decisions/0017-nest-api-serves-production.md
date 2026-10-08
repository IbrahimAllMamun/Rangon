# ADR-0017 — The NestJS API serves production; Django starts on demand

**Status:** Accepted · 2026-10-08 · phase 7 part 5 of the port, the cutover

## Context

The NestJS API was built beside Django, on Django's database, and proven equal to it request
by request ([ADR-0013](0013-nestjs-api-alongside-django.md)). By 2026-10-08 it answered every
path and method Django's router has -- the two route tables were dumped and compared, and each
of Django's is among the port's 326 -- and ran every background job
([ADR-0016](0016-nest-jobs-on-pg-boss.md)). Nothing routed to it.

Three things about the stack shaped what a cutover is:

- **The proxy is not where most API traffic passes.** The web app calls the API server-side,
  straight over the private network (`API_INTERNAL_URL`), and its `/api/proxy/*` route does the
  same for the browser. Nginx's `/api/` carries only what reaches the API directly: webhooks,
  the product feeds. A switch "at the proxy", as ADR-0013 pictured it, would move the feeds
  and leave the shop on Django.
- **There is no deployed environment yet** (roadmap, phase 30), so no traffic is at risk from the
  order in which paths move. There *is* one running shop: the local production stack on the
  owner's machine holds real data and serves it, on Django. This decision reaches it at its next
  upgrade, which is why that upgrade has a step of its own
  ([upgrading-local-production.md](../../operations/upgrading-local-production.md)).
- **Django serves five things the port does not have**, none of them the API itself: the
  Django admin, the OpenAPI schema and its Swagger page, the router's index pages
  (`/api/v1/`, `/api/v1/pos/`), and -- until this part -- uploaded files at `/media/`.

Four questions were put to the owner on 2026-10-08.

## Decision

1. **One switch, all paths.** Which API the whole stack talks to is one setting, not a table of
   paths. Going back is the same setting.
2. **Django starts only on demand.** Day to day its API, its Celery worker and beat do not run.
   They are started for a migration or a management command, for the Django admin and the API
   docs when someone wants them, and to go back.
3. **The NestJS API is the default in the production compose files**, from the merge of this
   part: `docker-compose.prod.yml` and `docker-compose.prodlocal.yml` run it unless told
   otherwise.
4. **A business rule still changes in Django first**, with its tests, and is then ported; the
   parity harness stays the proof. To be looked at again once the NestJS API has run in
   production for a while.

## Design

**The switch is which compose files are laid together.** The production overlays start
`api-nest` and point two things at it: the web app's `API_INTERNAL_URL`, and nginx's
`RANGON_API_UPSTREAM`, which `/api/` and `/media/` follow. One more file,
`docker-compose.django.yml`, laid over either overlay, turns all of it back at once:

| | default | with `-f docker-compose.django.yml` |
|---|---|---|
| The web app calls | `api-nest:3000` | `api:8000` |
| Nginx sends `/api/`, `/media/` to | `api-nest:3000` | `api:8000` |
| Started by `up` | `api-nest` | `api-nest`, `api`, `worker`, `beat` |
| The schedule is fired by | `api-nest` (pg-boss) | `beat` (`RANGON_JOBS_SCHEDULE=0` on `api-nest`) |
| Jobs a request queues go to | PostgreSQL, run by `api-nest` | Celery, run by `worker` |

A file rather than a variable, because the four parts must move together and compose cannot
derive one from another: a stack whose web app calls one API while nginx sends webhooks to the
other, or in which both beat and `api-nest` fire the sweep, is worse than either choice.
`COMPOSE_FILE` in the environment file makes it one line for a deployment that wants that.

**Django on demand is a compose profile.** `api` and `worker` carry `profiles: [django]`; `beat`
carries one that only the rollback file switches on, because the schedule must fire in one
place. Three uses:

- `run --rm api python manage.py migrate` (or any command). `run` starts a service whose profile
  is off, and the database it depends on. Django still owns the schema.
- `--profile django up -d api worker`, for the Django admin and the API docs. Nginx sends
  `/django-admin/`, `/api/schema/` and `/api/docs/` to Django whichever API serves, resolving
  its name per request so that nginx starts without it; while Django is down they answer 503
  and say how to start it. The worker comes too: what the admin queues goes to Celery, and
  with no worker would wait in Redis until one next started.
- The rollback file.

In the base file `api-nest` is behind a profile of its own. The development stack is still
Django's -- rules change there first -- and is unchanged.

**The NestJS API serves `/media/`.** With `USE_S3=0` the files are on the API's disk and nothing
else has them, in development and in the E2E job as much as behind nginx. `media/media.ts` is
`core.media.serve_media` over `django.views.static.serve`, compared with it case by case: the
private prefix (receipts, D91), the refusal to leave the root, `If-Modified-Since`, the type
table Python has in the Django image, `Content-Disposition`. Nginx's own lock on
`/media/expenses/` stays.

**One uid.** Uploads live on a volume the Django image created and wrote as uid 1001. The
NestJS image ran as `node`, 1000; it now runs as `appuser`, 1001, as Django's does, so either
can replace what the other stored. Its files are root's and read-only to it.

**Jobs.** `api-nest` runs with `RANGON_JOBS_BACKEND=pgboss`: it queues in PostgreSQL, works
the queues and fires the schedule, in the API process (ADR-0016). pg-boss creates its `pgboss`
schema at first start; the database role needs `CREATE` on the database.

## Consequences

- **About 430 MB less, day to day**: Django's API (about 235 MB), its worker (100 MB) and beat
  (98 MB) are not running. Measured figures for the stack as it now runs are in the roadmap's
  verification entry for this part.
- **`USE_S3=1` is not supported by the default.** The NestJS API refuses to start with it:
  django-storages' uploads and URLs are not ported. Every documented deployment uses
  `USE_S3=0`. A deployment on object storage runs Django, with the rollback file, until that is
  ported.
- **Errors are not reported to Sentry.** Django's production settings initialise it from
  `SENTRY_DSN`; the NestJS API logs to its container's output and nothing else.
- **The Django admin, `/api/docs/` and `/api/schema/` are down unless started.** So are the
  router's index pages for good: `GET /api/v1/` and `GET /api/v1/pos/` are a 404 from the
  NestJS API. Nothing in the web app calls any of them.
- **Two codebases for the same rules, still.** Decision 4 keeps Django the specification. The
  cost ADR-0013 named has not gone: a rule changed in one and not the other is caught by the
  parity harness, which CI still runs, and by nothing else.
- **Going back loses nothing, in either direction.** Both APIs write the same tables; tokens,
  carts and sessions are good on either. What does not carry over is in Redis and small: each
  API's own rate-limit buckets and its own cached feeds. Jobs queued before a switch are run
  by the side that queued them, which is why `api-nest` stays up under the rollback file and
  why Celery's queue should be empty before Django's worker is stopped.
- **CI builds and scans the NestJS image, runs the comparison with pg-boss as well, and drives
  the browser suite against both APIs.** The suite had never run on the NestJS API; its first run
  found nothing wrong with the API and one thing wrong with the suite (eleven sign-ins a minute
  against a limit of ten, hidden until then by Django's pace).

## Alternatives considered

- **Stages, by path.** An internal gateway routing each path prefix to one API, groups moved one
  at a time. Right for a shop with traffic; here there is none to protect, and it is a gateway
  to build, to keep in step with two routers, and to remove.
- **A small Django always on**, for the admin and the docs. Convenient, for 150 to 235 MB that
  the port was started to save.
- **Django kept running in full, as a standby.** An instant rollback and no saving. The rollback
  file is one `up -d` away instead.
- **Django stays the default, the switch built and left off.** Merging would then change nothing
  for a deployment. The owner chose to cut over with the merge.
- **A network alias as the switch** (whichever API holds the name `api`): no variable in nginx's
  configuration, but two containers answering to one name is a split nobody would see.
