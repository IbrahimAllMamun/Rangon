# Deploying Rangon on a Webuzo account

> **Done once, with the demo shop, on 2026-10-15**: `https://rangon.stataisrt.org`, a Webuzo
> account with shell access on a shared server. Every command below is the one that worked there,
> and every trap in §10 was hit there. A shop that trades has not run on it yet: before one does,
> read §11.
>
> This replaces the page written in 2026-09 for the Django stack on a Webuzo VPS with root and
> Docker, which was never executed. No Docker and no root are needed here.
>
> General release rules -- backups first, migrations as their own step, expand/contract -- are in
> [deployment.md](deployment.md). Hosting on hardware you own instead:
> [self-hosting-with-a-domain.md](self-hosting-with-a-domain.md).

---

## 1. What runs where

```text
browser ── https ──> Webuzo's web server ──> Next.js       127.0.0.1:30248   (a Webuzo application)
                                                │
                                                └──> NestJS API   127.0.0.1:30249   (cron + start script)
                                                        │
                                                        ├──> PostgreSQL 16   localhost:5432  (Webuzo's)
                                                        └──> Redis            127.0.0.1:6380  (built in ~)
```

**Only Next.js is public.** Every call a browser makes already goes through it: sign-in and sign-out
(`/api/auth/*`), the admin's and the POS's calls (`/api/proxy/*`, which attach the httpOnly token),
the pages, rendered on the server, and uploads (`/media/*`, which `next.config.ts` rewrites to the
API). So the API listens on 127.0.0.1 alone (`RANGON_LISTEN_ADDRESS`), and is not a Webuzo
application: every Webuzo application gets a public address.

The one thing that would need the API public is a payment gateway's webhook
(`POST /api/v1/shop/payments/<provider>/webhook/`). The demo takes cash on delivery. See §11.

The ports are this account's. Webuzo offers a free port in its application form; the API's port was
checked free with `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:30249/` (`000`).

## 2. Does the account qualify?

What was checked, and what it showed there:

| Needs | Check | There |
|---|---|---|
| A shell | SSH | `bash-5.1` |
| PostgreSQL 16, server side | `psql "<address>" -c "select version();"` | 16.10. `psql --version` is the client only |
| A user that can create schemas (pg-boss keeps its own) | `-c "create schema t; drop schema t;"` | yes |
| Node 22 | the banner in Webuzo's application form | `/usr/local/apps/nodejs22/bin/node` |
| Long-running processes allowed | a Redis started from the shell still answers hours later | yes |
| Cron | `crontab -l` | yes |
| A C compiler, for Redis | `make` in §3 | gcc |

`free` and `ulimit` show the server, not the account. The account's limits are real and do not show
until something is killed: §6 is built around two of them.

## 3. Redis

The API needs Redis for its rate limits, which are checked on almost every request: without it,
nearly every request is a 500. It also caches the marketing feeds. Nothing in it must survive a
restart.

```bash
cd ~
curl -LO https://download.redis.io/releases/redis-7.2.5.tar.gz
tar xzf redis-7.2.5.tar.gz
cd redis-7.2.5
make
umask 077
openssl rand -hex 24 > ~/.redis-pass
```

