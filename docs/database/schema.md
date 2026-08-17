# Schema Notes

The migrations in `apps/api/*/migrations/` are the authoritative schema. This file records the rules
those migrations follow and the things a reader should know before writing a query.

## Conventions

- **PK:** `UUIDField(primary_key=True, default=uuid4, editable=False)` on every domain table
  ([ADR-0003](../architecture/decisions/0003-uuid-primary-keys.md)).
- **Timestamps:** `created_at` (auto_now_add) and `updated_at` (auto_now) on every table via
  `core.models.TimeStampedModel`. All UTC, `USE_TZ = True`.
- **Actor:** business tables carry `created_by` → `accounts.User` (`on_delete=PROTECT`, nullable for
  system/self-service actions).
- **Money:** `DecimalField(max_digits=14, decimal_places=2)`; helper `core.models.money_field()`.
  Rates/percentages `DecimalField(6, 4)`. **No `FloatField` anywhere in the project.**
- **Quantities:** `IntegerField` — Rangon sells whole units. A future fractional unit (fabric by the
  metre) would need a migration to `DecimalField(12, 3)`, noted here so it is a conscious change.
- **Deletes:** `PROTECT` for anything referenced by financial history; `CASCADE` only for rows that are
  meaningless without their parent (order items, images, attribute values).
- **Soft delete:** only where the plan requires history — products/customers use `status`/`is_active`,
  never a `deleted` boolean that half the queries forget to filter.
- **Append-only:** `InventoryTransaction`, `OrderEvent`, `PaymentEvent`, `ShipmentEvent`, `AuditLog`
  inherit `core.models.AppendOnlyModel`, which raises on update and on delete.

## Enum values are strings

Every choice field is a `TextChoices` with an explicit `UPPER_SNAKE` value stored in the column. Integer
enums are forbidden — a database dump must be readable without the code.

## Snapshot columns (deliberate denormalisation)

| Table | Snapshot | Why |
|---|---|---|
| `orders_orderitem` | `sku`, `product_name`, `variant_label`, `unit_price`, `unit_cost` | renaming or repricing a product must not rewrite sales history |
| `orders_order` | `shipping_address`, `billing_address` (JSON) | a customer editing their address must not alter a past invoice |
| `inventory_inventorytransaction` | `on_hand_after`, `reserved_after` | self-verifying ledger |
| `purchasing_purchasereceiptitem` | `unit_cost` | costing must reflect the price actually paid |

Denormalisation is only used for **history that must not change**, never as a performance shortcut that
can drift.

## Cached aggregates

`Inventory.on_hand` / `Inventory.reserved` are caches over `InventoryTransaction`
([ADR-0004](../architecture/decisions/0004-pessimistic-locking-for-stock.md)). They are maintained in
the same transaction as the ledger write and verified by `inventory.services.verify_integrity()`.
No other cached aggregate exists — `Order.paid_total` and `refunded_total` are recomputed from payments
inside the payment service, under the order row lock.

## Migration discipline

- Migrations are additive and reversible where practical; data migrations are separate from schema
  migrations and are idempotent.
- Risky changes use expand/contract: add nullable → backfill → switch reads → make non-null → drop old.
- Migrations run as a **deployment step**, not at container start
  ([operations/deployment.md](../operations/deployment.md)).
- `python manage.py makemigrations --check --dry-run` runs in CI: a model change without a migration
  fails the build.
