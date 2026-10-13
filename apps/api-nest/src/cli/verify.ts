import { money, quantize } from '../checkout/pricing';
import { balanceDrift, repairBalanceDrift } from '../finance/integrity';
import { repairStockDrift, stockDrift } from '../inventory/integrity';
import { Refusal } from './migrate';
import { branchByCode, type Flags, inTransaction, NO_REQUEST, text } from './session';

/** Python's `{value:+d}`: the sign always. */
const signed = (value: bigint) => `${value < 0n ? '-' : '+'}${value < 0n ? -value : value}`;

/**
 * `verify-inventory`: `manage.py verify_inventory`. Check the stock ledger
 * against the cached stock columns, for one branch or all.
 *
 *     node dist/cli.js verify-inventory [--branch DHK1] [--fix --reason "..."]
 *
 * `--fix` never edits the ledger: it appends the rows that explain each
 * difference, so the correction is itself on record
 * (docs/operations/disaster-recovery.md). The lines it prints are the
 * management command's.
 */
export async function verifyInventory(
  databaseUrl: string,
  log: (line: string) => void,
  flags: Flags,
): Promise<void> {
  const reason = text(flags, 'reason');
  await inTransaction(databaseUrl, async (q) => {
    const branch = await branchByCode(q, text(flags, 'branch'));
    const drifted = await stockDrift(q, branch?.id ?? null);
    if (!drifted.length) {
      log('Inventory is consistent with the ledger.');
      return;
    }
    log(`${drifted.length} position(s) drifted from the ledger:`);
    for (const drift of drifted) {
      log(
        `  ${drift.sku.padEnd(28)} @ ${drift.branchCode.padEnd(6)} ` +
          `on_hand cached=${drift.cachedOnHand} ledger=${drift.ledgerOnHand} ` +
          `(drift ${signed(BigInt(drift.cachedOnHand) - BigInt(drift.ledgerOnHand))})  ` +
          `reserved cached=${drift.cachedReserved} ledger=${drift.ledgerReserved} ` +
          `(drift ${signed(BigInt(drift.cachedReserved) - BigInt(drift.ledgerReserved))})`,
      );
    }
    if (!flags.fix) {
      log(
        "\nRun again with --fix --reason '...' to reconcile. Investigate the cause first: " +
          'drift means something wrote stock outside inventory.services.',
      );
      return;
    }
    if (!reason.trim()) throw new Refusal('--fix requires --reason.');
    for (const drift of drifted) await repairStockDrift(q, NO_REQUEST, drift, reason);
    log(`Reconciled ${drifted.length} position(s).`);
  });
}

/**
 * `verify-accounts`: `manage.py verify_accounts`. Check the cash book against
 * the cached account balances, for one branch or all, and say what money
 * posted to no account at all.
 *
 *     node dist/cli.js verify-accounts [--branch DHK1] [--fix --reason "..."] [--skip-unposted]
 *
 * The unposted events -- captured payments, completed refunds and supplier
 * payments that name no account, because the branch had none able to hold
 * that method's money when they happened -- are not drift and cannot be
 * repaired by replaying anything. Listing them is the honest alternative to
 * guessing.
 */
export async function verifyAccounts(
  databaseUrl: string,
  log: (line: string) => void,
  flags: Flags,
): Promise<void> {
  const reason = text(flags, 'reason');
  await inTransaction(databaseUrl, async (q) => {
    const branch = await branchByCode(q, text(flags, 'branch'));
    const drifted = await balanceDrift(q, branch?.id ?? null);
    if (drifted.length) {
      log(`${drifted.length} account(s) drifted from the cash book:`);
      for (const drift of drifted) {
        const by = quantize(drift.cached.minus(drift.ledger));
        log(
          `  ${drift.name.padEnd(28)} @ ${drift.branchCode.padEnd(6)} ` +
            `cached=${money(drift.cached)} ledger=${money(drift.ledger)} ` +
            `(drift ${by.isNegative() ? '' : '+'}${money(by)})`,
        );
      }
    } else {
      log('Accounts are consistent with the cash book.');
    }

    if (!flags['skip-unposted']) {
      const scope = branch ? 'AND o.branch_id = $1' : '';
      const values = branch ? [branch.id] : [];
      const count = async (sql: string) =>
        Number((await q.one<{ n: string }>(sql, values))?.n ?? 0);
      const rows: [string, number][] = [
        [
          'captured payments',
          await count(
            `SELECT count(*) AS n FROM orders_payment p JOIN orders_order o ON o.id = p.order_id
              WHERE p.account_id IS NULL
                AND p.status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED') ${scope}`,
          ),
        ],
        [
          'completed refunds',
          await count(
            `SELECT count(*) AS n FROM orders_refund r JOIN orders_order o ON o.id = r.order_id
              WHERE r.account_id IS NULL AND r.status = 'COMPLETED' ${scope}`,
          ),
        ],
        [
          'supplier payments',
          await count(
            `SELECT count(*) AS n FROM purchasing_supplierpayment s
               JOIN purchasing_purchaseorder o ON o.id = s.purchase_order_id
              WHERE s.account_id IS NULL ${scope}`,
          ),
        ],
      ];
      const total = rows.reduce((all, [, n]) => all + n, 0);
      if (!total) {
        log('Every money event names an account.');
      } else {
        log(
          `\n${total} money event(s) posted nothing to any account ` +
            '(no account existed for that method at the time):',
        );
        for (const [label, n] of rows) if (n) log(`  ${String(n).padStart(6)}  ${label}`);
        log(
          "  These cannot be repaired by replaying the ledger -- the money's destination was " +
            'never recorded. Open the accounts you need so that future events post, and treat ' +
            'the figures above as a known gap.',
        );
      }
    }

    if (!drifted.length) return;
    if (!flags.fix) {
      log(
        "\nRun again with --fix --reason '...' to reconcile. Investigate the cause first: " +
          'drift means something wrote a balance outside finance.services.',
      );
      return;
    }
    if (!reason.trim()) throw new Refusal('--fix requires --reason.');
    for (const drift of drifted) await repairBalanceDrift(q, NO_REQUEST, drift, reason);
    log(`Reconciled ${drifted.length} account(s).`);
  });
}
