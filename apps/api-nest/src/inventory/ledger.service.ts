import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { InsufficientStock } from '../common/errors';
import { ENV, Env } from '../config/env';
import { Queryable } from '../database/database.service';

interface LockedInventory {
  id: string;
  variant_id: string;
  on_hand: number;
  reserved: number;
  average_cost: string;
  reorder_point: number;
  sku: string;
}

/**
 * `inventory.services`: stock moves only here, and every move is a ledger row
 * (CLAUDE.md section 3.2). Only what checkout needs is ported: holding stock
 * for an online order (`reserve`).
 *
 * The rules that make it safe are Django's, kept exactly: the inventory rows
 * are locked with `SELECT ... FOR UPDATE` in primary-key order -- the order
 * Django locks them in, so a sale through either API waits for the other
 * rather than deadlocking against it -- and every line is checked under the
 * lock before any is written, so a batch is all or nothing.
 */
@Injectable()
export class InventoryLedgerService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * `_lock_inventories`: one row per variant, created if the branch never
   * held it, then all locked, lowest id first.
   */
  private async lock(
    tx: Queryable,
    branchId: string,
    variantIds: string[],
  ): Promise<Map<string, LockedInventory>> {
    const unique = [...new Set(variantIds)];
    for (const variantId of unique) {
      // `get_or_create`: a concurrent creator wins and this one reads its row.
      await tx.query(
        `INSERT INTO inventory_inventory
           (id, created_at, updated_at, on_hand, reserved, average_cost, reorder_point, bin_location,
            branch_id, variant_id)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), 0, 0, 0, $2, '', $3::uuid, $4::uuid)
         ON CONFLICT (branch_id, variant_id) DO NOTHING`,
        [randomUUID(), this.env.RANGON_LOW_STOCK_THRESHOLD, branchId, variantId],
      );
    }
    const rows = await tx.query<LockedInventory>(
      `SELECT i.id, i.variant_id, i.on_hand, i.reserved, i.average_cost, i.reorder_point, v.sku
         FROM inventory_inventory i JOIN catalog_productvariant v ON v.id = i.variant_id
        WHERE i.branch_id = $1::uuid AND i.variant_id = ANY($2::uuid[])
        ORDER BY i.id
        FOR UPDATE OF i`,
      [branchId, unique],
    );
    return new Map(rows.map((row) => [row.variant_id, row]));
  }

  /**
   * `reserve`: hold stock for an online order, all or nothing. Answers the
   * inventory rows left at or below their reorder point, for the caller to
   * alert on once the transaction commits (`_schedule_low_stock_check`).
   */
  async reserve(
    tx: Queryable,
    branch: { id: string; code: string },
    lines: [variantId: string, quantity: number][],
    orderId: string,
  ): Promise<string[]> {
    const materialised = lines.filter(([, quantity]) => quantity !== 0);
    if (!materialised.length) return [];
    const inventories = await this.lock(
      tx,
      branch.id,
      materialised.map(([variantId]) => variantId),
    );

    // Every line is checked before any is written.
    for (const [variantId, quantity] of materialised) {
      const inventory = inventories.get(variantId) as LockedInventory;
      const available = inventory.on_hand - inventory.reserved;
      if (quantity > 0 && available < quantity && !this.env.RANGON_ALLOW_OVERSELL) {
        throw new InsufficientStock(
          `Only ${available} unit(s) of ${inventory.sku} are available at ${branch.code}.`,
          {
            details: {
              variant_id: variantId,
              sku: inventory.sku,
              branch: branch.code,
              requested: quantity,
              available,
            },
          },
        );
      }
    }

    const lowStock: string[] = [];
    for (const [variantId, quantity] of materialised) {
      const inventory = inventories.get(variantId) as LockedInventory;
      inventory.reserved += quantity;
      // `_write_ledger`: the cached row and its ledger entry, together.
      await tx.query(
        `UPDATE inventory_inventory SET updated_at = clock_timestamp(), on_hand = $2, reserved = $3,
                average_cost = $4 WHERE id = $1::uuid`,
        [inventory.id, inventory.on_hand, inventory.reserved, inventory.average_cost],
      );
      await tx.query(
        `INSERT INTO inventory_inventorytransaction
           (id, created_at, updated_at, branch_id, variant_id, transaction_type, quantity, unit_cost,
            on_hand_after, reserved_after, reference_type, reference_id, reason, notes, created_by_id,
            idempotency_key)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, 'RESERVATION', $4,
                 NULL, $5, $6, 'order', $7, '', '', NULL, NULL)`,
        [
          randomUUID(),
          branch.id,
          variantId,
          quantity,
          inventory.on_hand,
          inventory.reserved,
          orderId,
        ],
      );
      // `Inventory.is_low_stock`.
      if (inventory.on_hand - inventory.reserved <= inventory.reorder_point)
        lowStock.push(inventory.id);
    }
    return lowStock;
  }
}
