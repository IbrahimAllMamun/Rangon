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
- `npm run build` through the bind mount is far worse and never completed.
  `docker compose build web` (production image, copies source in) is the faster
  path and is what CI does.
- The Dockerfiles deliberately have **no `# syntax=docker/dockerfile:1.7`
  directive**. Nothing needed a newer frontend, and fetching one added a network
  dependency that crashed BuildKit (`failed to solve: frontend grpc server
  closed unexpectedly`). Do not add it back.

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
docker compose build web                                          # prod build

# Verify from Windows, not from a container
curl.exe -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/

# Hit the API through the same proxy the browser uses (put the script in
# apps/web/, which is bind-mounted to /app)
MSYS_NO_PATHCONV=1 docker exec rangon-web-1 sh /app/yourscript.sh
```

Config changes (ports, env) need `--force-recreate`; `restart` reuses the old
container and silently keeps the old settings. That is how a stale container ran
for 20 minutes with no published port.
