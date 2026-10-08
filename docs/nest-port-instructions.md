# Instructions for the NestJS port

Everything needed to continue porting the Django API to NestJS (`apps/api-nest/`) without having been
there for phases 1–4: the rules, the owner's decisions, the machine's traps, the exact commands, the
method, the lessons that cost time, and what comes next. Written 2026-10-01, when phase 3 was done;
brought up to date when phase 4 was.

Read these alongside it:

| Document | What it holds |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | the project's permanent rules; they outrank this file |
| [architecture/nest-port.md](architecture/nest-port.md) | the port's status, every ported endpoint, the race checks, every deliberate difference and copied defect |
| [ADR-0013](architecture/decisions/0013-nestjs-api-alongside-django.md) | why NestJS, why beside Django on one database |
| [ADR-0014](architecture/decisions/0014-nest-enqueues-celery-jobs.md) | why Nest queues Celery tasks for Django's worker |
| [roadmap.md](roadmap.md) | the verification log (one entry per part) and the known-defects table (D-numbers) |
| [business-rules.md](business-rules.md) | the rules a port must reproduce, and every `DECISION REQUIRED` |
| [.claude/environment.md](../.claude/environment.md) | the traps of the Windows workstation; §2 below covers the Linux one |

---

## 1. The rules that do not bend

1. **Django owns the schema and every business rule.** Never write a Drizzle migration. After a
   Django migration, re-introspect (`npm run db:pull`). To change a rule, change it in Django first,
   with its tests, and then port it. One bounded exception, the owner's (ADR-0016): pg-boss
   creates and migrates its own PostgreSQL schema, `pgboss`, and nothing outside it.
2. **A ported endpoint answers exactly as Django does**, and the proof is the parity harness, not
   review. It compares status, media type, the headers that matter (`Location`, `Allow`,
   `WWW-Authenticate`, request id) and every JSON value. For writes it also compares every row
   written and every job queued.
3. **The Nest API serves production** (ADR-0017, 2026-10-08): the production compose files run
   it, and start Django only on demand. So a difference between the two APIs is no longer a
   drift in a side project: whichever way it goes, production has the wrong one. The development
   stack is still Django's, and `docker-compose.django.yml` puts production back on Django.
4. **A write path is ported only with its row locks and its concurrency tests.** Stock and money go
   through one transaction with `SELECT … FOR UPDATE` on the rows whose invariant is protected. The
   race is driven across both APIs at once. Then the lock is removed and the test must fail
   (§6.4).
5. **Copy Django's defects; don't fix them in the port.** The two APIs must agree until Django is
   fixed. List each copied defect in `nest-port.md`. **Exception: a security hole** is fixed in
   Django first, on its own branch, and the port implements the fixed rule (D113 is the example).
6. **A deliberate difference is declared twice**: in `parity/known-differences.ts`, so the harness
   accepts it, and in the "Deliberate differences" table of `nest-port.md`, with the reason. Anything
   else that differs fails the run.
