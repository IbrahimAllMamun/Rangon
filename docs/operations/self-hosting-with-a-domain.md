# Hosting Rangon from your own machine, on your own domain

> Companion to [webuzo-deployment.md](webuzo-deployment.md) (rented VPS) and
> [deployment.md](deployment.md) (general release procedure). This file is for the case where the
> hardware is **yours** — a laptop or desktop at home or in the shop — and you point a real domain at it.
>
> Unlike the Webuzo guide, most of this **has been executed**. The production stack was built and run on
> this machine on 2026-08-19: prod images, gunicorn, nginx on one origin, `scripts/smoke-test.sh` passing
> 7/7, and the whole app reachable over public HTTPS through a Cloudflare tunnel with the storefront and
> cart verified in a browser. Every gotcha in §5 was hit for real, not imagined.

---

## 1. Read this before buying anything

Self-hosting a shop from a laptop is genuinely possible. It is also the thing people regret. Be honest
about which of these you can live with:

| Reality | What it means for a shop |
|---|---|
| **A laptop is not a server** | Closing the lid, a Windows update reboot, or someone unplugging it = the shop is offline. No alerts, no failover |
| **Home upload is the ceiling** | Product pages are ~130 KB. A 5 Mbps upload serves a handful of concurrent shoppers, not a campaign |
| **Most ISPs use CGNAT** | You share a public IP with hundreds of others, so **port forwarding cannot work at all**. Common in Bangladesh. Route A below sidesteps this entirely |
| **Residential terms of service** | Many ISPs forbid running public servers on a home connection |
| **Power and internet cuts** | Every outage is downtime, during which customers see nothing |
| **You are now the sysadmin** | Backups, patching, TLS renewal, intrusion response — all yours |

**A ৳500–800/month VPS removes every row in that table.** Self-host if you want to learn, to demo, to
run the POS on the shop counter's own LAN, or to stage before renting. For a storefront taking real
money from real customers, rent the VPS.

**The POS is the honourable exception.** A machine in the shop serving the register over the local
network is a genuinely good architecture: no internet dependency at the counter, low latency, and the
data stays on your premises.

---

## 2. Two ways to put a domain on your machine

```text
Route A — Cloudflare Tunnel  (recommended)
  visitor → Cloudflare edge (TLS, DDoS) → outbound tunnel → your machine
  • no port forwarding, works behind CGNAT, home IP never exposed
  • free certificates, renewed for you
  • requires the domain's nameservers to point at Cloudflare

Route B — Port forwarding
  visitor → your public IP :443 → router → your machine
  • needs a real public IP (fails on CGNAT) and router access
  • you own TLS renewal, and your home IP is public
```

Route A is better on every axis that matters here, and it is what was tested on this machine. Route B
is documented in §7 only for completeness.

---

## 3. Route A — Cloudflare Tunnel with your domain

### 3.1 Point the domain at Cloudflare

1. Buy the domain wherever you like (Namecheap, GoDaddy, a local registrar).
2. Create a free Cloudflare account, **Add a site**, enter the domain.
3. Cloudflare gives you two nameservers. Set them at your registrar, replacing what is there.
4. Wait for Cloudflare to report the domain **Active** (minutes to a few hours).

You do this part yourself — it involves your registrar account and payment details.

### 3.2 Create a *named* tunnel

A quick tunnel (`--url`, what this session used) gets a random `trycloudflare.com` name that dies with
the process. For a domain you want a **named** tunnel: stable hostname, survives restarts, runs as a
service.

```bash
# cloudflared is already downloaded to ~/tools/cloudflared.exe on this machine
cd ~/tools

./cloudflared.exe tunnel login          # opens a browser; pick your domain
./cloudflared.exe tunnel create rangon  # writes a credentials JSON, prints a tunnel UUID

# Point the hostnames at the tunnel (creates the DNS records for you)
./cloudflared.exe tunnel route dns rangon rangonfashion.com
./cloudflared.exe tunnel route dns rangon www.rangonfashion.com
```

**Expect this to fail the first time:**

```text
Failed to add route: code: 1003, reason: Failed to create record rangonfashion.com
with err An A, AAAA, or CNAME record with that host already exists.
```

Cloudflare imports the domain's existing records when you add the site — usually a parking A record on
the apex and a `www` CNAME — and `cloudflared` refuses to overwrite them. Either delete those two
records under **DNS → Records** in the dashboard, or tell it to replace them:

```bash
./cloudflared.exe tunnel route dns --overwrite-dns rangon rangonfashion.com
./cloudflared.exe tunnel route dns --overwrite-dns rangon www.rangonfashion.com
```

