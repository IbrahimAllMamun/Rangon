# Setting up Cloudflare against a locally running Rangon

> Companion to [self-hosting-with-a-domain.md](self-hosting-with-a-domain.md), which decides *whether*
> you should self-host at all and covers the whole picture. **This file is only the Cloudflare half**,
> written as a runbook: exact commands, in order, with the failures you will actually hit.
>
> Everything in §6 was read off this machine on 2026-08-27, not imagined.

---

## 1. What a tunnel does, and what it does not

```text
shopper ──HTTPS──> Cloudflare edge ──┐
                                     │  outbound, already-open connection
                                     ▼
                              cloudflared.exe  (a Windows process, on your machine)
                                     │  plain HTTP
                                     ▼
                              nginx :4100  (Docker) ──> web :3000 / api :8000
```

- **No inbound port is opened.** `cloudflared` dials *out* to Cloudflare and traffic comes back down
  that connection, which is why this works behind CGNAT and behind a router you do not control.
- **TLS ends at Cloudflare**, not at your machine. Your origin speaks plain HTTP on `localhost:4100`.
  That single fact causes half of §10.
- **Your home IP is never published.** The public DNS record is a CNAME to `<uuid>.cfargotunnel.com`.
- It does **not** make a laptop a server. Lid closed, Windows Update, power cut — shop offline. Read
  §1 of [self-hosting-with-a-domain.md](self-hosting-with-a-domain.md) before pointing a real domain
  at this.

---

## 2. Decide which stack you are exposing

| Stack | Origin to tunnel | Works through a tunnel? |
|---|---|---|
| **Local production** (`docker-compose.prodlocal.yml`) | `http://localhost:4100` | **Yes.** Nginx fronts everything on one origin, exactly like a deployment |
| Development (`docker-compose.dev.yml`) | `http://localhost:4000` | **No — pages render, nothing works.** There is no nginx in the dev overlay, and `NEXT_PUBLIC_API_URL` is baked as `http://localhost:8000/api/v1`, so every browser call from a public hostname goes to the *visitor's* localhost. Mixed-content blocking on top of that |

**Always tunnel port 4100.** One origin is the whole point: the storefront, `/admin`, `/pos`, Django's
`/api/v1/` and Next's `/api/proxy/` all arrive on the same hostname, so cookies, CORS and CSRF have
nothing to argue about.

Bring that stack up first — a tunnel to nothing is §10's first row:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d
```

Then prove the origin is reachable **from Windows**, not from a container
([.claude/environment.md](../../.claude/environment.md) §3):

```bash
curl.exe -s -o /dev/null -w "%{http_code}\n" http://localhost:4100/
```

`200` before you go any further. `cloudflared` is a Windows process, so `localhost` in its config means
*Windows'* localhost — the published Docker port. Never point it at `web:3000` or `api:8000`; those
names resolve only inside the Docker network.

---

## 3. Get `cloudflared`

Already present here as `~/tools/cloudflared.exe` (version **2026.8.2**). On a fresh machine:

```bash
winget install --id Cloudflare.cloudflared
```

or download `cloudflared-windows-amd64.exe` from Cloudflare's releases and rename it. Check it runs:

```bash
~/tools/cloudflared.exe --version
```

---

## 4. Route A — quick tunnel (no domain, no account, ~1 minute)

For a demo, a screenshot, or letting someone on another network click through the shop for an hour.

```bash
~/tools/cloudflared.exe tunnel --url http://localhost:4100
```

It prints a random hostname:

```text
+---------------------------------------------------------------+
|  https://oddly-chosen-words-here.trycloudflare.com             |
+---------------------------------------------------------------+
```

**Two things must change or the app answers 400 on every request.** Django's production settings refuse
unknown hosts — `prod.py` raises at boot if `DJANGO_ALLOWED_HOSTS` is empty or contains `*`, so there
is no shortcut. Add the hostname to `.env.prod.local`:

```bash
DJANGO_ALLOWED_HOSTS=oddly-chosen-words-here.trycloudflare.com,localhost,127.0.0.1,api,web,nginx
DJANGO_CSRF_TRUSTED_ORIGINS=https://oddly-chosen-words-here.trycloudflare.com
DJANGO_CORS_ALLOWED_ORIGINS=https://oddly-chosen-words-here.trycloudflare.com
```

Then recreate the API containers — `restart` reuses the old container and silently keeps the old
environment:

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --force-recreate api worker beat
```

Know what you are getting:

