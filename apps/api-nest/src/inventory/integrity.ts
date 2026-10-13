import { randomUUID } from 'node:crypto';

import { type AuditActor, type AuditContext, recordAudit } from '../common/audit';
import type { Queryable } from '../database/database.service';

/** A shelf whose cached figures are not what its ledger adds up to. */
export interface StockDrift {
  inventoryId: string;
  branchId: string;
  sku: string;
  branchCode: string;
  cachedOnHand: number;
  ledgerOnHand: number | bigint;
  cachedReserved: number;
  ledgerReserved: number | bigint;
}

/** A sum as PostgreSQL prints it: a number while it is exact, a bigint past that. */
function sum(text: string | null): number | bigint {
  if (text === null) return 0;
  const value = BigInt(text);
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/**
 * `inventory.services.verify_integrity`: replay the ledger against the cached
 * columns, for one branch or all, and answer the shelves that differ -- by
 * branch, SKU and then the row's id, so that a drift is listed the same way
 * each time (D245). The check the stock screen, the nightly job and
 * `verify-inventory` all make.
 */
export async function stockDrift(q: Queryable, branchId: string | null): Promise<StockDrift[]> {
  const ledger = await q.query<{
    branch_id: string;
    variant_id: string;
    on_hand: string | null;
    reserved: string | null;
  }>(
    `SELECT "inventory_inventorytransaction"."branch_id", "inventory_inventorytransaction"."variant_id",
            SUM("inventory_inventorytransaction"."quantity") FILTER (WHERE NOT ("inventory_inventorytransaction"."transaction_type" IN ('RESERVATION_RELEASE', 'RESERVATION'))) AS "on_hand",
            SUM("inventory_inventorytransaction"."quantity") FILTER (WHERE "inventory_inventorytransaction"."transaction_type" IN ('RESERVATION_RELEASE', 'RESERVATION')) AS "reserved"
       FROM "inventory_inventorytransaction"
      ${branchId ? 'WHERE "inventory_inventorytransaction"."branch_id" = $1::uuid' : ''}
      GROUP BY "inventory_inventorytransaction"."branch_id", "inventory_inventorytransaction"."variant_id"`,
    branchId ? [branchId] : [],
  );
  const totals = new Map(
    ledger.map((row) => [
      `${row.branch_id} ${row.variant_id}`,
      [sum(row.on_hand), sum(row.reserved)] as const,
    ]),
  );
  const inventories = await q.query<{
    id: string;
    branch_id: string;
    variant_id: string;
    on_hand: number;
    reserved: number;
    sku: string;
    code: string;
  }>(
    `SELECT "inventory_inventory"."id", "inventory_inventory"."branch_id",
            "inventory_inventory"."variant_id", "inventory_inventory"."on_hand",
            "inventory_inventory"."reserved", "catalog_productvariant"."sku",
            "accounts_branch"."code"
       FROM "inventory_inventory"
       INNER JOIN "accounts_branch" ON ("inventory_inventory"."branch_id" = "accounts_branch"."id")
       INNER JOIN "catalog_productvariant" ON ("inventory_inventory"."variant_id" = "catalog_productvariant"."id")
      ${branchId ? 'WHERE "inventory_inventory"."branch_id" = $1::uuid' : ''}
      ORDER BY "accounts_branch"."code" ASC, "catalog_productvariant"."sku" ASC, "inventory_inventory"."id" ASC`,
    branchId ? [branchId] : [],
  );
  const drifted: StockDrift[] = [];
  for (const inventory of inventories) {
    const [onHand, reserved] = totals.get(`${inventory.branch_id} ${inventory.variant_id}`) ?? [
      0, 0,
    ];
    // Python compares ints exactly, a bigint sum included.
    if (
      BigInt(inventory.on_hand) !== BigInt(onHand) ||
      BigInt(inventory.reserved) !== BigInt(reserved)
    ) {
      drifted.push({
        inventoryId: inventory.id,
        branchId: inventory.branch_id,
        sku: inventory.sku,
        branchCode: inventory.code,
        cachedOnHand: inventory.on_hand,
        ledgerOnHand: onHand,
        cachedReserved: inventory.reserved,
        ledgerReserved: reserved,
      });
    }
  }
  return drifted;
}

/**
 * `inventory.services.repair_drift`: reconcile a drifted shelf with its
 * ledger, in the caller's transaction. Drift means something wrote the cached
 * column without a ledger row. The physical count is taken to match the cache
 * -- it is what staff have been looking at -- so the repair appends the rows
 * that explain the difference and leaves the cache alone. The ledger itself is
 * never edited.
 */
export async function repairStockDrift(
  q: Queryable,
  context: AuditContext,
  drift: StockDrift,
  reason: string,
  actor: AuditActor | null = null,
): Promise<void> {
  const inventory = (await q.one<{
    id: string;
    branch_id: string;
    variant_id: string;
    on_hand: number;
    reserved: number;
    average_cost: string;
  }>(
    `SELECT id, branch_id, variant_id, on_hand, reserved, average_cost
       FROM inventory_inventory WHERE id = $1::uuid FOR UPDATE`,
    [drift.inventoryId],
  )) as {
    id: string;
    branch_id: string;
    variant_id: string;
    on_hand: number;
    reserved: number;
    average_cost: string;
  };
  const explain = (type: string, quantity: bigint, unitCost: string | null, notes: string) =>
    q.query(
      `INSERT INTO inventory_inventorytransaction
         (id, created_at, updated_at, branch_id, variant_id, transaction_type, quantity, unit_cost,
          on_hand_after, reserved_after, reference_type, reference_id, reason, notes, created_by_id,
          idempotency_key)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
               'integrity_repair', $9, $10, $11, $12::uuid, NULL)`,
      [
        randomUUID(),
        inventory.branch_id,
        inventory.variant_id,
        type,
        quantity.toString(),
        unitCost,
        // The cache is unchanged by these rows.
        inventory.on_hand,
        inventory.reserved,
        inventory.id,
        reason,
        notes,
        actor?.id ?? null,
      ],
    );

  const unexplainedOnHand = BigInt(inventory.on_hand) - BigInt(drift.ledgerOnHand);
  if (unexplainedOnHand !== 0n) {
    await explain(
      'ADJUSTMENT',
      unexplainedOnHand,
      inventory.average_cost,
      'Ledger reconciliation: stock present but never recorded as a movement.',
    );
  }
  const unexplainedReserved = BigInt(inventory.reserved) - BigInt(drift.ledgerReserved);
  if (unexplainedReserved !== 0n) {
    await explain(
      unexplainedReserved > 0n ? 'RESERVATION' : 'RESERVATION_RELEASE',
      unexplainedReserved,
      null,
      'Ledger reconciliation: reservation cache did not match the ledger.',
    );
  }
  await recordAudit(q, context, {
    action: 'STOCK_ADJUSTMENT',
    entity: {
      type: 'Inventory',
      id: inventory.id,
      label: `${drift.sku} @ ${drift.branchCode}: ${inventory.on_hand - inventory.reserved} available`,
    },
    actor,
    oldValues: { ledger_on_hand: drift.ledgerOnHand, ledger_reserved: drift.ledgerReserved },
    newValues: { on_hand: inventory.on_hand, reserved: inventory.reserved },
    reason,
    branchId: inventory.branch_id,
  });
}
