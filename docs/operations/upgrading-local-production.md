# Upgrading the local production stack without losing data

> How to put new code on a local production stack (`-p rangon-prod`) **that already holds a real
> shop's data**: back up, build, check the migrations, swap the app containers, verify, and be able to
> roll back in two commands. The database and Redis containers are never recreated, and no volume is
> touched.
>
> Building that stack the first time is [local-production.md](local-production.md) (demo data) or
> [new-store-from-scratch.md](new-store-from-scratch.md) (a blank database). This page is for every
> deploy after that.

**Never run any of these against a stack with real data:**

- `scripts/rebuild-local-prod.sh`: it starts with `compose down -v`, which **deletes the database
  volume**, and then fills the shop with demo data.
- `docker compose … down -v`, `docker volume rm` or `docker volume prune`: each deletes the
  database.
- `seed_demo` in any form: `--reset` deletes catalogue and order data before seeding demo data.

**Since 2026-10-08 the stack is served by the NestJS API** (`api-nest`), with Django started only
on demand ([ADR-0017](../architecture/decisions/0017-nest-api-serves-production.md)). A stack built
before that is still running Django's `api`, `worker` and `beat`; the first deploy that crosses
that date has one extra step, [6-once](#6-once-the-deploy-that-moves-the-shop-to-the-nestjs-api),
**and must not be done as an ordinary step 6**. Everything else on this page is written for the
stack as it runs afterwards.

The steps as they stand after that date were run on a Linux machine on 2026-10-08, against
throwaway stacks: the three builds, the one-off migration, the swap, the smoke test and the two
`verify_` commands. Step 6-once was rehearsed the way a running shop will meet it -- a stack
started from the old compose files, with an order and an uploaded photograph in it, then the step
as written: the photograph, the order numbering, the owner's sign-in and both ledger checks came
through, and the two commands at its end took the stack back to Django. None of this has been run
in **PowerShell**, or against a stack holding **real data**; the commands are the same ones, and
step 2's backup is what makes that safe to find out.

Before it, this procedure was run end to end on this machine for the label-sheet release on 2026-10-03: the
migration, the image swap, the smoke test and `verify_inventory`. The commands on this page are the
same, with two additions. The commit label on the images was tried on a throwaway image. The
pending-migration check was run against the live database. Section numbers are referred to as
steps below.

---

## 0. Which shell

Every command runs in **PowerShell**, from the repository root (`D:\Rangon`). Three traps, each of
which has already cost a deploy here:

| Trap | What happens | So |
|---|---|---|
| `VAR=value command` | That is bash syntax. PowerShell answers *"The term 'VAR=value' is not recognized"*. | Every command below is plain PowerShell. |
| `bash` | In PowerShell it starts **WSL's** bash (`WindowsApps\bash.exe`), not Git Bash. Your environment variables are not passed to it, and it may not even see Docker. | Bash scripts run through `& "C:\Program Files\Git\bin\bash.exe"`. |
| `>` with binary output | PowerShell 5.1 re-encodes a native command's output as text, so `pg_dump … > file.dump` writes a **corrupt** backup. | The dump is written inside the database container and copied out with `docker cp`. |

---

## 1. Before you deploy

**Be on the code you mean to deploy.** Deploy from `main` after the pull request is merged, so what
runs is what was reviewed. `--ff-only` refuses to merge anything locally:

```powershell
git switch main
```
```powershell
git pull --ff-only
```
```powershell
git status --short
```

The last one must print nothing. A local change would end up in the image.

**Check the merge's CI.** A pull request can be merged before its checks finish. Read them:

```powershell
gh pr checks <number>
```

*Backend (lint, types, tests)* must have passed. If it was still pending when the PR merged, run the
backend suite yourself before deploying ([.claude/environment.md](../../.claude/environment.md),
"Commands that actually work here"). *Secret scan (gitleaks)* has failed on a false positive in
`apps/api-nest/parity/run.ts` (a made-up request id, committed 2026-09-30) since PR #81; a gitleaks
failure that names any **other** file must be read before deploying.

**Know which commit is running now.** Images built with step 4's label say what they were built
from:

```powershell
docker image inspect rangon-api:prod --format "{{json .Config.Labels}}"
```

`{"rangon.commit":"264103f"}` means commit `264103f`. `null` means the image predates the label, so
rebuild both images this time. Then see what changed, and in which app:

```powershell
git diff --stat 264103f HEAD -- apps/api apps/api-nest apps/web
```

Rebuild the image of each directory that changed: `rangon-api-nest` for `apps/api-nest` (the API
that serves), `rangon-api` for `apps/api` (Django: the migrations, and the way back), `rangon-web`
for `apps/web`. When in doubt, rebuild all three: it only costs time. A change to a business rule
touches both API directories, by the project's own rule.

**Know whether the database will change.** This lists every migration on disk that the live database
has not applied (read-only):

```powershell
$applied = docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml exec -T db psql --host=localhost --username=rangon --dbname=rangon -tAc "select app || '.' || name from django_migrations"; Get-ChildItem apps\api\*\migrations\0*.py | ForEach-Object { "$($_.Directory.Parent.Name).$($_.BaseName)" } | Where-Object { $applied -notcontains $_ }
```

Nothing printed means no schema change. Anything printed is read in step 5 before it runs.

**Pick a quiet moment.** Swapping the containers interrupts requests for a few seconds: a sale
being rung up at that moment fails and has to be retried. **Is the Cloudflare tunnel up?** The site
is public while you work (`Get-Service Cloudflared`).

---

## 2. Back up the database

Written inside the database container by its own `pg_dump`, which always matches the server's
version ([backups.md](backups.md)), then copied out:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml exec -T db pg_dump --format=custom --compress=6 --no-owner --no-privileges --host=localhost --username=rangon --dbname=rangon --file=/tmp/before-deploy.dump
```
```powershell
New-Item -ItemType Directory -Force backups
```
```powershell
docker cp rangon-prod-db-1:/tmp/before-deploy.dump "backups\rangon-prodlocal-$(Get-Date -Format yyyyMMdd-HHmm).dump"
```

Read the dump back to prove it is whole. This prints the number of entries in it, well above 0:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml exec -T db pg_restore --list /tmp/before-deploy.dump | Measure-Object -Line
```

**If it errors or prints 0, stop here.** Do not deploy without a backup that reads back.

`backups\` is gitignored, so a dump, which holds customer data, cannot be committed. A copy on the
same disk as the database is not a backup of that disk: put one somewhere else as well.

---

## 3. Keep the running images for rollback

Tagged with today's date, so a second deploy on another day cannot overwrite the way back from the
first:

```powershell
docker tag rangon-api-nest:prod "rangon-api-nest:prod-before-$(Get-Date -Format yyyyMMdd)"
```
```powershell
docker tag rangon-api:prod "rangon-api:prod-before-$(Get-Date -Format yyyyMMdd)"
```
```powershell
docker tag rangon-web:prod "rangon-web:prod-before-$(Get-Date -Format yyyyMMdd)"
```

(On the deploy that moves the shop to the NestJS API there is no `rangon-api-nest:prod` yet, and
the first command says so. That is expected: the way back from that deploy is Django itself.)

Tagging changes nothing that is running. A container keeps the image it was started from until step
6 recreates it.

---

## 4. Build the new images

**One at a time.** Docker Desktop has about 4 GB here and the production stack is already using some
of it. Two builds at once can get something killed with exit 137 and no message
([local-production.md § 2](local-production.md#2-before-you-start)). The label records the commit,
for step 1 of the next deploy.

```powershell
docker build -t rangon-api-nest:prod --label "rangon.commit=$(git rev-parse --short HEAD)" -f apps/api-nest/Dockerfile apps/api-nest
```
```powershell
docker build -t rangon-api:prod --label "rangon.commit=$(git rev-parse --short HEAD)" -f apps/api/Dockerfile apps/api
```

The web image compiles its `NEXT_PUBLIC_*` values **into the bundle**, so they must be the ones the
running site was built with. Ask the running bundle which origin it has (read-only):

```powershell
docker exec rangon-prod-web-1 sh -c "grep -rlF 'http://localhost:4100' /app/.next | wc -l"
```

A number above 0 means the stack is served as `http://localhost:4100`; build with:

```powershell
docker build -t rangon-web:prod --label "rangon.commit=$(git rev-parse --short HEAD)" -f apps/web/Dockerfile apps/web --build-arg NEXT_PUBLIC_API_URL=http://localhost:4100/api/v1 --build-arg NEXT_PUBLIC_SITE_URL=http://localhost:4100
```

`0` means it was built for a domain. Run the same `grep` with your domain to confirm which one, then
build with that domain's arguments ([cloudflare-local-setup.md](cloudflare-local-setup.md)).
A web image built for the wrong origin renders, but every browser call goes to the wrong place.

If a build fails, nothing has changed: the running containers still use the old images, and
`rangon-*:prod` still points at them. Fix the build, and carry on from this step.

---

## 5. Read the migration plan before anything runs

Runs the **new** API image as a one-off container; it plans and applies nothing:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api python manage.py migrate --plan
```

- **"No planned migration operations."** Nothing to migrate. Skip step 6a.
- **A list.** Every entry must be one step 1 expected. Open each migration file and read its
  operations. `CreateModel`, `AddField` with a default or `null=True`, `AddIndex` and
  `AddConstraint` are additive: they leave every existing row alone, and the old code still running
  ignores them. `RemoveField`, `DeleteModel`, `RenameField`, `RenameModel`, `AlterField`, `RunSQL` and
  `RunPython` can change or drop data. **If you see one of those, stop.** That change needs an
  expand/contract plan (CLAUDE.md § 6), not this page.

---

## 6. Apply the migrations, then swap the app containers

**6a. Migrate**, only if step 5 listed anything. This runs while the old code is still serving,
which is safe *because* every operation was additive:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api python manage.py migrate
```

**6b. Recreate the app containers** on the new images. List only what step 4 rebuilt (Django's
image is not among them: nothing runs from it day to day). `--no-deps` keeps `db` and `redis` out
of it:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --no-deps --force-recreate api-nest web
```

**6c. Restart nginx.** It resolves `api-nest` and `web` once, at startup, and keeps the old containers'
addresses. Without this every `/api/` request answers 502 while the storefront looks fine
([local-production.md § 7](local-production.md#7-restart-nginx--not-optional)):

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml restart nginx
```

---

## 6-once. The deploy that moves the shop to the NestJS API

**In place of 6b and 6c, once**: on the first deploy of a release from 2026-10-08 or later onto a
stack that is still running Django (`docker ps` shows `rangon-prod-api-1`, `-worker-1` and
`-beat-1`). Do steps 1 to 6a as written, building all three images in step 4.

Why it cannot be an ordinary swap: with the new compose files, `up -d` starts `api-nest` and points
the web app and nginx at it, but it no longer manages Django's three containers and **leaves them
running**. Beat would go on firing the scheduled jobs beside an `api-nest` that fires them too --
every reservation sweep and every morning digest twice.

**a. Nothing left for Celery.** The number must be `0`; wait and ask again until it is. (`1` is the
database number at the end of `CELERY_BROKER_URL` in `.env.prod.local`; use yours.)

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml exec -T redis redis-cli -n 1 llen celery
```

**b. Stop Django, and remove its containers.** The shop is down from here until step d, a minute
or two:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml --profile django --profile django-schedule stop beat worker api
```
```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml --profile django --profile django-schedule rm -f beat worker api
```

**c. Start the stack as it now is.** `api-nest` is created, and the web app and nginx are recreated
because what they point at changed. `db` and `redis` are untouched:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d
```

**d. Restart nginx**, as in 6c:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml restart nginx
```

**e. Check which API is answering**, then carry on with step 7. The NestJS API answers this `404`;
Django answered it `401`:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:4100/api/v1/
```

What does not need doing: the uploads (both images run as the same user, on the same volume), the
accounts and sign-ins (one database; a session from before still works), and the scheduled jobs
(the same five, at the same times, fired by `api-nest`). The first start of `api-nest` adds one
schema to the database, `pgboss`, for its job queue; step 2's kind of backup includes it from then
on.

**Place one order afterwards and look for its confirmation email** (Mailpit, or the customer's
inbox): that is the job queue working, which no smoke test shows.

**If it goes wrong: back to Django, with the same data.** One more file on the command, and nginx
again:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml -f docker-compose.django.yml up -d
```
```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml -f docker-compose.django.yml restart nginx
```

That is the stack as it was before this step, on the new images. Nothing is lost by it; tell
whoever maintains the code what went wrong. Coming forward again is
[local-production.md § 9a](local-production.md#9a-django-on-demand-and-back-to-django).

---

## 7. Verify

All read-only:

```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/smoke-test.sh http://localhost:4100
```
```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api python manage.py verify_inventory
```
```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api python manage.py verify_accounts
```

(`run --rm`, not `exec`: these are Django's commands, and Django is not running. Each starts a
container for the one command and removes it.)

- Every smoke-test line must say `ok`, ending `smoke test passed`.
- `verify_inventory` must say *Inventory is consistent with the ledger.* and `verify_accounts`
  *Accounts are consistent with the cash book.* Anything else is drift: stop and read it. Neither
  repairs anything unless given `--fix`, and that is not part of a deploy.
- `verify_accounts` may also list *money event(s) posted nothing to any account*. That is a known
  gap from before the accounts existed, not something this deploy caused: compare it with the
  count before you deployed.
- A `UserWarning: min_value should be a Decimal instance` above them is old and harmless.

Then sign in and look at what the release changed. `docker ps` will show `web` as *unhealthy*
(and `worker` and `beat` too, whenever Django is running). That is expected and explained in
[local-production.md § 10](local-production.md#10-three-things-that-look-broken-and-are-not).

---

## 8. Clean up

The dump left inside the database container is a second copy of the shop's data:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml exec -T db rm /tmp/before-deploy.dump
```

Keep the `prod-before-*` images until you are sure of the release, a few days. Then list them and
remove the old ones by name:

```powershell
docker images rangon-api-nest; docker images rangon-api; docker images rangon-web
```
```powershell
docker rmi rangon-api-nest:prod-before-20261005 rangon-api:prod-before-20261005 rangon-web:prod-before-20261005
```

---

## Rolling back

**The code:** point the tags back at the images step 3 kept. Use the date shown by
`docker images rangon-api`. Then repeat step 6b and 6c:

```powershell
docker tag rangon-api-nest:prod-before-20261005 rangon-api-nest:prod
```
```powershell
docker tag rangon-api:prod-before-20261005 rangon-api:prod
```
```powershell
docker tag rangon-web:prod-before-20261005 rangon-web:prod
```

**Or the other API.** If the fault is in the NestJS API and the previous image does not cure it,
Django serves the same data: the two commands at the end of
[6-once](#6-once-the-deploy-that-moves-the-shop-to-the-nestjs-api).

**The database almost never needs rolling back.** With no migration there is nothing to undo, and an
additive one is ignored by the old code, so the old images run on the new schema as they are. Do
**not** reverse a migration with `migrate <app> <previous>`: reversing a `CreateModel` drops the
table and what was written to it.

**Restoring the step 2 backup** is only for data that is actually damaged. Switching to it loses
every sale, purchase and edit made since the dump. Follow [disaster-recovery.md](disaster-recovery.md):
restore into a **new** database first, check it, and only then point the stack at it, never over the
live one. `scripts/restore-db.sh` asks you to type the database name before it writes anything.

---

## When something goes wrong

| Symptom | Cause | Do |
|---|---|---|
| A command dies with exit **137**, or finishes suspiciously fast and silent | Out of memory | `docker ps` to see what is missing; run the step again with nothing else building or testing |
| `/api/` answers **502**, storefront fine | nginx kept the old containers' addresses | Step 6c |
| `/django-admin/` or `/api/docs/` answers **503** with a line of text | Django is not running, by design | `--profile django up -d api worker` ([local-production.md § 9a](local-production.md#9a-django-on-demand-and-back-to-django)) |
| A scheduled job ran twice (two digests at 08:00) | beat and `api-nest` are both up | Stop beat: 6-once, step b |
| `migrate --plan` lists something step 1 did not expect | The checkout is not what you think, or someone added a migration | Stop. `git log` and read it |
| The storefront calls the wrong host, or images and links say `localhost` on the public site | Web image built with the wrong `NEXT_PUBLIC_*` | Step 4's origin check, rebuild `web`, step 6b and 6c |
| `No such image: rangon-api:prod` | A build failed, or `docker rmi` removed the tag | Step 4; the dated tags from step 3 are still there |
| Pages error after the swap | A bad release | **Rolling back**, then read `docker compose … logs --tail 200 api-nest web` |
