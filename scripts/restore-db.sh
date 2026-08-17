#!/usr/bin/env bash
# Restore a Rangon dump into a target database.
# Usage: ./scripts/restore-db.sh <dump-file> [target-db]
#
# Default target is "<db>_restore" — restoring OVER a live database destroys the
# evidence of whatever went wrong.  Restore beside it, verify, then switch.
set -Eeuo pipefail

FILE="${1:?usage: restore-db.sh <dump-file> [target-db]}"
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

echo "==> creating ${TARGET}"
createdb --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" --username="$POSTGRES_USER" \
         "$TARGET" 2>/dev/null || echo "    (already exists, continuing)"

echo "==> restoring ${FILE} -> ${TARGET}"
pg_restore --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" --username="$POSTGRES_USER" \
           --dbname="$TARGET" --no-owner --no-privileges --jobs=4 "$FILE"

echo "==> sanity check"
psql --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" --username="$POSTGRES_USER" \
     --dbname="$TARGET" --command "
        select (select count(*) from orders_order)                  as orders,
               (select count(*) from inventory_inventorytransaction) as ledger_rows,
               (select count(*) from catalog_productvariant)         as variants,
               (select max(created_at) from orders_order)            as latest_order;"

echo "==> restored into ${TARGET}."
echo "    Point DATABASE_URL at it, run migrate, then 'manage.py verify_inventory'."
