# ADR-0021 — The recorded proof replays on a set clock; libfaketime, in the replay images only

**Status:** Accepted · 2026-10-09 · step 1 of [the removal plan](../django-removal-plan.md), which left this to a measurement

## Context

The recorded proof ([recorded-proof.md](../recorded-proof.md)) keeps the NestJS API's answer to
every parity case, with a snapshot of the database the answers were given from, and replays the
cases against them on a stack that has no Django in it.

The plan's step 1 named the question this ADR answers. A recording is taken at one moment and
replayed at another, and some answers depend on the moment. Either the cases that depend on the
clock arrange their own rows relative to it, or the stack runs with a set clock: "decide from
the measurement".

Measured on 2026-10-09, by replaying a recording of all 12,243 cases on a stack whose every
clock was shifted forward:

```text
the same night ................. the answers hold (once tied rows are dealt with)
clock one day ahead ............ 475 cases answer differently
clock forty days ahead ......... 775 cases answer differently
```

What changed was not noise. An order past its return window can no longer be returned (166
cases at forty days). A debt is a day older in the party ledger. A coupon has expired. The
reservation sweep finds seven orders to expire, not two. A report's "today" is another day and
its "last 30 days" another thirty. And the demo seed dates today's sales through the shop's
hours, so a row is "since the request" in the small hours and long past by evening: about 320
cases count such rows, at a day's distance.

Those are **right answers to a different question**. The snapshot is a shop as it stood one
night, and every rule that reads the calendar reads it against that shop.

## Decision

1. **The replay stack runs at the hour the recording was taken.** `record` writes down when it
   began; `replay` sets every process that tells the time -- PostgreSQL, both Nest processes,
   the worker, the sink, the harness -- the same number of seconds behind the real clock. The
   clock still runs, at the real rate; it is only somewhere else.
2. **By libfaketime, in the replay stack's images and no others.** A build target of the Nest
   image (`replay`, after `runtime`; the default target is still `runtime`) and a PostgreSQL
   image built in the compose file add the library under the process. Production's image is
   the same bytes as before. With no offset given the clock is the real one.
3. **And kept in step within the hour.** A replay asks one API where a recording asked two, so
   it gets through its cases about twice as fast, and a row dated a few minutes after the
   recording began is behind a case in one and ahead of it in the other. A recording keeps
   every moment the database holds in the hours ahead, and when each case was asked; a replay
   waits before a case for a moment the recording had already passed.

## Why not the other way

Arranging rows relative to the clock works for a case's own rows, and the cases that do it
keep doing it. It cannot work for the seed's. Its orders, their payments, returns, ledger
entries and purchase orders are dated by the seed relative to the day it ran, and the
snapshot freezes them there; every case that reads them through a rule with a calendar in it
would have to re-date the shop before it asked. That is rewriting the seed inside the harness,
for each of several hundred cases, and it would still leave "today".

Re-dating the snapshot on restore (every timestamp moved by the recording's age) was looked at
and not built: dates also live in document numbers, in JSON columns, in signed tokens and in
file names, and the hour of the day would still differ.

## Consequences

- **A new dependency, for tests only: libfaketime** (Debian's and Alpine's packages, in the two
  replay images). It is not in the image production runs, is not installed in CI's other
  jobs, and nothing in `apps/api-nest/src` knows of it.
- **The replay images need the package mirrors at build time**, as the Nest image's own build
  does.
- **What a set clock cannot do is prove the calendar rules on other days.** A recording says
  the return window is right on the night it was taken. The cases that arrange their own rows
  either side of a boundary (an order placed 45 days ago, 75, 200, tomorrow) are what prove the
  boundary, and they are in the recording.
- **Wall time only.** Timers run on the monotonic clock, which is left alone, so nothing waits
  longer or shorter than it did.
- **To be confirmed by the calendar**: every replay so far was run within hours of its
  recording. The shifted-clock runs show what an unset clock does at one day and at forty; that
  a set clock undoes it at forty days rests on the library adding one number to the time, which
  it does the same at any size of number. The first replay of a recording more than a day old
  is the confirmation, and should be looked at as one.
