#!/usr/bin/env bash
# The operator's commands in the NestJS API, beside Django's
# (removal plan step 4): `node dist/cli.js create-owner`, `bootstrap-store`,
# `verify-inventory` and `verify-accounts`.
#
#   scripts/nest-commands.sh compare   each of the four run on one database and Django's own on a
#                                      copy of it, and what they left compared: the rows, by what
#                                      they say, and the lines they printed
#
# It replaces the parity database (the `rangon-nest` compose project, or
# PARITY_PROJECT): `scripts/nest-parity.sh reset` brings the seeded shop back.
# The password it makes an owner with is made up on the spot and kept nowhere.
set -euo pipefail
cd "$(dirname "$0")/.."
project="${PARITY_PROJECT:-rangon-nest}"
compose=(docker compose -p "$project" -f docker-compose.nest.yml)
url() { echo "postgresql://rangon:rangon_nest_password@db:5432/$1"; }
psql_in() { "${compose[@]}" exec -T db psql -q -v ON_ERROR_STOP=1 -U rangon -d "$1" "${@:2}"; }
run=("${compose[@]}" run --rm --no-deps -T)
django() { local db="$1"; shift; "${run[@]}" -e DATABASE_URL="$(url "$db")" -e WEB_REVALIDATE_URL= -e CELERY_TASK_ALWAYS_EAGER=1 "$@"; }
# nest <database> [-e NAME=value]... <command> [flags]
nest() {
  local db="$1" envs=(); shift
  while [ "${1:-}" = -e ]; do envs+=(-e "$2"); shift 2; done
  "${run[@]}" -e DATABASE_URL="$(url "$db")" "${envs[@]}" nest node dist/cli.js "$@"
}
# Two copies of the database as it stands, one for each side.
copies() {
  "${compose[@]}" stop django nest > /dev/null 2>&1
  for copy in "$@"; do
    psql_in postgres -c "DROP DATABASE IF EXISTS $copy WITH (FORCE)" -c "CREATE DATABASE $copy TEMPLATE rangon OWNER rangon"
  done
}
status=0
work=$(mktemp -d)
# What a command prints is its standard output; compose's own lines and
# Django's warnings go to the other stream, and are not compared.
same() { # what, file a, file b
  if diff "$2" "$3" > "$work/diff"; then echo "  the same: $1 ($(wc -l < "$3") lines)"; else
    echo "  DIFFERENT: $1"; head -30 "$work/diff"; status=1; fi
}
refused() { # what, then the command
  local what="$1"; shift
  if "$@" > "$work/refused" 2>&1; then echo "  NOT refused: $what"; cat "$work/refused"; status=1
  else echo "  refused, as it should be: $what -- $(grep -v -e '^ Container ' -e '^$' "$work/refused" | tail -1 | cut -c1-120)"; fi
}

