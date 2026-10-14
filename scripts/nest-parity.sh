#!/usr/bin/env bash
# The NestJS API held to its recorded answers (docs/architecture/recorded-proof.md).
#
#   scripts/nest-parity.sh replay        a stack restored from the recording, every case against
#                                        its recorded answer, the races across two API processes,
#                                        the worker, the rate limits. Takes PARITY_ONLY,
#                                        PARITY_RACES and PARITY_VERBOSE as filters.
#                                        PARITY_TIES=mark: where an answer is the recorded rows
#                                        with tied ones in another order, keep where.
#                                        PARITY_HEAP=reversed: every table's rows turned over
#                                        first, to find what depends on the order rows lie in.
#                                        PARITY_ACCEPT=<regex>: the API's answer becomes the
#                                        recorded one for the cases it names -- a deliberate
#                                        change, committed with the change that made it
#   scripts/nest-parity.sh replay-empty  the same for the shop with nothing in it, at each of
#                                        its two moments
#   scripts/nest-parity.sh replay-down   remove that stack and its volumes
#
# The recording is committed (apps/api-nest/parity/recorded/): it was taken
# while Django still ran, from the cases on which the two APIs agreed, and
# nothing can take another (django-removal-plan.md, step 6.4). Each replay
# restores its snapshot and brings it to this build's schema with the API's
# own `migrate`, as a release would. A deliberate change to an answer is a
# change to the recording, made in the same commit (recorded-proof.md).
#
# Always the `rangon-recorded` compose project (`.env` sets
# COMPOSE_PROJECT_NAME=rangon); a second checkout names its own with
# RECORDED_PROJECT and RECORDED_PORT.
set -euo pipefail
cd "$(dirname "$0")/.."
# RECORDED_OVERLAY: one more compose file laid over the replay stack, for an
# experiment on it (a shifted clock, say) that does not belong in the repository.
recorded=(docker compose -p "${RECORDED_PROJECT:-rangon-recorded}" -f docker-compose.recorded.yml ${RECORDED_OVERLAY:+-f "$RECORDED_OVERLAY"})
recorded_dir="${PARITY_RECORDED_DIR:-$PWD/apps/api-nest/parity/recorded}"
export PARITY_RECORDED_DIR="$recorded_dir"

wait_for() {
  for _ in $(seq 1 120); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "timed out waiting for $1" >&2; return 1
}

# The snapshot restored into an empty database, then brought to this build's
# schema: the recording was taken at the baseline, before any migration of
# the API's own.
restore() {
  # This checkout's build, before its `migrate` runs: an image left from
  # another commit would bring the database to that commit's schema.
  "${recorded[@]}" build nest
  PARITY_HEAP="${1:-}" "${recorded[@]}" --profile restore run --rm restore
  "${recorded[@]}" run --rm --no-deps -T nest node dist/cli.js migrate
}

case "${1:-}" in
  replay)
    for part in snapshot.dump media.tar.gz answers.jsonl.gz clock.txt; do
      [ -s "$recorded_dir/$part" ] || { echo "no $recorded_dir/$part: the recording is committed; is this a full checkout?" >&2; exit 2; }
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
    restore "${PARITY_HEAP:-}"
    "${recorded[@]}" up -d --build nest nest-b
    wait_for "http://127.0.0.1:${RECORDED_PORT:-8640}/api/health/"
    status=0
    # PARITY_TIES=mark and PARITY_ACCEPT write beside the answers, so as the
    # user who owns them.
    writes="${PARITY_TIES:-}${PARITY_ACCEPT:-}"
    "${recorded[@]}" --profile replay run --rm ${writes:+--user "$(id -u):$(id -g)" -e HOME=/tmp} replay || status=$?
    # The worker on what the API queues: only after a whole replay, which
    # leaves the database as it found it.
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
  replay-empty)
    # As `replay`, once for each moment of the empty shop: the stack from
    # nothing, that moment's snapshot, every case against its recorded answer.
    # No races, worker or rate limits: the seeded shop's replay has those.
    given="${PARITY_FAKETIME:-}"
    status=0
    for stage in unopened opened; do
      dir="$recorded_dir/empty/$stage"
      for part in snapshot.dump media.tar.gz answers.jsonl.gz clock.txt; do
        [ -s "$dir/$part" ] || { echo "no $dir/$part: the recording is committed; is this a full checkout?" >&2; exit 2; }
      done
      behind=$(( $(date +%s) - $(cat "$dir/clock.txt") + 90 ))
      export PARITY_FAKETIME="${given:--$behind}"
      export PARITY_RECORDED_DIR="$dir"
      echo "the $stage shop: the replay's clocks run ${PARITY_FAKETIME}s from the real one"
      "${recorded[@]}" --profile restore --profile replay --profile worker --profile throttle down -v --remove-orphans
      "${recorded[@]}" up -d db redis
      restore
      "${recorded[@]}" up -d --build nest nest-b
      wait_for "http://127.0.0.1:${RECORDED_PORT:-8640}/api/health/"
      PARITY_RACES=none "${recorded[@]}" --profile replay run --rm -e PARITY_SHOP="$stage" replay || status=$?
    done
    exit "$status"
    ;;
  *)
    sed -n '2,20p' "$0"; exit 2
    ;;
esac