- The hostname **dies with the process**, and you get a different one next time. Every step above has
  to be repeated.
- `NEXT_PUBLIC_SITE_URL` is compiled into the JS bundle (§7.1), so canonical URLs, OG tags and
  `sitemap.xml` will still say `localhost`. Fine for a demo, wrong for anything indexed.
- Nginx's `$via_public_tunnel` map already treats any `*.trycloudflare.com` host as public and returns
  403 for `/django-admin/`. That is deliberate.

---

## 5. Route B — named tunnel on your own domain

Stable hostname, survives reboots, runs as a Windows service. The domain's nameservers must already
point at Cloudflare (**Add a site** → set the two nameservers at your registrar → wait for *Active*).
That part involves your registrar account and payment details — do it yourself.

### 5.1 Authenticate

```bash
cd ~/tools && ./cloudflared.exe tunnel login
```

Opens a browser; pick the domain. Writes `~/.cloudflared/cert.pem`.

### 5.2 Create the tunnel

```bash
./cloudflared.exe tunnel create rangon
```

Prints a UUID and writes `~/.cloudflared/<UUID>.json` — **that file is the tunnel's credential.** It
lives outside the repo and must stay there. Never commit it, never paste it into an issue.

### 5.3 Point hostnames at it

```bash
./cloudflared.exe tunnel route dns rangon rangonfashion.com
```

**Expect the first attempt to fail:**

```text
Failed to add route: code: 1003, reason: Failed to create record rangonfashion.com
with err An A, AAAA, or CNAME record with that host already exists.
```

Cloudflare imports the domain's existing records when you add the site — usually a parking A record on
the apex and a `www` CNAME — and `cloudflared` will not overwrite them. Delete them under
**DNS → Records**, or say so explicitly:

```bash
./cloudflared.exe tunnel route dns --overwrite-dns rangon rangonfashion.com
```

```bash
./cloudflared.exe tunnel route dns --overwrite-dns rangon www.rangonfashion.com
```

Each becomes a proxied `CNAME → <UUID>.cfargotunnel.com`. Pass the hostname **bare** — pasting a
markdown link such as `[www.example.com](https://www.example.com)` makes `cloudflared` treat the entire
string as the hostname, and the error that follows does not say so.

### 5.4 Write `~/.cloudflared/config.yml`

```yaml
tunnel: rangon
credentials-file: C:\Users\ibrahimAllMamun\.cloudflared\<UUID>.json

# Be patient with the origin: a cold Next.js route or a slow report can take a
# few seconds, and the default would surface that to a shopper as a 502.
originRequest:
  connectTimeout: 30s
  noTLSVerify: false

ingress:
  - hostname: rangonfashion.com
    service: http://localhost:4100
  - hostname: www.rangonfashion.com
    service: http://localhost:4100
  # Every ingress list must end with a catch-all or cloudflared refuses to start.
  - service: http_status:404
```

Get `<UUID>` from `cloudflared tunnel list`. Validate before running:

```bash
./cloudflared.exe tunnel ingress validate
```

```bash
./cloudflared.exe tunnel ingress rule https://rangonfashion.com/pos
```

### 5.5 Run it, then install it

```bash
./cloudflared.exe tunnel run rangon
```

Watch the connections register, `Ctrl-C`, then from an **administrator** terminal:

```bash
./cloudflared.exe service install
```

That is what makes the tunnel survive a reboot. The Docker containers use `restart: unless-stopped` and
come back too — but only after **someone logs in**. A machine sitting at the lock screen after a
Windows Update reboot is a machine serving nothing.

---

## 6. What is already set up on this machine

Read on 2026-08-27:

| Thing | State |
|---|---|
| Binary | `~/tools/cloudflared.exe`, version 2026.8.2 |
| Tunnel | `rangon` — created 2026-08-19, **4 live edge connections** (dac13 ×2, sin07, sin14) |
| Credentials | `~/.cloudflared/<UUID>.json` + `cert.pem` — outside the repo, correctly |
| Config | `~/.cloudflared/config.yml` → both hostnames to `http://localhost:4100` |
| Windows service | `cloudflared` — **Running**, StartType **Automatic** |
| The origin | **Down.** No containers running, nothing listening on 4100 |

So the tunnel is up and the app behind it is not: `rangonfashion.com` currently answers with
Cloudflare's error page, not with Rangon. Nothing is broken — bring the stack up (§2) and it starts
serving without touching Cloudflare at all. That asymmetry is worth remembering: **a healthy tunnel
tells you nothing about whether the shop works.**

