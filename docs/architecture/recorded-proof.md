# The recorded proof

Step 1 of [the plan to remove Django](django-removal-plan.md): a proof that the NestJS API is
right which does not need Django to be running. Decided in
[ADR-0020](decisions/0020-django-is-removed-in-steps.md). **It removes nothing.** The comparison
with Django ([nest-port.md](nest-port.md)) is unchanged and still the proof; this one runs
beside it until the plan's step 6.

## What it is

Until now "the NestJS API is right" has meant "it answered as Django just did": the parity
harness sends each case to both APIs and compares. The recorded proof turns that into "it
answered as recorded":

```text
record   every case to both APIs, as ever. Where the two agree, the Nest API's answer is
         kept: status, the headers the comparison reads, the body, every row the request
         wrote, every job it queued, everything it sent. With them, a snapshot of the
         database and the uploads the answers were given from.

replay   a stack with no Django in it, restored from that snapshot. Every case to the Nest
         API alone, compared with the answer kept for it. Then the races, across two Nest
         processes. Then the worker and the rate limits.
```

An answer is kept only from a case in which the two APIs agreed, so **every recorded answer
has been Django's too** -- except the deliberate differences (`parity/known-differences.ts`),
where what is kept is the Nest API's side, and nothing excuses a departure from it in a replay.

## Commands

```bash
scripts/nest-parity.sh reset
```

```bash
scripts/nest-parity.sh record
```

```bash
scripts/nest-parity.sh replay
```

