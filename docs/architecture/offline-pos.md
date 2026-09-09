# Offline POS — design notes (declined)

> **Dropped 2026-09-09 on the owner's decision.** This is no longer a plan; it is the record of what
> was considered and why it was not worth building. A local queue, a sync path and conflict
> resolution on a ledger that must not oversell is a large build to set against an occasional
> outage that one counter covers with a paper pad and a re-key. Revisit only if the shop runs
> several busy counters on an unreliable line.

Per plan §29, offline POS was only ever to be built **after** the online POS had proven itself in
production. What follows records the intended design, and it still earns its place: the online POS
was deliberately built in a way that does not block it, and those properties are worth keeping.

Status: **declined.** The POS requires connectivity.

## What the online POS already does to keep this possible

- All POS operations go through a small set of endpoints (`/pos/lookup`, `/pos/sales`, `/pos/holds`)
  with request bodies that are complete, self-describing commands — not incremental state mutations.
- Sale creation is idempotent on a client-generated `client_sale_id`, so a queued sale can be retried
  safely.
- The POS cart is client state in Zustand; nothing authoritative lives in component state.
- Product/price/barcode lookup is a single read endpoint that can be mirrored into a local cache.

## Planned mechanism

```text
Service Worker            app shell + static assets
IndexedDB "pos-cache"     variants (sku, barcode, name, price, tax), customers (recent), settings
IndexedDB "pos-queue"     pending sales (client_sale_id, payload, created_at, attempts, last_error)
Sync engine               online → drain queue in order, one request at a time
```

Cached data is limited to what a sale needs. The admin, reports and inventory screens are never offline.

## Sync

```text
local queue → POST /pos/sales (Idempotency-Key: client_sale_id)
            → server validates stock, prices, permissions, register
            → atomic sale + ledger write
            → 201 created | 200 already-processed | 409 rejected
            → mark local record synced | resolve conflict
```

## Conflict rules (decided in advance)

| Situation | Rule |
|---|---|
| Stock went negative because two registers sold offline | Accept the sale, allow negative, flag an `OVERSOLD` exception for the manager. A customer already left with the goods — the ledger must reflect reality. |
| Price changed while offline | The offline price stands for that sale; the difference is reported. |
| Product deleted/unpublished while offline | Accept; report. |
| Same `client_sale_id` already synced | Return the existing sale (idempotent), never duplicate. |
| Cashier's permission revoked while offline | Reject with `409`, queue moves to a manager review list. |

This is the one place where the "never oversell" rule is deliberately relaxed, because the physical
transaction has already happened. It requires an explicit oversell exception report before the feature
can be enabled — which is why it is V2, not V1.
