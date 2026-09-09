#!/usr/bin/env bash
# Dump the Rangon database, compress, upload off-host, prune old copies.
# Usage: ./scripts/backup-db.sh [label]
# Exits non-zero on any failure so a broken backup is noisy, not silent.
#
# ---------------------------------------------------------------------------
# Where pg_dump runs (D14 in docs/roadmap.md)
#
# `pg_dump` refuses to read a server newer than itself. The API image is Debian
# bookworm, whose `libpq5`/`postgresql-client` is 15, and the database is 16 --
# so running this in the `api` container aborted with "server version
# mismatch", and running it on a host whose client happened to be older failed
# the same way. Pinning a client version in the API image only moves the
# problem to the next major upgrade.
#
# So by default the dump runs inside the **database** container, whose client
# is the same build as its server and always will be. The bytes stream to this
# host over stdout; upload and pruning stay here, where the AWS CLI is.
#
#   BACKUP_VIA=compose   (default) dump via `docker compose exec` on the db service
#   BACKUP_VIA=direct    dump with the local pg_dump -- for a managed database
#                        with no db container. The version is checked first.
# ---------------------------------------------------------------------------
set -Eeuo pipefail

LABEL="${1:-scheduled}"
ENVIRONMENT="${RANGON_ENV:-dev}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_DIR:-./backups}"
FILE="${OUT_DIR}/rangon-${ENVIRONMENT}-${STAMP}-${LABEL}.dump"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"

: "${BACKUP_VIA:=compose}"
: "${COMPOSE_FILES:=-f docker-compose.yml}"
: "${DB_SERVICE:=db}"
: "${POSTGRES_HOST:=db}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=rangon}"
: "${POSTGRES_USER:=rangon}"
: "${PGPASSWORD:=${POSTGRES_PASSWORD:-}}"
export PGPASSWORD

mkdir -p "$OUT_DIR"

# `exec -T` because there is no terminal on a cron run, and without it the
# dump is corrupted by terminal processing rather than failing outright.
compose_db() {
    # shellcheck disable=SC2086  # COMPOSE_FILES is a deliberate word list
    docker compose $COMPOSE_FILES exec -T \
        -e PGPASSWORD="$PGPASSWORD" "$DB_SERVICE" "$@"
}

case "$BACKUP_VIA" in
compose)
    echo "==> dumping ${POSTGRES_DB} from the ${DB_SERVICE} container -> ${FILE}"
    # localhost, not $POSTGRES_HOST: this runs inside the database container.
    compose_db pg_dump --format=custom --compress=6 --no-owner --no-privileges \
        --host=localhost --port=5432 \
        --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" > "$FILE"
    ;;
direct)
    CLIENT="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
    SERVER="$(psql --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
        --tuples-only --no-align --command 'show server_version_num')"
    SERVER_MAJOR=$((SERVER / 10000))
    if [ "$CLIENT" -lt "$SERVER_MAJOR" ]; then
        echo "!! pg_dump is ${CLIENT} and the server is ${SERVER_MAJOR}." >&2
        echo "!! pg_dump cannot read a server newer than itself. Install" >&2
        echo "!! postgresql-client-${SERVER_MAJOR}, or leave BACKUP_VIA unset" >&2
        echo "!! to dump from the database container instead." >&2
        exit 1
    fi
    echo "==> dumping ${POSTGRES_DB} from ${POSTGRES_HOST} -> ${FILE}"
    pg_dump --format=custom --compress=6 --no-owner --no-privileges \
        --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
        --file="$FILE"
    ;;
*)
    echo "!! BACKUP_VIA must be 'compose' or 'direct', not '${BACKUP_VIA}'" >&2
    exit 1
    ;;
esac

SIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")
if [ "$SIZE" -lt 10000 ]; then
    echo "!! dump is only ${SIZE} bytes — refusing to treat this as a backup" >&2
    exit 1
fi

# Read the dump back with the same client that wrote it, for the same reason.
echo "==> verifying the dump is readable"
if [ "$BACKUP_VIA" = "compose" ]; then
    compose_db pg_restore --list /dev/stdin < "$FILE" > /dev/null
else
    pg_restore --list "$FILE" > /dev/null
fi

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    echo "==> uploading to s3://${BACKUP_S3_BUCKET}/"
    aws s3 cp "$FILE" "s3://${BACKUP_S3_BUCKET}/$(basename "$FILE")"
    REMOTE_SIZE=$(aws s3api head-object --bucket "$BACKUP_S3_BUCKET" \
                    --key "$(basename "$FILE")" --query ContentLength --output text)
    [ "$REMOTE_SIZE" = "$SIZE" ] || { echo "!! uploaded size mismatch" >&2; exit 1; }
else
    echo "!! BACKUP_S3_BUCKET is not set — this backup is only on local disk."
    echo "!! A copy on the same machine as the database is NOT a backup."
fi

echo "==> pruning local dumps older than ${RETAIN_DAYS} days"
find "$OUT_DIR" -name 'rangon-*.dump' -type f -mtime "+${RETAIN_DAYS}" -delete

echo "==> done: ${FILE} (${SIZE} bytes)"
