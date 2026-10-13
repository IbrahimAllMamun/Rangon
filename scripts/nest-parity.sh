#!/usr/bin/env bash
# The NestJS API beside the Django one, and the harness that compares them.
#
#   scripts/nest-parity.sh up       build and start both APIs on one database
#   scripts/nest-parity.sh seed     demo data plus the parity fixture
#   scripts/nest-parity.sh run      compare every case; non-zero on a difference
#   scripts/nest-parity.sh run-jobs the same, with the Nest API queuing its jobs in pg-boss (ADR-0016),
#                                   then `worker`
#   scripts/nest-parity.sh worker   the Nest worker on what the API queues: run, retried, closed
#   scripts/nest-parity.sh reset    DESTRUCTIVE to the parity database only: drop it, then up + seed
#   scripts/nest-parity.sh empty    DESTRUCTIVE likewise: a shop on its first day instead of the seeded
#                                   one, compared at two moments -- migrated with one owner, then with
#                                   `scripts/bootstrap-store.py` run on it (parity/empty-shop-cases.ts).
#                                   `reset` brings the seeded shop back
#
# The proof that needs no Django (docs/architecture/recorded-proof.md):
#   scripts/nest-parity.sh record   after `reset`: a snapshot of the database and the uploads, then
#                                   the `run-jobs` comparison, keeping the Nest API's answer to every
#                                   case the two agree on (apps/api-nest/parity/recorded/, untracked)
#   scripts/nest-parity.sh replay   another stack with no Django in it (docker-compose.recorded.yml),
#                                   restored from that snapshot: every case against its recorded
#                                   answer, the races across two Nest processes, then the worker.
#                                   Takes PARITY_ONLY, PARITY_RACES and PARITY_VERBOSE as `run` does.
#                                   PARITY_TIES=mark: where an answer is the recorded rows with tied
#                                   ones in another order, keep where (once, after `record`).
#                                   PARITY_HEAP=reversed: every table's rows turned over first, to
#                                   find what depends on the order rows lie in
#   scripts/nest-parity.sh replay-down   remove that stack and its volumes
#
# PARITY_S3=1 before any of them runs the stack with its uploads in a bucket
# (USE_S3=1 on both APIs, an S3 server beside them). Give it to `reset` and to
# every command after it: a database seeded one way holds files the other
# cannot find.
#   scripts/nest-parity.sh down     stop, keeping the database
#
# Always the `rangon-nest` compose project: `.env` sets COMPOSE_PROJECT_NAME=rangon,
# and without -p these containers would join the development project. A second
# checkout running beside the first names its own: PARITY_PROJECT, with
# PARITY_PORT_DJANGO, PARITY_PORT_NEST, PARITY_PORT_JOBS and PARITY_IMAGE
# (docker-compose.nest.yml), and RECORDED_PROJECT and RECORDED_PORT for `replay`.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -p "${PARITY_PROJECT:-rangon-nest}" -f docker-compose.nest.yml)
# RECORDED_OVERLAY: one more compose file laid over the replay stack, for an
# experiment on it (a shifted clock, say) that does not belong in the repository.
recorded=(docker compose -p "${RECORDED_PROJECT:-rangon-recorded}" -f docker-compose.recorded.yml ${RECORDED_OVERLAY:+-f "$RECORDED_OVERLAY"})
django_url="http://127.0.0.1:${PARITY_PORT_DJANGO:-8610}"
nest_url="http://127.0.0.1:${PARITY_PORT_NEST:-8620}"
jobs_url="http://127.0.0.1:${PARITY_PORT_JOBS:-8630}"
# The snapshot and the answers. Under the working copy, because Docker
# Desktop mounts nothing from outside the home directory; untracked, because
# both are made from the commit they sit beside (`.gitignore`).
recorded_dir="${PARITY_RECORDED_DIR:-$PWD/apps/api-nest/parity/recorded}"
export PARITY_RECORDED_DIR="$recorded_dir"

wait_for() {
  for _ in $(seq 1 120); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "timed out waiting for $1" >&2; return 1
}