case "${1:-}" in
  compare)
    "${compose[@]}" --profile parity --profile jobs --profile worker --profile throttle --profile s3 down -v --remove-orphans
    bash scripts/nest-parity.sh up

    echo "== a new shop: create-owner, bootstrap-store"
    copies ops_django ops_nest
    # Long, mixed, in no list: it passes every rule either side has.
    password="Rg-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')-Zq"
    django ops_django -e DJANGO_SUPERUSER_EMAIL=First.Owner@Shop.Example -e DJANGO_SUPERUSER_PASSWORD="$password" \
      django python manage.py createsuperuser --noinput > "$work/owner.django" 2>&1
    nest ops_nest -e OWNER_PASSWORD="$password" create-owner --email First.Owner@Shop.Example > "$work/owner.nest" 2>&1 \
      || { cat "$work/owner.nest"; status=1; }
    owners() {
      psql_in "$1" -At -c "SELECT row_to_json(t)::text FROM (SELECT u.email, u.is_superuser, u.is_staff, u.is_active, u.status,
        r.code AS role, u.organization_id, u.branch_id, u.first_name, u.last_name, u.phone, u.last_login, u.last_login_ip,
        left(u.password, 37) AS hashed_as, length(u.password) AS hash_length,
        (u.date_joined > now() - interval '10 minutes') AS joined_now
        FROM accounts_user u LEFT JOIN accounts_role r ON r.id = u.role_id ORDER BY u.email) t"
    }
    owners ops_django > "$work/owners.django"; owners ops_nest > "$work/owners.nest"
    same "the owner's account" "$work/owners.django" "$work/owners.nest"
    # The password this API hashed has to be one Django will take: Django is the way back.
    if django ops_nest -e PW="$password" django python manage.py shell -c \
      "import os; from accounts.models import User; raise SystemExit(0 if User.objects.get(email='first.owner@shop.example').check_password(os.environ['PW']) else 1)" > /dev/null 2>&1
    then echo "  Django takes the password this command hashed"; else echo "  Django REFUSES the password this command hashed"; status=1; fi
    refused "the same email again" nest ops_nest -e OWNER_PASSWORD="$password" create-owner --email first.owner@shop.example
    refused "a password of digits" nest ops_nest -e OWNER_PASSWORD=1234567890123 create-owner --email second@shop.example
    refused "no password at all" nest ops_nest create-owner --email second@shop.example

    store=(-e SHOP_NAME="Parity & Sons Ltd." -e BRANCH_NAME="First Shop" -e BRANCH_CODE=one)
    django ops_django "${store[@]}" django python manage.py shell < scripts/bootstrap-store.py > "$work/store.django" 2> "$work/stderr"
    nest ops_nest "${store[@]}" bootstrap-store > "$work/store.nest" 2> "$work/stderr" || { cat "$work/stderr"; status=1; }
    same "what bootstrap-store prints" "$work/store.django" "$work/store.nest"
    stores() {
      psql_in "$1" -At <<'SQL'
SELECT 'organization ' || row_to_json(t)::text FROM (SELECT name, slug, legal_name, status, email, phone, address,
  vat_registration, currency, logo, receipt_footer, tax_mode, default_tax_rate::text AS rate, tax_settled_at,
  tax_settled_by_id, counter_sells_reserved FROM accounts_organization ORDER BY created_at) t;
SELECT 'branch ' || row_to_json(t)::text FROM (SELECT b.name, b.code, b.address, b.phone, b.email, b.is_default,
  b.fulfils_online_orders, b.register_count, b.status, o.slug AS organization
  FROM accounts_branch b LEFT JOIN accounts_organization o ON o.id = b.organization_id ORDER BY b.code) t;
SELECT 'account ' || row_to_json(t)::text FROM (SELECT a.name, a.kind, a.account_number, a.bank_name, a.balance::text AS balance,
  a.is_active, a.is_default, a.allow_overdraft, a.notes, a.created_by_id, b.code AS branch
  FROM finance_account a JOIN accounts_branch b ON b.id = a.branch_id ORDER BY a.name) t;
SELECT 'ledger ' || count(*) FROM finance_accounttransaction;
SELECT 'audit ' || row_to_json(t)::text FROM (SELECT a.action, a.entity_type, a.entity_label, a.old_values::text AS old,
  a.new_values::text AS new, a.reason, a.actor_id, a.actor_label, a.ip_address, a.user_agent, a.request_id, b.code AS branch
  FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id ORDER BY a.created_at) t;
SQL
    }
    stores ops_django > "$work/stores.django"; stores ops_nest > "$work/stores.nest"
    same "the organisation, the branch, the drawer and the audit entry" "$work/stores.django" "$work/stores.nest"
    nest ops_nest "${store[@]}" bootstrap-store > "$work/store.again" 2> "$work/stderr"
    stores ops_nest > "$work/stores.again"
    same "the same after a second bootstrap-store" "$work/stores.nest" "$work/stores.again"

    echo "== a shop with drift in it: verify-inventory, verify-accounts"
    "${compose[@]}" start django nest > /dev/null 2>&1
    for _ in $(seq 1 120); do curl -sf -o /dev/null "http://127.0.0.1:${PARITY_PORT_DJANGO:-8610}/api/health/" && break; sleep 1; done
    "${compose[@]}" exec -T -e DJANGO_ALLOW_DEMO_SEED=1 -e CELERY_TASK_ALWAYS_EAGER=1 -e WEB_REVALIDATE_URL= django python manage.py seed_demo --reset > "$work/seed" 2>&1
    # Four writes nothing in the app can make: stock and money changed with no ledger row.
    psql_in rangon <<'SQL'
