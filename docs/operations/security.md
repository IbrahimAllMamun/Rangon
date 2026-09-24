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
| XSS | React escapes by default; no `dangerouslySetInnerHTML` outside a sanitised rich-text renderer; CSP sent by the web app itself (`apps/web/src/middleware.ts`) with a per-request nonce — **not** by Nginx, which would append a second policy and block the nonced scripts |
| CSRF | Cookie-borne auth on same-origin Next routes uses `SameSite=Lax` + a double-submit token on state-changing routes; the API itself is token-authenticated and CSRF-exempt by construction |
| CORS | Explicit allow-list (`DJANGO_CORS_ALLOWED_ORIGINS`), credentials allowed only for those origins; wildcard is forbidden in production |
| Transport | HTTPS only; HSTS 1 year with preload; `Secure` cookies; HTTP redirected |
| Headers | `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, CSP with `'nonce-…' 'strict-dynamic'` and no `unsafe-inline`/`unsafe-eval` in `script-src` |
| Uploads | Every image field — product photos, category images, brand logos, navigation and banner art — goes through `core.media.validate_image_upload`: Pillow must decode it (the magic-byte check), 10 MB cap, JPEG/PNG/WebP/AVIF only by detected type *and* extension. Until 2026-09-23 only product photos had the cap and the four-format list; the other four took any size in any of ~70 formats Pillow decodes, PostScript included. A decodable file named `.html` was refused throughout, by Django's model validator. **Not re-encoded** and **not on a separate origin**: with `USE_S3=0`, the default, Django serves `/media/` from the shop's own origin. Nothing uploadable is a type a browser executes, which is what makes that acceptable. **Receipts are private**: served only by `GET /api/v1/expenses/{id}/attachment/` to staff who may read the expense, refused on `/media/` by Django and Nginx, stored under random names ([D91](../roadmap.md#known-defects)) |
| Secrets | Environment only; `.env` git-ignored; no secret in an image layer or a frontend bundle; `NEXT_PUBLIC_*` reviewed as public by definition |
| Payments | No card data stored, logged or forwarded; only provider references; capture requires a verified webhook or a server-side verification call |
| Audit | Actor, action, entity, before/after, reason, IP, user agent, request id for every sensitive action; passwords and tokens never logged |
| Errors | Uniform error envelope; no stack traces, SQL or settings in responses; `DEBUG=False` enforced in production settings |
| Dependencies | Pinned; `pip-audit` and `npm audit` in CI; Trivy image scan fails the build on fixed HIGH/CRITICAL |
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

## Not done

- Independent penetration test (gap #6 in the roadmap).
- MFA for staff accounts — recommended before multi-branch rollout.
- Automated secret scanning in CI (`gitleaks`) — recommended, one workflow step.
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
