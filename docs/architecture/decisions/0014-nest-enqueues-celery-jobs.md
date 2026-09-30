# ADR-0014 — The NestJS API queues its background jobs on Django's Celery broker

**Status:** Accepted · 2026-10-01 · in use from phase 3 of the port (checkout)

## Context

Checkout is the first ported endpoint that starts background work. When Django places an online
order it queues, after the transaction commits:

- `inventory.tasks.notify_low_stock(inventory_id)` for each line whose shelf fell to the threshold;
- `notifications.tasks.send_order_email(order_id, "ORDER_CONFIRMED")` and `send_order_sms(...)`.

The staff notices (`notifications_notification` rows) are plain inserts, not jobs.

The emails and SMS are rendered from Django templates and sent through the providers Django's
settings configure. The NestJS API has neither. Phase 7 of the port plans to move background jobs
off Celery, but until then an order placed through Nest must send exactly the same email and SMS as
one placed through Django. The owner chose, on 2026-09-30, from three options:

1. **Queue Celery tasks from Nest** so that Django's worker runs them;
2. port the email and SMS senders, with their templates and providers, into Nest now;
3. send nothing from Nest until phase 7.

## Decision

**Nest writes Celery's own task message into Django's broker, and Django's worker does the work.**

- `apps/api-nest/src/jobs/celery.service.ts` builds a Celery 5.4, protocol 2 message, the envelope
  kombu writes to Redis. The body is `[args, {}, {callbacks, errbacks, chain, chord}]` as base64
  JSON. The headers carry the task name, id and root id, `argsrepr` as Python's tuple repr (a lone
  argument keeps its trailing comma), `retries: 0` and `timelimit: [null, null]`.
- It `LPUSH`es the message onto the `celery` list and `SADD`s kombu's binding of the default queue,
  just as `task.delay()` does. The broker is `CELERY_BROKER_URL`, the same variable Django reads.
- A unit test (`test/unit/checkout.spec.ts`) compares the message with the one Celery itself wrote
  to Redis for `send_order_email.delay(...)` in the Django container. The parity harness compares
  the jobs each API queues for every checkout case (`Case.jobs`), in order, with arguments and ids.
- Jobs are queued **only after the transaction commits**, like Django's `transaction.on_commit`,
  and in the same order: low-stock alerts, then the staff notices, then the customer's email and
  SMS. A checkout that rolls back queues nothing.
- **Queuing is best effort.** If the broker is unreachable, the failure is logged and the checkout
  still answers 201. The order is committed by then. Django raises in the same place and answers
  500 for an order it has placed (D116, measured: a retry with the same `Idempotency-Key` then
  returns the order).

Only what the ported endpoints need is implemented: the default queue, positional string arguments,
no countdown or ETA, no result backend.

## Consequences

- **No new dependency.** `ioredis` was already in the Nest API for its rate limits.
- **One worker, one set of templates.** A customer cannot tell which API placed an order from the
  email or SMS it sends.
- **The message format is a contract with Celery's version.** A Celery upgrade in `apps/api` must
  re-run the capture test's comparison. The header set is protocol 2's, which Celery 4 through 5.4
  all read.
- **Phase 7 still decides what replaces Celery.** Whatever replaces it, Nest's callers go through
  `CeleryService.delay(task, args)`, so a new transport is a change in one file.
- **Nest's behaviour on a broker outage differs from Django's** (D116): Nest logs and answers 201,
  Django answers 500. Listed in `docs/architecture/nest-port.md` as a deliberate difference.

## Alternatives considered

- **Port the senders now.** Rejected by the owner. It would mean a second copy of the templates and
  provider code to keep in step with Django's, in the phase that is least about notifications.
- **Send nothing from Nest until phase 7.** Rejected: an order through Nest would be the only one
  without a confirmation, and the parity harness would have to accept a missing effect.
- **Call Django over HTTP to queue the job.** Rejected: an internal endpoint that queues arbitrary
  tasks is a new attack surface, and the call can fail after the commit just as a broker write can.