---

## 7. Teach the app its public hostname

### 7.1 Rebuild the web image — this step is not optional

`NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_API_URL` are `ARG`s in `apps/web/Dockerfile`, compiled into the
JavaScript bundle at **build** time. An image built for `localhost` emits `localhost` canonical URLs,
OG tags and sitemap entries no matter what environment variables you set at run time. Verified here.

```bash
docker build -t rangon-web:prod -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://rangonfashion.com/api/v1 --build-arg NEXT_PUBLIC_SITE_URL=https://rangonfashion.com apps/web
```

About 6 minutes with warm layers, and roughly 2 GB of RAM.

### 7.2 Set the three host variables

In `.env.prod.local` (gitignored):

```bash
DJANGO_ALLOWED_HOSTS=rangonfashion.com,www.rangonfashion.com,localhost,127.0.0.1,api,web,nginx
DJANGO_CSRF_TRUSTED_ORIGINS=https://rangonfashion.com,https://www.rangonfashion.com
DJANGO_CORS_ALLOWED_ORIGINS=https://rangonfashion.com,https://www.rangonfashion.com
```

Keep all three in step. Adding a hostname to only the first gets you a page that renders and a login
that fails CSRF.

```bash
docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml up -d --force-recreate
```

### 7.3 Do not fight over the HTTPS redirect

`docker-compose.prodlocal.yml` hardcodes `DJANGO_SECURE_SSL_REDIRECT: "0"` on `api`, `worker` and
`beat`, and a compose `environment:` entry beats anything supplied through `--env-file`. **Setting
`DJANGO_SECURE_SSL_REDIRECT=1` in `.env.prod.local` therefore does nothing to this stack** — which is
correct, because that same stack has to keep working over plain `http://localhost:4100`.

Force HTTPS at the edge instead, where the visitor actually is:

- **SSL/TLS → Overview → Full** — not *Flexible*, and not *Full (strict)*: your origin has no
  certificate of its own.
- **SSL/TLS → Edge Certificates → Always Use HTTPS → On.**

Django still learns the real scheme: `prod.py` sets
`SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` and nginx passes the tunnel's value
through (§8), so `request.is_secure()` is true and secure cookies are set.

---

## 8. What nginx already handles

`infrastructure/docker/nginx/local-prod/default.conf` was written against a live tunnel. Three parts of
it exist because of Cloudflare — leave them alone.

**Scheme, without the redirect loop.** Cloudflare forwards HTTP, so `$scheme` is `http`. Blindly
setting `X-Forwarded-Proto $scheme` tells Django every request is insecure; with `SECURE_SSL_REDIRECT`
on anywhere, that is an infinite redirect and the site looks completely down:

```nginx
map $http_x_forwarded_proto $client_proto {
    default        $scheme;
    "~^https?$"    $http_x_forwarded_proto;
}
```

Note the trap underneath it: nginx inherits `proxy_set_header` from `http{}` **only if the current
level declares none.** Overriding one means restating them all, or `Host` and `X-Real-IP` vanish
silently.

**Keeping the Django admin off the internet.** Everything arrives through Docker's NAT, so the source
IP is the bridge gateway whether the request came from this laptop, the LAN or the public tunnel —
**IP rules cannot tell them apart.** An `allow 172.16.0.0/12` intended to permit the LAN silently
permitted the whole internet, because tunnel traffic arrives on exactly that range. The Host header can
tell them apart:

```nginx
map $host $via_public_tunnel {
    default                          0;
    "~^(www\.)?rangonfashion\.com$"  1;
    "~\.trycloudflare\.com$"         1;
}
```

Change the domain pattern to yours. Consider extending the same guard to `/admin` and `/pos` if the
shop only ever uses them on-site.