UPDATE inventory_inventory SET on_hand = on_hand + 3 WHERE id = (SELECT id FROM inventory_inventory ORDER BY id LIMIT 1);
UPDATE inventory_inventory SET on_hand = on_hand - 1, reserved = reserved + 2 WHERE id = (SELECT id FROM inventory_inventory ORDER BY id OFFSET 1 LIMIT 1);
UPDATE inventory_inventory SET reserved = reserved + 1 WHERE id = (SELECT id FROM inventory_inventory WHERE reserved = 0 ORDER BY id DESC LIMIT 1);
UPDATE finance_account SET balance = balance + 125.50 WHERE id = (SELECT id FROM finance_account ORDER BY id LIMIT 1);
UPDATE finance_account SET balance = balance - 40 WHERE id = (SELECT id FROM finance_account ORDER BY id OFFSET 1 LIMIT 1);
UPDATE orders_payment SET account_id = NULL WHERE id = (SELECT id FROM orders_payment WHERE status = 'CAPTURED' ORDER BY id LIMIT 1);
SQL
    copies drift_django drift_nest
    branch=$(psql_in drift_nest -At -c "SELECT code FROM accounts_branch ORDER BY code LIMIT 1")
    ledgers() {
      psql_in "$1" -At <<'SQL'
SELECT 'stock ' || row_to_json(t)::text FROM (SELECT v.sku, b.code AS branch, t.transaction_type, t.quantity, t.unit_cost::text AS unit_cost,
  t.on_hand_after, t.reserved_after, t.reference_type, (t.reference_id = i.id::text) AS names_its_shelf, t.reason, t.notes,
  t.created_by_id, t.idempotency_key
  FROM inventory_inventorytransaction t JOIN catalog_productvariant v ON v.id = t.variant_id JOIN accounts_branch b ON b.id = t.branch_id
  JOIN inventory_inventory i ON i.branch_id = t.branch_id AND i.variant_id = t.variant_id
  WHERE t.reference_type = 'integrity_repair' ORDER BY b.code, v.sku, t.transaction_type) t;
SELECT 'money ' || row_to_json(t)::text FROM (SELECT a.name, t.transaction_type, t.amount::text AS amount, t.balance_after::text AS balance_after,
  t.reference_type, (t.reference_id = a.id::text) AS names_its_account, t.reason, t.notes, t.created_by_id, t.idempotency_key,
  (t.occurred_at > now() - interval '10 minutes') AS occurred_now
  FROM finance_accounttransaction t JOIN finance_account a ON a.id = t.account_id
  WHERE t.reference_type = 'integrity_repair' ORDER BY a.name) t;
SELECT 'shelf ' || row_to_json(t)::text FROM (SELECT v.sku, b.code AS branch, i.on_hand, i.reserved FROM inventory_inventory i
  JOIN catalog_productvariant v ON v.id = i.variant_id JOIN accounts_branch b ON b.id = i.branch_id ORDER BY b.code, v.sku) t;
SELECT 'balance ' || row_to_json(t)::text FROM (SELECT name, balance::text AS balance FROM finance_account ORDER BY name) t;
SELECT 'audit ' || row_to_json(t)::text FROM (SELECT a.action, a.entity_type, a.entity_label, a.old_values::text AS old,
  a.new_values::text AS new, a.reason, a.actor_id, a.actor_label, b.code AS branch
  FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
  WHERE a.reason = 'Compared with Django' ORDER BY a.action, a.entity_label) t;
SQL
    }
    for check in inventory accounts; do
      for flags in "" "--branch $branch"; do
        # shellcheck disable=SC2086
        django drift_django django python manage.py "verify_$check" $flags > "$work/$check.django" 2> "$work/stderr" || true
        # shellcheck disable=SC2086
        nest drift_nest "verify-$check" $flags > "$work/$check.nest" 2> "$work/stderr" || true
        same "what verify-$check ${flags:-(every branch)} prints" "$work/$check.django" "$work/$check.nest"
      done
      refused "verify-$check for a branch that is not there" nest drift_nest "verify-$check" --branch NOPE
      refused "verify-$check --fix with no reason" nest drift_nest "verify-$check" --fix
      django drift_django django python manage.py "verify_$check" --fix --reason "Compared with Django" > "$work/$check.fix.django" 2> "$work/stderr" || true
      nest drift_nest "verify-$check" --fix --reason "Compared with Django" > "$work/$check.fix.nest" 2> "$work/stderr" || true
      same "what verify-$check --fix prints" "$work/$check.fix.django" "$work/$check.fix.nest"
      django drift_django django python manage.py "verify_$check" > "$work/$check.after.django" 2> "$work/stderr" || true
      nest drift_nest "verify-$check" > "$work/$check.after.nest" 2> "$work/stderr" || true
      same "what verify-$check prints once it is fixed" "$work/$check.after.django" "$work/$check.after.nest"
    done
    ledgers drift_django > "$work/ledgers.django"; ledgers drift_nest > "$work/ledgers.nest"
    same "the rows the two repairs appended, the shelves and balances they left alone, and the audit entries" "$work/ledgers.django" "$work/ledgers.nest"
    grep -c "^stock \|^money " "$work/ledgers.nest" | sed 's/^/  repair rows appended: /'

    [ "$status" = 0 ] && echo "the four commands do what Django's do"
    rm -rf "$work"
    exit "$status"
    ;;
  *)
    sed -n '2,13p' "$0" >&2
    exit 2
    ;;
esac
