#!/usr/bin/env bash
# Dump the Rangon database, compress, upload off-host, prune old copies.
# Usage: ./scripts/backup-db.sh [label]
# Exits non-zero on any failure so a broken backup is noisy, not silent.
set -Eeuo pipefail

LABEL="${1:-scheduled}"
ENVIRONMENT="${RANGON_ENV:-dev}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_DIR:-./backups}"
FILE="${OUT_DIR}/rangon-${ENVIRONMENT}-${STAMP}-${LABEL}.dump"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"

: "${POSTGRES_HOST:=db}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=rangon}"
: "${POSTGRES_USER:=rangon}"
: "${PGPASSWORD:=${POSTGRES_PASSWORD:-}}"
export PGPASSWORD

mkdir -p "$OUT_DIR"

echo "==> dumping ${POSTGRES_DB} from ${POSTGRES_HOST} -> ${FILE}"
pg_dump --format=custom --compress=6 --no-owner --no-privileges \
        --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
        --file="$FILE"

SIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")
if [ "$SIZE" -lt 10000 ]; then
    echo "!! dump is only ${SIZE} bytes — refusing to treat this as a backup" >&2
    exit 1
fi

echo "==> verifying the dump is readable"
pg_restore --list "$FILE" > /dev/null

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
