# Offline POS — design notes (V2, not implemented)

Per plan §29, offline POS is only built **after** the online POS has proven itself in production. This
document records the intended design so the online POS is not built in a way that blocks it.

Status: **not implemented.** The POS today requires connectivity. The first of its preconditions —
the oversell exception report — is built; see *Gate 1* below.

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

## Gate 1 — oversell exception report: **built**

The report exists (`StockException`, `/api/v1/stock-exceptions/`,
`/admin/inventory/exceptions`). Rules in
[business-rules.md §1.4a](../business-rules.md); mechanism in
[inventory.md](inventory.md).

What it guarantees, and therefore what the sync engine may now rely on:

- Any reduction leaving `on_hand < 0` raises a row, from **every** path — the hook sits in
  `inventory.services._write_ledger`, not at the call sites, so the sync engine gets one for free
  without asking.
- The row is written in the same transaction as the ledger entry, so an accepted-then-rolled-back
  sale leaves nothing behind and an accepted one is never silent.
- It cannot be created, deleted or re-resolved through the API, and closing one needs
  `inventory.adjust` plus a written reason.

So the sync engine's job for the oversell row of the table above is now simply: pass
`allow_negative=True`. It does not detect, report or flag anything itself — that is already done, and
doing it twice is how the two copies drift.

## Remaining gates before offline POS can be enabled

1. **Price-drift and unpublished-product reporting.** Rows 2 and 3 of the conflict table promise
   "the difference is reported" and "accept; report". Nothing reports either yet. The oversell row
   above is the pattern to copy.
2. **A manager review list for rejected sales.** Row 5 sends a revoked-permission sale to "a manager
   review list" that does not exist. A `409` today is a dead end for a sale that physically happened.
3. **The queue itself** — service worker, `pos-cache`, `pos-queue`, drain engine.
