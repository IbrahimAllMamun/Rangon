# ADR-0002 — One Next.js app with route groups instead of three apps

**Status:** Accepted · 2026-08-17 · Deviates from plan §4

## Context

The plan sketches `apps/web/{storefront,admin,pos}`. All three surfaces must look like one Rangon
product, share the design system, and share an auth cookie domain.

## Decision

A single Next.js app, `apps/web`, with App Router route groups:

```text
src/app/(storefront)/…    /            /shop  /product/[slug]  /cart  /checkout  /account
src/app/(admin)/admin/…   /admin       products  inventory  orders  purchases  reports  settings
src/app/(pos)/pos/…       /pos         register  holds  returns
src/app/api/auth/…        cookie-setting route handlers (login, refresh, logout)
```

## Consequences

- One `node_modules`, one build, one deploy, one Tailwind/token layer — no workspace plumbing and no
  three-way component drift.
- Route groups give each surface its own `layout.tsx`, so admin/POS chrome never leaks into the
  storefront and vice versa.
- Admin/POS bundles are code-split by route, so a customer never downloads POS code.
- Rejected: a monorepo `packages/ui` — with one consumer it is pure indirection. Revisit if a Tauri POS
  wrapper (plan §2) becomes real.
- Cost: the storefront and admin share a deployment. If the storefront ever needs to scale independently
  of admin, the route groups split into separate apps with the shared code lifted into a package.