Each becomes a proxied `CNAME → <TUNNEL-UUID>.cfargotunnel.com`. Pass the hostname bare — pasting a
markdown link like `[www.example.com](https://www.example.com)` makes cloudflared treat the whole
string as the hostname.

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: rangon
credentials-file: C:\Users\ibrahimAllMamun\.cloudflared\<TUNNEL-UUID>.json

ingress:
  - hostname: rangonfashion.com
    service: http://localhost:4100
  - hostname: www.rangonfashion.com
    service: http://localhost:4100
  # Every ingress list must end with a catch-all.
  - service: http_status:404
```

Run it, and once it works, install it so it starts with Windows:

```bash
./cloudflared.exe tunnel run rangon            # foreground, to check it works
./cloudflared.exe service install               # then: runs on boot (needs an admin terminal)
```

### 3.3 Rebuild the web image for your domain

**This step is not optional and is easy to miss.** `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_API_URL` are
compiled into the JavaScript bundle at *build* time (they are `ARG`s in `apps/web/Dockerfile`). An image
built for `localhost` will emit `localhost` canonical URLs, OG tags and sitemap entries no matter what
environment variables you set at run time — verified on this machine.

```bash
cd /c/Users/ibrahimAllMamun/Desktop/Rangon
docker build -t rangon-web:prod -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://rangonfashion.com/api/v1 \
  --build-arg NEXT_PUBLIC_SITE_URL=https://rangonfashion.com \
  apps/web
```

Roughly 6 minutes, and about 2 GB of RAM.

### 3.4 Point the app at the domain

Edit `.env.prod.local` (gitignored):

```bash
# prod.py REFUSES to boot if this is empty or contains "*"
DJANGO_ALLOWED_HOSTS=rangonfashion.com,www.rangonfashion.com,localhost,127.0.0.1,api,web,nginx
DJANGO_CSRF_TRUSTED_ORIGINS=https://rangonfashion.com,https://www.rangonfashion.com
DJANGO_CORS_ALLOWED_ORIGINS=https://rangonfashion.com,https://www.rangonfashion.com

# Safe to leave ON: nginx maps the tunnel's X-Forwarded-Proto through, so Django
# sees https and does not redirect-loop. See §5.1 — this bites hard if broken.
DJANGO_SECURE_SSL_REDIRECT=1
```

Then bring the stack up:

```bash
docker compose -p rangon-prod --env-file .env.prod.local \
  -f docker-compose.yml -f docker-compose.prodlocal.yml up -d
