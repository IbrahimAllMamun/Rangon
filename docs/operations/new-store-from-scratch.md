# Starting a new store on a blank database

> The local production stack, from building its images to the owner signing in, with **no demo
> data**: an empty catalogue, one branch, one cash drawer and one owner account. This is the path
> for a shop that is going to trade.
>
> [local-production.md](local-production.md) is the same stack filled with demo products, orders and
> staff by `seed_demo`. Its traps (nginx caching addresses, healthchecks that never pass, the OOM
> killer) apply here too, and this page links to them rather than repeating them.

**Never run either of these against this database:**

- `seed_demo`: it fills the shop with demo products, orders, customers and five `@rangon.test`
  staff accounts, and with `--reset` it deletes catalogue and order data first.
- `scripts/rebuild-local-prod.sh`: it starts with `compose down -v`, which **deletes the database
  volume**, and then reseeds the demo.

Once the shop is trading, new code goes on with
[upgrading-local-production.md](upgrading-local-production.md): backup, build, migration check,
swap, verify and rollback, without touching the database's volume.

All commands run from the repository root. The first command of step 4, steps 5–7 and the
integrity checks in step 9 were run against a brand-new database on 2026-10-03, including both forms
of step 6. The owner was created
with the non-interactive form of the same command and then signed in through the API. The image
builds and nginx steps are the ones [local-production.md](local-production.md) already uses.

---

## 0. Before you start

**Is the Cloudflare tunnel running?** The containers are `restart: unless-stopped`, so if the
tunnel is up they are public the moment they start, before an owner account exists. In PowerShell:

```powershell
Get-Service Cloudflared
```

If it says `Running`, stop it until step 9 is done (`Stop-Service Cloudflared`, elevated).