7. **Money never becomes a JavaScript number.** Postgres `numeric` arrives as a string. Arithmetic
   goes through `Dec` (`src/common/decimal.ts`: Python's default context, 28 digits, half-even).
   Cents use `quantize` (half-up) and `money()` (`src/checkout/pricing.ts`), which also keeps
   Python's `-0.00`.
8. **No secrets in the repository.** Test passwords live only in the parity fixtures. Settings come
   from the environment (`src/config/env.ts` reads the same variables Django reads).
9. **Never delete or skip a failing test or parity case to get green.** Find the cause. Twice in
   phase 3 the "flaky" case was a real bug (§8).

## 2. The owner's decisions so far

| When | Asked for / decided | Consequence |
|---|---|---|
| 2026-09-29 | Would Express or NestJS use fewer resources? | measured first; NestJS chosen over Express (ADR-0013) |
| 2026-09-30 | Tune Django first | done (PR #70); it cut memory by a quarter |
| 2026-09-30 | A NestJS API **alongside** Django: **full API parity, phased**, on **Django's own database** | the port, phases 1–7 (`nest-port.md`) |
| 2026-09-30 | Background jobs from Nest: **enqueue Celery tasks** (the recommended option) | ADR-0014: Nest writes Celery's message to Django's broker; Django's worker sends the email and SMS |
| Standing | Work is started phase by phase on request ("start phase N", "continue phase N") | one branch per phase; each part committed separately |
| Standing | Pull requests only when the owner runs the create-pr command, as **ready, not draft**, base `main` | never push or open a PR unasked |
| Standing | After finishing a phase, write down the instructions | this file; keep it current |
| 2026-10-07 | Which queue replaces Celery? | **pg-boss, in PostgreSQL** (not BullMQ, which the plan had): a job is written in the transaction that decides it. pg-boss owns the `pgboss` schema: ADR-0016 |
| 2026-10-07 | Where do the jobs run? | **In the API process, separable by a setting** (`RANGON_JOBS_WORKER=0` and `node dist/worker.js`) |
| 2026-10-07 | When is Celery switched off? | **At the cutover.** Until then `RANGON_JOBS_BACKEND` stays `celery` and no Django code changes |
| 2026-10-08 | How does traffic move? | **One switch, all paths** (not per path): which compose files are laid together. ADR-0017 |
| 2026-10-08 | What does Django do afterwards? | **Starts only on demand**: migrations and commands (`run --rm api`), the admin and docs (`--profile django`), going back (`docker-compose.django.yml`) |
| 2026-10-08 | Which API do the production compose files run by default? | **The Nest API**, from the merge of phase 7 part 5 |
| 2026-10-08 | Where does a rule change first, after the cutover? | **Still Django**, with its tests, then the port. To be revisited once the Nest API has run in production for a while |
| 2026-10-02 | D115: may the counter sell units reserved for online orders? | **No by default; the owner may allow it shop-wide** (`Organization.counter_sells_reserved`, owner-only), and the online orders left short are flagged for staff ([business-rules.md §1.4](business-rules.md)). Fixed in Django first; phase 5 ports it with the POS |

Waiting on the owner, each written up as DECISION REQUIRED in `business-rules.md` with the code's
present behaviour as the default, and copied by the port as it stands:

| Where | The question | Found as |
|---|---|---|
| §7.1 | May an administrator manage owners -- make one, reset one's password, become one? The rule says only an owner manages staff; the code gives `ADMIN` every permission | D221 |
| §7.1 | Should the organisation's `status` be editable at all? Switched off, it cannot be read, and the next edit creates a second one | D225 |
| §8a.3 | Which tracking update ships an order, what a returned parcel does to it, and whether a parcel may go backwards | D209, D210 |
| §8a.3 | May a parcel be edited or deleted once it has left? | D206 to D208 |
| §7a.3 | May a supplier that is switched off be a variant's preferred supplier? | D182 |
| §7b.2, §7b.3 | A return to a supplier of units reserved for orders; and whether it is credited at the order's cost or the delivery's | D193, D185 |
| §7c | May a draft purchase order be received? | D186 |

## 3. The machine

Phases 1–3 ran on a Linux workstation with Docker and **no Node on the host**. (The Windows traps
are in `.claude/environment.md`.)

- **Node runs in a container**: `node:22-bookworm-slim`, with the working copy mounted at `/app`.
- **Docker cannot mount `/tmp` paths here.** Put scratch files you need inside a container under
  `~/.cache/rangon-scratch/`.
- **Always pass `-p rangon-nest`** to `docker compose -f docker-compose.nest.yml`. `.env` sets
  `COMPOSE_PROJECT_NAME=rangon`; without `-p` these containers join the development project.
- The parity stack listens on loopback only: **8610 Django, 8620 Nest.**
- The host clock is `Asia/Dhaka`; containers run UTC. Around midnight in Dhaka, "today" differs.
- A Python edit script that anchors on exact text fails after Prettier has reformatted the file.
  Re-read the file, or anchor on a smaller unique string.

## 4. Commands

### Nest checks (run from `apps/api-nest/`)

The whole gate in one container: format, typecheck (API and harness), lint, format check, unit
tests, build.

```bash
docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp -e npm_config_update_notifier=false -v "$PWD":/app -w /app node:22-bookworm-slim sh -c '
npx prettier --write "{src,test,parity}/**/*.ts" >/dev/null
npm run -s typecheck > /tmp/tc.log 2>&1; tc=$?; tail -8 /tmp/tc.log
npm run -s lint > /tmp/lint.log 2>&1; lint=$?; tail -8 /tmp/lint.log
npm run -s format:check > /tmp/fmt.log 2>&1; fmt=$?
npm test -- --silent > /tmp/test.log 2>&1; t=$?; grep -E "Tests:|Suites:|✕|●" /tmp/test.log | head -20
npm run -s build > /tmp/build.log 2>&1; b=$?; tail -3 /tmp/build.log
echo "typecheck=$tc lint=$lint format=$fmt test=$t build=$b"'
```

All five must print 0 before a commit.

### The parity stack (run from the repository root)

```bash
scripts/nest-parity.sh reset
```

Drops the parity database, starts both APIs, seeds the demo data and applies every fixture. Use
it before a run you will report, and after any manual probe that wrote to the database.

```bash
scripts/nest-parity.sh up
```

Rebuilds and restarts both APIs. **The Nest service runs the built image**, so after any change
under `src/`, run `up` before `run`, or you are testing the old code.

```bash
scripts/nest-parity.sh run
```

Every case against both APIs, then the race checks. It exits non-zero on any unexplained
difference or failed race. Filters:

- `PARITY_ONLY=webhook` runs only the cases whose name contains the text. **The race checks do not
  run** under a filter unless it is `PARITY_ONLY=concurrency`, which runs the races alone.
- `PARITY_VERBOSE=1` prints each case's Django response and effects. Use it to check that a case
  exercises what its name claims.
- `PARITY_RACES=returns`, with `PARITY_ONLY=concurrency`, runs only the race groups whose name
  contains the text (the names are in `run.ts`): one part's races in a minute, not all in ten.

```bash
docker compose -p rangon-nest -f docker-compose.nest.yml --profile throttle up -d --build --force-recreate nest-throttled django-throttled
```

```bash
docker compose -p rangon-nest -f docker-compose.nest.yml --profile throttle run --rm throttle-check
```

Rate limits are off in the parity stack, so they are compared on their own, with both APIs'
limits on. Rebuild the throttled pair after changing the source.

```bash
scripts/nest-parity.sh run-jobs
```

The whole comparison again with the Nest API queuing its jobs in pg-boss (`nest-jobs`, port
8630, built and recreated by the command). It takes `PARITY_ONLY` and `PARITY_RACES` as `run`
does; `PARITY_ONLY=concurrency PARITY_RACES=jobs` runs the three transaction checks alone.
Run it after `run`, on the same database: a part that queues a job passes both. It ends with
the worker check:

```bash
scripts/nest-parity.sh worker
```

The worker itself (`nest-worker`, the image run as `node dist/worker.js`, schedule off) on what
`nest-jobs` queues: a job run, one retried, one closed (`parity/worker-check.ts`). It empties
`pgboss.job` first -- the worker would run whatever the comparison left -- and removes the
worker afterwards: it must not be up during a comparison, where a queued job stays queued to
be read.

```bash
PARITY_ONLY="jobs: " PARITY_VERBOSE=1 scripts/nest-parity.sh run
```

The ten handlers beside their Celery tasks, each run on demand, with what each wrote and
sent. `PARITY_ONLY=concurrency PARITY_RACES=sweep` runs the reservation sweep's races.

### The stack production runs (run from the repository root)

```bash
scripts/e2e-local.sh nest
```

The browser suite (`apps/web/e2e`) against the web app's production build on the Nest API, as CI's
E2E job runs it: a fresh database, migrated and seeded by Django, everything in containers named
`rangon-e2e-*`. `django` in place of `nest` is the other leg. About five minutes once the images
exist. The parity harness compares the API; this is the only check that the shop works through it.

```bash
DJANGO_DEMO_SEED_PASSWORD='<a password of your own>' scripts/rebuild-local-prod.sh
```

The local production stack (`-p rangon-prod`, port 4100) built from nothing, as the production
compose files now start it: `api-nest` serving, Django migrating and seeding in one-off containers.
**It begins with `down -v` on that project. Never run it on a machine whose `rangon-prod` stack
holds a shop** -- the owner's does (`docs/operations/upgrading-local-production.md`). Check first:
`docker volume ls | grep rangon-prod`.

Which API is answering, on any stack: `curl -s -o /dev/null -w '%{http_code}' <origin>/api/v1/` --
`404` is the Nest API, `401` is Django. Back to Django and forward again:
`docs/operations/deployment.md`, "Back to Django" (the order matters: stop Django before leaving
the rollback file out).

### Django-side checks

Parity settings and fixtures are Python. Lint what you touched inside the running container:

```bash
docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django sh -c 'ruff check config/settings/parity.py /opt/parity-gateway && ruff format --check config/settings/parity.py /opt/parity-gateway'
```

For a Django change (a fixed defect, a new rule), run the Django suite the way CLAUDE.md §14 says.

## 5. Where things are

```text
apps/api-nest/
  src/
    main.ts, app.factory.ts   createApp() builds the app; main.ts only listens
    config/env.ts             the environment, read as Django reads it
    database/                 the pool, transactions, schema.ts (introspected, never migrated)
    http/                     request bodies (raw bytes, parsed lazily as DRF does), routes, pipeline
    http/negotiation.ts       DRF's content negotiation: `?format=` and `Accept`, before authentication
    jobs/jobs.service.ts      `Jobs`: where background work is handed over, and the one place the
                              transport is chosen; `queues.ts` names each job and its retries
    jobs/pg-boss.service.ts   the pg-boss queue (ADR-0016); `celery.service.ts` is ADR-0014's writer
    jobs/job-handlers.service.ts
                              the ten jobs, each answering the word its Celery task returns;
                              `RetryJob` is what a task hands to `self.retry`
    jobs/job-worker.service.ts
                              the handlers on the queues, and the schedule; `apply` is Celery's
                              eager run, for the parity stack. `worker.ts` is the worker alone
    jobs/mailer.service.ts, jobs/sms.ts, jobs/sms.service.ts
                              SMTP as Django's settings have it; `notifications.sms`
    media/media.ts            `/media/<path>`: uploaded files, as `core.media.serve_media` serves
                              them. A Fastify route, not a controller: a plain Django view
    common/mimetypes.ts       Python's `mimetypes` table, printed in the Django image
    auth/view-registry.ts     what the view at a route pattern asks of any request (who may call,
                              how it is throttled): for a method no handler takes
    notifications/            the notices a signed-in user reads and marks read
    reports/                  the eleven reports and their CSV exports: `date-range.ts` is
                              `DateRange`, `reports.service.ts` the statements and the arithmetic
    auth/                     JWT (SimpleJWT-compatible), authentication guard, throttles
    common/
      python.ts               Python's int(), Decimal(), str(), repr(), float repr, strip, split ...
      drf.ts                  DRF serializer fields with DRF's messages, in DRF's order
      errors.ts               the error envelope's classes; slugParam/strParam (Django path converters)
      audit.ts                core_auditlog rows, with the request's address, agent and id
      filtering.ts            django-filter, OrderingFilter and SearchFilter, as the admin views use them
      isoformat.ts, dates.ts  CPython's fromisoformat (from the C), and core.dates' window parser
      pycsv.ts, pyurl.ts      CPython's csv reader (from _csv.c); urlsplit, hostname, port, urlunsplit
      html5ever.ts            html5ever 0.39's tree builder over parse5's tokenizer (nh3's parser)
      rust-url.ts, bidi-class.ts  whether rust-url 2.5.8 parses a link, with idna 1.1's extra checks
      datetime-field.ts       DRF's DateTimeField: Django's parse_datetime, enforce_timezone in Asia/Dhaka
      html-entities.ts        CPython's HTML5 entity table, generated; html.unescape is in python.ts
      signing.ts              django.core.signing: dumps and loads (TimestampSigner), for tokens both APIs read
      decimal.ts, datetime.ts, pagination.ts, query-dict.ts, phone.ts, uuid.ts ...
    <domain>/                 accounts, catalog, checkout, content, customers, engagement,
                              finance, inventory, jobs, orders, payments, shop (the controllers)
    inventory/stock.service.ts  inventory.services: the one place stock moves (checkout and admin)
    content/validators.ts     content.validators: links, social profiles and maps a merchandiser pastes
    content/rich-text.ts      content.rich_text: nh3.clean (ammonia's clean, html5ever's serializer)
    pos/                      the counter: orders.api.pos_views (session, scan, grid, held sales ...)
    orders/staff-order.service.ts, order-payments.service.ts
                              the staff's OrderDetailSerializer; record_payment as staff take money
    orders/returns.service.ts, returns.controller.ts
                              orders.services.returns and its two views: back office and counter
    orders/staff-order-actions.service.ts, orders.controller.ts, order-lifecycle.service.ts
                              OrderViewSet's writes; lifecycle.transition with its stock edges
    catalog/admin/labels.service.ts
                              inventory.labels: the barcode label sheet and its ticks
    finance/cash-book.service.ts, accounts.service.ts, finance.controller.ts
                              finance.services: every movement of money, under the account's lock;
                              accounts, the cash book and transfers
    finance/expenses.service.ts, party-ledger.service.ts
                              expenses with their receipts, and who owes whom
    purchasing/suppliers.service.ts, supplier-products.service.ts
                              who the shop buys from, and each supplier's price for each SKU
    purchasing/purchase-orders.service.ts, purchase-documents.ts
                              an order raised, sent, received and returned against; its serializers
    purchasing/supplier-payments.service.ts
                              money out to a supplier, under the order's lock and then the account's
    customers/customers-admin.service.ts, orders/leads-admin.service.ts
                              the back office's customers (over the storefront's address service)
                              and the call-back list
    promotions/coupons-admin.service.ts
                              the screen that makes and edits coupons
    shipping/shipping-settings.service.ts, shipping/shipments.service.ts
                              zones, methods and couriers; parcels and their tracking updates,
                              which move the order through `OrderLifecycle`
    shipping/tracking-url.ts  a courier's tracking page with the number in it, for staff and
                              for the customer's order page
    engagement/review-moderation.service.ts
                              the back office's reviews: the list, and approve and reject
    accounts/branches.service.ts, accounts/staff-users.service.ts, accounts/roles.service.ts,
    accounts/organization-admin.service.ts
                              branches; staff accounts, their profiles and the two guards;
                              roles and permissions; the organisation and its VAT treatment
    accounts/audit-log.service.ts
                              the audit log's list and one entry (the log is written by common/audit.ts)
    common/model-lookups.ts   what a model DateField or DateTimeField makes of a query-string value
  parity/
    run.ts                    the runner and the read-only cases
    *-cases.ts                write cases per area: accounts, orders, cart, checkout, payment
    concurrency.ts            the race checks; admin-, inventory-, content-, merchandising- and
                              pos-, returns- and staff-orders-concurrency.ts for staff writes
    restore.ts                snapshot-and-restore of whole tables for the admin write cases
    races.ts                  what the phase 6 race files share: `behind`, the mid-flight helper
    throttle.ts               rate-limit comparison
    known-differences.ts      the deliberate differences the harness accepts
    fixture*.py               Django shell scripts that add what the demo seed lacks
    serve.ts, gateway.ts, gateway/   the parity stack's Nest entry and stand-in payment gateway;
                              on both sides, the routes that run a job on demand and say what is
                              scheduled (`gateway/parity_gateway/jobs.py` is Django's)
    sink.ts                   a mail server and the web app's revalidation route, for both APIs:
                              keeps what a job sent, and refuses on request
    jobs-cases.ts, sweep-concurrency.ts, worker-check.ts
                              each job beside its Celery task; the sweep's races; the worker itself
    media-cases.ts, fixture_media.py
                              `/media/`, over files of known names, sizes and times
    django-only-cases.ts      the pages only Django serves, each a declared difference
  test/unit/                  unit tests; expected values printed by Django or DRF themselves
```

## 6. How to port an endpoint

### 6.1 Read Django first

1. Read the **view**, the **serializer** and the **service** it calls, every branch. Porting a rule
   means reading all of it. D113 was found this way.
2. Read the **serializer, not the model**, for the response shape: key names, `None` versus `""`,
   which datetime format, and which Decimal becomes a JSON number and which a string.
3. **Capture Django's SQL** for each path in the parity stack, and send the same statements, with
   the same ORDER BY, the same `LIMIT 21` on a `.get()`, the same joins where ordering depends on
   them. Run it in a transaction you roll back:

   ```python
   # docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django python manage.py shell
   from django.db import connection, transaction
   from django.test import Client
   from django.test.utils import CaptureQueriesContext
   class Rollback(Exception): pass
   try:
       with transaction.atomic():
           with CaptureQueriesContext(connection) as ctx:
               Client(HTTP_HOST="localhost").post("/api/v1/...", data="{}", content_type="application/json")
           for q in ctx.captured_queries: print(q["sql"])
           raise Rollback()
   except Rollback:
       pass
   ```

   `on_commit` hooks do not run inside that block. Measure after-commit behaviour with a real
   commit, then `reset` the parity database.

### 6.2 Write it

- **Bodies:** read them with `requestData()` (`src/http/request-body.ts`), which parses on first
  use as DRF does. A view that never reads `request.data` (the webhook) never refuses a malformed
  body. Raw bytes are `request.body.bytes` when `request.body instanceof RawBody`.
- **Validation:** `src/common/drf.ts` gives DRF's field messages in DRF's order. Match DRF 3.15's
  exact wording ("Must be a valid boolean.", "Must be a valid UUID.").
- **Python semantics:** `src/common/python.ts` for anything Python parses or formats that a client
  sees: `int()`, `Decimal()`, `str.strip()`, `repr`, float repr (`PyFloat`, which also writes JSON
  as `json.dumps` does), ints past 2^53 as `bigint` (`installBigIntJson`).
- **Path parameters:** check them with the Django converter the URL uses: `slugParam`, or
  `strParam` (no `/`, since Fastify decodes `%2F` and Django does not match it). Throw
  `RouteNotMatched` for Django's HTML 404.
- **Errors:** throw the classes in `src/common/errors.ts`: `ValidationError`, `NotFound`,
  `Conflict`, `InsufficientStock` and the rest, with `details` where Django gives them. A DRF
  `NotFound("...")` in a view is `new NotFound('...')`.
- **Authentication:** `@AllowAny()` is DRF's `AllowAny` (authentication still runs).
  `@SkipAuthentication()` is `authentication_classes = []` (it still throttles).
  `@SkipThrottle()` is for plain Django views. `@ThrottleScope('checkout')` is a scoped rate.
- **Audit:** `recordAudit(tx, auditContext(request, env), {...})`, inside the change's
  transaction. The entity label is Django's `str(entity)` at the moment Django records it.
- **Formats:** every DRF view negotiates before it authenticates (`http/negotiation.ts`): an
  unknown `?format=` is a 404 and an `Accept` nothing satisfies a 406. A view with
  `renderer_classes` of its own (the reports' CSV) declares them with `declareRenderers` and
  reads `request.acceptedRenderer`.
- **jsonb in an answer:** read it as text (`::text`, or `db.arrays(..., { jsonAsText: true })`
  where the statement must stay Django's) and parse it with `parsePythonJson`: `pg` would make
  `1.0` a `1` and round an integer past 2^53.

### 6.3 Write paths

- **The service owns the transaction:** `this.db.transaction(async (tx) => …)`. Take the locks
  Django takes, in Django's order: lock many rows `ORDER BY id … FOR UPDATE`, and check every line
  before writing any.
- **Unique-violation recovery:** where Django wraps an insert in a savepoint and catches
  `IntegrityError`, do the same: `SAVEPOINT x` → insert → on error code `23505`,
  `ROLLBACK TO SAVEPOINT x` and re-read the winner. That is how idempotency keys and webhook
  replays survive a race.
- **Every stock change goes through `StockService`** (`inventory/stock.service.ts`): `run()` for the
  transaction and its after-commit jobs, `lock()` for the rows. Never write `on_hand` or
  `reserved` anywhere else.
- **Reads Django makes before its transaction stay outside yours.** The webhook's payment lookup
  is one. Races depend on it.
- **Timestamps:** `clock_timestamp()`, not `now()`, where Django stamps each row as it saves. When
  Django sets a time and *then* saves (`captured_at`, then `updated_at`), read the time first
  (`SELECT clock_timestamp()`) and pass it in. **Postgres fills an UPDATE's SET list in column
  order**, not in the order you wrote it.
- **After-commit work** (Django's `transaction.on_commit`) runs only after the commit resolves, in
  Django's order.
- **Jobs go through `Jobs`** (ADR-0016), never a transport. A job decided inside the transaction:
  `await this.jobs.delayIn(tx, afterCommit, task, args)`, and run `afterCommit` once it has
  committed -- with Celery the job waits there, with pg-boss it is already a row of the
  transaction. One decided after the commit, or outside any: `this.jobs.delay(task, args)`, best
  effort, logged on failure. A new job needs its queue in `jobs/queues.ts`.
- **Numbers into jsonb:** `JSON.stringify` a value that came from `parsePythonJson`, so floats and
  big ints keep Python's form.
- **No clocks from `performance.*`** for wall time. It stops while the host sleeps (§8).

### 6.4 Prove it

1. **Fixtures.** Add what the demo seed lacks as a Django shell script,
   `parity/fixture_<area>.py`. Make it all-or-nothing, stopped by a marker row on a second run,
   with rows written through Django's own models or services. Add it to the `seed)` list in
   `scripts/nest-parity.sh`. Don't let a fixture disturb other cases: for example, give a new
   branch `fulfils_online_orders=False` and `INACTIVE`.
2. **Cases.** One per branch: missing, inactive, empty, a tie, malformed input, each refusal.
   - A read case needs a name and a path.
   - A **write case** also needs:
     - `reset`, which puts every row back before each API's request;
     - `effects`, SQL whose rows are compared after each request;
     - `jobs: true`, to compare the queued Celery jobs;
     - `sink: true`, to compare the mail and the revalidations sent (`{ mail: 'refuse' }` to
       have the sink refuse, and see the retries).
   - Use `prepare` for per-case state changes. `setup` runs once, before the per-side reset,
     which would undo it.
   - `normalize` blanks values each API mints (new ids, timestamps compared by form).
3. **Effects queries:**
   - Tell a request's rows from existing ones **by id against a snapshot**, never by time
     (`resetCheckout`, `resetPayments`). The demo seed dates some of today's sales later today.
   - Turn times into booleans (`captured_at IS NOT NULL`, `occurred_at = captured_at`).
   - Read jsonb as `payload::text`: `pg` turns jsonb into JavaScript numbers, so `3.0` would equal
     `3`.
   - Name rows by business keys (order number, SKU, account name), not ids.
4. **Spot check** with `PARITY_VERBOSE=1` that the key cases do what they say.
5. **Races** (`parity/concurrency.ts`), for every invariant a lock protects:
   - Split simultaneous requests across both APIs.
   - Assert the invariant: one default, one order, one capture, the row equal to its ledger.
   - Assert the allowed statuses.
   - Then **remove the lock in the port, rebuild, and run the races**. The check must fail.
     - If it passes anyway, something else serialises the requests (checkout's number sequence;
       the webhook's unique event id). Write a **deterministic mid-flight check**:
       1. The harness opens a transaction and takes the row lock itself.
       2. It starts one Nest request.
       3. It waits until `pg_stat_activity` shows that request waiting on a lock
          (`application_name = 'rangon-api-nest'`).
       4. It writes the competing change and commits.
       5. It asserts the request saw the change.
     - Put the lock back, rebuild, rerun.
6. **Throttles:** add a scenario to `parity/throttle.ts` for any new scope or unthrottled view.
7. **Unit tests** for the building blocks, with expected values printed by Django or DRF in the
   Django container, not reasoned out.
8. **Unreachable paths:** when production code can't reach a path over HTTP, because no provider
   takes webhooks, use a **stand-in that exists only in the parity stack**, installed identically
   on both sides. Keep it out of every image:
   - Django installs it through `config.settings.parity`, from a directory only
     `docker-compose.nest.yml` mounts.
   - Nest registers it in `parity/serve.ts` before `listen`.

   Never gate test code in `src/` behind an environment flag.

## 7. Defects

- **A Django defect found while porting** gets the next D-number in the roadmap's known-defects
  table. Record the measured behaviour, the files, and how it was found. The latest is **D232**. Read the
  latest number off the table on `main`, not off this line: parts 1 to 4 of phase 5 reused four
  numbers `main` had taken the day before, and all fourteen had to move.
- **Copied** into the port: listed under "Django defects that are copied" in `nest-port.md`.
- **A security hole:** fixed in Django first, on `fix/<slug>`, with tests, ahead of the port.
- **A rule the code breaks, or never had:** mark it `DECISION REQUIRED` in `business-rules.md`,
  state what the code does until then, and tell the owner.
- **Open now:**

  | Defect | What it is | Status |
  |---|---|---|
  | D114 | a first-time guest's double-click can get 409 | copied |
  | D115 | the counter could sell reserved stock | fixed in Django 2026-10-02 (owner's switch); port it in phase 5 |
  | D116 | a broker outage turns a placed order into a 500 | the port logs instead; a documented difference |

- **A bug in the port itself:** fix it, add a unit test that fails on the old code, and mention it
  in the verification entry. The token clock (§8) is the example.

## 8. Lessons that cost time

| Symptom | Cause | Now |
|---|---|---|
| A refresh case failed one run in three | Nest stamped tokens from `performance.timeOrigin + performance.now()`, a monotonic clock that stops in sleep; 8 ms behind after 7 minutes | `Date.now()`; a unit test skews the process clock |
| The checkout reset failed on a fresh seed | `seed_demo` spreads today's sales over shop hours, so before 9 p.m. some are in the future; the reset deleted by time | resets and effects tell rows by id |
| A webhook case compared equal when it should not | `pg` read jsonb into JS numbers: `3.0` = `3`, 20 digits rounded | payloads compared as `::text` |
| `updated_at` earlier than `captured_at` | one UPDATE's SET list runs in column order | read the time first |
| The stock race passed with the lock removed | the `order:WEB` sequence lock already serialised checkouts | the mid-flight check |
| Race tallies grew across checks | audit rows are not undone by a reset | count from each check's own start |
| A race showed 409 CONFLICT for shoppers | every shopper shared one phone, so they raced to create one guest customer | distinct phones per shopper; the same-phone case kept, as D114 |
| A per-case change had no effect | `setup` runs before the per-side `reset`, which undid it | use `prepare` |
| Negative zero | DRF prints `-0.00`; decimal.js drops the sign | `money()` and `decimalField` keep it |
| `DELETE /variants/lookup/` answered 404 where Django answered 405 | Fastify picks a route by method first; Django resolves the path first, and the router lists `lookup/` before `<pk>/` | `RouteRegistry.resolve` ranks a literal segment over a parameter, and the auth guard sends a mismatch to the no-route answer |
| `pyDecimal` passed its tests for a year of the port and still refused `১২৯০` | it was written from the docs, not from `numeric_as_ascii` | the same differential test as the date parser; the csv reader got one before it was used |
| The `DateField` port passed its tests and still refused what Django took | CPython's `fromisoformat` is looser than its docs: it never checks it reached the end, and any character separates date and time | port the C, then compare against a generated corpus: Python prints `parse_moment` for tens of thousands of strings in the container, a throwaway jest spec runs the port over the same file |
| A phase 3 race broke when a fixture added a second branch | it set one SKU's stock at every branch, and a reserved count went negative | harness statements name the branch |
| The transfer burst passed with the stock lock removed | every document that takes a number takes the sequence's row lock first, which serialises them | the mid-flight check, again |
| A same-key retry race passed with the stock lock removed | the idempotency key's unique index protects retries on its own | prove a lock with a race only the lock can win: the mid-flight checks, an oversell burst |
| The Nest stand-in gateway answered 400 where Django's answered 500 | it reused the API's JSON parser, which raises DRF's parse error; `json.loads` in the Django twin raises a plain exception | a stand-in fails exactly as its twin does |
| The content move's race passed with the run's lock removed | PostgreSQL sorts a locking `SELECT` before it waits, so a renumbering move ends the same with or without the lock (D132) | a check also asserts that the request waited on a `FOR UPDATE`; with no outcome to prove, the wait is the proof |
| A harness edit made mid-run was not in the run | the parity container reads `parity/` when it starts | start the run after the last edit |
| `nest-parity.sh` failed with "v: command not found" after a run | bash reads a script as it runs it; the script was edited mid-run | never edit `scripts/` while a reset or run is going |
| A sanitiser port matched nh3 on 20,000 inputs, then not on the next 150,000 | the first corpus was random noise; tables, `<select>`, foreign content and links were barely in it | a corpus per area, each aimed at what can differ |
| The same input cleaned differently on its second run in one process | Node 22's optimised `URL.canParse` refuses some hosts `new URL` parses (`https://ä.com`) | `new URL` in a try; never `canParse` |
| Node's URL parser stood in for rust-url's and disagreed on 1 link in 400 | rust-url departs from the URL standard (`tel://@`, a backslash ends a port) and idna checks more than UTS #46 (Punycode labels, the Bidi Rule) | port the parser's failure points; layer idna's checks on Node's mapping |
| A mid-flight check reported "never waited" for Django and passed for Nest | `pg_stat_activity` keeps 1024 bytes of a statement, and Django's locking `SELECT` over a join is longer, so `FOR UPDATE` was cut off | match the wait on the statement's start (the table, the join), not on `FOR UPDATE` |
| A case that needs a state no fixture has polluted the cases after it | `reset` runs before each API's request and once after both | a reset that arranges the state on its first two calls and only restores on the third (`arranged` in `merchandising-cases.ts`) |
| Creates differed only in `Location` | DRF's `get_success_headers` puts the answer's `url` field in `Location`, whatever that field means -- a navigation item's link, a banner's | copy it wherever a serializer has a `url` |
| A DRF `DateTimeField` port refused 2009's skipped hour, where DRF took it | DRF 3.15's `valid_datetime` never refuses: under PEP 495 such a time is never equal to itself in UTC, so its "exists" test short-circuits its "ambiguous" one | read DRF's code, not its message list; compare on a generated corpus |
| A 40,000-deep page took 24 s, all of it in the event loop | html5ever walks the whole stack of open elements for every block tag; Django's thread just waits, Node's process does not | count open elements by name, so the walk ends at once when none matches |
| A case named for a fixture row answered 404 on both APIs and "matched" | the case looked the row up by a label the fixture had overridden, so both APIs were asked for `/holds/undefined/` | read the `PARITY_VERBOSE=1` statuses of every new case before believing a green run |
| A fixture's inactive manager approved a discount | `User.save()` sets `is_active` from `status`; `create_user(is_active=False)` is overwritten | set the status; and ask Django (a shell probe) what a new case answers before trusting two APIs that agree |
| An effects query showed a seed order as "changed" by a sale | it selected rows by `updated_at >= $1`, and the seed dates some of today's rows later today; the two APIs' `$1` differ, so it would also have flaked | compare with the snapshot table (`to_jsonb(row) IS DISTINCT FROM` the snapshot's), never with the clock |
| A port answered 500 for `?ordering=<a relation>` on a detail route, Django 200 | Django's `get()` drops the queryset's ordering; only a name `order_by` cannot resolve fails, and it fails when the filter runs | on a detail route, an ordering term either raises at once or does nothing |
| Two race checks broke when a fixture gained sales | the new sales gave a customer totals and a branch its walk-in record, which the checks assumed were zero and absent | a check reads its baseline after the restore and asserts the change; a fixture row that must stay absent is said so beside the code that would make it |
| Two requests for one return passed "one wins, one is refused" with the return's lock removed | a request that takes no `FOR UPDATE` still queues at its `UPDATE`; when it happened to be first in the queue the other re-read the row and refused itself | run the pair through each API on its own as well as one per API, and assert the refusal's own message |
| A return's two lines came back in a different order on the second run, in Django alone | no `ORDER BY` anywhere: `ReturnItem` has no `Meta.ordering` (D161), and the restore between the two sides moves rows in the heap | send Django's statement as it is; compare what it leaves unordered by a stable key, and say so in the case file |
| The port stored a comment the counter route should have dropped | `PosReturnView` validates `customer_comment` with the shared serializer and `pos_return` never passes it on | read what the service is called with, not only what the serializer accepts |
| A fixture for one part broke another part's race check | it reserved a unit of the SKU the check sells the last of at the second branch | a fixture brings its own stock (`receive_stock`) rather than borrowing a SKU a check counts on; rerun every race check after adding one |
| A cancel's answer differed only in its payment totals | Django serialises the object the status machine returned, not the row the refund then saved (D170) | compare the answer and the rows separately: each can be right while the other is stale |
| Five cases differed by a few milliseconds in a date | their `prepare` set a row to `now() - interval ...`, and `prepare` runs once per API | a moment a case needs is fixed when the cases are built, and written into the statement |
| A form's blank date was refused where Django took it as null | the port's `dateTimeField` had no `html` meta, so a form's `''` reached the parser | a field read from a form says how DRF reads a blank for it; check every field of a serializer a form reaches |
| Nine new cases "matched" as 404s: both APIs were asked for `/purchase-orders/undefined/` | the case file keyed orders by invoice number *or* number, and the cases named the number of an order that has an invoice | a case file's lookup throws for a name the fixture does not hold; the same lesson as the held sale's, now enforced rather than remembered |
| A parcel's `tracking_url` was a 500 in the port and simply absent in Django | the model property raised KeyError, and DRF's `Field.get_attribute` turns a KeyError or an AttributeError on a field that is not required -- every read-only one -- into `SkipField`: the key is left out of the answer | a property behind a read-only serializer field cannot be ported as "raises, so 500": find out which exception it raises |
| A full run matched 393 new cases, a third of them as 404s | an earlier suite's reset (`orders-cases.ts`) deletes the reviews of the customers who sign in, and the new fixture had given them three; the cases had looked their ids up before the run began | count the races as well as the cases after a full run -- a group that finds its rows gone returns nothing -- and give a fixture's rows to owners no earlier suite cleans up after; `reviews-concurrency.ts` now fails if its fixture was there at the start and is gone |
| Sixty-two organisation cases differed by one queued job and nothing else | `content.signals` has a `post_save` receiver on `Organization` that asks the storefront to revalidate `site`; nothing in the view or the service says so | grep `signals.py` for every model a part saves before porting it; and leave `jobs: true` on every write case, which is what found it |
| `?format=csv` answered 200 where Django answered 404, on every view the port has | DRF settles the format in `APIView.initial`, before it authenticates; six phases of cases never sent a `format` or an `Accept` that JSON does not satisfy, so nothing had ported it | when a part's cases trip over something every view does, port it for every view, in its own commit, with cases of its own; and give each new part a case for what the framework does before the view runs |
| Two audit entries of one instant came back the other way round under `ordering=created_at` | the port selected only the columns it reads; with nothing selected from the accounts PostgreSQL drops that `LEFT JOIN`, where Django's statement hashes the log against it and the tie falls differently | where a tie can reach the client, the select list is Django's too -- every column of every joined table (`EXPLAIN` both statements to see it) |
| A second full run on the same database differed in two cases the first had matched | a full run's restores churn the heap, and both cases left an order to it: one compared unordered lines, one port selected fewer columns than Django and lost a join | `run-jobs` after `run` is also a churn test: a case that passes only on a fresh database is wrong. Compare unordered rows by a stable key; make the statement Django's |
| A check that a job and its order share a transaction id failed for a write-off | the ledger entry and the shelf are written under a savepoint, and a subtransaction has an id of its own: their `xmin` is not the transaction's | compare `xmin` with a row written at the top level of the transaction (the audit entry), and look at the ids once by hand before asserting on them |
| The demo seed could not test the VAT return: every order in it is zero-rated | the reports' arithmetic for inclusive prices, rates and credits ran on nothing | look at what the seed's data exercises before writing cases on it (one `GROUP BY` on the column the branch turns on); a fixture of rows with frozen figures -- no service called, no stock or money moved -- adds trade without disturbing a shelf or an account another suite counts |
| Two party-ledger cases from phase 6 broke when a fixture added purchase orders | each gives every purchase order one date, `payables` orders by that date alone, and the restore and `UPDATE` before each API's request move the rows in the heap: Django asked twice answers in two orders. They had agreed by luck | a write case that arranges a tie compares the tied rows by a stable key and says so (`byNumber` in `expenses-cases.ts`); and the port's statement is Django's all the same, as it now is there |
| The throttle check failed with "network ... not found" after a reset | `reset` takes the stack's network down, and the stopped throttled containers, which are in a profile `down` does not touch, still name it | remove the throttled pair before a reset (`--profile throttle rm -sf nest-throttled django-throttled`), or start it with `--force-recreate` |
| A case's `<now>` normalisation also blanked a moment the request had named | it blanked anything that looked like a UTC instant | blank only the end the request left to the clock: read which from the query |
| An anonymous `DELETE /auth/me/` answered 405 where Django answered 401; a bad token at `GET /auth/logout/` 401 for 405; and no 405 was ever throttled | DRF authenticates, checks permissions and throttles in `initial()`, before it looks for the method's handler; the port's answer for a missing method knew staff views only | a new view's cases include a method it does not serve -- anonymous, with a bad token, and as someone it refuses -- and the throttle check has a scenario for it |
| The sweep's audit entries differed: Django's carried an address and a request id, the port's none | the stand-in runs the Celery task inside a view, and `audit.record` reads the request's context; a worker has none | run the task in a context of its own (`contextvars.Context().run(task.apply, ...)`): what is compared is the job as a worker runs it |
| The digest and the expiry notice listed tied rows in two orders | both order by a column that ties (`on_hand`; the expiry date) and cut the list at thirty | compare such a body with its lines sorted (`EFFECTS_TIED`), and add one arrangement with no tie -- every shelf its own count -- so the cut itself is compared |
| A race check of the sweep "never waited" on Django though the order was locked | `pg_stat_activity.query` is cut at 1024 bytes, and Django's `SELECT ... FOR UPDATE` names every column first: the words `FOR UPDATE` are past the cut | match a lock wait by the table's name alone |
| The first worker check expected a job waiting to be retried to show `retry_count = 1` | pg-boss counts a retry when the job is delivered again, not when it is owed: a job in `retry` after one failure still says 0 | read `pgboss.job` once by hand before asserting on its columns |
| A new parity script that imported a helper ran the whole comparison | `run.ts` starts its run when loaded, and `concurrency.ts`, `checkout-cases.ts` and the rest import it | a script that is not part of the run stands alone, as `throttle.ts` and `worker-check.ts` do: its own requests, its own token |
| The seed's unpaid orders made a weak race for the sweep: 2 ledger rows for 57 lines | a release takes what the line asks for or what the shelf holds, whichever is less, and the seed reserves next to nothing | before a race over seeded rows, count what it will actually move; arrange the shelves so a second release would show |
| A `HEAD` case crashed the harness: "Parse Error: Data after `Connection: close`" | Django under gunicorn sends a body after a HEAD's headers (the 404 page, for one), which no HTTP client will read; nginx strips it in production | a HEAD of anything with a body cannot be a parity case; say so in "Deliberate differences" and check the port's answer with `nc` |
| `GET /media/%ff.png` answered 400 from the router where Django answered 404 | Fastify's router refuses a URL whose percent-escapes are not UTF-8 before any route is chosen | `rewriteUrl` can hand the router a readable spelling and keep the original for the handler (`media/media.ts`); try a malformed escape on any route whose path is free text |
| The cutover "at the proxy" would have moved almost nothing | the web app calls the API server-side over the private network (`API_INTERNAL_URL`), and proxies the browser's calls the same way; nginx's `/api/` carries only webhooks and feeds | before planning a switch, find every place the address of the thing is written -- here two, and they must move together |
| A plain `up -d` after removing the rollback file left beat running beside a scheduling Nest API | compose does not stop a service whose profile has just gone inactive; it simply stops managing it | a procedure that removes services says `stop` first, and was tried in that order |
| The browser suite failed one test on the Nest API and none on Django | eleven tests sign in from one address, the limit is ten a minute, and the faster API fits all eleven inside the minute | a suite that passes "by being slow" is a limit about to be hit: count what it spends against each throttle. The suite now keeps one session per account |
| An ordinary upgrade guide would have broken the one shop that exists | the local production stack on the owner's machine holds real data and still runs Django; the roadmap's "no live environment" did not mean "nothing running" | read the operations docs for what is actually deployed before saying nothing is |
| A stale `run.log` from an earlier session read as the run just started | the background run had not reached the redirect that overwrites it | give each run's log a new name, or delete the old ones first |
| The roadmap said "ruff clean" for two parts whose new fixtures had not been run through it | the documented ruff command covers `parity.py` and the gateway, not `apps/api-nest/parity/*.py`, which the Django container does not mount | pipe each new fixture through it: `docker compose ... exec -T django ruff format --check --stdin-filename /app/x.py - < fixture_x.py`, and `ruff check --ignore T201` the same way (fixtures print; `PARITY_PASSWORD` is the one S105) |

## 9. Documentation, per part

Every part of a phase updates, in the same branch:

1. `docs/architecture/nest-port.md`:
   - the status table;
   - the endpoint table (one row per endpoint, with its notes);
   - the race table;
   - deliberate differences and copied defects.
2. `docs/roadmap.md`:
   - a **verification entry** at the top of the verification log: what was asked for, what was
     ported, a `text` block of the numbers (parity, races, throttle check, unit tests, the gates),
     what the cases cover, and what was found;
   - new rows in the known-defects table.
3. A new ADR when the owner makes a decision (the latest is 0014), and ADR-0013's status line when
   a phase finishes.
4. `business-rules.md` for any `DECISION REQUIRED`.
5. This file, when a rule, a command or a lesson changes.

## 10. Git and pull requests

- **One branch per phase**, from `main`: `phase/nest-<n>-<slug>`. Phase 3 is `phase/nest-3-checkout`.
- **Commit each coherent unit** with a Conventional Commit, ending with the co-author line the
  session asks for:
  - `fix(api-nest): …` for a bug in the port;
  - `feat(api-nest): …` for a part;
  - `docs: …` for its documentation.
- Before each commit:
  - all five Nest gates print 0;
  - `scripts/nest-parity.sh reset` then `run` exits 0;
  - the throttle check matches, if throttling changed.
- **Push and open a PR only when the owner runs the create-pr command.** Base `main`, ready for
  review (not draft), a description of what was ported, how it is proven, and what was found.
  Then bind it with the PR tools and check its CI.

## 11. What comes next

| Phase | Scope | Notes before starting |
|---|---|---|
| 3 | done 2026-10-01 | merged to `main` |
| 4 | done 2026-10-01 | merged to `main` (PR #77) |
| 5 | done 2026-10-06 | on `phase/nest-5-pos`, seven parts; its PR is opened when the owner asks |
| 6 | done 2026-10-07 | merged to `main` (PR #88), ten parts (the list is in `nest-port.md`, "Phase 6: the back office") |
| 7 | done 2026-10-08, five parts (the list is in `nest-port.md`, "Phase 7"): the audit log, notifications, the reports, DRF's `initial()` on every view, the pg-boss queue, the ten jobs with their worker and schedule, and the cutover. Parts 1 to 3 merged in PR #89, part 4 in PR #90; part 5 is on `phase/nest-7-reports-jobs-cutover` until its PR | the port's phases are finished; what follows is below |

After the port:

1. **Every change is now a change to production twice.** The rule stands (Django first, with
   its tests, then the port, then parity), and CI runs the comparison both ways and the browser
   suite on both APIs. A change to an endpoint that skips the port ships the old behaviour.
2. **Three things the Nest API does not do**, each a candidate for the next piece of work:
   object storage (`USE_S3=1`: it refuses to start; `common/storage.ts` writes to disk only),
   Sentry (`SENTRY_DSN` is read by Django alone), and a measured answer to "what happens when
   Redis is down" (the throttles and the page cache live there).
3. **A provider written for Django needs its twin.** An SMS gateway (`docs/operations/sms.md`)
   or a payment gateway registered in Django alone is never called in production: the Nest API
   has its own registries (`jobs/sms.service.ts`, `payments/providers.ts`).
4. **The owner's standing question**: whether Django stays the place a rule changes first once
   the Nest API has run in production for a while. Until that is answered, do not remove
   Django code, and do not let the parity harness rot.
5. The owner should still see D221 first, then D233, D166, D149, D158, D164, D167, D204, D207
   and D222, and the decisions listed in §2.

### Checklist for a part

```text
[ ] Django's view, serializer and service read, every branch; its SQL captured
[ ] ported with Django's statements, locks, order of work and messages
[ ] fixtures for every branch, applied by scripts/nest-parity.sh seed
[ ] a case per branch; write cases compare every row written and every job queued
[ ] spot-checked with PARITY_VERBOSE=1
[ ] races across both APIs; each fails with the port's lock removed
[ ] throttle scenario if a scope changed
[ ] unit tests with values Django printed
[ ] five Nest gates at 0; reset + run + run-jobs exit 0; ruff clean on touched Python
[ ] scripts/e2e-local.sh nest (and django) if anything the web app calls changed
[ ] defects numbered, copied or fixed per §7; differences declared twice
[ ] nest-port.md, roadmap entry, ADR/business rules as needed; this file if a rule changed
[ ] committed on the phase branch; no push until asked
```