**`/api/` is not all Django.** `/api/proxy/*` and `/api/auth/*` are Next.js route handlers; routing all
of `/api/` to Django leaves pages rendering while sign-in, cart, checkout, POS sales and every admin
action return 404 ([D17](../roadmap.md#known-defects)). Both prefixes are already carved out. Do not
undo it.

---

## 9. Verify from outside, not from the laptop

The most-repeated mistake in this project is verifying from the wrong place. Use mobile data with WiFi
off, or a phone:

```bash
./scripts/smoke-test.sh https://rangonfashion.com
```

Seven checks; all seven must pass. Then in a real browser — pages rendering is not enough:

1. Load the storefront.
2. Add something to the cart and open the cart drawer. If this does nothing, it is §8's `/api/proxy/`
   rule.
3. Sign in. If it bounces, it is `DJANGO_CSRF_TRUSTED_ORIGINS`.
4. Confirm `/django-admin/` returns **403** through the tunnel and still works on
   `http://localhost:4100`.

Tunnel-side health:

```bash
~/tools/cloudflared.exe tunnel list
```

```bash
~/tools/cloudflared.exe tunnel info rangon
```

---

## 10. When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| Cloudflare error page or 502, tunnel shows connected | Origin down, or not on 4100 | Bring the prodlocal stack up; `curl.exe http://localhost:4100/` must return 200 |
| **Error 1033** | No `cloudflared` connected at all | `Get-Service cloudflared`; run `cloudflared tunnel run rangon` in the foreground and read the log |
| **400, "Invalid HTTP_HOST header"** | Hostname missing from `DJANGO_ALLOWED_HOSTS` | Add it, then `up -d --force-recreate api` — `restart` keeps the old env |
| Endless HTTPS redirect, site appears dead | `X-Forwarded-Proto` overwritten with `$scheme` | The `$client_proto` map in §8; check `proxy_set_header` is restated in full |
| Pages render, cart/login/POS all 404 | `/api/proxy/` and `/api/auth/` sent to Django | §8, third block (D17) |
| Login succeeds then immediately logs out | Origin thinks the request is insecure, so secure cookies are dropped | Cloudflare SSL mode **Full**; confirm nginx forwards `X-Forwarded-Proto` |
| `route dns` fails with **code 1003** | A parking A/CNAME record already owns that host | `--overwrite-dns`, or delete the record in the dashboard (§5.3) |
| `cloudflared` exits at startup complaining about the last ingress rule | No catch-all | End `ingress:` with `- service: http_status:404` |
| The registered hostname is a whole markdown link | Pasted `[host](https://host)` | Pass the hostname bare |
| Canonical URLs, sitemap or OG tags say `localhost` | `NEXT_PUBLIC_*` baked at build time | Rebuild the web image with the right `--build-arg`s (§7.1) |
| `bind: ... forbidden by its access permissions` on the origin port | Windows reserves TCP ranges — 2906–3505 here | `netsh.exe interface ipv4 show excludedportrange protocol=tcp`, then pick a port outside them. This is why the origin is 4100 and not 3000 |
| Blank page, console full of CSP errors | Historical ([D16](../roadmap.md#known-defects)) | Already fixed: the app mints a per-request nonce in `apps/web/src/middleware.ts`. **Do not add a CSP header in nginx** — `add_header` appends, browsers enforce the intersection of every policy they receive, and a second header re-breaks hydration |

---

## 11. Stopping and removing it

From an administrator terminal:

```bash
net stop cloudflared
```

```bash
~/tools/cloudflared.exe service uninstall
```

```bash
~/tools/cloudflared.exe tunnel delete rangon
```

Delete the DNS records in the dashboard **before** deleting the tunnel. Removing the tunnel does not
remove the CNAMEs, and what is left is a domain that resolves to a dead tunnel and answers 1033 forever.

---

## 12. Before you leave it exposed

The moment this is reachable from the internet it is a public web application, not a demo.

- [ ] **Rotate the seed passwords.** `owner@rangon.test / rangon12345` is in the public GitHub README
      and grants full owner access — and `seed_demo --reset` puts it straight back. Never point that
      command at an internet-facing instance. Rotation snippet:
      [self-hosting-with-a-domain.md §5.4](self-hosting-with-a-domain.md).
- [ ] `/django-admin/` returns 403 through the tunnel (§9, step 4).
- [ ] `DJANGO_DEBUG=0` and a real `DJANGO_SECRET_KEY` in `.env.prod.local`.
- [ ] Backups running **from the `db` container** — `pg_dump` in the API image is 15.19 against a 16.15
      server and aborts on the mismatch. [backups.md](backups.md).
- [ ] A restore rehearsed at least once. The database has been wiped twice on this machine already; it
      survives container removal but not `down -v`, and not a Docker Desktop factory reset.
- [ ] Real SMTP. Mailpit is a development trap, not an email server.
- [ ] Object storage, or accept that `USE_S3=0` keeps uploads inside the container where a rebuild
      destroys them.
- [ ] Payments are COD only; the card option is deliberately disabled.

For everything beyond the tunnel — whether to self-host at all, port forwarding, keeping a Windows
machine serving — read [self-hosting-with-a-domain.md](self-hosting-with-a-domain.md).
