#!/usr/bin/env bash
# The browser suite (apps/web/e2e), run here as CI runs it, against either API.
#
#   scripts/e2e-local.sh nest      the web app on the NestJS API (what production runs)
#   scripts/e2e-local.sh django    the web app on the Django API
#   scripts/e2e-local.sh down      remove the containers it left
#
# It is the `e2e` job of .github/workflows/ci.yml in containers, for a machine
# with Docker and no Node or Python of its own: a fresh database, migrated and
# seeded by Django; one API; the storefront's production build; Playwright in
# its own image. Nothing is published to the host and nothing of the
# development stack is touched -- every container is named `rangon-e2e-*`.
#
# The containers share one network namespace, so each finds the others on
# 127.0.0.1 exactly as the CI runner does. That matters: the web image is built
# for `http://127.0.0.1:4000`, and a browser accepts the session cookies of a
# production build over plain http only on a loopback address.
#
# The suite consumes seeded fixtures, so it is good for one run per database
# (D18): each invocation starts from an empty one. A run takes about five
# minutes once the images exist; the first builds three and pulls Playwright's.
set -euo pipefail
cd "$(dirname "$0")/.."

API="${1:-}"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v$(sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' apps/web/package.json)-noble"
NAMES=(rangon-e2e-web rangon-e2e-api rangon-e2e-redis rangon-e2e-db rangon-e2e-pod)
NET=(--network container:rangon-e2e-pod)
ENVS=(
    -e DJANGO_SECRET_KEY=ci-only-key
    -e DATABASE_URL=postgresql://rangon:rangon_ci_password@127.0.0.1:5432/rangon
    -e REDIS_URL=redis://127.0.0.1:6379/0
    -e DJANGO_DEBUG=1
    -e "DJANGO_ALLOWED_HOSTS=*"
    # As in CI: every request comes from one address, so the anonymous limit
    # would be a budget for the whole suite rather than for one shopper.
    -e DJANGO_THROTTLE_ANON=10000/min
)

down() { docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true; }

# What a URL inside the shared namespace answers, or nothing while it does not.
status() {
    docker exec rangon-e2e-pod wget -q -O /dev/null -S "$1" 2>&1 |
        grep -o 'HTTP/[0-9.]* [0-9][0-9][0-9]' | tail -n 1 | cut -d' ' -f2 || true
}

wait_for() {
    for _ in $(seq 1 90); do
        [ "$(status "$1")" = 200 ] && return 0
        sleep 2
    done
    echo "!! $1 never answered 200. Recent logs of $2:" >&2
    docker logs --tail 40 "$2" >&2
    return 1
}

case "$API" in
down)
    down
    exit 0
    ;;
nest | django) ;;
*)
    sed -n '2,7p' "$0"
    exit 2
    ;;
esac

echo "==> building the images (cached after the first run)"
docker build -q -t rangon-api:e2e -f apps/api/Dockerfile.dev apps/api >/dev/null
[ "$API" = nest ] && docker build -q -t rangon-api-nest:e2e -f apps/api-nest/Dockerfile apps/api-nest >/dev/null
# NEXT_PUBLIC_* are compiled into the bundle: they are build arguments.
docker build -q -t rangon-web:e2e -f apps/web/Dockerfile apps/web \
    --build-arg NEXT_PUBLIC_API_URL=http://127.0.0.1:8000/api/v1 \
    --build-arg NEXT_PUBLIC_SITE_URL=http://127.0.0.1:4000 >/dev/null

echo "==> a fresh database and cache"
down
docker run -d --name rangon-e2e-pod alpine:3 sleep 86400 >/dev/null
docker run -d --name rangon-e2e-db "${NET[@]}" --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_DB=rangon -e POSTGRES_USER=rangon -e POSTGRES_PASSWORD=rangon_ci_password \
    postgres:16-alpine >/dev/null
docker run -d --name rangon-e2e-redis "${NET[@]}" redis:7-alpine >/dev/null
for _ in $(seq 1 60); do
    docker exec rangon-e2e-db pg_isready -U rangon -d rangon >/dev/null 2>&1 && break
    sleep 1
done

echo "==> migrating and seeding (Django, whichever API serves: it owns the schema)"
# Uploads go to apps/api/media, which both APIs read; the NestJS image runs
# as another user, so what the seed wrote is opened to it.
docker run --rm "${NET[@]}" "${ENVS[@]}" -v "$PWD/apps/api:/app" -w /app rangon-api:e2e sh -c \
    'python manage.py migrate --noinput >/dev/null && python manage.py seed_demo --reset >/dev/null \
     && mkdir -p /app/media && chmod -R a+rwX /app/media'

echo "==> starting the API ($API)"
if [ "$API" = nest ]; then
    # As production starts it: the built image, its jobs in PostgreSQL.
    docker run -d --name rangon-e2e-api "${NET[@]}" "${ENVS[@]}" -e PORT=8000 \
        -e RANGON_JOBS_BACKEND=pgboss -v "$PWD/apps/api/media:/app/media" rangon-api-nest:e2e >/dev/null
else
    docker run -d --name rangon-e2e-api "${NET[@]}" "${ENVS[@]}" -v "$PWD/apps/api:/app" -w /app \
        rangon-api:e2e python manage.py runserver 0.0.0.0:8000 --noreload >/dev/null
fi
wait_for http://127.0.0.1:8000/api/ready/ rangon-e2e-api
# The router's index says which API this is: Django answers it 401, the NestJS API 404.
echo "    /api/v1/ answers $(status http://127.0.0.1:8000/api/v1/)"

echo "==> starting the storefront (production build)"
docker run -d --name rangon-e2e-web "${NET[@]}" -e PORT=4000 -e HOSTNAME=0.0.0.0 \
    -e API_INTERNAL_URL=http://127.0.0.1:8000/api/v1 -e REVALIDATE_SECRET=ci-revalidate-secret \
    rangon-web:e2e >/dev/null
wait_for http://127.0.0.1:4000/ rangon-e2e-web

echo "==> running the suite"
result=0
# The suite's own dependencies live in a volume, installed from the lockfile
# the first time and whenever it changes: the host need not have Node, and
# nothing owned by root is left in apps/web.
#
# `--output` keeps traces and screenshots out of apps/web for the same reason.
# They are printed as paths inside the container; rerun with `--trace on` and
# copy them out to look at one.
docker run --rm "${NET[@]}" --ipc=host -v "$PWD/apps/web:/work" -v rangon-e2e-node-modules:/work/node_modules \
    -w /work -e E2E_BASE_URL=http://127.0.0.1:4000 -e REVALIDATE_SECRET=ci-revalidate-secret \
    "$PLAYWRIGHT_IMAGE" sh -c '
        cmp -s package-lock.json node_modules/.lockfile-installed || {
            echo "    installing the suite'"'"'s dependencies"
            npm ci --no-audit --no-fund >/dev/null && cp package-lock.json node_modules/.lockfile-installed
        }
        npx playwright test --output /tmp/playwright-results "$@"' sh "${@:2}" || result=$?

down
exit "$result"