case "${1:-}" in
  up)
    # PARITY_S3=1: uploads in a bucket, as with USE_S3=1 (docker-compose.nest.yml
    # reads the same variable). The S3 server first, then its bucket, made with
    # the credentials and the client Django itself uses.
    if [ "${PARITY_S3:-0}" = 1 ]; then "${compose[@]}" --profile s3 up -d s3; fi
    "${compose[@]}" up -d --build django nest
    wait_for "$django_url/api/health/"
    wait_for "$nest_url/api/health/"
    if [ "${PARITY_S3:-0}" = 1 ]; then
      "${compose[@]}" exec -T django python manage.py shell -c '
from botocore.exceptions import ClientError
from django.core.files.storage import default_storage as storage
try:
    storage.connection.meta.client.create_bucket(Bucket=storage.bucket_name)
except ClientError as error:
    if error.response["Error"]["Code"] not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
        raise
print("bucket", storage.bucket_name, "ready")'
    fi
    ;;
  seed)
    # The media directory is shared with the Nest API, which runs as another user.
    "${compose[@]}" exec -T django sh -c 'mkdir -p /app/media && chmod -R a+rwX /app/media'
    # Seeding saves categories and navigation items, whose signals would ping
    # the storefront's revalidation URL inline; nothing listens, so it is unset.
    "${compose[@]}" exec -T -e DJANGO_ALLOW_DEMO_SEED=1 -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py seed_demo --reset
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_content.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_nav.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_accounts.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_orders.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_cart.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_payments.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_staff.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_attributes.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_products.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_inventory.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_pages.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_merchandising.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_pos.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_returns.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_staff_orders.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_labels.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_finance.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_purchasing.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_customers.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_shipping.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_reviews.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_team.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_audit.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_notifications.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_reports.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_jobs.py
    "${compose[@]}" exec -T django python manage.py shell < apps/api-nest/parity/fixture_media.py
    ;;
  run)
    "${compose[@]}" run --rm -e PARITY_ONLY="${PARITY_ONLY:-}" -e PARITY_VERBOSE="${PARITY_VERBOSE:-}" -e PARITY_RACES="${PARITY_RACES:-}" parity
    ;;
  run-jobs)
    # The throttled pair's trick, for the same reason: a container left from
    # before a reset still names the network that reset removed.
    "${compose[@]}" --profile jobs up -d --build --force-recreate nest-jobs
    wait_for "$jobs_url/api/health/"
    "${compose[@]}" --profile jobs run --rm -e PARITY_ONLY="${PARITY_ONLY:-}" -e PARITY_VERBOSE="${PARITY_VERBOSE:-}" -e PARITY_RACES="${PARITY_RACES:-}" parity-jobs
    bash "$0" worker
    ;;
  worker)
    # The worker itself, on what the Nest API queues: run, retried, closed.
    # Whatever the comparison left queued goes first; the worker would run it.
    "${compose[@]}" --profile jobs up -d nest-jobs
    wait_for "$jobs_url/api/health/"
    "${compose[@]}" exec -T db psql -q -U rangon -d rangon -c 'DELETE FROM pgboss.job'
    "${compose[@]}" --profile worker up -d --force-recreate nest-worker
    status=0
    "${compose[@]}" --profile jobs run --rm parity-jobs node parity/worker-check.ts || status=$?
    "${compose[@]}" --profile worker rm -sf nest-worker
    exit "$status"
    ;;
  record)
    # The database as the comparison is about to find it, and the uploads its
    # rows name; then the comparison, keeping what the Nest API answers. The
    # Nest side queues in pg-boss, as production does: its first start makes
    # the `pgboss` schema, which is why it is up before the dump.
    "${compose[@]}" --profile jobs up -d --build --force-recreate nest-jobs
    wait_for "$jobs_url/api/health/"
    mkdir -p "$recorded_dir"
    rm -f "$recorded_dir"/snapshot.dump "$recorded_dir"/media.tar.gz "$recorded_dir"/*.jsonl.gz "$recorded_dir"/made.txt "$recorded_dir"/clock.txt "$recorded_dir"/began.txt
    "${compose[@]}" exec -T db psql -q -U rangon -d rangon -c 'DELETE FROM pgboss.job'
    "${compose[@]}" exec -T db pg_dump -U rangon -d rangon -Fc --no-owner > "$recorded_dir/snapshot.dump"
    # Through the Django container, which can read every file whoever wrote it.
    "${compose[@]}" exec -T django tar -czf - -C /app/media . > "$recorded_dir/media.tar.gz"
    # And the comparison is made on a restore of that snapshot, not on the
    # database it was taken from: the same rows, lying in the order a replay
    # will find them in. Where an answer leaves rows that tie to the order
    # they lie in, the recording and its replays then start from one order.
    "${compose[@]}" --profile jobs stop django nest nest-jobs
    "${compose[@]}" exec -T db psql -q -U rangon -d postgres \
      -c 'DROP DATABASE rangon WITH (FORCE)' -c 'CREATE DATABASE rangon OWNER rangon'
    "${compose[@]}" exec -T db pg_restore --exit-on-error --no-owner -U rangon -d rangon < "$recorded_dir/snapshot.dump"
    "${compose[@]}" --profile jobs start django nest-jobs
    wait_for "$django_url/api/health/"
    wait_for "$jobs_url/api/health/"
    # The moment the recording begins: a replay sets its clocks by it.
    date +%s > "$recorded_dir/clock.txt"
    # As this user, so that the answers land in a file this user owns.
    "${compose[@]}" --profile jobs run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$recorded_dir:/recorded" -e PARITY_MODE=record \
      -e PARITY_ONLY="${PARITY_ONLY:-}" -e PARITY_VERBOSE="${PARITY_VERBOSE:-}" -e PARITY_RACES="${PARITY_RACES:-}" \
      parity-jobs
    # The rate limits, which the comparison above runs without: both APIs
    # throttled, the Nest API's side kept. Skipped under a filter, as the
    # races are.
    if [ -z "${PARITY_ONLY:-}" ]; then
      "${compose[@]}" --profile throttle up -d --build --force-recreate nest-throttled django-throttled
      throttled=0
      "${compose[@]}" --profile throttle run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
        -v "$recorded_dir:/recorded" -e PARITY_MODE=record throttle-check || throttled=$?
      "${compose[@]}" --profile throttle rm -sf nest-throttled django-throttled
      [ "$throttled" = 0 ] || exit "$throttled"
    fi
    {
      echo "commit   $(git rev-parse HEAD)$(git diff --quiet HEAD -- apps scripts docker-compose.nest.yml || echo ' (with uncommitted changes)')"
      echo "made     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "only     ${PARITY_ONLY:-(every case)}"
    } > "$recorded_dir/made.txt"
    ls -l "$recorded_dir"
    ;;
  replay)
    for part in snapshot.dump media.tar.gz answers.jsonl.gz clock.txt; do
      [ -s "$recorded_dir/$part" ] || { echo "no $recorded_dir/$part: run \`$0 record\` first" >&2; exit 2; }
    done
    # The clock: every process of the stack as many seconds behind the real
    # one as the recording is old, and a minute and a half more -- the stack
    # takes about that long to come up, and the replay must not be ahead of
    # the recording when its first case runs (run.ts waits where it is
    # behind; it cannot go back). PARITY_FAKETIME given: that, as it is.
    behind=$(( $(date +%s) - $(cat "$recorded_dir/clock.txt") + 90 ))
    export PARITY_FAKETIME="${PARITY_FAKETIME:--$behind}"
    echo "the replay's clocks run ${PARITY_FAKETIME}s from the real one"
    # From nothing, every time: a replay that began on what the last one left
    # would not be the recording's database.
    "${recorded[@]}" --profile restore --profile replay --profile worker --profile throttle down -v --remove-orphans
    "${recorded[@]}" up -d db redis
    # PARITY_HEAP=reversed: every table's rows turned over once they are in
    # (parity/reverse-heap.sql), to find what depends on the order they lie in.
    PARITY_HEAP="${PARITY_HEAP:-}" "${recorded[@]}" --profile restore run --rm restore
    "${recorded[@]}" up -d --build nest nest-b
    wait_for "http://127.0.0.1:${RECORDED_PORT:-8640}/api/health/"
    status=0
    # PARITY_TIES=mark writes beside the answers, so as the user who owns them.
    "${recorded[@]}" --profile replay run --rm ${PARITY_TIES:+--user "$(id -u):$(id -g)" -e HOME=/tmp} replay || status=$?
    # The worker on what the API queues, as `worker` above: only after a whole
    # replay, which leaves the database as it found it.
    if [ -z "${PARITY_ONLY:-}" ]; then
      "${recorded[@]}" exec -T db psql -q -U rangon -d rangon -c 'DELETE FROM pgboss.job'
      "${recorded[@]}" --profile worker up -d --force-recreate nest-worker
      "${recorded[@]}" --profile replay run --rm replay node parity/worker-check.ts || status=$?
      "${recorded[@]}" --profile worker rm -sf nest-worker
      # The rate limits, held to what was recorded.
      if [ -s "$recorded_dir/throttle.jsonl.gz" ]; then
        "${recorded[@]}" --profile throttle up -d nest-throttled
        "${recorded[@]}" --profile throttle run --rm throttle-replay || status=$?
        "${recorded[@]}" --profile throttle rm -sf nest-throttled
      else
        echo "no $recorded_dir/throttle.jsonl.gz: the rate limits were not recorded" >&2
        status=1
      fi
    fi
    exit "$status"
    ;;
  replay-down)
    "${recorded[@]}" --profile restore --profile replay --profile worker --profile throttle down -v --remove-orphans
    ;;
  empty)
    # What a new installation is, and no case on the seeded shop can reach:
    # nothing can empty that one. The same steps as the new-store guide
    # (docs/operations/new-store-from-scratch.md), with the cases run after
    # each. Both stages run whatever the first finds.
    "${compose[@]}" --profile parity --profile jobs --profile worker --profile throttle --profile s3 down -v --remove-orphans
    bash "$0" up
    "${compose[@]}" exec -T django sh -c 'mkdir -p /app/media && chmod -R a+rwX /app/media'
    # No password: the harness mints its own tokens, and nobody signs in.
    "${compose[@]}" exec -T -e DJANGO_SUPERUSER_EMAIL=owner@rangon.test django python manage.py createsuperuser --noinput
    status=0
    "${compose[@]}" run --rm -e PARITY_SHOP=unopened -e PARITY_RACES=none \
      -e PARITY_ONLY="${PARITY_ONLY:-}" -e PARITY_VERBOSE="${PARITY_VERBOSE:-}" parity || status=$?
    "${compose[@]}" exec -T -e SHOP_NAME="Rangon Fashion" -e BRANCH_NAME="Rangon Panthapath" -e BRANCH_CODE=DHK1 \
      -e WEB_REVALIDATE_URL= django python manage.py shell < scripts/bootstrap-store.py
    "${compose[@]}" run --rm -e PARITY_SHOP=opened -e PARITY_RACES=none \
      -e PARITY_ONLY="${PARITY_ONLY:-}" -e PARITY_VERBOSE="${PARITY_VERBOSE:-}" parity || status=$?
    exit "$status"
    ;;
  reset)
    # Every profile: a container left from one of them still names the network
    # this removes, and the next `up` of it fails.
    "${compose[@]}" --profile parity --profile jobs --profile worker --profile throttle --profile s3 down -v --remove-orphans
    bash "$0" up
    bash "$0" seed
    ;;
  down)
    # The profiles' containers too (not the S3 server, whose bucket goes with
    # its container): `down` alone leaves them running, on a network it has
    # just tried to remove.
    "${compose[@]}" --profile parity --profile jobs --profile worker --profile throttle down
    ;;
  *)
    sed -n '2,31p' "$0"; exit 2
    ;;
esac
