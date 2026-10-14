# Running the production build on your own machine

> The production images, the production settings and the deployed nginx topology — on
> `localhost`, over plain HTTP. Use it to see what a shopper will actually get before anything is
> deployed, and as the origin behind a [Cloudflare tunnel](cloudflare-local-setup.md).
>
> This is **not** [deployment.md](deployment.md), which pulls the exact images CI built and scanned.
> Here you build them yourself.
>
> This page fills the stack with demo data. For a real shop on a blank database (no demo, your own
> organization, branch and owner account), follow
> [new-store-from-scratch.md](new-store-from-scratch.md) instead.
>
> **Already running a shop on this stack?** Deploy new code with
> [upgrading-local-production.md](upgrading-local-production.md). Everything on this page assumes
> the data in it can be thrown away.

---

## 1. What this gives you, and what it does not

`docker-compose.prodlocal.yml` runs the same images CI produces, with `config.settings.prod`, behind
nginx as a single origin on **4100** — the storefront, `/admin`, `/pos`, the API's `/api/v1/` and
Next's `/api/proxy/` all arrive on one hostname, exactly as they would deployed.

**The API** (`api-nest`) serves every request, sends the emails and fires the scheduled jobs. Its
operator's commands -- `migrate` among them -- run in one-off containers of the same image (step 5,
[operator-commands.md](operator-commands.md)).

Three deliberate differences from a real deployment:

- plain HTTP on localhost, so `SECURE_SSL_REDIRECT` is off;
- images are built locally rather than pulled by immutable tag;
- the container hardening in `docker-compose.prod.yml` (`read_only`, `cap_drop`) is not applied — it
  changes nothing you can see in a browser.

It is a **separate compose project** (`-p rangon-prod`) with its own network and its own volumes, so
it cannot collide with the development stack or share a Postgres data directory with it. Two servers
on one data directory is how a database is lost.

That separation has a consequence worth stating plainly: **its database always starts empty**, so
step 5 is not optional the first time.

---

## 1a. The short version

Sections 3–8 are one script:

```bash
./scripts/rebuild-local-prod.sh
```

It tears the stack down with `compose down -v`, builds the two images, restores the committed demo
snapshot into the empty database, has the API's `migrate` bring it to this build's schema, gives
every demo account your password, brings the stack up, waits for the API to report healthy,
restarts nginx, smoke-tests the result and runs both ledger checks — so it fails loudly rather than
exiting `0` on a stack that is not serving.

**It is destructive and unconditionally so.** `down -v` removes this project's volumes, which takes
the database with them, so the reseed is not a step you can skip — it is how the stack gets a
database at all. There is no `--no-seed` for that reason. The dev stack's volumes are a separate
project and are untouched.

Read the rest of this page anyway the first time. The script encodes the traps below, but knowing
*why* nginx has to be restarted is what saves you the next time something 502s.

---

## 2. Before you start

**`.env.prod.local` must exist.** It needs at least `DJANGO_SECRET_KEY` — compose refuses to start
without it — plus `DJANGO_SETTINGS_MODULE=config.settings.prod` and `DJANGO_DEBUG=0`. It is
gitignored, and a new machine must write its own.

**Free the memory first.** Docker Desktop is allocated about 4 GB here. Building an image while
another stack runs gets something OOM-killed with **exit 137 and no message anywhere obvious** — a
`pytest` run has already died this way and still exited `0`, having executed no tests. Stop the
development stack before building:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

Its data survives: `rangon_postgres_data` belongs to the `rangon` project and is untouched by
anything below.

---

## 3. Tear down any previous local production stack

