# Security

Scope: customer PII, staff permissions, payment references, inventory and financial records.
Baseline: OWASP ASVS L1 with L2 controls where they are cheap.

## Implemented controls

| Area | Control |
|---|---|
| Password storage | Argon2id (Django `ARGON2` hasher first), minimum length 10, common-password and numeric validators |
| Session | JWT access 30 min + rotating refresh 14 days, blacklist on logout, tokens only in `httpOnly` `SameSite=Lax` cookies ([ADR-0005](../architecture/decisions/0005-jwt-cookie-auth.md)) |
| Authorization | Role → permission codes enforced by DRF permission classes on **every** endpoint; branch scoping on every branch-bearing queryset; `OWNER` bypass is explicit and audited |
| Brute force | Throttle 10/min per IP on login/register/password-reset; failed logins audit-logged |
| Input | DRF serializers validate and coerce everything; the ORM parameterises all SQL; no raw string SQL anywhere |
| XSS | React escapes by default; no `dangerouslySetInnerHTML` outside a sanitised rich-text renderer; CSP sent by the web app itself (`apps/web/src/middleware.ts`) with a per-request nonce — **not** by Nginx, which would append a second policy and block the nonced scripts |
| CSRF | Cookie-borne auth on same-origin Next routes uses `SameSite=Lax` + a double-submit token on state-changing routes; the API itself is token-authenticated and CSRF-exempt by construction |
| CORS | Explicit allow-list (`DJANGO_CORS_ALLOWED_ORIGINS`), credentials allowed only for those origins; wildcard is forbidden in production |
| Transport | HTTPS only; HSTS 1 year with preload; `Secure` cookies; HTTP redirected |
| Headers | `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, CSP with `'nonce-…' 'strict-dynamic'` and no `unsafe-inline`/`unsafe-eval` in `script-src` |
| Uploads | Extension + MIME + magic-byte check, 10 MB cap, images re-encoded, stored in object storage, served from a separate origin, never executed |
| Secrets | Environment only; `.env` git-ignored; no secret in an image layer or a frontend bundle; `NEXT_PUBLIC_*` reviewed as public by definition |
| Payments | No card data stored, logged or forwarded; only provider references; capture requires a verified webhook or a server-side verification call |
| Audit | Actor, action, entity, before/after, reason, IP, user agent, request id for every sensitive action; passwords and tokens never logged |
| Errors | Uniform error envelope; no stack traces, SQL or settings in responses; `DEBUG=False` enforced in production settings |
| Dependencies | Pinned; `pip-audit` and `npm audit` in CI; Trivy image scan fails the build on fixed HIGH/CRITICAL |
| Database | Private network only, never published to the internet; least-privilege application user |

## Threats considered

| Threat | Mitigation |
|---|---|
| Price manipulation from the browser | Server re-prices every line at cart read and at checkout; client totals are ignored |
| Coupon abuse | Server-side validation of window, minimum, cap, total and per-customer usage; redemption rows are unique per order |
| Oversell via race | Row locks + check constraints + concurrency tests ([ADR-0004](../architecture/decisions/0004-pessimistic-locking-for-stock.md)) |
| Duplicate charge | Idempotency keys on checkout/refund; webhook dedupe on `(provider, event_id)` |
| Insider theft via stock edits | Stock can only move through the ledger; every adjustment needs a reason and is audit-logged; cashiers cannot adjust stock at all |
| Cashier self-refund | `sales.refund` withheld from `CASHIER`; manager elevation is a separate credential check, logged with both user ids |
| Enumeration of orders/customers | UUID primary keys; guest order tracking requires a signed token as well as the order number |
| Account takeover | Argon2, throttling, refresh rotation + blacklist, logout everywhere on password change |
| PII exposure in logs | Structured logging with an explicit field allow-list; no request bodies logged on auth endpoints |

## Not done

- Independent penetration test (gap #6 in the roadmap).
- MFA for staff accounts — recommended before multi-branch rollout.
- Automated secret scanning in CI (`gitleaks`) — recommended, one workflow step.
- Field-level encryption for customer phone numbers; currently protected by database access control only.

## Reporting

Suspected incident → technical lead immediately → preserve logs and database state (do **not** restore
over the live database, see the DR runbook) → assess data exposure → notify the owner → remediate →
write it up in `docs/operations/incidents/`.
