# Security

Scope: customer PII, staff permissions, payment references, inventory and financial records.
Baseline: OWASP ASVS L1 with L2 controls where they are cheap.

## Implemented controls

| Area | Control |
|---|---|
| Password storage | Argon2id (Django `ARGON2` hasher first), minimum length 10, common-password and numeric validators |
| Session | JWT access 30 min + rotating refresh 14 days, blacklist on logout, tokens only in `httpOnly` `SameSite=Lax` cookies ([ADR-0005](../architecture/decisions/0005-jwt-cookie-auth.md)). Every token carries a hash of the password it was issued under (`CHECK_REVOKE_TOKEN`) and every refresh token is blacklisted on a password change or reset, so either ends every session at once ([D86](../roadmap.md#known-defects)). **Signing out needs only the refresh token** — no access token, no throttle — because the access token and its cookie expire at thirty minutes, and until 2026-09-23 signing out after that answered 401 and left the refresh token alive for fourteen days ([D92](../roadmap.md#known-defects)) |
| Authorization | Role → permission codes enforced by DRF permission classes on **every** endpoint; `OWNER` bypass is explicit and audited. **Branch scope**: staff bound to a branch read its rows (`accounts.services.branch_queryset`) and act on it (`resolve_branch`); a row with two branches — a stock transfer — is visible from either end. Deliberate exceptions, each a `DECISION REQUIRED` in business-rules §7.1: the branch directory, the staff list, and organisation-wide audit entries span branches; a non-owner **with no branch assigned** sees every branch. `tests/api/test_branch_scope.py` sweeps every parameter-free GET route for another branch's rows, including routes added after it — it found [D93](../roadmap.md#known-defects) and [D94](../roadmap.md#known-defects), after checking viewsets one at a time had missed them |
| Brute force | Throttle 10/min on login and register (per IP) and on password change (per account, since 2026-09-19 — [D87](../roadmap.md#known-defects)); failed logins and wrong current passwords audit-logged as `LOGIN_FAILED`. **Per IP means per *trusted* IP** — see the row below; until 2026-09-21 it did not ([D88](../roadmap.md#known-defects)) |
| Input | DRF serializers validate and coerce everything; the ORM parameterises all SQL; no raw string SQL anywhere |
| XSS | React escapes by default; no `dangerouslySetInnerHTML` outside a sanitised rich-text renderer; CSP sent by the web app itself (`apps/web/src/middleware.ts`) with a per-request nonce — **not** by Nginx, which would append a second policy and block the nonced scripts. **Measured 2026-09-24** on a production build: every document route, a 404 and the redirects included, sends it; every `<script>` carries the nonce; the nonce is new per request; `e2e/csp.spec.ts` checks in a real browser that each page's scripts load under it |
| CSRF | The session is `httpOnly` `SameSite=Lax` cookies on the shop's origin, used by the Next routes under `/api/proxy` and `/api/auth`. Every state-changing request to those routes must carry this site's `Origin` or none (`apps/web/src/lib/api/same-origin.ts`): a browser always sends it on a cross-origin write and page script cannot forge it, and a request without one is not a browser's. `SameSite=Lax` alone left a **same-site** origin — any subdomain — able to act with the cookies. **This row used to promise a double-submit token; none was ever built** — measured 2026-09-24, a PATCH from `https://blog.shop.example` changed an account with an owner's cookies, and a sign-in from another origin set a session ([D101](../roadmap.md#known-defects)). The Django API is bearer-token authenticated; its session authentication (Django admin only) keeps Django's own CSRF check |
| CORS | Explicit allow-list (`DJANGO_CORS_ALLOWED_ORIGINS`), credentials allowed only for those origins; `CORS_ALLOW_ALL_ORIGINS = False` is fixed in `prod.py`. **Measured 2026-09-24** against production settings: only an exact listed origin gets `Access-Control-Allow-Origin` (a suffix like `shop.example.evil.com`, the wrong scheme and `null` get nothing); `*` in the list is refused at start by `corsheaders.E013`, and forced past the check it matches nothing. The browser never needs it: it talks only to its own origin (`connect-src 'self'`) |
| Transport | HTTPS only; HSTS 1 year with preload; `Secure` cookies; HTTP redirected |
| Headers | `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, CSP with `'nonce-…' 'strict-dynamic'` and no `unsafe-inline`/`unsafe-eval` in `script-src` |
| Uploads | Every image field — product photos, category images, brand logos, navigation and banner art — goes through `core.media.validate_image_upload`: Pillow must decode it (the magic-byte check), 10 MB cap, JPEG/PNG/WebP/AVIF only by detected type *and* extension. Until 2026-09-23 only product photos had the cap and the four-format list; the other four took any size in any of ~70 formats Pillow decodes, PostScript included. A decodable file named `.html` was refused throughout, by Django's model validator. **Not re-encoded** and **not on a separate origin**: with `USE_S3=0`, the default, Django serves `/media/` from the shop's own origin. Nothing uploadable is a type a browser executes, which is what makes that acceptable. **Receipts are private**: served only by `GET /api/v1/expenses/{id}/attachment/` to staff who may read the expense, refused on `/media/` by Django and Nginx, stored under random names ([D91](../roadmap.md#known-defects)) |
| Secrets | Environment only; `.env` git-ignored; no secret in an image layer or a frontend bundle; `NEXT_PUBLIC_*` reviewed as public by definition |
| Payments | No card data stored, logged or forwarded; only provider references. **Today every capture is a staff action**: the only registered provider is `manual`, which takes no webhooks — a forged `payment.success` is a 404 and captures nothing (measured 2026-09-24, `tests/api/test_payment_webhooks.py`). Checking a webhook's signature is each provider's `parse_webhook`; what a verified event may do is decided in one place — it acts only on a payment made through the **same provider**, and captures only the **amount that payment was for**. Until 2026-09-24 it captured the order's first pending payment, whoever it was with and whatever it was for ([D100](../roadmap.md#known-defects)) — latent, and closed before the first gateway |
| Audit | Actor, action, entity, before/after, reason, IP, user agent, request id for every sensitive action; passwords and tokens never logged |
| Errors | Uniform error envelope; no stack traces, SQL or settings in responses; `DEBUG=False` fixed in `prod.py`. `core.handlers` turns an unhandled exception into a bare 500 with a request id and an `IntegrityError` into a bare 409 (`tests/api/test_error_leakage.py`). The one path around it — the cart's coupon re-check put `str(exc)` in the response, SQL included for a database error — was closed 2026-09-24 ([D99](../roadmap.md#known-defects)) |
| Dependencies | Pinned; `pip-audit` and `npm audit` run in CI **as advisories** — both steps end in `\|\| echo "::warning::…"`, so they report and never fail the build; Trivy image scan fails the build on fixed HIGH/CRITICAL |
| Secrets in the repository | gitleaks over **the whole history** on every push and pull request, pinned and checksum-verified, **blocking** — see **Secret scanning** below |
| Client address | Every rate limit, and the audit trail's `ip_address`, resolve the caller through `core.ip.client_ip`, which counts `DJANGO_TRUSTED_PROXY_HOPS` entries **from the right** of `X-Forwarded-For` — the entries our own proxies appended. The default is 0: no proxy, ignore the header. See **Deploying behind a proxy** below |
| Database | Private network only, never published to the internet; least-privilege application user |

## Threats considered

| Threat | Mitigation |
|---|---|
| Price manipulation from the browser | Server re-prices every line at cart read and at checkout; client totals are ignored |
| Coupon abuse | Server-side validation of window, minimum, cap, total and per-customer usage; redemption rows are unique per order |
| Oversell via race | Row locks + check constraints + concurrency tests ([ADR-0004](../architecture/decisions/0004-pessimistic-locking-for-stock.md)) |
| Duplicate charge | Idempotency keys on checkout/refund; webhook dedupe on `(provider, event_id)` |
| Insider theft via stock edits | Stock can only move through the ledger; every adjustment needs a reason and is audit-logged; cashiers cannot adjust stock at all. A transfer's **source** must be the caller's own branch unless they cross branches — until 2026-09-23 it was not checked, and staff at one branch could send another's stock to their own ([D94](../roadmap.md#known-defects)) |
| Reading another branch's figures | Reports honour `?branch=` only for a branch the caller may see; an unknown id is a 404, not every branch ([D93](../roadmap.md#known-defects)) |
| Financial documents in public media | Expense receipts are not media: a dedicated endpoint, two refusals on `/media/`, random names ([D91](../roadmap.md#known-defects)) |
| Cashier self-refund | `sales.refund` withheld from `CASHIER`; manager elevation is a separate credential check, logged with both user ids |
| Enumeration of orders/customers | UUID primary keys; guest order tracking requires a signed token as well as the order number |
| The tracking link showing the shop's record | The link is open to whoever holds it, so it returns the customer's version of the order, field by field — never staff identities, internal notes, typed reasons or the drawer a payment went into. Until 2026-09-24 it returned the staff serializer, and so did the signed-in account's orders ([D97](../roadmap.md#known-defects)) |
| Cross-site request forgery | `Origin` checked on every state-changing cookie-authenticated route; `SameSite=Lax` beneath it ([D101](../roadmap.md#known-defects)) |
| Money moved through the wrong account | A named account must be the money's branch's own, open, and of the method's kind, checked where every sale, refund and supplier payment posts. Until 2026-09-24 only the default was checked: a sale at one branch could fill another's drawer ([D95](../roadmap.md#known-defects)) |
| A webhook capturing the wrong payment | Only its own provider's payment, only for its amount ([D100](../roadmap.md#known-defects)) |
| Account takeover | Argon2, throttling, refresh rotation + blacklist, logout everywhere on password change or an owner's reset. The last was listed here before it existed: until 2026-09-19 a changed password left every session open for up to 14 days ([D86](../roadmap.md#known-defects)) |
| PII exposure in logs | Structured logging with an explicit field allow-list; no request bodies logged on auth endpoints |
| Rate limits defeated by a forged header | `X-Forwarded-For` is client-supplied. DRF's stock throttles key on the whole of it when `NUM_PROXIES` is unset, so one varying header bought a fresh bucket per request. `core.throttling` keys on the trusted entry instead ([D88](../roadmap.md#known-defects)) |
| Audit trail attributed to a forged address | The same header, read left-most, was recorded as `AuditLog.ip_address` and `User.last_login_ip` — attacker-writable evidence, which is worse than a blank field because it is believed. Same fix, same helper ([D88](../roadmap.md#known-defects)) |

## Deploying behind a proxy

`DJANGO_TRUSTED_PROXY_HOPS` is **how many reverse proxies you control** sit in
front of Django, each appending the peer it saw to `X-Forwarded-For`.

| Topology | Value |
|---|---|
| Django exposed directly (dev, `runserver`, tests) | `0` — the default; the header is ignored entirely |
| The shipped Nginx stack (`docker-compose.prod.yml`) | `1` — set there already |
| CDN or load balancer in front of that Nginx | `2` |

Two rules, and getting either wrong is silent:

1. **Never set it higher than the number of proxies that actually run.** Each
   extra hop steps one entry further left, into the part the caller wrote, and
   the limit stops applying to anyone who sends a header.
2. **Django must not be reachable around the proxy.** A request that arrives
   directly carries no proxy-appended entry, so the count cannot be satisfied
   honestly. `docker-compose.prod.yml` publishes a port on Nginx only;
   `docker-compose.prodlocal.yml` also publishes the API on 8100 as a debugging
   door, which is why throttling is measured there through 4100.

Too low is the safe way to be wrong: callers share a bucket, honest traffic
gets 429s, and somebody notices within the hour. Too high is silent.

## Secret scanning

The `secrets` job in `.github/workflows/ci.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks)
8.21.2 over **every commit** on every push and pull request — a key committed and deleted a commit
later is still in the history anyone who can clone reads. The binary is pinned by version and
verified against its published SHA-256 before it runs. A finding fails the build.

When it fails:

1. **Assume it is real.** Rotate the credential at its source first — revoke the key, change the
   password — then take it out of the code and read it from the environment. Removing it from the
   *history* (a rewrite, then a force-push) comes after the rotation, never instead of it: the value
   has been public since the push.
2. **If it is not a secret** — a test fixture, a documented example — add its fingerprint to
   `.gitleaksignore` with the reason on the line above. A fingerprint names one finding in one
   commit, so nothing else can hide behind the entry. Never skip a rule or a path to get green.

Run it locally before pushing — and fetch every branch first, because CI's checkout does and
gitleaks walks every ref it can see:

```bash
git fetch origin '+refs/heads/*:refs/remotes/origin/*'
gitleaks git --redact .    # every commit on every branch, as CI does
gitleaks dir --redact .    # the working tree, including what is not committed yet
```

The first run, 2026-09-24: one finding, a test fixture's password — the rotation a re-seed must
leave alone — in **two** commits, the one on `main` and its first copy on another branch. Both are
accepted by fingerprint. The local check before that push had seen only this clone's branches and
passed; CI saw all 33 and failed. Hence the fetch above.

## Not done

- Independent penetration test (gap #6 in the roadmap).
- MFA for staff accounts — recommended before multi-branch rollout.
- Field-level encryption for customer phone numbers; currently protected by database access control only.
- **Re-encoding uploaded images.** It would strip EXIF — a phone photo's GPS position among it — and
  any bytes trailing the image. The allow-list keeps executable types out; re-encoding is the
  remaining layer.
- **Refresh-token reuse detection.** Rotation blacklists the old token, but two refreshes racing
  with the same token can both succeed, and presenting a rotated token does not revoke the family
  it came from. Neither is a bypass of anything above; both are what a stolen-token defence would
  add next.

## Reporting

Suspected incident → technical lead immediately → preserve logs and database state (do **not** restore
over the live database, see the DR runbook) → assess data exposure → notify the owner → remediate →
write it up in `docs/operations/incidents/`.