`-v` removes this project's volumes so you genuinely start from scratch. It touches only the
`rangon-prod` project — the development stack's database is a different volume.

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml down -v
```

---

## 4. Build the images by hand

**This is the step that is skipped, and the failure is confusing.** `docker-compose.prodlocal.yml`
sets `build: !reset null` on every application service, so `up -d --build` builds **nothing** — it
looks for `rangon-api-nest:prod` and `rangon-web:prod` and fails if they are missing. Unlike the `:latest` tags the two web Dockerfiles fight over, these collide with nothing.

The API:

```bash
docker build -t rangon-api-nest:prod -f apps/api-nest/Dockerfile apps/api-nest
```

The web image is the slow one, and most of that time is `npm ci`. There is no way around it: the
production image is a clean multi-stage build that starts with no `node_modules`, and `next build`
cannot run without them. It is a one-time cost — BuildKit caches the dependency layer against
`package.json` and `package-lock.json`, so later builds skip it unless the lockfile changes.

```bash
docker build -t rangon-web:prod -f apps/web/Dockerfile apps/web --build-arg NEXT_PUBLIC_API_URL=http://localhost:4100/api/v1 --build-arg NEXT_PUBLIC_SITE_URL=http://localhost:4100
```

**Those two build arguments are baked into the client bundle and cannot be changed afterwards.**
Setting them in the compose file or the environment does nothing — Next inlines `NEXT_PUBLIC_*` at
build time. Omit them and the image silently falls back to the Dockerfile defaults
(`http://localhost:3000`, `http://localhost:8000/api/v1`), which produces wrong canonical URLs, OG
tags and `sitemap.xml` entries while the app otherwise appears to work. If you later expose this
through a domain, the image must be rebuilt with the public URL — see
[cloudflare-local-setup.md §7.1](cloudflare-local-setup.md).

Check what an existing image was built with before trusting it:

```bash
docker inspect rangon-web:prod --format '{{range .Config.Env}}{{println .}}{{end}}' | grep NEXT_PUBLIC
```

---

## 5. Migrate and seed

Before anything is started. The database is a separate volume from the development stack's, so it
starts empty every time it is recreated; and the API works the job queue and fires the schedule
from the moment it is up, so it should find its tables there.

**The demo snapshot** is committed (`infrastructure/snapshots/demo/`, [demo-snapshot.sh](../../scripts/demo-snapshot.sh)):
a seeded shop, dumped while Django still made it. Restored into this stack's empty database, with
its uploads, then brought to this build's schema and given its roles by the API:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --wait db
scripts/demo-snapshot.sh restore "$(docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml ps -q db)" rangon rangon
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm --no-deps -T \
  api-nest sh -c 'tar -xzf - -C /app/media' < infrastructure/snapshots/demo/media.tar.gz
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api-nest node dist/cli.js migrate
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm api-nest node dist/cli.js sync-permissions
```

The database name and user are this stack's (`POSTGRES_DB`, `POSTGRES_USER`). The restore refuses
a database that already has tables in it, so it cannot land on a shop.

**Then give every account a password of your own.** The snapshot's accounts carry the password
printed in the README, and this stack has been published through a tunnel before. For each address
in the table in step 9, with `NEW_PASSWORD` set in your shell (PowerShell's way to ask for it is in
[new-store-from-scratch.md § 7](new-store-from-scratch.md#7-create-the-owner-account)):

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml run --rm -T -e NEW_PASSWORD api-nest node dist/cli.js set-password --email owner@rangon.test
```

`scripts/rebuild-local-prod.sh` does all of this, for every account, with `DJANGO_DEMO_SEED_PASSWORD`
from the environment or from `.env.prod.local`, and stops before its teardown if that is missing or
is the README's. The password must pass the API's rules (10+ characters, not common, not all digits).

---

## 6. Start the stack

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d
```

Six containers: `db`, `redis`, `api-nest`, `web`, `nginx`, `mailpit`.

---

## 7. Restart nginx — not optional

`infrastructure/docker/nginx/local-prod/default.conf.template` declares its upstreams as
`server api-nest:3000` and `server web:3000`. **Nginx resolves those names once, at startup, and caches the address for the life
of the process.** Any container created or recreated after nginx therefore has an address nginx does
not know.

The symptom is misleading: `/api/` answers **502** while the storefront still renders, so it reads as
an API fault rather than a proxy one — and `docker exec … getent hosts api-nest` inside the very same
nginx container prints the correct new address.

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml restart nginx
```

