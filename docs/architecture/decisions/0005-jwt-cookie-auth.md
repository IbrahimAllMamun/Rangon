# ADR-0005 — JWT issued by the API, stored in httpOnly cookies set by Next.js

**Status:** Accepted · 2026-08-17

## Context

Three clients (storefront, admin, POS) on `:3000` talk to an API on `:8000` in development and to a
different hostname in production. Plan §9 says "session/token strategy" without choosing. Storing tokens
in `localStorage` exposes them to XSS; pure Django sessions across origins need careful CSRF + CORS +
`SameSite=None` handling and do not suit the future Tauri POS.

## Decision

- The API issues short-lived access tokens (30 min) and rotating refresh tokens (14 days) via
  `djangorestframework-simplejwt`, with refresh-token blacklisting on logout.
- The browser never sees a token in JavaScript. Next.js route handlers (`/api/auth/login`,
  `/api/auth/refresh`, `/api/auth/logout`) proxy to the API and store both tokens in `httpOnly`,
  `SameSite=Lax`, `Secure` (in production) cookies.
- Server components read the cookie and call the API over the private Docker network
  (`API_INTERNAL_URL`); client components call the same-origin Next.js routes, which attach the token.

## Consequences

- No token in `localStorage`; XSS cannot exfiltrate credentials directly.
- Same-origin browser requests mean no CORS preflight for the app itself; CORS stays narrow.
- Refresh is handled in one place (`lib/api/server.ts` + the refresh route), not in every component.
- A future native POS can use the raw JWT endpoints without cookies.
- Cost: an extra network hop for client-side mutations (browser → Next → API). Acceptable; reads mostly
  happen in server components anyway.
