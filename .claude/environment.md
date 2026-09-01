# This machine will lie to you — read this first

Windows 11 + Docker Desktop + Git Bash. Every item below cost real time in the
session that produced this file. None are hypothetical.

---

## 1. The home directory is a git repository

`C:\Users\ibrahimAllMamun` is itself a git repo (one commit, "first commit").

**Before any git command**, confirm which repo you are in:

```bash
git rev-parse --show-toplevel
```

It must print `C:/Users/ibrahimAllMamun/Desktop/Rangon`. If it prints the home
directory, `git add -A` would stage the user's entire home folder — documents,
downloads, credentials. `Desktop/Rangon` has its own `.git`, so you are safe
*inside* it, but never run git from a parent directory.

---

## 2. Port 3000 cannot be bound — the storefront is on 4000

Windows reserves wide TCP ranges for Hyper-V/WinNAT. On this machine:

```text
2906-3005   3006-3105   3106-3205   3206-3305   3306-3405   3406-3505
50000-50059
```

So 3000, 3001 and 3100 all fail with:

```text
bind: An attempt was made to access a socket in a way forbidden by its access permissions
```

Nothing is listening; the OS simply refuses. Check the current ranges with:

```bash
netsh.exe interface ipv4 show excludedportrange protocol=tcp
```

`.env` therefore sets `WEB_PORT=4000`, with `NEXT_PUBLIC_SITE_URL`,
`DJANGO_CORS_ALLOWED_ORIGINS` and `DJANGO_CSRF_TRUSTED_ORIGINS` moved to the
same origin. **Keep those four in step** or the cart and checkout break on CORS.
`docker-compose.dev.yml` publishes `${WEB_PORT:-3000}`, so Linux/macOS/CI are
unaffected.

`.env` is gitignored — a new machine must set this itself.

Reclaiming 3000 needs an elevated `net stop winnat && net start winnat`, which
drops every other Docker port mapping while it restarts. Not done; ask first.

---

## 3. `docker run --network host` is NOT the Windows host

On Docker Desktop it joins the **Linux VM's** network namespace. A curl from
there proves nothing about whether Windows can reach the service. This is
exactly what made "I verified host access" wrong once already.

To test from Windows, use the built-in `curl.exe` from Git Bash:

```bash
curl.exe -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/
netstat.exe -ano | grep -E "[:.]4000\s+.*LISTENING"
```

And trust `docker port <container>` over `docker ps` for what is actually
published:

```bash
docker port rangon-web-1      # empty output = NOT reachable from Windows
```

---

## 4. MSYS mangles paths passed to containers

Git Bash rewrites leading-slash arguments into Windows paths, so
`docker exec … sh /app/script.sh` becomes `sh 'C:/Program Files/Git/app/...'`.

```bash
MSYS_NO_PATHCONV=1 docker exec rangon-web-1 sh /app/script.sh
```

Same for `docker compose run` with absolute in-container paths.

---

## 5. Reading logs and command output

- **`docker logs --since` needs RFC3339 with the `Z`.** `--since 2026-08-18T07:00:00`
  is silently ignored and replays the entire buffer, so old errors look current.
  Prefer `--tail N`.
- **Docker keeps logs across `restart`.** A restart does not clear history —
  after fixing something, `--tail` the end rather than counting matches.
- **PowerShell `| Select-Object -Last N` buffers the whole stream**, so a
  long-running build writes nothing to its output file until it exits. Redirect
  to a file and `tail` it instead.
- A `> nul` redirect on Windows creates a file literally named `nul` in the
  working directory, which then breaks `git add`. It is gitignored now.

---

## 6. Builds are slow; prefer containers over the host

- Host `node`/`npm` were intermittently unavailable in this session. Do
  everything through the containers.
- `tsc --noEmit` through the bind mount takes **~10 minutes**.
- `npm run build` through the bind mount is far worse and has still never been
  allowed to finish. Do not use it to check whether the build works.
  `docker compose build web` (production image, copies source in) is the faster
  path, is what CI does, and **does** complete here — about 6 minutes with warm
  layers, most of it `npm ci`. The build itself is fine; only the bind mount is
  pathological.
- The Dockerfiles deliberately have **no `# syntax=docker/dockerfile:1.7`
  directive**. Nothing needed a newer frontend, and fetching one added a network
  dependency that crashed BuildKit (`failed to solve: frontend grpc server
  closed unexpectedly`). Do not add it back.

---

## 7. `node_modules` is an anonymous volume — it outlives image rebuilds

`docker-compose.dev.yml` mounts `/app/node_modules` as an anonymous volume so
the bind mount does not hide the image's install. The cost: that volume is
populated **once**, when the container is first created, and then shadows the
image forever.

This bit hard. `package.json` and `package-lock.json` pinned Next **15.5.23**,
the image contained 15.5.23, CI built 15.5.23 — and the running container served
**15.1.4**, because its volume had been created before the upgrade. Two image
rebuilds changed nothing. Every "works on my machine" reading was against a
different Next than CI.

Check whenever dependency behaviour looks wrong:

```bash
# what the container actually runs vs. what the image ships
MSYS_NO_PATHCONV=1 docker exec rangon-web-1 node -p "require('/app/node_modules/next/package.json').version"
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint node rangon-web:latest -p "require('/app/node_modules/next/package.json').version"
```