**Repeat this every time you recreate `api-nest` or `web` later**, including after the
`--force-recreate` in the Cloudflare runbook.

---

## 8. Verify

```bash
bash scripts/smoke-test.sh http://localhost:4100
```

Seven checks: API liveness and readiness, the storefront, the shop listing endpoint, `sitemap.xml`,
`robots.txt`, and that an admin endpoint refuses an anonymous caller with 401.

Verify from **Windows**, not from inside a container — on Docker Desktop `--network host` joins the
Linux VM, so a `curl` from there proves nothing about whether Windows can reach the service
([.claude/environment.md](../../.claude/environment.md) §3):

```bash
curl.exe -s -o /dev/null -w "%{http_code}\n" http://localhost:4100/
```

---

## 9. What you are looking at

| URL | What |
| --- | --- |
| `http://localhost:4100` | The app — one origin, exactly like the deployed topology |
| `http://localhost:8100` | The API directly, for poking it without going through nginx |
| `http://localhost:${MAILPIT_PORT:-8125}` | Mailpit — where order confirmation emails land |

The demo accounts, all with the password you gave them in step 5:

| Role | Email |
| --- | --- |
| Owner | `owner@rangon.test` |
| Manager | `manager@rangon.test` |
| Cashier | `cashier@rangon.test` |
| Inventory manager | `stock@rangon.test` |
| Accountant | `accounts@rangon.test` |

---

## 9a. Operator commands

Every command below starts with the same words; `C` stands for them:

```bash
C="docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml"
```

`$C run --rm api-nest node dist/cli.js <command>`: the migrations, the roles, an owner, a password,
the store and the two verifications ([operator-commands.md](operator-commands.md)). Django's admin
and API docs, `/django-admin/`, `/api/docs/` and `/api/schema/`, answer 404: they went with Django.
The back office is `/admin`.

---

## 10. Two things that look broken and are not

**`web` reports `unhealthy`, and this one is a real bug.** Next.js standalone `server.js` binds
`process.env.HOSTNAME`, and Docker sets `HOSTNAME` to the container ID, so the server listens only on
the container's own address rather than `0.0.0.0`:

```bash
docker exec rangon-prod-web-1 netstat -ltn | grep 3000
# tcp 0 0 172.20.0.3:3000 0.0.0.0:* LISTEN     <- not 0.0.0.0:3000
```

The app still works, because nginx reaches it as `web:3000` across the bridge — but the image's own
healthcheck can never pass, and `depends_on: service_healthy` on `web` would hang forever. The fix is
one line in `apps/web/Dockerfile`: `ENV HOSTNAME=0.0.0.0`.

**The container names are `rangon-prod-*`, not `rangon-*`.** The project name is `rangon-prod`, so
`docker logs rangon-web-1` finds the development container, or nothing.

---

## 11. When the storefront 504s but the API is fine

A real failure chain worth recognising, because every symptom points at the wrong layer:

```text
curl http://localhost:4100/            -> 504
curl http://localhost:4100/api/health/ -> 200
```

The web app renders its navigation server-side, and that fetch has a 5-second timeout. So:

1. `db` is not running — it was recreated and never started, or it was OOM-killed;
2. the API answers **500** on `/api/v1/shop/navigation/` in about 4.7 s, because it has no database
   (it was Django when this was seen; the chain is the same);
3. the web app's 5 s server-side fetch times out and logs `UPSTREAM_TIMEOUT`;
4. nginx returns **504** for `/`, while `/api/health/` still answers 200 because it touches nothing.

It reads as a web fault and is a database that is not running. Check the container states before the
logs:

```bash
docker ps -a --format "{{.Names}}\t{{.Status}}"
```

