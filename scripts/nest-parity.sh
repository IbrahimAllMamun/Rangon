#!/usr/bin/env bash
# The NestJS API beside the Django one, and the harness that compares them.
#
#   scripts/nest-parity.sh up       build and start both APIs on one database
#   scripts/nest-parity.sh seed     demo data plus the parity fixture
#   scripts/nest-parity.sh run      compare every case; non-zero on a difference
#   scripts/nest-parity.sh reset    DESTRUCTIVE to the parity database only: drop it, then up + seed
#   scripts/nest-parity.sh down     stop, keeping the database
#
# Always the `rangon-nest` compose project: `.env` sets COMPOSE_PROJECT_NAME=rangon,
# and without -p these containers would join the development project.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -p rangon-nest -f docker-compose.nest.yml)

wait_for() {
  for _ in $(seq 1 120); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "timed out waiting for $1" >&2; return 1
}

case "${1:-}" in
  up)
    "${compose[@]}" up -d --build django nest
    wait_for http://127.0.0.1:8610/api/health/
    wait_for http://127.0.0.1:8620/api/health/
    ;;
  seed)
    # The media directory is shared with the Nest API, which runs as another user.
    "${compose[@]}" exec -T django sh -c 'mkdir -p /app/media && chmod -R a+rwX /app/media'
    # Seeding saves categories and navigation items, whose signals would ping
    # the storefront's revalidation URL inline; nothing listens, so it is unset.
    "${compose[@]}" exec -T -e DJANGO_ALLOW_DEMO_SEED=1 -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py seed_demo --reset
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_content.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_nav.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_accounts.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_orders.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_cart.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_payments.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_staff.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_attributes.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_products.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_inventory.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_pages.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_merchandising.py
    "${compose[@]}" exec -T -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py shell < apps/api-nest/parity/fixture_pos.py
    ;;
  run)
    "${compose[@]}" run --rm -e PARITY_ONLY="${PARITY_ONLY:-}" -e PARITY_VERBOSE="${PARITY_VERBOSE:-}" parity
    ;;
  reset)
    "${compose[@]}" down -v --remove-orphans
    bash "$0" up
    bash "$0" seed
    ;;
  down)
    "${compose[@]}" down
    ;;
  *)
    sed -n '2,11p' "$0"; exit 2
    ;;
esac
