#!/usr/bin/env bash
#
# Run the whole stack without Docker.
#
# Docker is how the README documents running Rangon; it is not what running it
# requires. Any Linux box with PostgreSQL, Redis and Node can do it, and
# this script is what proved the admin screens work (docs/roadmap.md, "The
# screens were finally used"). It exists so a browser pass does not depend on
# Docker Desktop being healthy.
#
#   scripts/dev-stack-native.sh up       # start everything, seed, wait for health
#   scripts/dev-stack-native.sh reseed   # the demo snapshot again, under the running stack
#   scripts/dev-stack-native.sh down     # stop everything
#   scripts/dev-stack-native.sh status
#
# The API in watch mode, as in the Docker development stack. The database is
# the committed demo snapshot, restored afresh on every `up` unless SEED=0, and
# brought to this build's schema by the API's `migrate`.
#
# The two traps this script exists to avoid, both of which cost real time:
#
#   1. Redis is NOT optional. The auth throttle is Redis-backed, so without it
#      POST /api/v1/auth/login/ returns a bare 500 and the login page says only
#      "An unexpected error occurred". Nothing points at Redis.
#   2. API_INTERNAL_URL is the variable that matters, not NEXT_PUBLIC_API_URL.
#      It defaults to http://api:8000/api/v1 — the compose service hostname —
#      which does not resolve outside compose, so every server-side fetch fails
#      while the pages still render.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${RANGON_RUN_DIR:-/tmp/rangon-native}"
PGDATA="${RANGON_PGDATA:-$RUN_DIR/pg}"
API_PORT="${RANGON_API_PORT:-8000}"
WEB_PORT="${RANGON_WEB_PORT:-4000}"
PG_BIN="${RANGON_PG_BIN:-/usr/lib/postgresql/16/bin}"
DB_URL="postgresql://rangon:rangon@127.0.0.1:5432/rangon"
SECRET="${DJANGO_SECRET_KEY:-dev-only-not-a-real-secret-0123456789}"
MEDIA="$RUN_DIR/media"
SNAPSHOT="$ROOT/infrastructure/snapshots/demo"

mkdir -p "$RUN_DIR"

log() { printf '  %s\n' "$*"; }

