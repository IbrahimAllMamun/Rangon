#!/usr/bin/env bash
# The NestJS API's own schema: a baseline that builds, from nothing, the
# database Django's migrations build (removal plan step 3).
#
#   scripts/nest-baseline.sh cut       re-make the baseline from a database Django has just migrated.
#                                      Run it after adding a Django migration; commit what it changes
#   scripts/nest-baseline.sh compare   build one database with Django's migrations and one with
#                                      `node dist/cli.js migrate` and `sync-permissions`, and compare
#                                      them: the schema dumps, the rows migrations seed, the roles.
#                                      Then that a Django-built database is adopted, not rebuilt
#
# Both replace the parity database (the `rangon-nest` compose project, or
# PARITY_PROJECT): `scripts/nest-parity.sh reset` brings the seeded shop back.
#
# Django still migrates production. Until the removal plan's step 6.4 this
# baseline is exercised here and in CI and nowhere else, and it is CUT, never
# edited: a schema change is a Django migration, then `cut`. `compare` is what
# fails when someone adds the first and forgets the second.
#
# What `cut` writes, under apps/api-nest/:
#   drizzle/0000_baseline.sql      `pg_dump --schema-only` of the migrated database, then the rows
#                                  Django's migrations leave in a new one (its own bookkeeping, and
#                                  the seeded pages, menu, social links and expense categories)
#   drizzle/meta/                  drizzle-kit's journal and its snapshot of the schema, which the
#                                  first migration written here will be a difference from
#   drizzle/meta/django-head.json  the Django migrations the baseline stands for
#   drizzle/schema.ts, relations.ts  the whole schema as Drizzle reads it, foreign keys included
#   src/database/schema.ts, relations.ts  the same without the foreign keys, for the API (see
#                                  scripts/pull-schema.mjs for why)
#
# `cut` needs apps/api-nest/node_modules (drizzle-kit is a dev dependency), or
# NEST_NODE_MODULES=<another checkout's>.
set -euo pipefail
cd "$(dirname "$0")/.."
project="${PARITY_PROJECT:-rangon-nest}"
compose=(docker compose -p "$project" -f docker-compose.nest.yml)
url() { echo "postgresql://rangon:rangon_nest_password@db:5432/$1"; }
psql_in() { "${compose[@]}" exec -T db psql -q -v ON_ERROR_STOP=1 -U rangon -d "$1" "${@:2}"; }
# What pg_dump writes for psql and a driver cannot run, and the schema every database has.
plain() { sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' -e '/^CREATE SCHEMA public;$/d' -e "/^COMMENT ON SCHEMA public IS /d"; }
# Tables whose rows Django's migrations create in a new database. The roles
# and permissions are not here: `sync-permissions` makes those, as Django's
# post-migrate hook does.
SEEDED=(django_migrations django_content_type auth_permission content_sitesettings content_sitepage
  content_navigationitem content_sociallink finance_expensecategory)

fresh() {
  "${compose[@]}" --profile parity --profile jobs --profile worker --profile throttle --profile s3 down -v --remove-orphans
  bash scripts/nest-parity.sh up
}

case "${1:-}" in
  cut)
    fresh
    out=apps/api-nest/drizzle
    rm -rf "$out"
    docker run --rm --network "${project}_default" --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -e DATABASE_URL="$(url rangon)" -e npm_config_update_notifier=false \
      -v "$PWD/apps/api-nest:/app" ${NEST_NODE_MODULES:+-v "$NEST_NODE_MODULES:/app/node_modules:ro"} \
      -w /app node:22-bookworm-slim npm run -s db:pull
    # drizzle-kit names its migration at random and writes it commented out.
    pulled=$(ls "$out"/0000_*.sql)
    tag=$(basename "$pulled" .sql)
    rm "$pulled"
    sed -i "s/\"$tag\"/\"0000_baseline\"/" "$out/meta/_journal.json"
    {
      cat <<'HEADER'
-- The schema Django's migrations build, and the rows they leave in a new
-- database. CUT by scripts/nest-baseline.sh from a database Django had just
-- migrated; never edited by hand. `node dist/cli.js migrate` runs it on an
-- empty database and records it, unrun, on one Django built
-- (docs/architecture/django-removal-plan.md, step 3).
--
-- Foreign keys are DEFERRABLE INITIALLY DEFERRED, as Django makes them, and no
-- column has a default: Django supplied those in Python, and the NestJS API
-- writes every column.
HEADER
      "${compose[@]}" exec -T db pg_dump -U rangon -d rangon --schema-only --no-owner --no-privileges --schema=public | plain
      echo
      echo "-- What the migrations themselves put in a new database."
      tables=(); for table in "${SEEDED[@]}"; do tables+=(-t "public.$table"); done
      "${compose[@]}" exec -T db pg_dump -U rangon -d rangon --data-only --column-inserts --no-owner "${tables[@]}" | plain
    } > "$out/0000_baseline.sql"
    psql_in rangon -At -c "SELECT json_agg(json_build_array(app, name) ORDER BY app, name) FROM django_migrations" \
      > "$out/meta/django-head.json"
    ls -l "$out" "$out/meta"
    git status --short apps/api-nest/drizzle apps/api-nest/src/database
    ;;
  compare)
    fresh
    status=0
    work=$(mktemp -d)
    nest=("${compose[@]}" run --rm --no-deps -T)
    psql_in postgres -c 'DROP DATABASE IF EXISTS rangon_baseline WITH (FORCE)' -c 'CREATE DATABASE rangon_baseline OWNER rangon'
    echo "== a new database: migrate, then sync-permissions"
    "${nest[@]}" -e DATABASE_URL="$(url rangon_baseline)" nest node dist/cli.js migrate
    "${nest[@]}" -e DATABASE_URL="$(url rangon_baseline)" nest node dist/cli.js sync-permissions

    dump() { "${compose[@]}" exec -T db pg_dump -U rangon -d "$1" --schema-only --no-owner --no-privileges --schema=public | plain | grep -v '^-- Dumped '; }
    dump rangon > "$work/django.sql"
    dump rangon_baseline > "$work/nest.sql"
    if diff "$work/django.sql" "$work/nest.sql" > "$work/schema.diff"; then
      echo "the schema: identical ($(grep -c '^CREATE TABLE' "$work/nest.sql") tables, $(wc -l < "$work/nest.sql") lines of pg_dump --schema-only)"
    else
      echo "the schema DIFFERS: is the baseline older than Django's migrations? (scripts/nest-baseline.sh cut)"
      head -40 "$work/schema.diff"; status=1
    fi

    # The rows, by what they say: ids and moments are each database's own.
    rows() {
      psql_in "$1" -At <<'SQL'
SELECT 'migration ' || app || ' ' || name FROM django_migrations ORDER BY 1;
SELECT 'content type ' || app_label || '.' || model FROM django_content_type ORDER BY 1;
SELECT 'model permission ' || c.app_label || '.' || p.codename || ' ' || p.name
  FROM auth_permission p JOIN django_content_type c ON c.id = p.content_type_id ORDER BY 1;
SELECT 'permission ' || code || ' | ' || "group" || ' | ' || name FROM accounts_permission ORDER BY 1;
SELECT 'role ' || code || ' | ' || name || ' | ' || description || ' | ' || is_system FROM accounts_role ORDER BY 1;
SELECT 'grant ' || r.code || ' ' || p.code FROM accounts_role_permissions g
  JOIN accounts_role r ON r.id = g.role_id JOIN accounts_permission p ON p.id = g.permission_id ORDER BY 1;
SELECT 'site settings ' || row_to_json(t)::text FROM
  (SELECT key, tagline, address, phone, email, opening_hours, show_address, map_embed_url, map_link_url,
          copyright_text, bottom_note, whatsapp_float FROM content_sitesettings ORDER BY key) t;
SELECT 'page ' || row_to_json(t)::text FROM
  (SELECT slug, title, meta_description, md5(body) AS body, is_published, is_system FROM content_sitepage ORDER BY slug) t;
SELECT 'menu ' || row_to_json(t)::text FROM
  (SELECT n.placement, n.type, n.label, n.url, n.position, n.is_active, p.slug AS page, up.label AS parent
     FROM content_navigationitem n LEFT JOIN content_sitepage p ON p.id = n.page_id
     LEFT JOIN content_navigationitem up ON up.id = n.parent_id ORDER BY n.placement, up.label NULLS FIRST, n.position, n.label) t;
SELECT 'social ' || row_to_json(t)::text FROM
  (SELECT platform, url, is_visible, position FROM content_sociallink ORDER BY platform) t;
SELECT 'expense category ' || row_to_json(t)::text FROM
  (SELECT name, code, description, is_active FROM finance_expensecategory ORDER BY code) t;
SELECT 'rows ' || c.relname || ' ' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1;
SQL
    }
    rows rangon > "$work/django.rows"
    rows rangon_baseline > "$work/nest.rows"
    if diff "$work/django.rows" "$work/nest.rows" > "$work/rows.diff"; then
      echo "the rows: the same $(wc -l < "$work/nest.rows") facts ($(grep -c '^permission ' "$work/nest.rows") permissions, $(grep -c '^role ' "$work/nest.rows") roles, $(grep -c '^grant ' "$work/nest.rows") grants, $(grep -c '^migration ' "$work/nest.rows") Django migrations on record)"
    else
      echo "the rows DIFFER:"; head -40 "$work/rows.diff"; status=1
    fi

    # Django is the way back until the plan's step 8, so it has to be able to
    # take over a database this command built: its own record must say done.
    if "${nest[@]}" -e DATABASE_URL="$(url rangon_baseline)" django python manage.py migrate --check > "$work/django.check" 2>&1; then
      echo "Django, on the new database: nothing to migrate"
    else
      echo "Django would MIGRATE the new database:"; tail -20 "$work/django.check"; status=1
    fi

    echo "== again on the same database: nothing to do"
    "${nest[@]}" -e DATABASE_URL="$(url rangon_baseline)" nest node dist/cli.js migrate
    "${nest[@]}" -e DATABASE_URL="$(url rangon_baseline)" nest node dist/cli.js sync-permissions
    rows rangon_baseline > "$work/nest.rows.again"
    diff "$work/nest.rows" "$work/nest.rows.again" > /dev/null || { echo "a second run CHANGED the rows"; status=1; }

    echo "== a database Django built: adopted, not rebuilt"
    "${nest[@]}" -e DATABASE_URL="$(url rangon)" nest node dist/cli.js migrate
    "${nest[@]}" -e DATABASE_URL="$(url rangon)" nest node dist/cli.js sync-permissions
    dump rangon > "$work/django.after.sql"
    rows rangon > "$work/django.rows.after"
    diff "$work/django.sql" "$work/django.after.sql" > /dev/null || { echo "adopting CHANGED the schema"; status=1; }
    diff "$work/django.rows" "$work/django.rows.after" > /dev/null || { echo "adopting CHANGED the rows"; diff "$work/django.rows" "$work/django.rows.after" | head -20; status=1; }
    [ "$status" = 0 ] && echo "the baseline builds what Django's migrations build, and adopts what they built"
    rm -rf "$work"
    exit "$status"
    ;;
  *)
    sed -n '2,14p' "$0" >&2
    exit 2
    ;;
esac
