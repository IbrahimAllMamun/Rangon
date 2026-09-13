#!/usr/bin/env bash
# Rebuild the local production stack from scratch.
#
# Usage: ./scripts/rebuild-local-prod.sh [-h]
#
#   -h, --help     this text
#
# DESTRUCTIVE, and unconditionally so. It runs `compose down -v`, which removes
# this project's volumes -- so the database goes with them and the reseed that
# follows is not optional, it is how the stack gets a database at all. There is
# deliberately no `--no-seed`: there would be nothing left to keep.
#
# ---------------------------------------------------------------------------
# Why each step is here, because three of them look redundant and are not
# (docs/operations/local-production.md, .claude/environment.md §11):
#
#  - **The images are built by hand.** `docker-compose.prodlocal.yml` sets
#    `build: !reset null` on api, worker, beat and web, so `up -d --build`
#    builds *nothing* and then fails on a missing image. The two `docker build`
#    calls below are not a convenience; they are the only thing that produces
#    `rangon-api:prod` and `rangon-web:prod`.
#
#  - **nginx is restarted last.** `local-prod/default.conf` names its upstreams
#    as `server api:8000` / `server web:3000`, and nginx resolves those once at
#    startup and caches the address for the life of the process. Recreating api
#    or web hands them new addresses, so every `/api/` request answers 502 while
#    `getent hosts api` inside the very same nginx container prints the correct
#    new IP -- which reads as an API fault rather than a proxy one.
#
#  - **`migrate` runs twice.** Once against whatever is already running, before
#    anything is replaced, and once against the new image. The first is skipped
#    when no api container is up, which is the normal case on a cold start.
#
# Docker Desktop has ~4 GB here and the OOM killer is silent. This script
# builds *before* bringing the stack up rather than alongside it, for that
# reason. If a step dies with exit 137, that is what happened.
# ---------------------------------------------------------------------------
set -Eeuo pipefail

cd "$(dirname "$0")/.."

: "${COMPOSE_PROJECT:=rangon-prod}"
: "${ENV_FILE:=.env.prod.local}"
: "${PUBLIC_URL:=http://localhost:4100}"
: "${SHOP_TIME_ZONE:=Asia/Dhaka}"

while [ $# -gt 0 ]; do
    case "$1" in
    -h | --help)
        # The usage block is everything between the shebang and the first
        # divider, so adding a line above does not silently truncate --help.
        awk 'NR>1 && /^#[[:space:]]*-{10,}/ {exit}
             NR>1 && /^#/ {sub(/^#[[:space:]]?/, ""); print}' "$0"
        exit 0
        ;;
    *)
        echo "!! unknown option '$1' -- try --help" >&2
        exit 1
        ;;
    esac
    shift
done

compose() {
    docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" \
        -f docker-compose.yml -f docker-compose.prodlocal.yml "$@"
}



# `exec -T`: there is no terminal when this runs from CI or a scheduler, and
# without it Django's output is mangled rather than failing outright.
api() { compose exec -T api "$@"; }

step() { printf '\n==> %s\n' "$*"; }

require_file() {
    [ -f "$1" ] || {
        echo "!! ${1} is missing. The local production stack cannot start without it." >&2
        exit 1
    }
}

require_file "$ENV_FILE"


# --------------------------------------------------------------- 1. migrate --
# Only if something is already running. On a cold start there is no container
# to exec into, and `set -e` would abort the whole script on that.

step "tear down the stack that is already running"
compose down -v


# ---------------------------------------------------------------- 2. build ---

step "building rangon-api:prod"
docker build -t rangon-api:prod -f apps/api/Dockerfile apps/api

step "building rangon-web:prod"
# NEXT_PUBLIC_* are compiled into the bundle, so they are build args and
# not environment. Changing the origin means rebuilding, not restarting.
docker build -t rangon-web:prod -f apps/web/Dockerfile apps/web \
   --build-arg "NEXT_PUBLIC_API_URL=${PUBLIC_URL}/api/v1" \
   --build-arg "NEXT_PUBLIC_SITE_URL=${PUBLIC_URL}" \
   --build-arg "NEXT_PUBLIC_TIME_ZONE=${SHOP_TIME_ZONE}"


# ------------------------------------------------------------------- 3. up ---
step "starting the stack"
compose up -d

# `up -d` returns as soon as the containers are created, which is well before
# Postgres will accept a connection. Migrating into that gap fails in a way
# that looks like a broken migration.
step "waiting for the api to report healthy"
for attempt in $(seq 1 60); do
    state="$(docker inspect -f '{{.State.Health.Status}}' \
        "$(compose ps -q api)" 2>/dev/null || echo starting)"
    [ "$state" = "healthy" ] && break
    [ "$attempt" = 60 ] && {
        echo "!! the api container never became healthy. Recent logs:" >&2
        compose logs --tail 40 api >&2
        exit 1
    }
    sleep 2
done
echo "    healthy after ~$((attempt * 2))s"

# -------------------------------------------------------------- 4. migrate ---
step "migrating against the new image"
api python manage.py migrate

# ----------------------------------------------------------------- 5. seed ---


step "reseeding demo data"
api python manage.py seed_demo --reset


# ---------------------------------------------------------------- 6. nginx ---
# Last, and always: api and web have just been replaced, so nginx is holding
# addresses that no longer exist. See the header.
step "restarting nginx so it re-resolves api and web"
compose restart nginx

# ---------------------------------------------------------------- 7. check ---
# nginx is listening within a second of the restart, but `web` is a Next
# standalone server that is not. Smoke testing straight away failed all seven
# checks against a stack that was healthy thirty seconds later, so wait for the
# origin to answer before deciding anything is wrong with it.
step "waiting for ${PUBLIC_URL} to answer"
for attempt in $(seq 1 45); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        "${PUBLIC_URL}/api/health/" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && break
    [ "$attempt" = 45 ] && {
        echo "!! ${PUBLIC_URL} never answered (last status ${code})." >&2
        echo "!! nginx publishes the port, so check what is behind it:" >&2
        compose ps >&2
        exit 1
    }
    sleep 2
done
echo "    answered after ~$((attempt * 2))s"

# A script that exits 0 on a broken stack is worse than one that fails, so this
# asks the running system rather than assuming the steps above worked.
step "smoke testing ${PUBLIC_URL}"
if ! ./scripts/smoke-test.sh "$PUBLIC_URL"; then
    echo "!! the stack is up but not serving correctly." >&2
    echo "!! ${PUBLIC_URL} answered, but not with what was expected -- check:" >&2
    echo "!!   docker compose -p ${COMPOSE_PROJECT} --env-file ${ENV_FILE} \\" >&2
    echo "!!     -f docker-compose.yml -f docker-compose.prodlocal.yml logs --tail 50 api web nginx" >&2
    exit 1
fi

printf '\n==> done. %s is ready.\n' "$PUBLIC_URL"