wait_for() { # wait_for <name> <url> <expected-codes-regex> <attempts>
  local name=$1 url=$2 want=$3 tries=${4:-40} code
  for _ in $(seq 1 "$tries"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
    if [[ $code =~ $want ]]; then log "$name ready ($code)"; return 0; fi
    sleep 2
  done
  log "$name NOT ready (last: ${code:-none})"
  return 1
}

start_postgres() {
  if psql -h 127.0.0.1 -U rangon -d rangon -c 'SELECT 1' >/dev/null 2>&1; then
    log "postgres already up"; return
  fi
  if [[ ! -d $PGDATA ]]; then
    mkdir -p "$PGDATA"
    # initdb refuses to run as root, so the cluster is owned by the postgres user.
    chown -R postgres "$PGDATA"
    su postgres -s /bin/bash -c "$PG_BIN/initdb -D $PGDATA -U postgres --auth=trust" >"$RUN_DIR/initdb.log" 2>&1
    log "cluster created at $PGDATA"
  fi
  su postgres -s /bin/bash -c "$PG_BIN/pg_ctl -D $PGDATA -l $PGDATA/server.log -o '-p 5432 -k /tmp' start" >/dev/null
  sleep 3
  psql -h 127.0.0.1 -U postgres -c "CREATE USER rangon WITH PASSWORD 'rangon' SUPERUSER;" >/dev/null 2>&1 || true
  psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE rangon OWNER rangon;" >/dev/null 2>&1 || true
  log "postgres up"
}

start_redis() {
  if redis-cli ping >/dev/null 2>&1; then log "redis already up"; return; fi
  redis-server --daemonize yes --port 6379 --save '' >/dev/null
  sleep 1
  redis-cli ping >/dev/null && log "redis up"
}

# The demo data: the snapshot into an emptied database, its uploads into
# MEDIA. SEED=0 keeps what is there.
make_data() {
  [[ ${SEED:-1} == 1 ]] || return 0
  psql -q -h 127.0.0.1 -U postgres -c "DROP DATABASE IF EXISTS rangon WITH (FORCE);" \
    -c "CREATE DATABASE rangon OWNER rangon;" >/dev/null
  pg_restore --exit-on-error --no-owner -d "$DB_URL" "$SNAPSHOT/demo.dump"
  rm -rf "$MEDIA" && mkdir -p "$MEDIA" && tar -xzf "$SNAPSHOT/media.tar.gz" -C "$MEDIA"
  log "database restored from the demo snapshot"
}

# The API by its process group, so that the compiler stops with it.
stop_api() {
  if [[ -f $RUN_DIR/api.pid ]]; then
    kill -- "-$(cat "$RUN_DIR/api.pid")" 2>/dev/null || true
    rm -f "$RUN_DIR/api.pid"
  fi
  sleep 1
}

start_api() {
  stop_api
  make_data
  cd "$ROOT/apps/api-nest"
  [[ -d node_modules ]] || npm ci --no-audit --no-fund >"$RUN_DIR/npm-api.log" 2>&1
  npm run -s build >"$RUN_DIR/build-api.log" 2>&1
  local vars=(DATABASE_URL="$DB_URL" REDIS_URL=redis://127.0.0.1:6379/0 DJANGO_SECRET_KEY="$SECRET"
    DJANGO_SETTINGS_MODULE=config.settings.dev DJANGO_DEBUG=1 MEDIA_ROOT="$MEDIA")
  env "${vars[@]}" node dist/cli.js migrate >"$RUN_DIR/migrate.log" 2>&1
  env "${vars[@]}" node dist/cli.js sync-permissions >>"$RUN_DIR/migrate.log" 2>&1
  log "$(head -n 2 "$RUN_DIR/migrate.log" | tail -n 1)"
  # Its own process group, so that `down` stops the compiler with the API.
  # The jobs in PostgreSQL, worked and scheduled by this process.
  env "${vars[@]}" PORT="$API_PORT" setsid nohup npm run -s dev >"$RUN_DIR/api.log" 2>&1 &
  echo $! >"$RUN_DIR/api.pid"
  wait_for "api" "http://127.0.0.1:$API_PORT/api/ready/" '^200$'
}

start_web() {
  pkill -f "next dev --port $WEB_PORT" 2>/dev/null || true
  cd "$ROOT/apps/web"
  [[ -d node_modules ]] || npm ci --no-audit --no-fund >"$RUN_DIR/npm.log" 2>&1
  API_INTERNAL_URL="http://127.0.0.1:$API_PORT/api/v1" \
    NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT/api/v1" \
    NEXT_PUBLIC_SITE_URL="http://127.0.0.1:$WEB_PORT" \
    REVALIDATE_SECRET="${REVALIDATE_SECRET:-dev-revalidate-secret}" \
    nohup npx next dev --port "$WEB_PORT" >"$RUN_DIR/web.log" 2>&1 &
  wait_for "web" "http://127.0.0.1:$WEB_PORT/" '^200$' 60
}

case "${1:-up}" in
  up)
    start_postgres; start_redis; start_api; start_web
    echo
    log "storefront  http://127.0.0.1:$WEB_PORT"
    log "admin       http://127.0.0.1:$WEB_PORT/admin"
    log "api         http://127.0.0.1:$API_PORT/api/v1/"
    log "logins      owner@rangon.test … / rangon12345"
    log "logs        $RUN_DIR"
    log "e2e         PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \\"
    log "              E2E_BASE_URL=http://127.0.0.1:$WEB_PORT REVALIDATE_SECRET=dev-revalidate-secret \\"
    log "              E2E_SEED_CMD='scripts/dev-stack-native.sh reseed' npx playwright test"
    ;;
  reseed)
    # What the browser suite runs before it starts (apps/web/e2e/global-setup.ts):
    # the API's connections are cut by the drop and it opens new ones.
    SEED=1 make_data
    (cd "$ROOT/apps/api-nest" && DATABASE_URL="$DB_URL" node dist/cli.js migrate >/dev/null &&
      DATABASE_URL="$DB_URL" node dist/cli.js sync-permissions >/dev/null)
    ;;
  down)
    pkill -f "next dev --port $WEB_PORT" 2>/dev/null || true
    stop_api
    redis-cli shutdown nosave >/dev/null 2>&1 || true
    su postgres -s /bin/bash -c "$PG_BIN/pg_ctl -D $PGDATA stop" >/dev/null 2>&1 || true
    log "stopped"
    ;;
  status)
    psql -h 127.0.0.1 -U rangon -d rangon -c 'SELECT 1' >/dev/null 2>&1 && log "postgres up" || log "postgres down"
    redis-cli ping >/dev/null 2>&1 && log "redis up" || log "redis down"
    log "api  $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/api/ready/" || echo down)"
    log "web  $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/" || echo down)"
    ;;
  *)
    echo "usage: $0 {up|reseed|down|status}" >&2; exit 2 ;;
esac