**One command per line.** Pasted onto one line, `curl` takes the rest for addresses to download.
The `make` output's complaints about `python3` and `pkg-config` are optional extras; `LINK
redis-server` is what matters. The start script (§5) starts it; the "Memory overcommit" warning it
prints is about saving to disk, which is off.

A generated password, not a typed one: an `@`, `:` or `/` in it breaks `REDIS_URL`.

## 4. The database and the API

**The database.** Create it and its user in Webuzo. The API takes the password from `~/.pgpass`
(`localhost:5432:*:<user>:<password>`, mode 600) when the address has none, as `psql` does:

```bash
umask 077
printf 'DATABASE_URL=postgres://<user>@localhost:5432/<database>\n' > ~/rangon-db.env
```

`pg` 8 warns on every start that this is deprecated; at `pg` 9 the password moves into the address.

**The code and the API's build:**

```bash
git clone https://github.com/IbrahimAllMamun/Rangon.git ~/rangon
cd ~/rangon/apps/api-nest
export PATH=/usr/local/apps/nodejs22/bin:$PATH
npm ci
npm run build
```

`npm ci` reports moderate advisories: all of them in development tools (`npm audit --omit=dev`: 0).
Never `npm audit fix --force` on the server.

**The shop's data.** For the demo, the committed snapshot, then this build's schema:

```bash
set -a; . ~/rangon-db.env; set +a
psql "$DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema='public';"   # 0
cd ~/rangon
pg_restore --exit-on-error --no-owner --no-privileges -d "$DATABASE_URL" infrastructure/snapshots/demo/demo.dump
mkdir -p ~/rangon-media && tar -xzf infrastructure/snapshots/demo/media.tar.gz -C ~/rangon-media
cd apps/api-nest
node dist/cli.js migrate            # adopted: Django built this database ...; applied 1 migration
node dist/cli.js sync-permissions
```

`--no-privileges`: the dump's grants name a role this server does not have.

**The demo's accounts carry the README's password, which is public.** Before the site is reachable,
every one gets yours:

```bash
read -rs -p "New password for the demo accounts: " NEW_PASSWORD; echo; export NEW_PASSWORD
for email in $(psql "$DATABASE_URL" -Atc "select email from accounts_user order by email;"); do
  node dist/cli.js set-password --email "$email" || echo "FAILED: $email"
done
unset NEW_PASSWORD
```

A shop that trades starts instead from its own backup, or from nothing:
[new-store-from-scratch.md](new-store-from-scratch.md), steps 5 to 7: the same `node dist/cli.js`
commands, run here from `apps/api-nest` rather than in a container.

**The API's settings**, `~/rangon-api.env`, readable by you alone:

```bash
umask 077
cat > ~/rangon-api.env <<EOF
DJANGO_SETTINGS_MODULE=config.settings.prod
DJANGO_DEBUG=0
DJANGO_SECRET_KEY=$(openssl rand -hex 32)
PORT=30249
RANGON_LISTEN_ADDRESS=127.0.0.1
DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost
DJANGO_SECURE_SSL_REDIRECT=0
DJANGO_TRUSTED_PROXY_HOPS=0
DJANGO_CSRF_TRUSTED_ORIGINS=https://rangon.stataisrt.org
DJANGO_CORS_ALLOWED_ORIGINS=https://rangon.stataisrt.org
RANGON_PUBLIC_URL=https://rangon.stataisrt.org
REDIS_URL=redis://:$(cat ~/.redis-pass)@127.0.0.1:6380/0
MEDIA_ROOT=$HOME/rangon-media
WEB_REVALIDATE_URL=http://127.0.0.1:30248/api/revalidate
WEB_REVALIDATE_SECRET=$(openssl rand -hex 24)
EOF
```

Two of these differ from the Docker stack on purpose:

- **`DJANGO_SECURE_SSL_REDIRECT=0`.** The only caller is Next.js, over plain HTTP on 127.0.0.1, and
  with the redirect on the API answers its every call with a 301 to `https://127.0.0.1:30249/...`.
  The browser's HTTPS is Webuzo's.
- **`DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost`.** The only names the API is called by. Production
  settings refuse to start without the list, and with a `*` in it.

Email is not configured: jobs that send mail fail and retry. `EMAIL_HOST`, `EMAIL_PORT`,
`EMAIL_USER`, `EMAIL_PASSWORD` and `DEFAULT_FROM_EMAIL` go in this file when there is a mail server.

## 5. Keeping Redis and the API running

[`scripts/webuzo-start.sh`](../../scripts/webuzo-start.sh) starts Redis when it does not answer a
`PING`, and the API when `/api/health/` does not answer, stopping a hung one first. Cron runs it every
five minutes and at reboot; it leaves a healthy process alone.

