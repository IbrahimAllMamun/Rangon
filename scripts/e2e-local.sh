#!/usr/bin/env bash
# The browser suite (apps/web/e2e), run here as CI runs it.
#
#   scripts/e2e-local.sh nest      the web app on the NestJS API (what production runs, and CI)
#   scripts/e2e-local.sh django    the web app on the Django API (the way back, until it goes)
#   scripts/e2e-local.sh down      remove the containers it left
#
# `nest` is the `e2e` job of .github/workflows/ci.yml in containers, for a
# machine with Docker and no Node or Python of its own: a fresh database
# restored from the demo snapshot (scripts/demo-snapshot.sh); the NestJS API;
# the storefront's production build; Playwright in its own image. No Django
# runs beside the suite. The snapshot is made first when there is none, or
# when apps/api has changed since the commit it was made at -- that one step
# is Django's, in a throwaway stack of its own, until Django goes
# (django-removal-plan.md, step 6.3).
#
# `django` is what CI ran too until step 6.2: Django migrates and seeds, and
# serves. Nothing is published to the host and nothing of the development
# stack is touched -- every container is named `rangon-e2e-*`.
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

# The demo snapshot, made from the commit it sits beside: a snapshot from
# before a change under apps/api may hold another schema or other rows. And
# one with the README's password, which is the one the suite signs in with.
snapshot="${DEMO_SNAPSHOT_DIR:-$PWD/infrastructure/snapshots/demo}"
if [ "$API" = nest ]; then
    made="$(sed -n 's/^commit *\([0-9a-f]*\).*/\1/p' "$snapshot/made.txt" 2>/dev/null || true)"
    if [ ! -s "$snapshot/demo.dump" ] || [ -z "$made" ] ||
        grep -q -e 'with uncommitted changes' -e "maker's own" "$snapshot/made.txt" ||
        ! git diff --quiet "$made" -- apps/api 2>/dev/null; then
        echo "==> making the demo snapshot (Django, in a throwaway stack: none here, or not this commit's)"
        DJANGO_DEMO_SEED_PASSWORD='' bash scripts/demo-snapshot.sh make >/dev/null
    fi
    grep '^commit' "$snapshot/made.txt" | sed 's/^/    snapshot /'
fi

echo "==> building the images (cached after the first run)"
if [ "$API" = nest ]; then
    docker build -q -t rangon-api-nest:e2e -f apps/api-nest/Dockerfile apps/api-nest >/dev/null
else
    docker build -q -t rangon-api:e2e -f apps/api/Dockerfile.dev apps/api >/dev/null
fi
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

if [ "$API" = nest ]; then
    echo "==> restoring the demo snapshot"
    # The uploads into a directory of their own, under the working copy
    # because Docker Desktop mounts nothing from outside the home directory,
    # and emptied first from inside a container: the last run's API wrote
    # there as its own user. Then opened to that user.
    media="$PWD/infrastructure/snapshots/e2e-media"
    mkdir -p "$media"
    docker run --rm -v "$media:/media" postgres:16-alpine sh -c 'rm -rf /media/* /media/.[!.]*' >/dev/null
    MEDIA_DIR="$media" bash scripts/demo-snapshot.sh restore rangon-e2e-db rangon rangon | sed 's/^/    /'
    chmod -R a+rwX "$media"
else
    echo "==> migrating and seeding (Django)"
    # Uploads go to apps/api/media, which the API reads.
    docker run --rm "${NET[@]}" "${ENVS[@]}" -v "$PWD/apps/api:/app" -w /app rangon-api:e2e sh -c \
        'python manage.py migrate --noinput >/dev/null && python manage.py seed_demo --reset >/dev/null \
         && mkdir -p /app/media && chmod -R a+rwX /app/media'
fi

echo "==> starting the API ($API)"
if [ "$API" = nest ]; then
    # As production starts it: the built image, its jobs in PostgreSQL.
    docker run -d --name rangon-e2e-api "${NET[@]}" "${ENVS[@]}" -e PORT=8000 \
        -e RANGON_JOBS_BACKEND=pgboss -v "$media:/app/media" rangon-api-nest:e2e >/dev/null
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
