import { Injectable } from '@nestjs/common';

import { Database, Queryable } from '../database/database.service';
import { Params } from '../database/sql';

export interface AvailabilitySnapshot {
  variantId: string;
  onHand: number;
  reserved: number;
  available: number;
  averageCost: string;
}

/**
 * `inventory.services.availability`: a read-only stock snapshot, no locking.
 * Never a substitute for the lock a sale takes; a variant never stocked at the
 * branch reads as zero.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly db: Database) {}

  async availability(
    branchId: string | null,
    variantIds: string[],
    q: Queryable = this.db,
  ): Promise<Map<string, AvailabilitySnapshot>> {
    const snapshots = new Map<string, AvailabilitySnapshot>();
    if (branchId && variantIds.length) {
      const params = new Params();
      const rows = await q.query<{
        variant_id: string;
        on_hand: number;
        reserved: number;
        average_cost: string;
      }>(
        `SELECT variant_id, on_hand, reserved, average_cost FROM inventory_inventory
          WHERE branch_id = ${params.add(branchId, 'uuid')} AND variant_id IN ${params.list(variantIds, 'uuid')}`,
        params.values,
      );
      for (const row of rows) {
        snapshots.set(row.variant_id, {
          variantId: row.variant_id,
          onHand: row.on_hand,
          reserved: row.reserved,
          // `Inventory.available`: on hand less reserved, which can go negative.
          available: row.on_hand - row.reserved,
          averageCost: row.average_cost,
        });
      }
    }
    for (const id of variantIds) {
      if (!snapshots.has(id)) {
        snapshots.set(id, {
          variantId: id,
          onHand: 0,
          reserved: 0,
          available: 0,
          averageCost: '0.00',
        });
      }
    }
    return snapshots;
  }
}