```bash
cp ~/rangon/scripts/webuzo-start.sh ~/rangon-start.sh
chmod 700 ~/rangon-start.sh
(crontab -l; echo '*/5 * * * * $HOME/rangon-start.sh'; echo '@reboot $HOME/rangon-start.sh') | crontab -
~/rangon-start.sh
sleep 20
curl -s http://127.0.0.1:30249/api/ready/; echo                     # "status":"ready"
curl -s -o /dev/null -w 'products %{http_code}\n' http://127.0.0.1:30249/api/v1/shop/products/
```

Logs: `~/rangon-logs/api.log`, `redis.log`, and `start.log`, one line per start.

## 6. Building the web app

`NEXT_PUBLIC_SITE_URL` is baked into the build: the links, the sitemap, and the check that refuses a
form posted from another site, which refuses sign-in when it is wrong. So is `API_INTERNAL_URL`, for
the `/media/` rewrite, although the server reads it again when it runs.

```bash
cd ~/rangon/apps/web
export PATH=/usr/local/apps/nodejs22/bin:$PATH
npm ci
rm -rf .next
CIRCLE_NODE_TOTAL=2 UV_THREADPOOL_SIZE=2 NODE_OPTIONS="--max-old-space-size=768 --v8-pool-size=2" \
  NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_SITE_URL=https://rangon.stataisrt.org \
  API_INTERNAL_URL=http://127.0.0.1:30249/api/v1 npx next build --no-lint
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
```

**A plain `next build` does not survive the account's limits.** The server reports 48 cores, and
Node and Next.js size themselves by them:

| Attempt there | What happened |
|---|---|
| `next build` | killed while compiling (`SIGKILL`): memory |
| with `--max-old-space-size=768` | compiled, then `pthread_create: Resource temporarily unavailable` and `SIGABRT` in the type check: threads |
| all of the above | built |

Measured on a 4-core machine with the same code:

| Build | Peak memory | Peak threads |
|---|---|---|
| `next build` | 1.55 GB | 73 |
| `--max-old-space-size=768` | 1.33 GB | 73 |
| the command above | 1.13 GB | 31 |
| `experimental: { cpus: 1, webpackMemoryOptimizations, webpackBuildWorker: false }` | 2.26 GB | -- |

What each part does:

- `CIRCLE_NODE_TOTAL=2`: Next.js takes its worker count from this variable when it is set, and from
  the core count less one when not -- 47 workers there.
- `--v8-pool-size=2`, `UV_THREADPOOL_SIZE=2`: each Node process's thread pools, otherwise one thread
  per core.
- `--no-lint`: CI lints every change before it merges. The type check still runs.
- Next.js's own low-memory settings made it worse, as the last row shows.

`next start` cannot serve a `standalone` build; `server.js` is what runs, with `.next/static` and
`public` copied in beside it, as the Dockerfile does.

Before Webuzo, a test from the shell:

```bash
cd ~/rangon/apps/web/.next/standalone
NODE_ENV=production HOSTNAME=127.0.0.1 PORT=30248 API_INTERNAL_URL=http://127.0.0.1:30249/api/v1 \
  /usr/local/apps/nodejs22/bin/node server.js &
sleep 8
curl -s -o /dev/null -w 'home %{http_code}\n' http://127.0.0.1:30248/    # home 200
kill %1
```

## 7. The Webuzo application

Application Manager, **Create**, the **Self Managed** tab:

| Field | Value |
|---|---|
| Port | 30248 (offered by the form) |
| Application Name | `rangon_web` |
| Deployment Domain | `rangon.stataisrt.org`, its SSL switched on |
| Base Application URL | empty: the site's root |
| Application Path | `rangon/apps/web/.next/standalone` |
| Application type | Node.js 22 |
| Application startup file | `server.js` |
| Deployment Environment | Production |
| Start Command | `/usr/local/apps/nodejs22/bin/node /home/stataisr/rangon/apps/web/.next/standalone/server.js` |
| Stop Command | `pkill -u stataisr -f "[s]tandalone/server.js"` |

The `[s]` keeps `pkill` from matching the shell that runs it, whose own command line holds the
pattern.

