# The operator's commands

What an operator does to a database rather than through the app: `node dist/cli.js <command>`,
run in a one-off `api-nest` container. Until 2026-10-14 these were Django's `python manage.py ...`;
the right-hand column says which each replaces, for an older page or a habit.

## The commands

| To do this | Command | Was Django's |
|---|---|---|
| Bring the schema to this build's | `node dist/cli.js migrate` ([migrations.md](../database/migrations.md)) | `manage.py migrate` |
| Make the roles and permissions match the code | `node dist/cli.js sync-permissions` -- after every `migrate` | (ran after every `migrate`) |
| Create the first owner | `node dist/cli.js create-owner --email <address>`, with `OWNER_PASSWORD` in the environment | `manage.py createsuperuser` |
| Set an account's password | `node dist/cli.js set-password --email <address>`, with `NEW_PASSWORD` in the environment | `manage.py changepassword` |
| Give a new database its organisation, first branch and cash drawer | `node dist/cli.js bootstrap-store --shop-name "..." --branch-name "..." --branch-code <CODE>` | `manage.py shell < scripts/bootstrap-store.py` |
| Check the stock ledger against the cached stock | `node dist/cli.js verify-inventory [--branch <CODE>]` | `manage.py verify_inventory` |
| ... and reconcile what drifted | `... --fix --reason "..."` | the same |
| Check the cash book against the cached balances | `node dist/cli.js verify-accounts [--branch <CODE>] [--skip-unposted]` | `manage.py verify_accounts` |
| ... and reconcile | `... --fix --reason "..."` | the same |

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

In the development stack the running container has the commands compiled from the working
copy:

```bash
docker compose exec api-nest node dist/cli.js verify-inventory
```

`run` starts a container of the service beside the one that is serving and removes it
afterwards. A command connects, does one thing and exits: 0 when it is done, 1 when it refused or
failed, 2 when it was not understood. A refusal is one line saying why; nothing was changed.

The image has to be a build that has the commands: one made from a commit after 2026-10-14.
`Cannot find module '/app/dist/cli.js'` means it is not.

## Passwords and flags

- **`create-owner` and `set-password` take the password from the environment**, `OWNER_PASSWORD`, never from the
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
- **A refusal is one line saying why**; nothing was changed. What `verify-*` prints is what Django's
  printed, line for line, so an older note of a clean run still reads the same.

## How they are known to be right

Each was compared with Django's own on copies of one database until Django went (2026-10-14): the
rows they left and the lines they printed were the same. `migrate` is exercised in CI on a new
database and on the demo snapshot, a database Django built; the two schemas must match.
