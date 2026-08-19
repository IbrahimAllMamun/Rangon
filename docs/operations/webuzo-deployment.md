# Deploying Rangon on a Webuzo server

> **Status: written, never executed.** Nothing in this project has been deployed anywhere
> ([roadmap.md](../roadmap.md#still-unproven)). This document is a plan derived from the repo's actual
> compose files, Dockerfiles and settings — not a transcript of a working deploy. Expect to correct it
> the first time you run it, and edit this file as you go.
>
> General release procedure, rollback and expand/contract migrations live in
> [deployment.md](deployment.md). This file covers only what is **specific to Webuzo**.

---

## 1. Does your server actually qualify?

Webuzo comes in two very different shapes, and only one can run this stack.

| You have | Can it run Rangon? |
|---|---|
| **Webuzo on your own VPS/dedicated server, with root SSH** | **Yes** — this guide |
| A Webuzo *end-user account* on someone else's server (no root, no SSH) | **No** |

Rangon needs long-running processes (Gunicorn, a Node server, two Celery processes), PostgreSQL 16,
Redis, and the ability to bind local ports. A restricted panel account that only offers PHP, MySQL and
a file manager cannot host it at any price. If you are not sure which you have, log in and check for a
**root** SSH login — no root, no deploy.

**Minimum sizing.** The stack is eight processes plus a database. Budget **4 GB RAM and 2 vCPU** as a
floor, 8 GB if the same box also runs Webuzo's own Apache/MySQL for other sites. The production compose
file alone requests 2 GB for Postgres and 1 GB per API replica.

---

## 2. Fix these three things first — they will break the first deploy

Found by reading the production setup, not by deploying. Each one stops the stack cold.

### 2.1 `${RANGON_DOMAIN}` is never substituted

[`infrastructure/docker/nginx/conf.d/rangon.conf`](../../infrastructure/docker/nginx/conf.d/rangon.conf)
contains `server_name ${RANGON_DOMAIN};` and

```nginx
ssl_certificate /etc/letsencrypt/live/${RANGON_DOMAIN}/fullchain.pem;
```

Nginx does **not** expand environment variables in config files. The official image only runs `envsubst`
on files in `/etc/nginx/templates/*.template`, and compose mounts this straight into `conf.d/`. Nginx
would look for a certificate in a directory literally named `${RANGON_DOMAIN}` and fail to start.

**On Webuzo you avoid this entirely** by not running that container at all — see §3.

### 2.2 `/static/` would 404

The prod compose mounts an `api_static` volume into Nginx read-only, but **nothing ever populates it** —
the `api` service never mounts it. The `location /static/` alias would serve an empty directory.

Harmless here, because the API already ships **WhiteNoise**
(`whitenoise.storage.CompressedManifestStaticFilesStorage`) and serves its own hashed, compressed static
files. Django admin and the DRF browsable API work as long as nothing intercepts `/static/`. Another
reason to drop the container Nginx rather than fix it.

### 2.3 The production compose cannot build images

`docker-compose.prod.yml` sets `build: !reset null` and pulls
`${REGISTRY}/rangon-api:${TAG}`. CI builds and scans images but **does not push them** — no registry is
configured. So you must either push to a registry first, or build on the server (§4.3).

---

## 3. The topology to aim for

Webuzo already owns ports 80 and 443 and already automates Let's Encrypt. Running the project's own
Nginx container as well would mean two proxies fighting for the same ports. The project's own
[deployment.md](deployment.md#reverse-proxy) says exactly what to do:

> If the hosting platform already provides a managed load balancer with TLS, drop the Nginx service and
> record that decision here rather than running two proxies.

So:

```text
Internet
   │  :80 / :443  + Let's Encrypt
   ▼
Webuzo's Nginx (or Apache)            ← the only public web server
   ├── /api/  ──► 127.0.0.1:8001      ← api container (Gunicorn)
   └── /      ──► 127.0.0.1:8080      ← web container (Next.js)
                     │
   docker network (private): db, redis, worker, beat
```

Database and Redis publish **no** ports and stay on the private Docker network.

**Dropping the container Nginx drops what it was doing.** HSTS, CSP, the other security headers and the
rate-limit zones live in that config. §5 reproduces them in the Webuzo vhost. Do not skip it — going
live without them is a security regression, not a simplification.

---

## 4. Steps

### 4.1 Install Docker (Webuzo does not provide it)

Over root SSH, on Debian/Ubuntu:

```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

Webuzo manages its own Apache/Nginx/MySQL; Docker sits alongside and does not interfere, provided the
containers never bind 80/443.

### 4.2 Get the code and write the production env

```bash
mkdir -p /opt/rangon && cd /opt/rangon
git clone https://github.com/IbrahimAllMamun/Rangon.git .
cp .env.example .env
chmod 600 .env
```

Now edit `.env`. These are the values that differ from development, and the ones that cause the most
first-deploy failures:

```bash
DJANGO_SETTINGS_MODULE=config.settings.prod
DJANGO_DEBUG=0
DJANGO_SECRET_KEY=<50+ random chars>          # python -c "import secrets;print(secrets.token_urlsafe(64))"

# prod.py REFUSES to boot if this is empty or contains "*"
DJANGO_ALLOWED_HOSTS=rangonfashion.com,www.rangonfashion.com,api,web
DJANGO_CSRF_TRUSTED_ORIGINS=https://rangonfashion.com,https://www.rangonfashion.com
DJANGO_CORS_ALLOWED_ORIGINS=https://rangonfashion.com,https://www.rangonfashion.com

POSTGRES_PASSWORD=<strong random>
DATABASE_URL=postgresql://rangon:<same password>@db:5432/rangon

# Browser-visible. Baked into the JS bundle at BUILD time — see 4.3.
NEXT_PUBLIC_API_URL=https://rangonfashion.com/api/v1
NEXT_PUBLIC_SITE_URL=https://rangonfashion.com
# Server-side, inside the Docker network. Stays http and internal.
API_INTERNAL_URL=http://api:8000/api/v1

USE_S3=0                                       # or configure real S3 credentials
EMAIL_HOST=<your SMTP host>                    # Mailpit is development-only
EMAIL_PORT=587
EMAIL_USE_TLS=1
```

> **`WEB_PORT=4000` in the example file is a Windows workaround** for the development machine and is
> irrelevant here. The dev overlay is not used in production.

### 4.3 Build the images on the server

CI does not push images, so build locally on the box. **The `NEXT_PUBLIC_*` values are compiled into the
browser bundle at build time** (see `apps/web/Dockerfile` — they are `ARG`s). Build with the real domain
or the shipped JavaScript will call `localhost`:

```bash
cd /opt/rangon
docker compose build api
docker compose build web \
  --build-arg NEXT_PUBLIC_API_URL=https://rangonfashion.com/api/v1 \
  --build-arg NEXT_PUBLIC_SITE_URL=https://rangonfashion.com
```

The web build needs roughly 2 GB of free RAM. If it is OOM-killed, add swap or build elsewhere and
`docker save` / `docker load` the image across.

### 4.4 Create a Webuzo-specific compose overlay

Create `/opt/rangon/docker-compose.webuzo.yml`. This drops the Nginx service, binds the two app
containers to **localhost only**, and keeps the data services private:

```yaml
# Webuzo overlay: Webuzo's own web server is the public edge, so the project's
# Nginx container is not used (docs/operations/deployment.md, "Reverse proxy").
# Ports bind to 127.0.0.1 so nothing is reachable except through Webuzo.
services:
  api:
    environment:
      DJANGO_SETTINGS_MODULE: config.settings.prod
      DJANGO_DEBUG: "0"
    ports:
      - "127.0.0.1:8001:8000"
    restart: unless-stopped

  web:
    environment:
      NODE_ENV: production
    ports:
      - "127.0.0.1:8080:3000"
    restart: unless-stopped

  worker:
    environment:
      DJANGO_SETTINGS_MODULE: config.settings.prod
    restart: unless-stopped

  beat:
    environment:
      DJANGO_SETTINGS_MODULE: config.settings.prod
    restart: unless-stopped

  db:
    volumes:
      - /var/lib/rangon/postgres:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    volumes:
      - /var/lib/rangon/redis:/data
    restart: unless-stopped
```

Note this deliberately extends the **base** `docker-compose.yml`, not `docker-compose.prod.yml` — the
latter demands a registry and a `TAG`, which you do not have. You lose the prod overlay's hardening
(`read_only`, `cap_drop`, replica counts). Copy those blocks across once the stack is up and you have a
baseline that works; do not do both at once, or you will not know which change broke it.

### 4.5 Start the stack and migrate

```bash
cd /opt/rangon
mkdir -p /var/lib/rangon/postgres /var/lib/rangon/redis

docker compose -f docker-compose.yml -f docker-compose.webuzo.yml up -d db redis
sleep 10
docker compose -f docker-compose.yml -f docker-compose.webuzo.yml run --rm api python manage.py migrate
docker compose -f docker-compose.yml -f docker-compose.webuzo.yml up -d

docker compose -f docker-compose.yml -f docker-compose.webuzo.yml ps
```

Create the first real user (**do not** run `seed_demo` on a production database — it wipes and reseeds):

```bash
docker compose -f docker-compose.yml -f docker-compose.webuzo.yml exec api python manage.py createsuperuser
```

Confirm both services answer locally before touching the web server:

```bash
curl -s -o /dev/null -w "api %{http_code}\n" http://127.0.0.1:8001/api/health/
curl -s -o /dev/null -w "web %{http_code}\n" http://127.0.0.1:8080/
```

### 4.6 Point the domain at the server

In the Webuzo panel: add the domain, then issue a **Let's Encrypt** certificate for it. Confirm
`https://rangonfashion.com` serves Webuzo's default page over a valid certificate **before** adding the
proxy rules — debugging TLS and proxying at the same time wastes an afternoon.

---

## 5. The Webuzo vhost configuration

Add this as custom Nginx configuration for the domain in the Webuzo panel (Webuzo writes its own vhost
files; use its custom-config field rather than hand-editing files it will regenerate). This replaces the
container Nginx, including the security headers and rate limits that came with it.

```nginx
# Rate-limit zones — must sit in the http{} context. Webuzo may require these in
# its global nginx.conf rather than the vhost; if the config test rejects them
# here, move just these two lines.
limit_req_zone $binary_remote_addr zone=rangon_general:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=rangon_auth:10m    rate=1r/s;
```

```nginx
# --- inside the HTTPS server block for rangonfashion.com -------------------

client_max_body_size 12m;              # product image uploads; the API caps at 10 MB

add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header X-Content-Type-Options    "nosniff" always;
add_header X-Frame-Options           "DENY" always;
add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
add_header Permissions-Policy        "camera=(), microphone=(), geolocation=(), payment=()" always;
# 'unsafe-inline' for styles is required by Next.js's inlined critical CSS.
add_header Content-Security-Policy   "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;

# These four headers are not optional. Django's prod settings set
# SECURE_SSL_REDIRECT=True and trust X-Forwarded-Proto; if Webuzo proxies over
# plain http without setting it, Django sees an insecure request and redirects
# to https forever — an infinite loop that looks like "the site is down".
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

location /api/ {
    limit_req zone=rangon_general burst=60 nodelay;
    proxy_pass http://127.0.0.1:8001;
    proxy_read_timeout 60s;
}

location ~ ^/api/v1/auth/(login|register|password) {
    limit_req zone=rangon_auth burst=5 nodelay;
    proxy_pass http://127.0.0.1:8001;
}

location /django-admin/ {
    # Restrict to the office network before go-live.
    # allow 203.0.113.0/24; deny all;
    proxy_pass http://127.0.0.1:8001;
}

# Django serves /static/ itself via WhiteNoise (hashed + compressed).
location /static/ {
    proxy_pass http://127.0.0.1:8001;
    expires 30d;
    access_log off;
    add_header Cache-Control "public, immutable";
}

location /_next/static/ {
    proxy_pass http://127.0.0.1:8080;
    expires 365d;
    access_log off;
    add_header Cache-Control "public, immutable";
}

location / {
    limit_req zone=rangon_general burst=60 nodelay;
    proxy_pass http://127.0.0.1:8080;
    proxy_read_timeout 30s;
}
```

**If Webuzo is running Apache instead of Nginx**, the equivalent is `ProxyPass` / `ProxyPassReverse` to
the same two ports, plus `RequestHeader set X-Forwarded-Proto "https"` — that header is what stops the
redirect loop described above. `Header always set` gives you the security headers.

Reload the web server from the panel, then:

```bash
curl -sI https://rangonfashion.com | head -20
curl -s https://rangonfashion.com/api/health/
```

---

## 6. Verify before you call it live

```bash
cd /opt/rangon
./scripts/smoke-test.sh https://rangonfashion.com          # base URL is a positional argument
docker compose -f docker-compose.yml -f docker-compose.webuzo.yml exec api \
  python manage.py verify_inventory
```

Then by hand, because none of it has ever been done on a server:

- [ ] Storefront home, shop, a product page, cart, checkout all load over HTTPS
- [ ] `/admin` and `/pos` redirect to `/login` when signed out, and work when signed in
- [ ] A test order completes end to end, then **cancel it** so it does not pollute real figures
- [ ] `verify_inventory` still reports the ledger consistent afterwards
- [ ] Celery: `docker compose ... logs worker beat --tail 50` shows no crash loop
- [ ] Email actually sends (order confirmation), through the real SMTP host
- [ ] HSTS/CSP present: `curl -sI https://rangonfashion.com | grep -i strict-transport`
- [ ] `https://rangonfashion.com/api/docs/` is reachable — then decide whether it should be public
- [ ] The nine `DECISION REQUIRED` business rules are settled — **especially VAT**, which rewrites every
      historical total if changed later ([business-rules.md](../business-rules.md))

---

## 7. Backups — do this on day one, not later

`/var/lib/rangon/postgres` holds the only copy of every order, payment and ledger row.

### Where `backup-db.sh` can actually run — this was tested

`scripts/backup-db.sh` calls `pg_dump` against host `db`, which only resolves **inside** the Docker
network. That rules out running it from the Webuzo host unless you publish the database port, which the
overlay in §4.4 deliberately does not do. So it has to run in a container — and only one of them works:

| Runs in | `pg_dump` | Result |
|---|---|---|
| `api` container | 15.19 (Debian bookworm) | **Fails** — `aborting because of server version mismatch` |
| `db` container | 16.15 | **Works** — verified, produced a 398 KB dump |

`pg_dump` refuses to read a server newer than itself, and the API image ships the older client. Run
backups from the **db** container, which has both `pg_dump` 16 and `bash`:

```bash
# In Webuzo's cron manager, or the system crontab. Adjust the path to .env.
0 2 * * * cd /opt/rangon && /usr/bin/docker compose -f docker-compose.yml -f docker-compose.webuzo.yml \
  exec -T -e RANGON_ENV=prod -e BACKUP_DIR=/backups db bash /scripts/backup-db.sh scheduled \
  >> /var/log/rangon-backup.log 2>&1
```

That command needs two mounts added to the `db` service in your overlay, so the script and the output
directory exist inside the container:

```yaml
  db:
    volumes:
      - /var/lib/rangon/postgres:/var/lib/postgresql/data
      - ./scripts:/scripts:ro
      - /var/backups/rangon:/backups
```

`PGPASSWORD` is picked up from `POSTGRES_PASSWORD`, which the compose env already provides to `db`.

If you would rather not mount the repo into the database container, the equivalent without the script —
losing its size check, `pg_restore --list` verification, off-site upload and pruning — is:

```bash
docker compose -f docker-compose.yml -f docker-compose.webuzo.yml exec -T db \
  pg_dump -U rangon -d rangon --format=custom --compress=6 --no-owner --no-privileges \
  > /var/backups/rangon/rangon-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Set `BACKUP_S3_BUCKET` to get off-site copies; without it the script warns that the backup exists only
on the same disk as the database it is protecting. Read [backups.md](backups.md) for retention and
[disaster-recovery.md](disaster-recovery.md) for the restore drill.

**Rehearse a restore into a scratch database before go-live.** The scripts exist and have never been run
end to end; a backup nobody has restored is not a backup
([roadmap.md](../roadmap.md#still-unproven)).

---

## 8. Updating a running deployment

```bash
cd /opt/rangon
./scripts/backup-db.sh                                    # always first
git pull
docker compose build api
docker compose build web \
  --build-arg NEXT_PUBLIC_API_URL=https://rangonfashion.com/api/v1 \
  --build-arg NEXT_PUBLIC_SITE_URL=https://rangonfashion.com
docker compose -f docker-compose.yml -f docker-compose.webuzo.yml \
  run --rm api python manage.py migrate
docker compose -f docker-compose.yml -f docker-compose.webuzo.yml up -d
```

Migrations run as a **separate step**, never as a container start hook — otherwise every replica races
to migrate the same database. Rollback and expand/contract rules: [deployment.md](deployment.md).

---

## 9. Webuzo-specific gotchas

| Symptom | Cause |
|---|---|
| Redirect loop, or "too many redirects" | `X-Forwarded-Proto` not set by the proxy. Django's prod settings force HTTPS and trust that header |
| CSS/JS 404 on the storefront | `/_next/static/` not proxied to the web container |
| Django admin unstyled | `/static/` not reaching the API container (WhiteNoise serves it from there) |
| Browser calls `localhost:8000` | `NEXT_PUBLIC_API_URL` was wrong **at image build time**; rebuild the web image with the right build arg |
| `docker compose up` fails on port 80 | You left the `nginx` service in; the Webuzo overlay must exclude it |
| API refuses to start | `DJANGO_ALLOWED_HOSTS` empty or contains `*` — `prod.py` raises deliberately |
| Panel unreachable after firewall changes | Webuzo's own ports (commonly 2002–2005) must stay open; confirm in your panel before locking the firewall down |
| Stack dies overnight | OOM. Check `docker compose ps` and `dmesg | grep -i kill`; 4 GB is a floor, not a target |

---

## 10. What this document does not cover

- **A real payment gateway.** COD only today; the card option is deliberately disabled in the UI.
- **Object storage.** `USE_S3=0` stores uploads on the container filesystem, which does not survive a
  rebuild. Configure S3-compatible storage before customers upload anything you care about.
- **Multi-server or HA.** One box, one database. The prod overlay's `replicas` are for a single host.
- **Anything verified.** No part of this has been executed against a Webuzo server.
