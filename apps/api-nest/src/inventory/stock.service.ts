import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { quantize } from '../checkout/pricing';
import { AuditActor, AuditContext, recordAudit } from '../common/audit';
import { Dec } from '../common/decimal';
import { InsufficientStock, NotFound, NotReceived, ValidationError } from '../common/errors';
import { pyRepr, pyStrip } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { CeleryService } from '../jobs/celery.service';

/**
 * `inventory.services`: the only code that moves stock (CLAUDE.md section
 * 3.2), for the storefront's checkout and the admin alike.
 *
 * Every movement as Django makes it: one transaction; the inventory rows
 * locked `FOR UPDATE` lowest id first (created first if the branch never held
 * the variant), so a movement through either API waits for the other rather
 * than deadlocking against it; every line checked under the lock before any
 * is written; the cached row and its append-only ledger entry written
 * together; a low-stock job queued only once the transaction commits.
 *
 * A variant that does not exist still gets an inventory row -- Django's
 * foreign keys are checked at commit -- and the first thing to read its SKU
 * fails: Django's `RelatedObjectDoesNotExist`, which the API answers 404.
 */

export const TRANSACTION_TYPES = [
  'PURCHASE',
  'SALE',
  'RETURN',
  'DAMAGE',
  'LOSS',
  'ADJUSTMENT',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'RESERVATION',
  'RESERVATION_RELEASE',
  'PURCHASE_RETURN',
] as const;

/** `TransactionType` labels: `get_transaction_type_display()`. */
export const TRANSACTION_LABELS: Readonly<Record<string, string>> = {
  PURCHASE: 'Purchase received',
  SALE: 'Sale',
  RETURN: 'Customer return',
  DAMAGE: 'Damaged',
  LOSS: 'Lost or stolen',
  ADJUSTMENT: 'Manual adjustment',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
  RESERVATION: 'Reserved for an order',
  RESERVATION_RELEASE: 'Reservation released',
  PURCHASE_RETURN: 'Returned to supplier',
};

export const RESERVATION_AFFECTING: ReadonlySet<string> = new Set([
  'RESERVATION',
  'RESERVATION_RELEASE',
]);
const REASON_REQUIRED = new Set(['ADJUSTMENT', 'DAMAGE', 'LOSS']);
const SIGN: Readonly<Record<string, number>> = {
  PURCHASE: 1,
  SALE: -1,
  RETURN: 1,
  DAMAGE: -1,
  LOSS: -1,
  TRANSFER_IN: 1,
  TRANSFER_OUT: -1,
  PURCHASE_RETURN: -1,
  RESERVATION: 1,
  RESERVATION_RELEASE: -1,
  ADJUSTMENT: 0,
};

export interface Branch {
  id: string;
  code: string;
}

export interface LockedInventory {
  id: string;
  branch_id: string;
  variant_id: string;
  on_hand: number;
  reserved: number;
  average_cost: string;
  reorder_point: number;
  /** Null when the variant does not exist. */
  sku: string | null;
  branch_code: string;
}

/** An `InventoryTransaction` row as written: enough to read it back. */
export interface LedgerEntry {
  id: string;
  branch_id: string;
  variant_id: string;
}

/** Jobs to queue once the transaction commits: `transaction.on_commit`. */
export class AfterCommit {
  readonly jobs: [task: string, args: unknown[]][] = [];

  /** `_schedule_low_stock_check`: only a row at or below its reorder point. */
  lowStockCheck(inventory: LockedInventory): void {
    if (inventory.on_hand - inventory.reserved <= inventory.reorder_point)
      this.jobs.push(['inventory.tasks.notify_low_stock', [inventory.id]]);
  }
}

/**
 * A whole number as Python holds it: exact past 2^53. A serializer's
 * `IntegerField` answers a bigint there; PostgreSQL then refuses it for the
 * `integer` column, as it refuses Django's.
 */
export type Count = number | bigint;

