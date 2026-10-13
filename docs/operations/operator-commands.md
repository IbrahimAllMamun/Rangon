# The operator's commands, in both APIs

**Status:** 2026-10-14 · step 4 of [the removal plan](../architecture/django-removal-plan.md)

What an operator does to a database rather than through the app has been Django's:
`python manage.py ...`, run in a one-off `api` container. The NestJS API has the same commands
now, in its own image: `node dist/cli.js <command>`, run in a one-off `api-nest` container. Both
sets exist until Django goes, and for five of them either may be used. **Not for the sixth:**
Django still migrates production.

Every other page gives the Django command. This one gives the other.

## The commands

| To do this | Django | NestJS API |
|---|---|---|
| Create the first owner | `manage.py createsuperuser` | `node dist/cli.js create-owner --email <address>`, with `OWNER_PASSWORD` in the environment |
| Give a new database its organisation, first branch and cash drawer | `manage.py shell < scripts/bootstrap-store.py` | `node dist/cli.js bootstrap-store --shop-name "..." --branch-name "..." --branch-code <CODE>` |
| Check the stock ledger against the cached stock | `manage.py verify_inventory [--branch <CODE>]` | `node dist/cli.js verify-inventory [--branch <CODE>]` |
| ... and reconcile what drifted | `... --fix --reason "..."` | `... --fix --reason "..."` |
| Check the cash book against the cached balances | `manage.py verify_accounts [--branch <CODE>] [--skip-unposted]` | `node dist/cli.js verify-accounts [--branch <CODE>] [--skip-unposted]` |
| ... and reconcile | `... --fix --reason "..."` | `... --fix --reason "..."` |
| Make the roles and permissions match the code | (runs after every `migrate`) | `node dist/cli.js sync-permissions` |
| Migrate the schema | `manage.py migrate` | **Not yet.** `node dist/cli.js migrate` exists and is exercised in CI; production is migrated by Django until the plan's step 6.4 |

`node dist/cli.js` alone lists them.

## Running one

In a production stack, where `...` is the stack's own compose words:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api-nest node dist/cli.js verify-inventory
```

In local production:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api-nest node dist/cli.js verify-inventory
```

`run` starts a container of the service beside the one that is serving and removes it
afterwards. A command connects, does one thing and exits: 0 when it is done, 1 when it refused or
failed, 2 when it was not understood. A refusal is one line saying why; nothing was changed.

The image has to be a build that has the commands: one made from a commit after 2026-10-14.
`Cannot find module '/app/dist/cli.js'` means it is not.

## Where they differ from Django's

- **`create-owner` takes its password from the environment**, `OWNER_PASSWORD`, never from the
  command line (every process on the machine can read that) and never by asking. It holds the
  password to the same four rules the app does. Django's `createsuperuser` asks twice and
  checks; its `--noinput` form checks nothing, which this does not copy.

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm -e OWNER_PASSWORD api-nest node dist/cli.js create-owner --email owner@shop.example
  ```

  `-e OWNER_PASSWORD` with no value passes the variable from your shell: set it there first,
  with a leading space so that the shell keeps it out of its history.

- **`bootstrap-store` takes flags**, or the script's own `SHOP_NAME`, `BRANCH_NAME` and
  `BRANCH_CODE` from the environment. There is no file to pipe in, so the PowerShell
  byte-order-mark trap of [new-store-from-scratch.md](new-store-from-scratch.md) §6 does not
  arise.
- **Refusals are worded for this command**, not as Django's `CommandError`. What is printed
  when a command succeeds is the same, line for line.

## How they are known to agree

`scripts/nest-commands.sh compare`, in CI's parity job: each of the four is run on one database
and Django's own on a copy of it.

```text
create-owner ............... the account's row is the same; Django accepts the password this hashed
bootstrap-store ............ the organisation, branch, drawer and audit entry are the same; a second run changes nothing
verify-inventory ........... the same lines printed, for every branch and for one; --fix appends the same rows
verify-accounts ............ the same lines printed, unposted events included; --fix appends the same rows
both repairs ............... the shelves and balances are left as they were; the audit entries are the same
```

A row is compared by what it says: ids and moments are each database's own.
