# ADR-0016 — The NestJS API runs its background jobs on pg-boss, in PostgreSQL

**Status:** Accepted · 2026-10-07 · built in phase 7 part 4 of the port, switched on at the cutover of 2026-10-08 ([ADR-0017](0017-nest-api-serves-production.md))

## Context

Django's background work is Celery: a worker and a beat scheduler, two Python processes of
about 96 MB and 98 MB (measured 2026-09-30), with Redis as the broker. Ten jobs:

| Kind | Task | What it does |
|---|---|---|
| queued | `notifications.tasks.send_order_email`, `send_order_sms` | tell a customer about their order |
| queued | `notifications.tasks.send_notification_email` | email a staff notice |
| queued | `inventory.tasks.notify_low_stock` | staff notices when a shelf falls to its reorder point |
| queued | `content.tasks.revalidate_storefront` | ask the web app to drop cached pages |
| every 5 min | `orders.tasks.release_expired_reservations` | cancel unpaid online orders past the window, free their stock |
| 01:30 | `inventory.tasks.verify_inventory_integrity` | the ledger against the cached stock; alert on drift |
| 03:00 | `orders.tasks.expire_abandoned_carts` | switch off carts idle for 30 days |
| 08:00 | `inventory.tasks.send_low_stock_digest` | one notice, and an email, of what needs reordering |
| 08:15 | `catalog.tasks.check_expiring_stock` | warn about stock near its expiry date |

Since phase 3 the NestJS API has queued its jobs for that same worker, by writing Celery's own
message into the broker ([ADR-0014](0014-nest-enqueues-celery-jobs.md)). That ADR left open what
replaces Celery once Django is gone. Three questions were put to the owner on 2026-10-07.

## Decision

1. **The queue is pg-boss, in PostgreSQL.** Not BullMQ on Redis, which the plan had pencilled
   in, and not a Node consumer of Celery's own queue.
2. **Jobs run in the API process by default, and can be split off by a setting.** One Node
   process serves requests, works the queue and fires the schedule; the same image started as
   a worker does only the last two.
3. **Celery is switched off at the cutover, not before.** Part 4 builds every job in Nest and
   proves each against its Celery twin; until paths move, Celery does the work and no Django
   code changes.

### Why pg-boss

A job is a row. It is written **inside the transaction that decides it**, so a checkout that
commits has its confirmation email queued and one that rolls back has queued nothing -- with no
window between the commit and the queue in which a broker outage loses the email. That window is
D116 today: Django answers 500 for an order it has placed, and the port answers 201 and logs.
With the job in the same transaction neither can happen.

It also means one store to back up and restore: a restored database has its pending jobs, and
no job refers to an order the restore lost.

### The exception this makes to "Django owns the schema"

pg-boss creates and migrates its own tables. Until now the rule was absolute: Django owns the
schema, the port never migrates ([ADR-0013](0013-nestjs-api-alongside-django.md)). The owner
chose pg-boss knowing this. The exception is bounded:

- pg-boss owns one PostgreSQL schema, `pgboss`, and nothing outside it. Every table Django
  knows stays in `public`, and Django still owns all of them.
- It is created by `boss.start()` the first time a Nest process starts with
  `RANGON_JOBS_BACKEND=pgboss`. The database role therefore needs `CREATE` on the database.
  A process started with the default backend creates nothing.
- Drizzle is still never migrated, and `npm run db:pull` still introspects `public` only.
- Django's migrations, its test databases, `seed_demo --reset` and the parity harness's
  table restores do not see the schema.

## Design

`apps/api-nest/src/jobs/`:

- **`Jobs`** is what every caller uses, and the one place the transport is chosen
  (`RANGON_JOBS_BACKEND`, `celery` by default, or `pgboss`). `delayIn(tx, ...)` queues inside
  the caller's transaction when the backend can; `delay(...)` queues at once.