A container sitting in `Created` was never started — usually an interrupted `up -d`. A container that
died with exit **137** was OOM-killed; check `docker inspect <name> --format '{{.State.OOMKilled}}'`
to tell the two apart before blaming memory.

---

## 12. Exposing it publicly with Cloudflare

The local production stack is the **only** stack worth tunnelling. The development stack cannot work
through one: it has no nginx, and `NEXT_PUBLIC_API_URL` is baked as `http://localhost:8000/api/v1`, so
every browser call from a public hostname goes to the *visitor's* own localhost.

**Always tunnel 4100.** One origin is the point — cookies, CORS and CSRF then have nothing to argue
about.

Full runbook, including named tunnels on a real domain, DNS, the Windows service and the failure
table: **[cloudflare-local-setup.md](cloudflare-local-setup.md)**. The short version:

### Get `cloudflared`

```bash
winget install --id Cloudflare.cloudflared
```

### Confirm the origin answers before tunnelling to it

A tunnel to nothing is the most common failure. `cloudflared` runs as a *Windows* process, so
`localhost` in its arguments means Windows' localhost — the published Docker port. Never point it at
`web:3000` or `api:8000`; those names resolve only inside the Docker network.

```bash
curl.exe -s -o /dev/null -w "%{http_code}\n" http://localhost:4100/
```

### Quick tunnel — no domain, no account

For a demo, a screenshot, or letting someone on another network click through the shop for an hour.

```bash
cloudflared tunnel --url http://localhost:4100
```

It prints a random `https://<words>.trycloudflare.com` hostname that **dies with the process**.

**Two settings must change or every request answers 400.** `prod.py` refuses unknown hosts and raises
at boot if `DJANGO_ALLOWED_HOSTS` is empty or contains `*`, so there is no shortcut. Put the printed
hostname into `.env.prod.local`:

```text
DJANGO_ALLOWED_HOSTS=<words>.trycloudflare.com,localhost,127.0.0.1,api,web,nginx
DJANGO_CSRF_TRUSTED_ORIGINS=https://<words>.trycloudflare.com
DJANGO_CORS_ALLOWED_ORIGINS=https://<words>.trycloudflare.com
```

Then **recreate** the API containers. `restart` reuses the old container and silently keeps the old
environment, which is how twenty minutes go missing:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --force-recreate api worker beat
```

And because that recreated `api`, restart nginx again (§7):

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml restart nginx
```

### What a quick tunnel will still get wrong

`NEXT_PUBLIC_SITE_URL` is compiled into the JS bundle, so canonical URLs, OG tags and `sitemap.xml`
keep saying `localhost:4100`. Fine for a demo; wrong for anything that will be indexed. Fixing it
means rebuilding the web image against the public hostname — §4 above, and
[cloudflare-local-setup.md §7.1](cloudflare-local-setup.md).

**`NEXT_PUBLIC_SITE_URL` is also the origin writes are accepted from.** Every sign-in, save and sale
must come from this site's own origin ([D101](../roadmap.md#known-defects)): the one compiled in,
or the host the request arrived on. Through the tunnel the second one matches — Nginx passes the
tunnel's `https` and hostname through. On `localhost:4100` only the first can, because Nginx
forwards `Host $host`, which drops the port. So an image built for the tunnel's hostname and then
used at `http://localhost:4100` refuses writes with **403 `CROSS_ORIGIN_REFUSED`** — build it for the
address you use (§4), or browse through the tunnel.

Nginx answers **404** for `/django-admin/`, `/api/docs/` and `/api/schema/` on every address,
public or not: they were Django's, and went with it. It still knows a public host from a local one
(`$via_public_tunnel`), for a guard on `/admin` or `/pos` if you want one.

Before leaving anything exposed for more than an hour, read
[cloudflare-local-setup.md §12](cloudflare-local-setup.md) and
[self-hosting-with-a-domain.md](self-hosting-with-a-domain.md) §1 — a laptop with the lid closed is
a shop that is offline.
