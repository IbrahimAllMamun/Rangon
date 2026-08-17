# API Conventions

Base: `/api/v1/`. OpenAPI schema at `/api/schema/`, Swagger UI at `/api/docs/`.

## Namespaces

| Prefix | Audience | Auth |
|---|---|---|
| `/api/v1/auth/` | everyone | public (login/register/refresh) |
| `/api/v1/shop/` | customers, guests | optional; guest cart via `X-Cart-Token` |
| `/api/v1/pos/` | cashiers | JWT + `sales.*` |
| `/api/v1/` (rest) | staff/back office | JWT + permission codes |
| `/api/health/`, `/api/ready/` | infra | public, no detail leaked |

## Requests

- JSON only (`application/json`), except uploads (`multipart/form-data`).
- Auth: `Authorization: Bearer <access>`.
- `Idempotency-Key: <uuid>` required on `POST /shop/checkout/`, `POST /pos/sales/`,
  `POST /orders/{id}/refunds/`. Repeats return the original result.
- `X-Request-ID` is echoed back and appears in logs and audit entries; generated if absent.
- Writes are `POST`/`PATCH`; `PUT` is not used. `DELETE` exists only for non-financial rows
  (draft product, unused coupon) — financial rows are cancelled/reversed, never deleted.

## Responses

Single resource:

```json
{ "id": "9f1c…", "name": "Men's Polo Shirt", "created_at": "2026-08-17T09:12:33Z" }
```

List (always paginated):

```json
{ "count": 248, "next": "…?page=3", "previous": "…?page=1", "results": [ … ] }
```

Defaults: `page_size=25`, max `100`. Money is a **string** (`"1290.00"`) so no client can lose precision
in a float. Timestamps are ISO-8601 UTC with `Z`.

## Errors

Always the same envelope:

```json
{ "error": { "code": "INSUFFICIENT_STOCK",
             "message": "Only 2 units of RGN-POL-BLK-M are available.",
             "details": { "variant_id": "…", "requested": 5, "available": 2 } } }
```

Validation errors put field errors in `details`:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid input.",
             "details": { "phone": ["Enter a valid Bangladeshi phone number."] } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | serializer/field failure |
| `AUTHENTICATION_REQUIRED` | 401 | missing/expired token |
| `PERMISSION_DENIED` | 403 | authenticated but not allowed |
| `NOT_FOUND` | 404 | absent, or outside the caller's branch scope |
| `CONFLICT` | 409 | idempotency or concurrent-state conflict |
| `INSUFFICIENT_STOCK` | 409 | not enough available stock |
| `INVALID_STATUS_TRANSITION` | 409 | illegal order/purchase/return transition |
| `PRICE_CHANGED` | 409 | client total disagrees with server total |
| `COUPON_INVALID` | 422 | expired, limit reached, scope mismatch, min order unmet |
| `PAYMENT_FAILED` | 402 | provider declined |
| `REFUND_EXCEEDS_CAPTURED` | 422 | refund larger than money actually taken |
| `RATE_LIMITED` | 429 | throttle exceeded |
| `SERVER_ERROR` | 500 | unexpected; no detail exposed, `request_id` returned |

Stack traces, SQL and settings are never returned. In `DEBUG` the traceback goes to the log, not the
response body.

## Filtering, ordering, search

```text
GET /api/v1/products/?search=polo&category=men-shirts&brand=rangon&status=ACTIVE
                      &price_min=500&price_max=2000&in_stock=true
                      &ordering=-created_at&page=2&page_size=50
GET /api/v1/shop/products/?attr_size=M&attr_color=black&sort=price_asc
```

`ordering` accepts a whitelist per endpoint. Unknown query params are ignored, never guessed.

## Throttling

| Scope | Limit |
|---|---|
| anonymous | 60/min |
| authenticated | 600/min |
| `auth/login`, `auth/register`, `auth/password-reset` | 10/min per IP |
| `shop/checkout` | 20/hour per user or cart token |
| `shop/products` search | 120/min |
| POS endpoints | 1200/min (a busy counter is not an attack) |

## Versioning

`/api/v1/` is stable: no field is removed or retyped, no enum value is repurposed. Additive changes only.
Breaking changes ship as `/api/v2/` with both served during a documented deprecation window.
