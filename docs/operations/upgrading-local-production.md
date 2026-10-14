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
- `scripts/dev-stack-native.sh` or `scripts/demo-snapshot.sh restore` pointed at it: both are for
  an empty database (the second refuses anything else).

## A shop still on Django: two deploys, in order

**The API is the NestJS one alone since 2026-10-14**; Django was removed
([ADR-0023](../architecture/decisions/0023-django-is-gone.md)). A stack still served by Django, or
by the NestJS API with Django beside it, reaches this release in **two deploys**, never one:

1. **To `c5f4e81`**, the last release that has Django, with this page **as it was at that commit**
   -- it has the step that moves a shop off Django (6-once) and Django's migrations. Read it there:

   ```powershell
   git show c5f4e81:docs/operations/upgrading-local-production.md
   ```

   and deploy from that commit (`git switch --detach c5f4e81` in place of step 1's `git switch main`
   and `git pull`). That page was rehearsed on the shop's own backup on 2026-10-14
   ([the roadmap](../roadmap.md#verification-log)).
2. **To this release**, with this page, from `main`. Its `migrate` adopts the database Django left
   and applies what is newer.

Which one is due: `docker ps -a --format "{{.Names}}"` listing `rangon-prod-api-1`,
`-worker-1` or `-beat-1` running, or the image label in step 1 naming a commit older than
`c5f4e81`, means the first. Doing the second first does no harm: step 6a's `migrate` refuses, says
*This database is behind the baseline*, and changes nothing.

The steps below were run on a Linux machine on 2026-10-14 against throwaway databases -- a new one, a
Django-built one adopted and migrated, one an earlier build had adopted -- but not on the shop's own
data, and not in **PowerShell**. Step 2's backup is what makes that safe to find out. Section
numbers are referred to as steps below.

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

*NestJS API (lint, types, unit tests, migrations)* and *NestJS API against its recorded answers*
must have passed. If either was still pending when the PR merged, wait for the run on `main`
before deploying. *Secret scan (gitleaks)* has failed on a false positive in
`apps/api-nest/parity/run.ts` (a made-up request id, committed 2026-09-30) since PR #81; a gitleaks
failure that names any **other** file must be read before deploying.

**Know which commit is running now.** Images built with step 4's label say what they were built
from:

```powershell
docker image inspect rangon-api-nest:prod --format "{{json .Config.Labels}}"
```

`{"rangon.commit":"c5f4e81"}` means commit `c5f4e81`. `null` means the image predates the label, so
rebuild both images this time. Then see what changed, and in which app:

```powershell
git diff --stat c5f4e81 HEAD -- apps/api-nest apps/web
```

Rebuild the image of each directory that changed: `rangon-api-nest` for `apps/api-nest`,
`rangon-web` for `apps/web`. When in doubt, rebuild both: it only costs time.

**Know whether the database will change.** The migrations that came with the new code, by file:

```powershell
git diff --name-only --diff-filter=A c5f4e81 HEAD -- apps/api-nest/drizzle/*.sql
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
docker tag rangon-web:prod "rangon-web:prod-before-$(Get-Date -Format yyyyMMdd)"
```

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

## 5. Read the migrations before anything runs

Open each file step 1 listed and read its SQL. `CREATE TABLE`, `ADD COLUMN` that allows `NULL` or
has a default, `CREATE INDEX` and `ADD CONSTRAINT` are additive: they leave every existing row
alone, and the old code still running ignores them. `DROP`, `RENAME`, `ALTER COLUMN ... TYPE`,
`SET NOT NULL`, and any `UPDATE` or `DELETE` can change or lose data. **If you see one of those,
stop**, unless the migration's own comment says it is the contract step of an earlier expand (CLAUDE.md
§ 6). [migrations.md](../database/migrations.md) has the rules they were written to.

One is known, and is safe: **`0001_drop_django_framework_tables.sql`**, on the deploy after the
one to `c5f4e81`. It drops the tables only Django's framework used -- content types, its permissions
and groups, the admin's log, sessions, Celery beat's schedule. The NestJS API never read them, so
the old API image, still serving while it runs, does not notice.

---

## 6. Apply the migrations, then swap the app containers

**6a. Migrate, then the roles.** With the **new** API image, as a one-off container, while the old
code is still serving -- safe *because* step 5 found every operation additive, or `0001`:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api-nest node dist/cli.js migrate
```
```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api-nest node dist/cli.js sync-permissions
```

The first deploy after Django prints *adopted: Django built this database ...*, then *applied 1
migration*. *This database is behind the baseline* means the deploy to `c5f4e81` has not been done:
nothing was changed; do that one first.

**6b. Recreate the app containers** on the new images. List only what step 4 rebuilt. `--no-deps`
keeps `db` and `redis` out of it:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --no-deps --force-recreate api-nest web
```

On the first deploy after Django, remove what is left of it too. An error saying a container does
not exist is fine:

```powershell
docker rm -f rangon-prod-api-1 rangon-prod-worker-1 rangon-prod-beat-1
```

**6c. Restart nginx.** It resolves `api-nest` and `web` once, at startup, and keeps the old containers'
addresses. Without this every `/api/` request answers 502 while the storefront looks fine
([local-production.md § 7](local-production.md#7-restart-nginx--not-optional)):

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml restart nginx
```

---

## 7. Verify

All read-only:

```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/smoke-test.sh http://localhost:4100
```
```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api-nest node dist/cli.js verify-inventory
```
```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T api-nest node dist/cli.js verify-accounts
```

- Every smoke-test line must say `ok`, ending `smoke test passed`.
- `verify-inventory` must say *Inventory is consistent with the ledger.* and `verify-accounts`
  *Accounts are consistent with the cash book.* Anything else is drift: stop and read it. Neither
  repairs anything unless given `--fix`, and that is not part of a deploy.
- `verify-accounts` may also list *money event(s) posted nothing to any account*. That is a known
  gap from before the accounts existed, not something this deploy caused: compare it with the
  count before you deployed.

**Place one order and look for its confirmation email** (Mailpit, or the customer's inbox): that is
the job queue working, which no smoke test shows.

Then sign in and look at what the release changed. `docker ps` will show `web` as *unhealthy*.
That is expected and explained in
[local-production.md § 10](local-production.md#10-two-things-that-look-broken-and-are-not).

---

## 8. Clean up

The dump left inside the database container is a second copy of the shop's data:

```powershell
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml exec -T db rm /tmp/before-deploy.dump
```

Keep the `prod-before-*` images until you are sure of the release, a few days. Then list them and
remove the old ones by name:

```powershell
docker images rangon-api-nest; docker images rangon-web
```
```powershell
docker rmi rangon-api-nest:prod-before-20261014 rangon-web:prod-before-20261014
```

After the first deploy past Django, its image is nothing's any more: `docker images rangon-api`,
then `docker rmi` each tag it lists, once you are sure of the release.

---

## Rolling back

**The code:** point the tags back at the images step 3 kept. Use the date shown by
`docker images rangon-api-nest`. Then repeat step 6b and 6c:

```powershell
docker tag rangon-api-nest:prod-before-20261014 rangon-api-nest:prod
```
```powershell
docker tag rangon-web:prod-before-20261014 rangon-web:prod
```

That holds for the deploy past Django too: the image from `c5f4e81` serves a database `0001` has
run on, because its API never read what `0001` dropped. What cannot come back is Django itself.

**The database almost never needs rolling back.** With no migration there is nothing to undo, and an
additive one is ignored by the old code, so the old images run on the new schema as they are. There
is no command that reverses a migration, on purpose.

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
| `/django-admin/` or `/api/docs/` answers **404** | Django's, dropped, and Django is gone | Nothing to start: the back office is `/admin` |
| A scheduled job ran twice (two digests at 08:00) | A Django `beat` container is still running beside `api-nest` | Step 6b's `docker rm -f` |
| `migrate` says *behind the baseline* | The shop has not had the deploy to `c5f4e81` | [Two deploys, in order](#a-shop-still-on-django-two-deploys-in-order) |
| Step 1 lists a migration you did not expect | The checkout is not what you think, or someone added a migration | Stop. `git log` and read it |
| The storefront calls the wrong host, or images and links say `localhost` on the public site | Web image built with the wrong `NEXT_PUBLIC_*` | Step 4's origin check, rebuild `web`, step 6b and 6c |
| `No such image: rangon-api-nest:prod` | A build failed, or `docker rmi` removed the tag | Step 4; the dated tags from step 3 are still there |
| Pages error after the swap | A bad release | **Rolling back**, then read `docker compose … logs --tail 200 api-nest web` |
