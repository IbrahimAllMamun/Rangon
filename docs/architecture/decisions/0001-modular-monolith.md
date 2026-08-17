# ADR-0001 — Modular monolith, not microservices

**Status:** Accepted · 2026-08-17

## Context

The platform spans catalog, inventory, purchasing, POS, online orders, payments, shipping and reporting.
A tempting reading of that list is "one service per domain". The business is a single fashion retailer
with one branch at launch.

## Decision

One Django project (`apps/api`) with clearly bounded apps and a one-way dependency graph. Deployment is
one API image, one web image, plus worker/beat.

## Consequences

- Inventory and orders share a **database transaction**, which is the only cheap way to guarantee "stock
  and order are consistent". Splitting them would require sagas/outbox for the highest-risk invariant in
  the system.
- Refactoring boundaries is a directory move rather than a network contract change.
- Scaling is vertical + replicas first. If one domain genuinely needs independent scaling later, the app
  boundaries and service-layer entry points are already the extraction seams.
- Enforced by review: `inventory` must not import `orders`; cross-app calls go through service functions.
