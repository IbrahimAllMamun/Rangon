import { randomUUID } from 'node:crypto';

import { money, quantize, ZERO } from '../checkout/pricing';
import { type AuditActor, type AuditContext, recordAudit } from '../common/audit';
import { Dec } from '../common/decimal';
import type { Queryable } from '../database/database.service';

/** An account whose cached balance is not what its cash book adds up to. */
export interface BalanceDrift {
  accountId: string;
  name: string;
  kind: string;
  branchId: string;
  branchCode: string;
  cached: Dec;
  ledger: Dec;
}

const KIND_LABELS: Record<string, string> = {
  CASH: 'Cash drawer',
  BANK: 'Bank account',
  MFS: 'Mobile financial service',
  OTHER: 'Other',
};

/**
 * `finance.services.verify_integrity`: every account's cached balance beside
 * the sum of its ledger, for one branch or all, and the ones that differ --
 * by branch, kind and name, the accounts' own order. The check the accounts
 * screen and `verify-accounts` both make.
 */
export async function balanceDrift(q: Queryable, branchId: string | null): Promise<BalanceDrift[]> {
  const rows = await q.query<{
    id: string;
    name: string;
    kind: string;
    branch_id: string;
    branch_code: string;
    balance: string;
    ledger: string | null;
  }>(
    `SELECT "finance_account"."id", "finance_account"."name", "finance_account"."kind",
            "finance_account"."branch_id", "accounts_branch"."code" AS "branch_code",
            "finance_account"."balance",
            (SELECT SUM(t."amount") FROM "finance_accounttransaction" t
              WHERE t."account_id" = "finance_account"."id") AS "ledger"
       FROM "finance_account"
       INNER JOIN "accounts_branch" ON ("finance_account"."branch_id" = "accounts_branch"."id")
      ${branchId ? 'WHERE "finance_account"."branch_id" = $1' : ''}
      ORDER BY "accounts_branch"."name" ASC, "finance_account"."kind" ASC, "finance_account"."name" ASC`,
    branchId ? [branchId] : [],
  );
  return rows
    .map((row) => ({
      accountId: row.id,
      name: row.name,
      kind: row.kind,
      branchId: row.branch_id,
      branchCode: row.branch_code,
      cached: quantize(row.balance),
      ledger: quantize(row.ledger ?? ZERO),
    }))
    .filter((drift) => !drift.cached.eq(drift.ledger));
}

/**
 * `finance.services.repair_drift`: reconcile a drifted balance with the cash
 * book, in the caller's transaction. As for stock: the cached figure is the
 * one people have been looking at, so the repair appends an entry that
 * explains the difference and leaves the cache alone. The ledger itself is
 * never edited.
 */
export async function repairBalanceDrift(
  q: Queryable,
  context: AuditContext,
  drift: BalanceDrift,
  reason: string,
  actor: AuditActor | null = null,
): Promise<void> {
  const account = (await q.one<{ id: string; balance: string }>(
    `SELECT id, balance FROM finance_account WHERE id = $1::uuid FOR UPDATE`,
    [drift.accountId],
  )) as { id: string; balance: string };
  const unexplained = quantize(new Dec(account.balance).minus(drift.ledger));
  if (unexplained.isZero()) return;
  await q.query(
    `INSERT INTO finance_accounttransaction
       (id, created_at, updated_at, account_id, transaction_type, amount, balance_after, reference_type,
        reference_id, reason, notes, occurred_at, created_by_id, idempotency_key)
     VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, 'ADJUSTMENT', $3, $4,
             'integrity_repair', $5, $6,
             'Appended by finance.repair_drift to explain cache/ledger drift.', clock_timestamp(),
             $7::uuid, NULL)`,
    // The cache is unchanged by this row.
    [
      randomUUID(),
      account.id,
      money(unexplained),
      account.balance,
      account.id,
      reason,
      actor?.id ?? null,
    ],
  );
  await recordAudit(q, context, {
    action: 'SETTINGS_CHANGED',
    entity: {
      type: 'Account',
      id: account.id,
      label: `${drift.name} (${KIND_LABELS[drift.kind] ?? drift.kind})`,
    },
    actor,
    oldValues: { ledger_balance: money(drift.ledger) },
    newValues: { cached_balance: account.balance, explained_by: money(unexplained) },
    reason,
    branchId: drift.branchId,
  });
}