Environment variables:

| Name | Value |
|---|---|
| `NODE_ENV` | `production`: the session cookies are `Secure` |
| `HOSTNAME` | `127.0.0.1`. `server.js` listens on `HOSTNAME`, and a shell sets that to the machine's name |
| `PORT` | `30248` |
| `API_INTERNAL_URL` | `http://127.0.0.1:30249/api/v1` |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `REVALIDATE_SECRET` | `sed -n 's/^WEB_REVALIDATE_SECRET=//p' ~/rangon-api.env`: the same string, or the API's requests to refresh cached pages are refused |

## 8. Verify

- `https://rangon.stataisrt.org` shows the twelve products, with their images.
- `/login` as `owner@rangon.test`, with the password from §4, opens the admin.
- `tail ~/rangon-logs/api.log` and Webuzo's log for the application show no errors.

## 9. Updating

```bash
pg_dump --format=custom --no-owner --no-privileges -d "$(cut -d= -f2- ~/rangon-db.env)" \
  -f ~/rangon-backup-$(date -u +%Y%m%dT%H%M%SZ).dump                    # always first
cd ~/rangon && git pull
cd apps/api-nest && npm ci && npm run build
set -a; . ~/rangon-db.env; set +a
node dist/cli.js migrate
node dist/cli.js sync-permissions
kill "$(cat ~/rangon-logs/api.pid)"; ~/rangon-start.sh
```

Then §6's build and copies, and stop and start the application in Webuzo. A change to
`NEXT_PUBLIC_SITE_URL` or to the API's port needs that rebuild; a change to the other variables in §7
needs only the restart.

**Backups.** [`scripts/backup-db.sh`](../../scripts/backup-db.sh) runs here with
`BACKUP_VIA=direct POSTGRES_HOST=localhost POSTGRES_DB=<database> POSTGRES_USER=<user>
BACKUP_DIR=$HOME/rangon-backups RANGON_ENV=prod`, the password from `~/.pgpass`, from cron like the
start script. Not yet run there. Without `BACKUP_S3_BUCKET` the copies sit on the same disk as the
database: see [backups.md](backups.md).

## 10. What went wrong on the way

| Symptom | Cause |
|---|---|
| `curl: (6) Could not resolve host: tar` | several commands pasted onto one line |
| Next.js build `SIGKILL` | the account's memory limit; §6 |
| `pthread_create: Resource temporarily unavailable`, `SIGABRT` | the account's thread limit, and pools sized for 48 cores; §6 |
| Every page fails, the API log shows nothing | `DJANGO_SECURE_SSL_REDIRECT` left on: the API redirects Next.js's plain-HTTP calls; §4 |
| `Error: Connection is closed.` on every API call | Redis not running; `~/rangon-start.sh` |
| Sign-in "came from another website" | the web app built without `NEXT_PUBLIC_SITE_URL`, or with another address; rebuild |
| Webuzo cannot reach the web app | `HOSTNAME` unset, so `server.js` listens on the machine's name |
| `DeprecationWarning: pgpass support is deprecated` | `pg` 8 reading `~/.pgpass`; harmless |

## 11. Before a shop trades on it

- **Rate limits see one visitor.** Next.js does not pass the shopper's address to the API, so every
  anonymous visitor shares one bucket (`DJANGO_THROTTLE_ANON`, 60 a minute by default) and one
  sign-in limit. True of the Docker stack too; not fixed yet.
- **Next.js 15.5.24 has a moderate advisory** for self-hosted sites (cache poisoning of SSG and ISR
  pages, GHSA-4jqv-mc3x-m676, GHSA-mcj8-r9mp-w47p); 15.5.28 fixes it.
- **Payments.** A gateway's webhook needs the API reachable: a second Webuzo application on its own
  subdomain, with the redirect and the allowed hosts changed to suit.
- **Email**, §4. **Backups**, §9, with a restore rehearsed.
- **Uploads** are in `~/rangon-media`, on the same disk; the database backup does not include them.
