#!/usr/bin/env bash
# The demo shop as a database snapshot: what the test stacks start from when
# there is no Django to seed them (removal plan step 2; ADR-0020, decision 3).
#
#   scripts/demo-snapshot.sh make                      Django migrates and seeds a throwaway database;
#                                                      what it holds is dumped, with its uploads
#   scripts/demo-snapshot.sh restore <container> [database] [user]
#                                                      into the PostgreSQL in that container: an EMPTY
#                                                      database only. MEDIA_DIR=<dir> puts the uploads there
#
# `make` is the one step that needs Django, and it is Django's own
# `migrate` and `seed_demo --reset` on development settings. Once Django is
# gone the snapshot is not made again: it is brought forward by migrations
# (plan step 3).
#
# THE ACCOUNTS' PASSWORD. Left alone, the seeded accounts carry the password
# printed in the README, which is right for a test stack and wrong for
# anything another machine can reach: `seed_demo` refuses to put it on a
# production-settings database, and a restore is a way round that refusal.
# For a demo shop on a stack like that, make the snapshot with a password of
# your own (DJANGO_DEMO_SEED_PASSWORD=... scripts/demo-snapshot.sh make);
# `made.txt` says which kind a snapshot holds, and `restore` repeats it.
#
# What it leaves, in DEMO_SNAPSHOT_DIR (default infrastructure/snapshots/demo,
# untracked -- made from the commit it sits beside, like the recorded proof):
#   demo.dump       pg_dump -Fc --no-owner: schema and rows, Django's framework tables included
#   media.tar.gz    the uploads the rows name
#   made.txt        the commit, the moment, the last migration of each app
#
# `restore` wants only Docker and a running PostgreSQL container: no Python, no
# Node. It refuses a database that already has tables in it, so it cannot be
# pointed at a shop by mistake.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${DEMO_SNAPSHOT_DIR:-$PWD/infrastructure/snapshots/demo}"

case "${1:-}" in
  make)
    compose=(docker compose -p "${SNAPSHOT_PROJECT:-rangon-snapshot}" -f docker-compose.test.yml)
    mkdir -p "$out"
    rm -rf "$out/demo.dump" "$out/media.tar.gz" "$out/made.txt" "$out/media.tmp"
    mkdir -p "$out/media.tmp"
    "${compose[@]}" down -v --remove-orphans
    # Development settings, not the test ones: the test settings hash
    # passwords with MD5, which no API signs anybody in with.
    "${compose[@]}" run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -e DJANGO_SETTINGS_MODULE=config.settings.dev -e DJANGO_DEBUG=1 \
      -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= \
      -e DJANGO_DEMO_SEED_PASSWORD="${DJANGO_DEMO_SEED_PASSWORD:-}" \
      -v "$out/media.tmp:/app/media" \
      api-test sh -c 'python manage.py migrate --noinput && python manage.py seed_demo --reset'
    "${compose[@]}" exec -T db-test pg_dump -U rangon -d rangon_test -Fc --no-owner > "$out/demo.dump"
    tar -czf "$out/media.tar.gz" -C "$out/media.tmp" .
    {
      echo "commit   $(git rev-parse HEAD)$(git diff --quiet HEAD -- apps/api || echo ' (with uncommitted changes under apps/api)')"
      echo "made     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      if [ -n "${DJANGO_DEMO_SEED_PASSWORD:-}" ]; then
        echo "accounts a password of the maker's own"
      else
        echo "accounts THE PASSWORD PRINTED IN THE README: for a stack only you can reach"
      fi
      echo "rows     $("${compose[@]}" exec -T db-test psql -U rangon -d rangon_test -Atc \
        "SELECT (SELECT count(*) FROM catalog_product) || ' products, ' || (SELECT count(*) FROM orders_order) || ' orders, ' || (SELECT count(*) FROM accounts_user) || ' accounts'")"
      echo "migrations"
      "${compose[@]}" exec -T db-test psql -U rangon -d rangon_test -Atc \
        "SELECT '  ' || app || ' ' || max(name) FROM django_migrations GROUP BY app ORDER BY app"
    } > "$out/made.txt"
    "${compose[@]}" down -v --remove-orphans
    rm -rf "$out/media.tmp"
    cat "$out/made.txt"
    ls -l "$out"
    ;;
  restore)
    container="${2:?the PostgreSQL container to restore into (a name or an id)}"
    database="${3:-rangon}"
    user="${4:-rangon}"
    for part in demo.dump media.tar.gz; do
      [ -s "$out/$part" ] || { echo "no $out/$part: run \`$0 make\` first, or fetch the snapshot" >&2; exit 2; }
    done
    tables=$(docker exec "$container" psql -U "$user" -d "$database" -Atc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
    if [ "$tables" != 0 ]; then
      echo "the database $database in $container already holds $tables tables: a snapshot is restored into an empty one" >&2
      exit 3
    fi
    docker exec -i "$container" pg_restore --exit-on-error --no-owner -U "$user" -d "$database" < "$out/demo.dump"
    if [ -n "${MEDIA_DIR:-}" ]; then
      mkdir -p "$MEDIA_DIR"
      tar -xzf "$out/media.tar.gz" -C "$MEDIA_DIR"
    fi
    grep '^accounts' "$out/made.txt" 2>/dev/null || echo "accounts (made.txt does not say which password they carry)"
    echo "restored: $(docker exec "$container" psql -U "$user" -d "$database" -Atc \
      "SELECT (SELECT count(*) FROM catalog_product) || ' products, ' || (SELECT count(*) FROM orders_order) || ' orders'")${MEDIA_DIR:+, uploads in $MEDIA_DIR}"
    ;;
  *)
    sed -n '2,12p' "$0" >&2
    exit 2
    ;;
esac