/** A Python int for a response: a number while it is exact. */
function exact(value: bigint): Count {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/** The SKU of a locked row, or Django's 404 for a variant that is not there. */
function skuOf(inventory: LockedInventory): string {
  if (inventory.sku === null) throw new NotFound();
  return inventory.sku;
}

@Injectable()
export class StockService {
  constructor(
    private readonly db: Database,
    private readonly celery: CeleryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Run `work` in one transaction, then queue what it scheduled, in order. */
  async run<T>(work: (tx: Queryable, after: AfterCommit) => Promise<T>): Promise<T> {
    const after = new AfterCommit();
    const result = await this.db.transaction((tx) => work(tx, after));
    for (const [task, args] of after.jobs) await this.celery.delay(task, args);
    return result;
  }

  /**
   * `_lock_inventories`: one row per variant, created if the branch never
   * held it (`get_or_create`: a concurrent creator wins and this reads its
   * row), then all locked, lowest id first.
   */
  async lock(
    tx: Queryable,
    branchId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, LockedInventory>> {
    const unique = [...new Set(variantIds)];
    for (const variantId of unique) {
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
      `SELECT i.id, i.branch_id, i.variant_id, i.on_hand, i.reserved, i.average_cost, i.reorder_point,
              v.sku, b.code AS branch_code
         FROM inventory_inventory i
         LEFT JOIN catalog_productvariant v ON v.id = i.variant_id
         JOIN accounts_branch b ON b.id = i.branch_id
        WHERE i.branch_id = $1::uuid AND i.variant_id = ANY($2::uuid[])
        ORDER BY i.id
        FOR UPDATE OF i`,
      [branchId, unique],
    );
    return new Map(rows.map((row) => [row.variant_id, row]));
  }

  /** `_write_ledger`: apply `delta` to the locked row and append its ledger entry. */
  async writeLedger(
    tx: Queryable,
    inventory: LockedInventory,
    entry: {
      type: string;
      delta: Count;
      actor: AuditActor | null;
      referenceType: string;
      referenceId: string | null;
      reason: string;
      notes: string;
      unitCost: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<LedgerEntry> {
    const reserving = RESERVATION_AFFECTING.has(entry.type);
    const onHand = BigInt(inventory.on_hand) + (reserving ? 0n : BigInt(entry.delta));
    const reserved = BigInt(inventory.reserved) + (reserving ? BigInt(entry.delta) : 0n);
    // Past `integer`, PostgreSQL refuses the row here, as it does Django's.
    await tx.query(
      `UPDATE inventory_inventory SET on_hand = $2, reserved = $3, average_cost = $4,
              updated_at = clock_timestamp() WHERE id = $1::uuid`,
      [inventory.id, onHand.toString(), reserved.toString(), inventory.average_cost],
    );
    inventory.on_hand = Number(onHand);
    inventory.reserved = Number(reserved);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO inventory_inventorytransaction
         (id, created_at, updated_at, branch_id, variant_id, transaction_type, quantity, unit_cost,
          on_hand_after, reserved_after, reference_type, reference_id, reason, notes, created_by_id,
          idempotency_key)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
               $9, $10, $11, $12, $13::uuid, $14)`,
      [
        id,
        inventory.branch_id,
        inventory.variant_id,
        entry.type,
        entry.delta.toString(),
        entry.unitCost,
        inventory.on_hand,
        inventory.reserved,
        entry.referenceType || 'manual',
        entry.referenceId || '',
        entry.reason,
        entry.notes,
        entry.actor?.id ?? null,
        entry.idempotencyKey || null,
      ],
    );
    return { id, branch_id: inventory.branch_id, variant_id: inventory.variant_id };
  }

  /** `_check_can_reduce`: stock may not go below zero, oversell aside. */
  checkCanReduce(inventory: LockedInventory, delta: Count, allowNegative = false): void {
    if (delta >= 0) return;
    const after = BigInt(inventory.on_hand) + BigInt(delta);
    if (after < 0n && !(allowNegative || this.env.RANGON_ALLOW_OVERSELL)) {
      const sku = skuOf(inventory);
      throw new InsufficientStock(
        `Only ${inventory.on_hand} unit(s) of ${sku} are in stock at ${inventory.branch_code}.`,
        {
          details: {
            variant_id: inventory.variant_id,
            sku,
            branch: inventory.branch_code,
            requested: exact(-BigInt(delta)),
            on_hand: inventory.on_hand,
            available: inventory.on_hand - inventory.reserved,
          },
        },
      );
    }
  }

  /** `received_variant_ids`: the variants this branch has ever received at a cost. */
  async receivedVariantIds(
    q: Queryable,
    branchId: string,
    variantIds: readonly string[],
  ): Promise<Set<string>> {
    if (!variantIds.length) return new Set();
    const rows = await q.query<{ variant_id: string }>(
      `SELECT DISTINCT variant_id FROM inventory_inventorytransaction
        WHERE branch_id = $1::uuid AND variant_id = ANY($2::uuid[])
          AND transaction_type IN ('PURCHASE', 'TRANSFER_IN')`,
      [branchId, variantIds],
    );
    return new Set(rows.map((row) => row.variant_id));
  }

  /** `_check_can_raise`: an adjustment upwards only where the branch has received the variant. */
  async checkCanRaise(tx: Queryable, inventory: LockedInventory, delta: Count): Promise<void> {
    if (delta <= 0) return;
    const received = await this.receivedVariantIds(tx, inventory.branch_id, [inventory.variant_id]);
    if (received.size) return;
    const sku = skuOf(inventory);
    throw new NotReceived(
      `${sku} has never been received at ${inventory.branch_code}, so there is no cost to count ` +
        'it in at. Receive it on a purchase order.',
      {
        details: {
          variant_id: inventory.variant_id,
          sku,
          branch: inventory.branch_code,
          requested: delta,
          on_hand: inventory.on_hand,
        },
      },
    );
  }

  /** `str(inventory)`: `"<sku> @ <branch>: <available> available"`. */
  private label(inventory: LockedInventory): string {
    const available = inventory.on_hand - inventory.reserved;
    return `${skuOf(inventory)} @ ${inventory.branch_code}: ${available} available`;
  }

  /** `InventoryTransaction.objects.filter(idempotency_key=key).first()`. */
  private async byKey(q: Queryable, key: string): Promise<LedgerEntry | null> {
    return q.one<LedgerEntry>(
      `SELECT id, branch_id, variant_id FROM inventory_inventorytransaction
        WHERE idempotency_key = $1 ORDER BY created_at DESC LIMIT 1`,
      [key],
    );
  }

  /**
   * `apply_transaction` for a movement of stock (not of reservations, which
   * no ported caller makes this way): idempotent on its key -- looked up
   * before the lock, again once it is held (a retry still in flight has
   * committed by then, D89), then claimed by the ledger row itself in a
   * savepoint, so a retry that loses the race is answered with the winner's
   * row (D90).
   */
  async applyTransaction(
    tx: Queryable,
    after: AfterCommit,
    movement: {
      branch: Branch;
      variantId: string;
      type: string;
      quantity: Count;
      actor: AuditActor | null;
      referenceType?: string;
      referenceId?: string | null;
      reason?: string;
      notes?: string;
      unitCost?: string | null;
      allowNegative?: boolean;
      idempotencyKey?: string | null;
    },
  ): Promise<LedgerEntry> {
    const key = movement.idempotencyKey || null;
    if (key) {
      const existing = await this.byKey(tx, key);
      if (existing) return existing;
    }
    if (!(TRANSACTION_TYPES as readonly string[]).includes(movement.type))
      throw new ValidationError(`Unknown transaction type ${pyRepr(movement.type)}.`);
    if (RESERVATION_AFFECTING.has(movement.type))
      throw new Error('apply_transaction is not ported for reservations');
    const reason = movement.reason ?? '';
    if (REASON_REQUIRED.has(movement.type) && !pyStrip(reason)) {
      throw new ValidationError(`A reason is required for ${movement.type}.`, {
        details: { reason: ['Required.'] },
      });
    }
    const sign = SIGN[movement.type] as number;
    let delta: Count;
    if (sign === 0) {
      delta = movement.quantity;
      if (BigInt(delta) === 0n) throw new ValidationError('An adjustment of zero has no effect.');
    } else {
      if (movement.quantity <= 0)
        throw new ValidationError(`Quantity must be positive for ${movement.type}.`);
      delta = exact(BigInt(sign) * BigInt(movement.quantity));
    }

    const inventory = (await this.lock(tx, movement.branch.id, [movement.variantId])).get(
      movement.variantId,
    ) as LockedInventory;
    if (key) {
      const existing = await this.byKey(tx, key);
      if (existing) return existing;
    }
    this.checkCanReduce(inventory, delta, movement.allowNegative ?? false);
    if (movement.type === 'ADJUSTMENT') await this.checkCanRaise(tx, inventory, delta);

    await tx.query('SAVEPOINT apply_transaction');
    let entry: LedgerEntry;
    try {
      entry = await this.writeLedger(tx, inventory, {
        type: movement.type,
        delta,
        actor: movement.actor,
        referenceType: movement.referenceType ?? 'manual',
        referenceId: movement.referenceId ?? null,
        reason,
        notes: movement.notes ?? '',
        unitCost: movement.unitCost ?? null,
        idempotencyKey: key,
      });
      await tx.query('RELEASE SAVEPOINT apply_transaction');
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT apply_transaction');
      // `except IntegrityError`: the key was claimed by a retry that got there first.
      if (key && String((error as { code?: unknown }).code ?? '').startsWith('23')) {
        const existing = await this.byKey(tx, key);
        if (existing) return existing;
      }
      throw error;
    }
    after.lowStockCheck(inventory);
    return entry;
  }

  /**
   * `reserve`: hold stock for an online order, all or nothing. Answers the
   * inventory rows left at or below their reorder point, for the caller to
   * alert on once the transaction commits.
   */
  async reserve(
    tx: Queryable,
    branch: Branch,
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

    // `_check_can_reserve`, every line before any is written.
    for (const [variantId, quantity] of materialised) {
      const inventory = inventories.get(variantId) as LockedInventory;
      const available = inventory.on_hand - inventory.reserved;
      if (quantity > 0 && available < quantity && !this.env.RANGON_ALLOW_OVERSELL) {
        const sku = skuOf(inventory);
        throw new InsufficientStock(
          `Only ${available} unit(s) of ${sku} are available at ${branch.code}.`,
          {
            details: {
              variant_id: variantId,
              sku,
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
      await this.writeLedger(tx, inventory, {
        type: 'RESERVATION',
        delta: quantity,
        actor: null,
        referenceType: 'order',
        referenceId: orderId,
        reason: '',
        notes: '',
        unitCost: null,
      });
      if (inventory.on_hand - inventory.reserved <= inventory.reorder_point)
        lowStock.push(inventory.id);
    }
    return lowStock;
  }

  /** `adjust`: correct stock to a counted figure by writing the difference. */
  async adjust(
    tx: Queryable,
    after: AfterCommit,
    context: AuditContext,
    adjustment: {
      branch: Branch;
      variantId: string;
      newOnHand: Count;
      reason: string;
      actor: AuditActor | null;
      referenceType?: string;
      referenceId?: string | null;
    },
  ): Promise<LedgerEntry | null> {
    if (!pyStrip(adjustment.reason))
      throw new ValidationError('A reason is required for an adjustment.');
    if (adjustment.newOnHand < 0) throw new ValidationError('Counted stock cannot be negative.');
    const inventory = (await this.lock(tx, adjustment.branch.id, [adjustment.variantId])).get(
      adjustment.variantId,
    ) as LockedInventory;
    const delta = exact(BigInt(adjustment.newOnHand) - BigInt(inventory.on_hand));
    if (delta === 0) return null;
    await this.checkCanRaise(tx, inventory, delta);
    const before = { on_hand: inventory.on_hand, reserved: inventory.reserved };
    const entry = await this.writeLedger(tx, inventory, {
      type: 'ADJUSTMENT',
      delta,
      actor: adjustment.actor,
      referenceType: adjustment.referenceType ?? 'manual',
      referenceId: adjustment.referenceId ?? null,
      reason: adjustment.reason,
      notes: '',
      unitCost: inventory.average_cost,
    });
    await recordAudit(tx, context, {
      action: 'STOCK_ADJUSTMENT',
      entity: { type: 'Inventory', id: inventory.id, label: this.label(inventory) },
      actor: adjustment.actor,
      oldValues: before,
      newValues: { on_hand: inventory.on_hand, reserved: inventory.reserved },
      reason: adjustment.reason,
      branchId: adjustment.branch.id,
    });
    after.lowStockCheck(inventory);
    return entry;
  }

  /** `write_off`: damage or loss, with a reason, audited -- on a replay too. */
  async writeOff(
    tx: Queryable,
    after: AfterCommit,
    context: AuditContext,
    writeOff: {
      branch: Branch;
      variantId: string;
      quantity: Count;
      type: string;
      reason: string;
      notes: string;
      actor: AuditActor | null;
      idempotencyKey: string | null;
    },
  ): Promise<LedgerEntry> {
    if (writeOff.type !== 'DAMAGE' && writeOff.type !== 'LOSS')
      throw new ValidationError('Write-off must be DAMAGE or LOSS.');
    const entry = await this.applyTransaction(tx, after, {
      branch: writeOff.branch,
      variantId: writeOff.variantId,
      type: writeOff.type,
      quantity: writeOff.quantity,
      actor: writeOff.actor,
      referenceType: 'manual',
      reason: writeOff.reason,
      notes: writeOff.notes,
      idempotencyKey: writeOff.idempotencyKey,
    });
    const variant = await tx.one<{ sku: string }>(
      `SELECT sku FROM catalog_productvariant WHERE id = $1::uuid`,
      [entry.variant_id],
    );
    if (!variant) throw new NotFound();
    await recordAudit(tx, context, {
      action: 'STOCK_ADJUSTMENT',
      entityType: 'Inventory',
      entityId: entry.variant_id,
      entityLabel: `${variant.sku} @ ${writeOff.branch.code}`,
      actor: writeOff.actor,
      newValues: { type: writeOff.type, quantity: exact(-BigInt(writeOff.quantity)) },
      reason: writeOff.reason,
      branchId: writeOff.branch.id,
    });
    return entry;
  }

  /**
   * `receive_stock`: stock in at a cost, the branch's weighted average moved
   * to take it, the variant's "latest cost" set to it.
   */
  async receiveStock(
    tx: Queryable,
    receipt: {
      branch: Branch;
      variantId: string;
      quantity: number;
      unitCost: string;
      actor: AuditActor | null;
      referenceType: string;
      referenceId: string | null;
      notes: string;
    },
  ): Promise<LedgerEntry> {
    if (receipt.quantity <= 0) throw new ValidationError('Received quantity must be positive.');
    const unitCost = quantize(new Dec(receipt.unitCost));
    if (unitCost.lt(0)) throw new ValidationError('Unit cost cannot be negative.');
    const inventory = (await this.lock(tx, receipt.branch.id, [receipt.variantId])).get(
      receipt.variantId,
    ) as LockedInventory;
    const previous = Math.max(inventory.on_hand, 0);
    const total = previous + receipt.quantity;
    inventory.average_cost = quantize(
      new Dec(previous)
        .times(inventory.average_cost)
        .plus(new Dec(receipt.quantity).times(unitCost))
        .div(total),
    ).toFixed(2);
    const entry = await this.writeLedger(tx, inventory, {
      type: 'PURCHASE',
      delta: receipt.quantity,
      actor: receipt.actor,
      referenceType: receipt.referenceType,
      referenceId: receipt.referenceId,
      reason: '',
      notes: receipt.notes,
      unitCost: unitCost.toFixed(2),
    });
    await tx.query(`UPDATE catalog_productvariant SET cost = $2 WHERE id = $1::uuid`, [
      receipt.variantId,
      unitCost.toFixed(2),
    ]);
    return entry;
  }
}
