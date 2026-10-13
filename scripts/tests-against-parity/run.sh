#!/usr/bin/env bash
# Which of Django's rule code do its own tests reach that no parity case does?
#
#   scripts/tests-against-parity/run.sh tests     Django's suite, one coverage context per test
#   scripts/tests-against-parity/run.sh parity    a whole comparison, races included, Django under coverage
#   scripts/tests-against-parity/run.sh diff      subtract; writes covdiff.json and the sorted list
#
# The method and the result: docs/architecture/djangos-tests-sorted.md.
# `parity` resets the parity stack's database, as `scripts/nest-parity.sh reset`
# does; run one stack at a time on a small Docker VM. The data lands in
# COVERAGE_DATA (default apps/api-nest/parity/recorded/coverage, untracked).
set -euo pipefail
cd "$(dirname "$0")/../.."
here=scripts/tests-against-parity
data="${COVERAGE_DATA:-$PWD/apps/api-nest/parity/recorded/coverage}"
mkdir -p "$data"
export COVERAGE_DATA="$data"
tests=(docker compose -p "${TEST_PROJECT:-rangon-test}" -f docker-compose.test.yml)
parity=(docker compose -p "${PARITY_PROJECT:-rangon-nest}" -f docker-compose.nest.yml -f "$here/compose.cov.yml")
as_me=(--user "$(id -u):$(id -g)" -e HOME=/tmp)

case "${1:-}" in
  tests)
    rm -f "$data/tests.coverage"
    "${tests[@]}" run --rm "${as_me[@]}" -e COVERAGE_FILE=/covdata/tests.coverage -v "$data:/covdata" \
      api-test pytest -p no:cacheprovider -q --cov=. --cov-branch --cov-context=test --cov-report=
    "${tests[@]}" down -v --remove-orphans
    ;;
  parity)
    rm -f "$data/parity.coverage"
    scripts/nest-parity.sh reset
    # The same Django, restarted under coverage. The harness is run through the
    # overlay too: without it compose would put the plain Django back.
    "${parity[@]}" up -d --force-recreate django
    for _ in $(seq 1 180); do
      curl -sf -o /dev/null "http://127.0.0.1:${PARITY_PORT_DJANGO:-8610}/api/health/" && break
      sleep 1
    done
    "${parity[@]}" run --rm -e PARITY_ONLY= -e PARITY_VERBOSE= -e PARITY_RACES= parity
    # A graceful stop: the worker writes its coverage as it exits.
    "${parity[@]}" stop -t 90 django
    scripts/nest-parity.sh down
    ;;
  diff)
    before="${2:-$data/covdiff.json}"
    "${tests[@]}" run --rm --no-deps "${as_me[@]}" -v "$PWD/$here:/cov:ro" -v "$data:/covdata" \
      api-test python /cov/covdiff.py /covdata/tests.coverage /covdata/parity.coverage /covdata/covdiff.json
    "${tests[@]}" run --rm --no-deps "${as_me[@]}" -v "$PWD/$here:/cov:ro" -v "$data:/covdata" \
      -v "$PWD/docs/architecture:/docs" -e PYTHONPATH=/cov api-test \
      python /cov/sort_tests.py "/covdata/$(basename "$before")" /covdata/covdiff.json \
      /covdata/sorted.md /docs/djangos-tests-sorted.tsv
    echo "the tables: $data/sorted.md (pasted into docs/architecture/djangos-tests-sorted.md)"
    ;;
  *)
    sed -n '2,12p' "$0" >&2
    exit 2
    ;;
esac
