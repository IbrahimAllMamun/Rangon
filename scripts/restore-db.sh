#!/usr/bin/env bash
# Restore a Rangon dump into a target database.
# Usage: ./scripts/restore-db.sh <dump-file> [target-db]
#
# Default target is "<db>_restore" — restoring OVER a live database destroys the
# evidence of whatever went wrong.  Restore beside it, verify, then switch.
#
# Runs inside the database container by default, for the same reason
# backup-db.sh does: the client there always matches the server (D14 in
# docs/roadmap.md).  Set RESTORE_VIA=direct for a managed database with no db
# container and a matching client on PATH.
set -Eeuo pipefail

FILE="${1:?usage: restore-db.sh <dump-file> [target-db]}"
: "${RESTORE_VIA:=compose}"
: "${COMPOSE_FILES:=-f docker-compose.yml}"
: "${DB_SERVICE:=db}"
: "${POSTGRES_HOST:=db}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=rangon}"
: "${POSTGRES_USER:=rangon}"
: "${PGPASSWORD:=${POSTGRES_POSTGRES_PASSWORD:-${POSTGRES_PASSWORD:-}}}"
export PGPASSWORD
TARGET="${2:-${POSTGRES_DB}_restore}"

[ -f "$FILE" ] || { echo "!! no such file: $FILE" >&2; exit 1; }

if [ "$TARGET" = "$POSTGRES_DB" ]; then
    echo "!! You are about to restore over the LIVE database '${TARGET}'."
    echo "!! Type the database name to confirm:"
    read -r CONFIRM
    [ "$CONFIRM" = "$TARGET" ] || { echo "aborted"; exit 1; }
fi

if [ "$RESTORE_VIA" = "compose" ]; then
    HOST=localhost PORT=5432
    run() {
        # shellcheck disable=SC2086  # COMPOSE_FILES is a deliberate word list
        docker compose $COMPOSE_FILES exec -T \
            -e PGPASSWORD="$PGPASSWORD" "$DB_SERVICE" "$@"
    }
else
    HOST="$POSTGRES_HOST" PORT="$POSTGRES_PORT"
    run() { "$@"; }
fi

echo "==> creating ${TARGET}"
run createdb --host="$HOST" --port="$PORT" --username="$POSTGRES_USER" \
    "$TARGET" 2>/dev/null || echo "    (already exists, continuing)"

echo "==> restoring ${FILE} -> ${TARGET}"
# `--jobs` needs a seekable archive, so it is only used where pg_restore reads
# the file itself. Streamed into the container the restore is single-threaded;
# on a shop-sized database that is seconds, not minutes.
if [ "$RESTORE_VIA" = "compose" ]; then
    run pg_restore --host="$HOST" --port="$PORT" --username="$POSTGRES_USER" \
        --dbname="$TARGET" --no-owner --no-privileges /dev/stdin < "$FILE"
else
    pg_restore --host="$HOST" --port="$PORT" --username="$POSTGRES_USER" \
        --dbname="$TARGET" --no-owner --no-privileges --jobs=4 "$FILE"
fi

echo "==> sanity check"
run psql --host="$HOST" --port="$PORT" --username="$POSTGRES_USER" \
    --dbname="$TARGET" --command "
        select (select count(*) from orders_order)                  as orders,
               (select count(*) from inventory_inventorytransaction) as ledger_rows,
               (select count(*) from catalog_productvariant)         as variants,
               (select max(created_at) from orders_order)            as latest_order;"

echo "==> restored into ${TARGET}."
echo "    Point DATABASE_URL at it, run migrate, then 'manage.py verify_inventory'."