- **`CeleryTransport`** is ADR-0014's writer, unchanged: Celery's message, after the commit.
- **`PgBossTransport`** owns the `PgBoss` instance. A queue per task, named for the Celery task
  it replaces (`notifications.tasks.send_order_email`), so the two transports are compared
  by name and arguments.
- **`JobHandlers`** are the ten tasks, each answering the word its Celery twin returns
  (`sent`, `skipped`, `released:2`).
- **`JobWorker`** registers the handlers and the schedule when `RANGON_JOBS_WORKER` is on
  (the default with the pg-boss backend). The schedule is the five lines of `config/celery.py`,
  in the shop's time zone as `CELERY_TIMEZONE` has them. `src/worker.ts` is the same
  application with no HTTP listener, for a separate worker container.
  `RANGON_JOBS_SCHEDULE=0` starts a worker that fires no schedule (added in part 4b): for one
  that runs beside Celery's beat before the cutover, and for the parity stack's.

**What is transactional.** A job decided inside a transaction is queued in it: checkout's
confirmation email and SMS, and the low-stock alert of any stock movement (`StockService.run`).
A job Django itself decides *after* its commit stays there -- the notice and messages of a
status change (`_notify_status` runs in `on_commit`) and a storefront revalidation -- because
moving them is a change to the order of work in write paths whose races are proven as they
stand. They can move inside once Django no longer serves those paths.

**Retries are Celery's.** The three senders retry three times, a minute or two apart, and the
revalidation twice, thirty seconds apart, and only for what their tasks retry: a mail or gateway
fault. Any other failure is logged and the job closed, as Celery fails a task it was not told
to retry, with the reason left on its row (`pgboss.job.output`: `{"result": null, "error":
"..."}`); the other six jobs never retry. Nothing is retried with backoff that Celery retries
at a fixed interval.

## Consequences

- **Two new dependencies**, both in the API's `package.json` at exact versions:
  `pg-boss` 12.37.0 (the queue; it brings `cron-parser`, `rrule-temporal` and
  `serialize-error`, and needs Node 22.12 or later, which the image has) and `nodemailer`
  10.0.16 (SMTP: Node has no client of its own, and Django's `send_mail` has to be replaced by
  something that speaks it).
- **Two fewer processes at the cutover**, about 195 MB, with the default layout.
- **Redis stays** for the rate limits and the page cache. It stops being a broker.
- **The API holds a second, small connection pool.** pg-boss keeps its own connections for
  polling and maintenance; it is capped at four.
- **While Django serves any path, both run.** Jobs Django queues go to Celery; jobs Nest queues
  go wherever `RANGON_JOBS_BACKEND` says. The schedule must fire in exactly one place: beat
  until the cutover, the Nest worker after it. Running both sends the 08:00 digest twice.
- **An email is no longer byte-identical.** nodemailer and Django's `EmailMessage` encode a
  message differently (header folding, transfer encoding, `Message-ID`). What is compared is
  what a reader sees: sender, recipients, subject, and the body's text.
- **A job row is visible.** `SELECT * FROM pgboss.job` answers "was the email queued?", which
  Redis never did.

## Alternatives considered

- **BullMQ on Redis.** The plan's first choice. Mature, with the same retries and scheduler,
  and no schema of its own -- but a job is queued after the commit, so the window D116 names
  stays open, and pending jobs live outside the database backup.
- **A Node worker reading Celery's queue.** No new queue and nothing for Django to change, but
  retries, delays and the schedule would be code this project writes and maintains.
- **Switch Celery off as soon as the jobs are proven.** Saves the two processes at once, but
  Django would have to queue into the new store while it still serves traffic: a change to
  Django's code and tests ahead of the cutover, for a saving the cutover brings anyway.
- **Always a separate worker.** Isolates request latency from a slow mail server from the first
  day, for one more process. Left as a setting rather than the default: the port began as a
  question about resources.