If they disagree, the volume is stale. Recreate it:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --force-recreate --renew-anon-volumes web
```

`--renew-anon-volumes` is the flag that matters; `--force-recreate` alone keeps
the old volume. A plain `docker compose down` (without `-v`) also leaves it.

---

## 8. Both web images are called `rangon-web:latest`

Neither compose file sets an `image:` key for `web`, so Compose derives the name
from project + service. That means:

```bash
docker compose build web                                    # production Dockerfile
docker compose -f docker-compose.yml -f docker-compose.dev.yml build web   # Dockerfile.dev
```

both write **the same tag**, and the second silently replaces the first. The
production runtime deliberately deletes npm (so Trivy stops flagging npm's own
vendored dependencies), so if the tag is left pointing at the production image, a
later `up -d` *without* `--build` starts it with the dev command `npm run dev`
and fails.

**After building the production image, rebuild the dev one before starting the
stack.** A running container keeps the image it started with, so an already-up
stack is unaffected until it is recreated.

---

## 9. Playwright cannot run in the web container

`apps/web/Dockerfile.dev` is `node:22-alpine`. Playwright publishes no musl
browser builds, and `~/.cache/ms-playwright` does not exist in the image, so
`npm run test:e2e` has nothing to drive. `npx playwright install` will not fix
it.

To actually run the E2E specs, use a glibc image (`mcr.microsoft.com/playwright`)
on the same Docker network, or run them from the Windows host, pointing
`E2E_BASE_URL` at the real storefront origin (`http://localhost:4000` here, not
the config default of 3000).

---

## 10. There is no `gh` CLI on this machine

`gh` is not installed, but `origin` is a **public** GitHub repo, so the REST API
answers unauthenticated:

```bash
curl.exe -s "https://api.github.com/repos/IbrahimAllMamun/Rangon/actions/runs?per_page=10"
curl.exe -s "https://api.github.com/repos/IbrahimAllMamun/Rangon/actions/runs/<id>/jobs"
```

That is how the CI status in `../docs/roadmap.md` was checked. Downloading run
**logs** does need a token; job and step conclusions do not.

---

## Commands that actually work here

```bash
# Full stack
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --force-recreate web api

# Backend (fast, reliable)
MSYS_NO_PATHCONV=1 docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  run --rm -T -e DJANGO_SETTINGS_MODULE=config.settings.test api pytest -q
docker compose exec api python manage.py migrate
docker compose exec api python manage.py seed_demo --reset
docker compose exec api python manage.py verify_inventory
docker compose exec api ruff check . && docker compose exec api ruff format .

# Frontend
MSYS_NO_PATHCONV=1 docker exec rangon-web-1 npx tsc --noEmit      # ~10 min
MSYS_NO_PATHCONV=1 docker exec rangon-web-1 npx vitest run        # ~25 s, 17 tests
docker compose build web                                          # prod build (~6 min warm)
# then put the dev image back on the shared tag — see §7
docker compose -f docker-compose.yml -f docker-compose.dev.yml build web

# Verify from Windows, not from a container
curl.exe -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/

# Hit the API through the same proxy the browser uses (put the script in
# apps/web/, which is bind-mounted to /app)
MSYS_NO_PATHCONV=1 docker exec rangon-web-1 sh /app/yourscript.sh
```

Config changes (ports, env) need `--force-recreate`; `restart` reuses the old
container and silently keeps the old settings. That is how a stale container ran
for 20 minutes with no published port.

---

## 8. The stack runs without Docker — and that is how it was verified

Added 2026-08-28, after "Docker is unavailable, so this cannot be verified" was
repeated through four working sessions and cost five admin screens their
sign-in verification. Docker is how the README *documents* running the stack;
it is not what running it requires.

A Linux box with PostgreSQL, Redis, Python and Node runs the whole thing:

```bash
pg_ctl -D <data-dir> -o '-p 5432 -k /tmp' start
redis-server --daemonize yes --port 6379 --save ''      # NOT optional, see below

cd apps/api
DATABASE_URL=postgresql://rangon:rangon@127.0.0.1:5432/rangon \
DJANGO_SECRET_KEY=<anything> DJANGO_DEBUG=1 \
python manage.py migrate && python manage.py seed_demo --reset
... runserver 8000 --noreload

cd apps/web
API_INTERNAL_URL=http://127.0.0.1:8000/api/v1 npx next dev --port 4000
```

Three traps, all of which cost time:

1. **Redis is not optional.** The auth throttle is Redis-backed, so with no
   Redis `POST /api/v1/auth/login/` returns **500**, not a throttling error —
   and the login page shows only "An unexpected error occurred". Nothing points
   at Redis. `redis-cli ping` first.

2. **`API_INTERNAL_URL` is the variable that matters**, not
   `NEXT_PUBLIC_API_URL`. It defaults to `http://api:8000/api/v1` — the compose
   service hostname — which does not resolve outside compose, so every
   server-side fetch fails while the pages still render.

3. **`--noreload` means new URLs do not appear.** The API is started with
   `--noreload` (deliberately — the autoreloader is flaky under this sandbox).
   Adding a route to `config/api_urls.py` therefore changes nothing until the
   server is restarted, and the symptom is not a visible 404: the admin page
   catches the failed fetch and renders its error state, so a brand-new
   endpoint looks like a screen that loads with no data. Check
   `/tmp/rangon-native/api.log` for `Not Found:` before suspecting the UI.
   Restart the API **on its own** — `dev-stack-native.sh up` reseeds with
   `--reset` and will destroy whatever you were testing against:

   ```bash
   pkill -f "manage.py runserver 8000"
   cd apps/api && DATABASE_URL=... DJANGO_SECRET_KEY=... DJANGO_DEBUG=1 \
     DJANGO_ALLOWED_HOSTS='*' python manage.py runserver 8000 --noreload
   ```

   Backgrounding it with `nohup ... &` from a tool call does **not** survive;
   the process needs to be started as a genuinely detached background command.

For a browser pass, this environment ships Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. `playwright.config.ts`
already honours `PW_CHROMIUM_PATH` for exactly this. **D7 does not mean
"Playwright cannot run here"** — it means the *dev container's* Alpine base
ships no musl browser.