**Free the memory.** Docker Desktop has about 4 GB here, and building an image beside another stack
gets something killed with exit 137 and no message ([local-production.md §2](local-production.md#2-before-you-start)).
Stop the development stack; its data is a different volume and survives:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

**Check the ports.** Windows reserves whole TCP ranges and moves them on every reboot
([.claude/environment.md §2](../../.claude/environment.md)). The stack needs **4100** (the app),
`API_PORT` and `MAILPIT_PORT`:

```bash
netsh.exe interface ipv4 show excludedportrange protocol=tcp
```

**Which shell.** Git Bash for everything except step 7, which needs an interactive terminal:
PowerShell or Windows Terminal, or prefix the command with `winpty` in Git Bash. Step 6 has a
PowerShell form, because PowerShell's pipe corrupts the script it sends.

---

## 1. Write `.env.prod.local`

It is gitignored, and `config/settings/prod.py` refuses to boot without it. Two secrets to generate
first, in Git Bash:

```bash
openssl rand -base64 48
```

That one is `DJANGO_SECRET_KEY`. It must not start with `dev-`, `test-`, `build-` or `insecure`,
which the production settings refuse.

```bash
openssl rand -hex 24
```

That one is the database password. Hex on purpose: it also goes inside `DATABASE_URL`, where `@`,
`/` or `:` would break the URL unless encoded.

```dotenv
DJANGO_SETTINGS_MODULE=config.settings.prod
DJANGO_DEBUG=0
DJANGO_SECRET_KEY=<the base64 value>
# Must not be empty and must not contain "*"; prod.py raises at boot otherwise.
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,api,web,nginx
DJANGO_CSRF_TRUSTED_ORIGINS=http://localhost:4100
DJANGO_CORS_ALLOWED_ORIGINS=http://localhost:4100
DJANGO_SECURE_SSL_REDIRECT=0
DJANGO_TIME_ZONE=Asia/Dhaka

POSTGRES_HOST=db
POSTGRES_DB=rangon
POSTGRES_USER=rangon
POSTGRES_PASSWORD=<the hex value>
DATABASE_URL=postgresql://rangon:<the same hex value>@db:5432/rangon

REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1
CELERY_RESULT_BACKEND=redis://redis:6379/2
API_INTERNAL_URL=http://api:8000/api/v1

EMAIL_HOST=mailpit
EMAIL_PORT=1025
EMAIL_USE_TLS=0

# Any free ports outside the reserved ranges from step 0.
API_PORT=8400
MAILPIT_PORT=8425
```

**Get the database password right before step 4.** Postgres reads `POSTGRES_PASSWORD` only when it
creates its data volume. Changing it afterwards changes nothing in the database, and the API then
fails to connect with the new value.

---

## 2. Remove an old local production stack (only if one exists)

```bash
docker volume ls --filter name=rangon-prod
```

No output means there is nothing to remove; go to step 3. If there is a `rangon-prod_postgres_data`
volume, **it is a store's database.** If anything in it matters, back it up first
([backups.md](backups.md)). Then:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml down -v
```

`-v` deletes this project's volumes and nothing else; the development stack's database is a
different project.

---

## 3. Build the three images

The local production compose file builds nothing itself (`build: !reset null`), so `up` fails on a
missing image unless all three exist ([local-production.md §4](local-production.md#4-build-the-three-images-by-hand)).
The API the shop runs on is the NestJS one; Django's image sets the database up in steps 5 to 7,
and is what the stack can go back to
([local-production.md §9a](local-production.md#9a-django-on-demand-and-back-to-django)).

```bash
docker build -t rangon-api-nest:prod -f apps/api-nest/Dockerfile apps/api-nest
```

```bash
docker build -t rangon-api:prod -f apps/api/Dockerfile apps/api
```

```bash
docker build -t rangon-web:prod -f apps/web/Dockerfile apps/web --build-arg NEXT_PUBLIC_API_URL=http://localhost:4100/api/v1 --build-arg NEXT_PUBLIC_SITE_URL=http://localhost:4100
```

The two `NEXT_PUBLIC_*` values are compiled into the browser bundle and cannot be changed later.
`NEXT_PUBLIC_SITE_URL` is also the origin sign-ins are accepted from, so build it for the address
the shop will be used at. A shop reached through a domain needs that domain here
([cloudflare-local-setup.md §7.1](cloudflare-local-setup.md)). To check an existing image:

```bash
docker inspect rangon-web:prod --format '{{range .Config.Env}}{{println .}}{{end}}' | grep NEXT_PUBLIC
```

---

## 4. Start the database and the cache

Those two only, waiting until each reports healthy. The rest of the stack starts in step 8, once
the database has its tables, its shop and its owner:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --wait db redis
```

Steps 5 to 7 are Django's commands. Django is not one of the containers this stack keeps running,
so each is `run --rm api ...`: a container made for the one command, and removed after it.

---

## 5. Migrate

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api python manage.py migrate
```

Migrating also creates the seven roles and every permission code, through a `post_migrate` hook
(`accounts.apps`). That is why it must come before step 7: the owner account takes the Owner role
only if the role already exists. To see what a blank database holds now:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api python manage.py shell -c "from accounts.models import Role, Permission, Organization, Branch; print('roles', Role.objects.count(), 'permissions', Permission.objects.count(), 'organizations', Organization.objects.count(), 'branches', Branch.objects.count())"
```

Expect `roles 7`, a permission count (43 today; it follows `accounts/permissions.py`), and **0
organizations and 0 branches**. Step 6 fills that gap.

---

## 6. Create the organization, first branch and cash drawer

**Nothing in the app creates the organization.** On a blank database `GET /organization/` answers
404 (`No organisation configured.`), Settings has no shop to edit, and a branch added from the
admin is saved against an organization that does not exist. Only `seed_demo` ever made one. `scripts/bootstrap-store.py` makes
exactly these three rows and nothing else:

| Row | What it is |
| --- | --- |
| Organization | The shop: its name heads labels and receipts. Currency BDT. |
| Branch | The first branch, marked default, with one register. Its code prints on receipts. |
| Cash drawer | `<CODE> Cash Drawer`, the default cash account counter sales post into, at **৳ 0.00**. |

Set the three names on the command. In **Git Bash**:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm -T -e SHOP_NAME="Rangon Fashion" -e BRANCH_NAME="Rangon Panthapath" -e BRANCH_CODE=DHK1 api python manage.py shell < scripts/bootstrap-store.py
```

In **PowerShell**, go through `cmd`. PowerShell's own pipe prefixes a byte-order mark, and Python
stops at line 1 with `SyntaxError: invalid non-printable character U+FEFF`:

```powershell
cmd /c 'docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm -T -e SHOP_NAME="Rangon Fashion" -e BRANCH_NAME="Rangon Panthapath" -e BRANCH_CODE=DHK1 api python manage.py shell < scripts\bootstrap-store.py'
```

It prints:

```text
Organization: Rangon Fashion (rangon-fashion)
Branch:       Rangon Panthapath (DHK1), default=True
Cash drawers: 1
```

- **The names apply on the first run only.** Running it again is harmless, but it reuses what exists
  and ignores new names. The app is single-tenant and only ever reads the oldest organization, so a
  second one would be invisible. Rename both later in **Settings**.
- `BRANCH_CODE` is uppercased and holds at most 16 characters. A longer one is refused before
  anything is written.
- **The drawer opens at zero on purpose.** What is physically in the till is a figure only the owner
  knows; they post it as the opening balance from **Finance** (step 10).

---

## 7. Create the owner account

From **PowerShell** or Windows Terminal, because it asks questions:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api python manage.py createsuperuser
```

From Git Bash, prefix it with `winpty`, or it stops with `the input device is not a TTY`:

```bash
winpty docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api python manage.py createsuperuser
```

It asks for an email address and a password, twice. The password must be at least 10 characters,
not a common password, not all digits and not too close to the email address.

The account gets the **Owner** role automatically, plus access to the Django admin. It belongs to no
branch on purpose: an owner works across every branch, and the default branch is used until they
pick another.

**Do not use `--noinput` with `DJANGO_SUPERUSER_PASSWORD` here.** Django checks the password rules
only when it asks interactively; the non-interactive form accepts any password at all, for the one
account that can do everything.

---

## 8. Start the shop, and restart nginx

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d
```

Do not add `--wait`: `web` reports `unhealthy` permanently
([local-production.md §10](local-production.md#10-three-things-that-look-broken-and-are-not)),
so it would wait forever.

nginx looks up the `api-nest` and `web` containers once, when it starts, and keeps those addresses.
Any container started after it has an address nginx does not know, and `/api/` answers 502 while
pages still render ([local-production.md §7](local-production.md#7-restart-nginx--not-optional)).

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml restart nginx
```

---

## 9. Check it

```bash
bash scripts/smoke-test.sh http://localhost:4100
```

The two ledgers should agree with themselves from the first minute:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api python manage.py verify_accounts
```

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api python manage.py verify_inventory
```

Expect `Accounts are consistent with the cash book.` and `Inventory is consistent with the
ledger.` Then sign in as the owner at **http://localhost:4100/login**.

The storefront is empty, which is correct: there is nothing to sell yet.

---

## 10. The owner's first hour

What a new shop needs before it can sell, in the order it needs it.

| Page | Do this |
| --- | --- |
| **Settings** | Shop details: legal name, address, phone, email, VAT registration, receipt footer, logo. **Tax**: whether prices include VAT, and the rate. **Reserved stock**: whether the counter may sell stock held for online orders (owner only). **Branches**: the branch's address and phone, the number of registers, any further branches. |
| **Staff** | An account for each manager, cashier, inventory manager and accountant. Your own name is set here too; it was left blank in step 7. |
| **Finance** | Post the cash drawer's opening float. Open the bank and bKash/Nagad accounts the shop is paid into. |
| **Taxonomy** | Categories, brands, sizes and colours. A first purchase order can also create these as it goes. |
| **Suppliers** | Who you buy from. |
| **Products** | What you sell. A product with no price above zero cannot be published. |
| **Purchases** | **Stock arrives only by receiving a purchase order** ([business-rules.md §4.0a](../business-rules.md)); there is no typing a count in. Raise, send and receive the first order, and the stock lands on the shelf with its cost. |
| **Shipping** | Zones and delivery methods, before the storefront takes online orders. |
| **Barcode labels** | Stickers for stock that arrived without barcodes. |

---

## 11. Updating it later, without losing the store

The database outlives every rebuild, as long as nothing runs `down -v`. After pulling new code:

```bash
docker build -t rangon-api-nest:prod -f apps/api-nest/Dockerfile apps/api-nest
```

```bash
docker build -t rangon-api:prod -f apps/api/Dockerfile apps/api
```

```bash
docker build -t rangon-web:prod -f apps/web/Dockerfile apps/web --build-arg NEXT_PUBLIC_API_URL=http://localhost:4100/api/v1 --build-arg NEXT_PUBLIC_SITE_URL=http://localhost:4100
```

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api python manage.py migrate
```

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --force-recreate api-nest web
```

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml restart nginx
```

Use the same build arguments every time. Back the database up on a schedule: [backups.md](backups.md).

---

## When something goes wrong

| What you see | What it is |
| --- | --- |
| `SyntaxError: invalid non-printable character U+FEFF` in step 6 | The script was piped from PowerShell. Use the `cmd /c` form. |
| `the input device is not a TTY` in step 7 | Git Bash under mintty. Use PowerShell, or prefix `winpty`. |
| Settings shows no shop details; `/api/v1/organization/` answers 404 | Step 6 was skipped. Run it; it is safe on a database that already has data. |
| Sign-in shows "An unexpected error occurred" | Usually Redis is not running: the login throttle needs it, and answers 500 without it ([.claude/environment.md](../../.claude/environment.md), "The stack runs without Docker"). `docker ps` should list `rangon-prod-redis-1`. |
| Sign-in refused with `403 CROSS_ORIGIN_REFUSED` | The web image was built for a different `NEXT_PUBLIC_SITE_URL` than the address in the browser (step 3). |
| `/api/...` answers 502 while pages render | nginx kept an old address. Step 8. |
| `/django-admin/` answers 503 with a line of text | Django is not running, by design. Start it when you want the Django admin: [local-production.md §9a](local-production.md#9a-django-on-demand-and-back-to-django). |
| The API cannot reach the database after changing `POSTGRES_PASSWORD` | Postgres kept the password it was created with (step 1). Put the old one back, or start from step 2. |
| A command dies with exit 137, or finishes suspiciously fast and silent | Out of memory. Stop the other stacks and run it again ([local-production.md §2](local-production.md#2-before-you-start)). |
