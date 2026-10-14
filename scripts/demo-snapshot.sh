#!/usr/bin/env bash
# The demo shop as a database snapshot: what the test stacks, the development
# stack and a local production stack start from (ADR-0020, decision 3).
#
#   scripts/demo-snapshot.sh restore <container> [database] [user]
#                     into the PostgreSQL in that container: an EMPTY database
#                     only. MEDIA_DIR=<dir> puts the uploads there
#
# The snapshot is committed (infrastructure/snapshots/demo/): Django seeded it
# while it still ran, and nothing can seed another. It is at the schema of the
# commit `made.txt` names; `node dist/cli.js migrate` brings it forward, as
# for any database Django built. A fixture that needs new rows adds them
# through the API or in SQL, and the snapshot is dumped again from that.
#
# THE ACCOUNTS' PASSWORD is the one printed in the README, which is right for
# a test stack and wrong for anything another machine can reach: give each
# account one of your own with `node dist/cli.js set-password` before such a
# stack is reachable (scripts/rebuild-local-prod.sh does).
#
# What is there:
#   demo.dump       pg_dump -Fc --no-owner: schema and rows
#   media.tar.gz    the uploads the rows name
#   made.txt        the commit, the moment, the last migration of each app
#
# `restore` wants only Docker and a running PostgreSQL container: no Node. It
# refuses a database that already has tables in it, so it cannot be pointed
# at a shop by mistake.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${DEMO_SNAPSHOT_DIR:-$PWD/infrastructure/snapshots/demo}"

case "${1:-}" in
  restore)
    container="${2:?the PostgreSQL container to restore into (a name or an id)}"
    database="${3:-rangon}"
    user="${4:-rangon}"
    for part in demo.dump media.tar.gz; do
      [ -s "$out/$part" ] || { echo "no $out/$part: the snapshot is committed; is this a full checkout?" >&2; exit 2; }
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
    sed -n '2,8p' "$0" >&2
    exit 2
    ;;
esac