`record` needs the parity stack up and seeded (`reset`). It is the `run-jobs` comparison -- the
Nest API queuing its jobs in pg-boss, as production does -- with the answers kept, and it fails
without recording if any case differs. `replay` starts another compose project
(`docker-compose.recorded.yml`, `-p rangon-recorded`, port 8640) from nothing each time, and
takes `PARITY_ONLY`, `PARITY_RACES` and `PARITY_VERBOSE` as `run` does.
`scripts/nest-parity.sh replay-down` removes it. A replay is strict, and CI's is that one;
`PARITY_TIES=mark` and `PARITY_HEAP=reversed` are for looking for what depends on the order
rows lie in ([Tied rows](#tied-rows)).

What `record` leaves, in `apps/api-nest/parity/recorded/` (untracked):

| File | What |
|---|---|
| `snapshot.dump` | `pg_dump -Fc` of the parity database, schema and rows, the `pgboss` schema included |
| `media.tar.gz` | the uploads the rows name |
| `answers.jsonl.gz` | one line per case: its name, the request, the answer, the effects |
| `throttle.jsonl.gz` | one line per rate-limit scenario |
| `moments.jsonl.gz`, `clock.txt` | every moment the database holds in the hours ahead, and when the recording began ([The clock](#the-clock)) |
| `ties.jsonl.gz` | written by `PARITY_TIES=mark scripts/nest-parity.sh replay`: where tied rows may change places ([Tied rows](#tied-rows)) |
| `made.txt` | the commit and the moment |

## How it is built

- **One harness, three modes** (`PARITY_MODE`: `compare`, `record`, `replay`;
  `parity/recording.ts`). The cases, their resets, their effects queries and the comparison
  itself (`parity/compare.ts`) are the ones the comparison with Django uses. A replay puts the
  kept answer where Django's stood.
- **Two Nest processes in a replay**, `nest` and `nest-b`. `DJANGO_BASE` names the second. The
  cases that carry a token from one API to the other still have two processes that share no
  memory, and every race is split between them as it was split between the two APIs.
- **No Django anywhere in the replay stack.** `docker-compose.recorded.yml` defines no service
  built from `apps/api`; the schema arrives with the snapshot, not by migration.
- **Case names are the key.** A name used twice is `name #2` in the order the cases run, which
  is the same in both modes. A whole replay also fails for an answer on file that no case asked
  for: a case renamed or removed without recording again.
- **The recording belongs to its snapshot.** The answers hold the ids the seed gave its rows,
  and a fresh seed gives others. `record` takes the two together and `replay` restores the one
  before it reads the other.

## Proven by

The plan's two tests for this step, both run on 2026-10-09:

- **The recorded suite passes with no Django container.** A recording of all 12,243 cases,
  replayed on `docker-compose.recorded.yml`: 12,243 as recorded (84 of them with tied rows
  marked), 220 race checks across two Nest processes, the worker's five checks and the 17
  rate-limit scenarios. The stack defines no service that runs Python.
- **With a deliberate change to a ported rule, the same cases fail that fail against Django.**
  A percentage coupon was made to divide by 101. Against Django, 30 cases differed (checkout,
  the cart, the coupon, the lead, the counter's quote). Against the recording, the same 30 --
  and nine more that the comparison cannot see: audit-log lists showing an entry an earlier
  case had left behind with the wrong total in it. Both APIs read that entry off one table
  and agreed about it; the recording remembered what it should have said.

## What a recording cannot hold

Everything the two APIs mint per request -- a new row's id, a token, a timestamp of "now" -- was
already blanked by each case's `normalize`, or compared by shape, because Django's request and
the Nest API's were always two requests. What is left is what is the same for two requests a
moment apart and different in another run. The plan's step 1.1 says to measure it before
building on it. Measured on 2026-10-09, the first whole replay of a whole recording, on a
restored snapshot, the same night:

```text
12,243 cases: 12,076 as recorded, 167 not
```

None of the 167 was the Nest API answering wrongly. Four things, each dealt with since, and
then a fifth and larger one, the date ([The clock](#the-clock)):

| What differed | Cases | Why | What is done |
|---|---|---|---|
| **Tied rows, the other way round** | about 125 | A list ordered by a column that ties (`?ordering=on_hand`, a report's top products, the valuation, the counter's product grid) leaves the tied rows to the heap, in Django's statement and so in the port's. The two APIs, asked a moment apart, read one heap and agree. A restored database is another heap | [Tied rows](#tied-rows), below |
| **The harness's own address** | 22 | The audit log keeps the caller's address; the caller is the harness, and its address is whatever its compose network gave it | read as `<the harness>` on both sides of a replay (`plain` in `recording.ts`) |
| **How many APIs were asked** | about 13 | What a case's own sign-ins leave behind -- issued tokens, audit entries -- that no reset takes away. A comparison leaves it twice, once per API; a replay once. So the audit log was 397 entries long in the recording and 390 in the replay, and a password change ended 14 sessions, then 7 | while recording, what Django's turn leaves is taken away before the Nest API's turn (`undoTurn`, in `run.ts`): a recording is of one API answering. The search-term log is the same kind, found later: every search adds one to its term's count, and "popular searches" is ordered by the counts |
| **A moment a case arranged** | 5 | The party ledger's cases move an order to "45 days ago", counted from when the cases were built, and the ledger prints the moment | read as `<45 days before the cases were built>` (`asArranged` in `expenses-cases.ts`) |

### Tied rows

That order is nobody's rule, and no recording can hold it: it changes with the heap, which
changes with every restore and every row a reset puts back. It is also the one thing here that
is not only the harness's business. **A list that ties is a list whose pages can show a row
twice or not at all**, in production, on either API. That is a defect copied from Django
([nest-port.md](nest-port.md), D161 and its kind); the fix is a last ordering key, in both
APIs, and belongs to the triage in ADR-0020, not to this step.

What a recording can hold is everything else about the order. A replay run with
`PARITY_TIES=mark`, once after `record`, finds each answer that is the recorded rows with some
of them permuted, and keeps -- in `ties.jsonl.gz`, beside the answers -- the smallest runs of
positions within which they were permuted. Every replay then lets rows change places **inside
such a run and nowhere else**. An ordering that broke moves rows across runs and still fails;
so does a row that changed, or one too many.

It is evidence, not a declaration: a run is marked only where the same rows, from the same
code, were seen in two orders. A tie nobody has yet seen come back the other way is held
strictly, and shows itself one day as a difference of order only. Mark again then; marks add
up.

`record` makes its comparison on a **restore** of the snapshot it has just taken, not on the
database it took it from, so the recording and every replay start from rows lying in one
order. That settles the tables no case writes to. On the ones the cases do write to, the
resets between cases put rows back, and where they land is not the same twice:

```text
recorded on a restore, replayed with PARITY_TIES=mark ...... 12,243 of 12,243 as recorded, 84 cases marked
the same recording replayed again, strictly, minutes later . 12,191 as recorded; 52 not, all the stock
                                                             valuation, the same rows in another order
```

That was the state on 2026-10-09, and it meant a replay had to be a marking one, in which an
answer that is the recorded rows in another order passes whether the rows tie or an `ORDER BY`
has just been lost. The way out was not better marking but no ties.

**Since 2026-10-13 a list has one order, in both APIs** (D243 to D245 and D161: Django first,
then the port), and a replay is strict:

```text
recorded on a restore, replayed strictly ................... 12,243 of 12,243 as recorded; no marks on file
replayed with every table turned over, marking ............. 0 cases marked
```

The marking stays in the harness for the day a list that ties is written again: it is how
such a list is found and named. It is no longer how a replay passes.

### What turning the tables over found

`PARITY_HEAP=reversed scripts/nest-parity.sh replay` restores the snapshot and then puts every
table's rows back in the reverse of the order they lay in (`parity/reverse-heap.sql`): the same
rows, the same ids, the same values. Nothing an API was asked for has changed, so anything that
answers differently depends on the order rows happen to lie in. Run once, on 2026-10-09, with
`PARITY_TIES=mark`:

```text
12,243 cases: 11,458 as recorded
                 546 the recorded rows, tied ones in another order
                 239 something else
```

The 239 are worth more than the 546, because they are not about the harness:

- **A variant's label is built in the order its rows lie in** (D243): "M / White" became
  "White / M" in the cart, the inventory, the counter's grid, the product feed's title -- and
  on the order line, where the label is copied when the order is placed. 206 of the 239.
- **The dashboard's top expense category** is whichever of two equal totals comes first (D244):
  17 cases.
- The other 16: **pages cut through a tie** (D245; next section) -- purchase orders five to a
  page, the stock counts by branch; tied rows inside a row or inside a text, which the marking
  does not reach (a count's lines, the lines of the integrity alert's email); and the harness
  choosing its own subject with a query that has no order ("a sale at another branch", "a SKU
  to scan"), so that the case asks about a different row. Those last are not the API's.

**The comparison with Django could not have found any of these.** Both APIs read the same
tables in the same order and agree. This is the one place so far where the recorded proof sees
something the comparison cannot; it is also a check Django can be put through while it is
still here, and has not been yet.

**Fixed since, and measured the same way** (2026-10-13): on a turned-over database the port
now marks no case and differs in 24, every one of them the harness choosing its own subject
with an unordered query -- 20 at the counter, where a case scans "a SKU" or reads "a sale at
another branch", and 4 that read "a ledger row" -- so that the case asks about another row.
Those are the harness's to fix, and until they are this replay cannot be a check CI runs; it
is one to run by hand on any part that returns a list.

### A page cut through a tie

Where a page ends inside a run of tied rows, which of them it shows was the heap's choice too
-- other rows, not other places, so nothing could be marked. Three lists were seen to do it (a
supplier's offers, the notifications, the dashboard's ten best sellers), and for four days
their cases read the rows at a page's ends as "one of the rows that tie on this". With D245
fixed there is no such page, and that reading was taken out again: every row of every page is
compared.

### The clock

The largest thing a recording cannot hold is the date, and it is not held: it is set.
[ADR-0021](decisions/0021-the-recorded-proof-replays-on-a-set-clock.md) has the measurement
(475 cases answer differently with the clock a day ahead, 775 at forty days) and the decision:

- `record` writes down when it began (`clock.txt`). `replay` runs every process that tells the
  time that many seconds behind the real clock, by libfaketime -- in the replay stack's two
  images and no others. The clock runs at the real rate; it is only somewhere else.
- A recording also keeps every moment the database holds in the six hours ahead
  (`moments.jsonl.gz`) and when each case was asked. A replay gets through its cases about
  twice as fast as a recording, which asked two APIs; before a case it waits for any such
  moment the recording had already passed. It says at the end how long it waited.
- And a recording keeps the instant its harness began (`began.txt`), which a replay waits for
  before it builds a case. The replay's clocks are set a minute and a half further back than
  the recording's age, for the stack to come up in, so a replay began up to that much earlier
  than its recording had -- and the cases are built from the clock: what an API mints is told
  from what was there by being newer than the harness. A row a `reset` had made two minutes
  before a recording was older than the recording's harness and newer than the replay's.
  Found on 2026-10-13, twice in one night. Replaying a recording taken straight after a reset,
  109 cases differed, each by one timestamp read as "now" on one side. And the first run of
  this proof on GitHub failed on four cases of the audit log: the comparison CI runs before it
  records had written audit rows up to the moment the recording began, and the replay took
  them for rows of its own.

## Races

The race checks were written to split their simultaneous requests between the two APIs, which
proved that a lock held across them. In a replay they are split between two Nest processes,
`nest` and `nest-b`: the invariant is the same, the processes share nothing but the database,
and the lock is PostgreSQL's either way. Nothing in a check was rewritten for it -- `DJANGO_BASE`
names the second process -- and the mutation test still applies: take the lock out of the port,
build, and the check must fail. Tried on 2026-10-09 with the coupon's row lock
(`FOR UPDATE` in `checkout/coupons.service.ts`): of the counter sale's 18 checks, the two that
use up a coupon mid-flight failed, one on each process, the sale answered 201 where it should
have been refused.

### Django's own concurrency tests

CLAUDE.md §9 makes `apps/api/tests/test_concurrency.py` mandatory: 28 tests, which call the
services from threads. The port's services are reached over HTTP, so each is stood for by a race
check that drives the endpoint. Eighteen already were when this was first written, at 23 tests.
Five were not, and have checks now, run against Django and the Nest API together before they
were relied on. The last five rows came with the guards ADR-0020 put first (2026-10-13): each
test was written with its fix, and its check with the port of it:

| Django's test (`tests/test_concurrency.py`) | The race check that stands for it | File |
|---|---|---|
| `test_two_online_checkouts_cannot_both_buy_the_last_unit` | checkout: 10 shoppers for the last 7 units, 3 each -- 2 sell, none oversold | `concurrency.ts` |
| `test_pos_sale_and_online_checkout_cannot_both_take_the_last_unit` | stock: 5 online checkouts racing 5 counter sales -- no lost update, no online oversell; and the mid-flight check after it | `concurrency.ts` |
| `test_counter_sales_and_checkouts_racing_never_sell_held_stock` | counter: a sale of the whole shelf that meets an online reservation mid-flight leaves the reserved unit | `pos-sale-concurrency.ts` |
| `test_double_click_checkout_creates_one_order` | checkout: 6 simultaneous clicks, one key -- one order, reserved once | `concurrency.ts` |
| `test_duplicate_payment_webhook_captures_once` | webhook: 8 copies of one capture event at once -- stored and captured once | `concurrency.ts` |
| `test_concurrent_sales_of_different_variants_do_not_block_each_other` | counter: 4 sales of 4 different SKUs at once -- all four go through **(new)** | `pos-sale-concurrency.ts` |
| `test_multi_line_sales_in_opposite_order_do_not_deadlock` | counter: 6 two-line sales at once, the two SKUs in opposite orders -- no deadlock **(new)** | `pos-sale-concurrency.ts` |
| `test_return_processed_twice_refunds_once` | returns: two completions of one return queue on its row -- the refund is paid once | `returns-concurrency.ts` |
| `test_simultaneous_sales_all_land_in_one_drawer` | counter: a cash payment that meets another movement of the drawer mid-flight lands on the committed balance | `pos-sale-concurrency.ts` |
| `test_simultaneous_walk_in_lookups_resolve_to_one_customer` | counter: 6 anonymous sales at once at a branch with no walk-in record -- one record, six sales | `pos-sale-concurrency.ts` |
| `test_concurrent_withdrawals_cannot_overdraw_a_drawer` | cash book: 6 withdrawals of all a drawer holds at once -- one is paid | `finance-concurrency.ts` |
| `test_transfers_in_opposite_directions_do_not_deadlock` | cash book: 8 transfers between two accounts, four each way, at once | `finance-concurrency.ts` |
| `test_a_replayed_capture_webhook_banks_the_money_once` | orders: two requests to record one pending payment -- captured once, the money entered once; webhook: 6 different capture events for one payment | `staff-orders-concurrency.ts`, `concurrency.ts` |
| `test_one_customer_cannot_spend_a_one_per_customer_coupon_twice` | checkout: 6 orders by one customer for a coupon good once per customer -- redeemed once **(new)** | `concurrency.ts` |
| `test_two_tills_cannot_both_spend_a_coupons_last_use` | counter: a sale whose coupon is used up mid-flight is refused -- the coupon lock holds | `pos-sale-concurrency.ts` |
| `test_a_till_and_the_website_cannot_share_a_coupons_last_use` | checkout: a counter sale and an online order for a coupon's last use at once, each way round -- no deadlock **(new)** | `concurrency.ts` |
| `test_two_payments_cannot_pay_one_purchase_order_twice` | supplier payments: 6 payments of all an order owes at once -- one is recorded | `supplier-payment-concurrency.ts` |
| `test_a_replayed_supplier_payment_pays_once` | supplier payments: 6 clicks of one payment with one Idempotency-Key | `supplier-payment-concurrency.ts` |
| `test_a_cancel_cannot_land_on_an_order_being_received` | purchase orders: an order part received while a cancel of it waits on its row is not cancelled | `purchase-order-concurrency.ts` |
| `test_two_simultaneous_movements_with_one_key_post_once` | cash book: 6 clicks of one deposit with one Idempotency-Key; two deposits under one key queued on the account | `finance-concurrency.ts` |
| `test_two_simultaneous_write_offs_with_one_key_deduct_once` | inventory: 6 simultaneous retries of one write-off take one unit, once | `inventory-concurrency.ts` |
| `test_a_replayed_withdrawal_is_answered_not_refused` | cash book: 6 clicks of one withdrawal of all a drawer holds with one Idempotency-Key **(new)** | `finance-concurrency.ts` |
| `test_two_simultaneous_pos_sales_with_one_key_sell_once` | counter: 6 clicks with one Idempotency-Key -- one sale, one unit sold | `pos-sale-concurrency.ts` |
| `test_one_remittance_recorded_four_times_at_once_is_one_payment` | orders: 6 recordings of one remittance at once with no key -- captured once, five refused as past what is owed; and two queued on the order's row | `staff-orders-concurrency.ts` |
| `test_one_payment_request_sent_four_times_at_once_is_answered_four_times` | orders: 6 copies of one payment request with one Idempotency-Key -- six 201s, one payment | `staff-orders-concurrency.ts` |
| `test_the_last_two_owners_cannot_both_be_switched_off_at_once` | team: the last two owners switched off at once -- one goes, an owner is left; and the second switched off while the first's deactivation waits on the owners' rows | `team-concurrency.ts` |
| `test_one_owner_demoted_while_the_other_is_switched_off_leaves_an_owner` | team: one owner switched off while the other is demoted -- an owner is left | `team-concurrency.ts` |
| `test_the_sweep_leaves_an_order_confirmed_while_it_waited` | sweep: an order confirmed while the sweep waits on its row -- it is left confirmed | `sweep-concurrency.ts` |

Two of the five say less than their names. Every counter sale takes the `order:POS` number
sequence's row lock before it touches stock, so counter sales already run one after another and
cannot deadlock on shelves whatever order their lines are in; Django's two tests pass for the
same reason. The checks are there so that the day the sequence lock goes, something fails.

224 checks in a replay, all passing: the 211 the comparison had, the three of the pg-boss
queue's own, the six added here, and four with the guards of 2026-10-13 (three older checks
were rewritten then, to the fixed outcome). They take about a minute on two Nest processes,
where the comparison's take ten: Django was the slower half.

## Django's other tests

The plan's step 1.6 sorts Django's 1,514 tests (87 files) into three: covered by a parity case
already; a service-level invariant no case reaches, to be ported as a Nest test against a real
database; and Django-only, which goes with the thing it tests. **This is sorted by file, not
yet by test, and only the concurrency tests are done.** It is most of what is left of step 1.

| Kind | Files | Tests | What becomes of them | State |
|---|---|---|---|---|
| Concurrency (`tests/test_concurrency.py`) | 1 | 28 | each stood for by a race check, on two Nest processes | **done** (above) |
| Through the API (`tests/api/`) | 56 | 917 | the port wrote "a case per branch" for each of these areas, compared with Django; a test is covered when a case sends what it sends | to be confirmed test by test |
| Services called directly (`tests/test_*.py`) | 19 | 454 | the invariants: the ledger, costing, the cash book, VAT, discounts, the party ledger, the reports' arithmetic. Reached over HTTP by cases in most places; where a test arranges what no request can, a Nest test against a real database | not started |
| Pure logic (`tests/unit/`) | 4 | 73 | pricing, phone numbers, slugs, the site-content rules: the port's unit tests hold values Django printed for the same functions | to be confirmed test by test |
| Django-only | 7 | 47 | the label-mark migration; `migrate` keeping the roles in step (becomes the test of `sync-permissions`, plan step 4); the seed's guard and its reset (go with the seed, plan step 2); the psycopg adapter; the query budgets, whose idea ports and whose ORM counts do not | go with what they test |

The counts are the plan's, of 2026-10-08, but for the concurrency row. Two files have been added
to the services row since, each written with a fix made in both APIs and each compared case by
case when it was: `tests/test_one_order.py` (D243 to D245) and
`tests/test_guards_before_django_goes.py` (the guards ADR-0020 put first). pytest collects 1,811
today.

**How to sort the 1,444 in the middle without reading each against 12,243 cases:** by what
they execute. Run Django's suite with branch coverage and one context per test
(`pytest --cov --cov-branch --cov-context=test`); run a whole parity comparison with Django
under coverage; then every line and branch of the apps' code that the tests reach and the
comparison never does is, with the tests that reach it, exactly the list of "an invariant no
case reaches". A test none of whose lines is the tests' alone stands on code a case already
exercises. Coverage is a coarse sieve -- the same line with another number in it is the same
line -- so the arithmetic (pricing, VAT, costing) still wants its values compared, as the
port's unit tests do. The two runs and the script that subtracts them were prepared on
2026-10-09 and not run: the machine could not hold them beside the replays.

## What is not in it yet

1. **Django's tests, sorted and ported** (above). Until it is done, removing Django removes
   assertions nothing else makes.
2. ~~D243 to D245.~~ Fixed in Django on 2026-10-12 and in the NestJS API on 2026-10-13; a
   replay is strict since ([Tied rows](#tied-rows)).
3. **A replay of a recording more than a day old.** Every replay so far was within hours of its
   recording. ADR-0021 says why the set clock should hold at any distance; the first replay at
   a distance is what shows it.
4. ~~The workflow has not run on GitHub.~~ It has, three times, and each of the first two runs
   found something no local run had: the clock (D247, four audit-log cases), then a grouped
   query with no order (D248, one case). A runner is another machine, and that is what it is
   for. A green run is still owed.
5. **Uploads in a bucket.** The recording is of the stack with its uploads on disk; the
   `PARITY_S3=1` comparison has no recorded counterpart.
6. **Where a recording lives once Django cannot make another.** Today it is made from the
   commit it sits beside and is untracked: a snapshot of 0.7 MB and 2.7 MB of answers, in a
   repository whose whole history packs to 11 MB. That is the plan's step 6 to decide.
7. **The harness's own unordered choices.** 24 cases pick their subject with a query that
   has no order; on a turned-over database they ask about another row. They agree with their
   recording on a plain restore, and are all that the turned-over run still lists. Giving
   those queries an order would let that run be a check of its own in CI.
8. The race checks' names still say "both APIs" and "Django" in the source; a replay prints
   them as "two Nest processes" and "the second Nest process".