```

### 3.5 Verify from outside, not from the laptop

The most-repeated mistake in this project's history is verifying from the wrong place
([.claude/environment.md](../../.claude/environment.md) §3). Check from mobile data, with WiFi off:

```bash
./scripts/smoke-test.sh https://rangonfashion.com
```

Then in a real browser: load the storefront, add something to the cart, and open the cart drawer. If
pages render but the cart does nothing, read §5.2 — that exact failure has already happened here.

---

## 4. Restrict the admin surfaces to your own network

Once the domain is public, the back office should not be. `infrastructure/docker/nginx/local-prod/`
already blocks `/django-admin/` for any request arriving on a `trycloudflare.com` host; change that
guard to your own domain:

```nginx
map $host $via_public_tunnel {
    default                   0;
    "~^(www\.)?rangonfashion\.com$"  1;
}
```

Everything arrives through Docker's NAT, so the source IP is the bridge gateway whether the request came
from your laptop, the LAN or the internet — **IP rules cannot tell them apart.** The Host header can.
This was found by testing: an `allow 172.16.0.0/12` rule intended to permit the LAN silently permitted
the whole internet, because tunnel traffic arrives on exactly that range.

Consider extending the same guard to `/admin` and `/pos` if the shop only ever uses them on-site.

---

## 5. The five things that will actually break

Every one of these was hit on this machine. They are why §3.5 says to verify in a browser.

### 5.1 Infinite HTTPS redirect

Cloudflare terminates TLS and forwards **HTTP** to your machine. `prod.py` sets
`SECURE_SSL_REDIRECT=True` and trusts `X-Forwarded-Proto`. If nginx overwrites that header with its own
`$scheme` (which is `http`), Django decides every request is insecure and redirects to HTTPS forever.
The site looks completely down.

`local-prod/default.conf` solves it with a map that prefers the upstream proxy's value:

```nginx
map $http_x_forwarded_proto $client_proto {
    default        $scheme;
    "~^https?$"    $http_x_forwarded_proto;
}
```

Note the subtlety: nginx only inherits `proxy_set_header` from `http{}` if the current level declares
**none**. Overriding one means restating them all, or `Host` and `X-Real-IP` vanish silently.

### 5.2 Cart, login and POS all return 404

`/api/proxy/*` and `/api/auth/*` are **Next.js route handlers**, not Django. Send all of `/api/` to the
API and pages still render while every interactive feature dies — sign-in, cart, checkout, POS sales,
admin actions. Fixed in both nginx configs (D17); do not undo it.

### 5.3 A completely blank page

`script-src 'self'` blocks the inline scripts the Next.js App Router streams its payload through, so
React never hydrates. **This is still unfixed (D16).** `local-prod/default.conf` uses `'unsafe-inline'`
as a stopgap, which works but discards what the directive is for. Before real customers, fix it properly
with a per-request nonce from Next middleware.

### 5.4 The seed passwords are published in your public GitHub README

`owner@rangon.test / rangon12345` grants full owner access. They were rotated on this machine on
2026-08-19, but **`seed_demo --reset` puts them straight back**. Never run that against an internet-facing
instance. To rotate:

```bash
docker compose -p rangon-prod --env-file .env.prod.local \
  -f docker-compose.yml -f docker-compose.prodlocal.yml exec -T api python -c "
import django, os, secrets, string; os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings.prod'); django.setup()
from accounts.models import User
a = string.ascii_letters + string.digits
for u in User.objects.all():
    pw = ''.join(secrets.choice(a) for _ in range(20)); u.set_password(pw); u.save(update_fields=['password'])
    print(u.email.ljust(26), pw)"
```

### 5.5 Backups fail from the API container

`pg_dump` in the API image is **15.19** against a **16.15** server and aborts on the version mismatch.
Run backups from the **db** container. Full detail in [backups.md](backups.md).

---

## 6. Keeping a Windows machine serving

- **Stop it sleeping.** Settings → System → Power → screen and sleep set to *Never* when plugged in.
  Closing the lid must be set to *Do nothing*, or every lid close is an outage.
- **Docker Desktop must start on login**, and the containers use `restart: unless-stopped`, so they come
  back after a reboot — but only once someone logs in. A machine sitting at the lock screen after a
  Windows Update reboot is a machine serving nothing.
- **`cloudflared service install`** makes the tunnel itself survive reboots.
- **Watch the disk.** Postgres, images and build cache grow. `docker system df`, and prune build cache
  (not volumes) when it bloats.
- **Windows reserves TCP ranges** — 2906–3505 on this machine — which is why the storefront uses 4100 and
  not 3000. Check with `netsh interface ipv4 show excludedportrange protocol=tcp` before choosing ports.

Bring the stack back after any restart:

```bash
cd /c/Users/ibrahimAllMamun/Desktop/Rangon
docker compose -p rangon-prod --env-file .env.prod.local \
  -f docker-compose.yml -f docker-compose.prodlocal.yml up -d
```

The database lives in the `rangon-prod_postgres_data` volume and survives container removal — but **not**
`docker compose down -v`, and not a Docker Desktop factory reset. It has been wiped twice on this machine
already. Back it up before you rely on it.

---

## 7. Route B — port forwarding (only if you have a real public IP)

First find out whether you even can:

```bash
curl -s https://api.ipify.org          # your public IP as the internet sees it
```

Compare it to the WAN address in your router's admin page. **If they differ, you are behind CGNAT and
port forwarding cannot work** — use Route A. Some ISPs sell a static IP as an add-on.

If they match:

1. Give the machine a static LAN IP (DHCP reservation in the router).
2. Forward TCP 80 and 443 to that IP.
3. Publish nginx on 80/443 instead of 4100, in `docker-compose.prodlocal.yml`.
4. Get certificates with Certbot in webroot or DNS mode, and mount them into the nginx container. Renewal
   is now your job — a cron that reloads nginx after each renewal.
5. Add dynamic DNS if your IP changes (most residential IPs do).
6. Open Windows Firewall for 80/443 — a security setting you should change yourself, deliberately.

You are now exposing your home network directly. Everything in §5 still applies, plus you own TLS
renewal and you have published your home IP address.

---

## 8. Before a real customer buys anything

Beyond this document — these are product gaps, not hosting gaps:

- [ ] **CSP fixed properly** (D16) — currently `unsafe-inline`
- [ ] **Payment gateway** — COD only today; the card option is deliberately disabled
- [ ] **Backups running and a restore rehearsed** — never done ([roadmap.md](../roadmap.md#still-unproven))
- [ ] **VAT settled** — changing it later rewrites every historical total
      ([business-rules.md](../business-rules.md))
- [ ] **Object storage** — `USE_S3=0` keeps uploads inside the container; they die with a rebuild
- [ ] **Real SMTP** — Mailpit is a development trap, not an email server
- [ ] Seed data cleared, and `seed_demo --reset` never pointed at the live database
- [ ] Someone other than you knows how to restart it at 2 a.m.
