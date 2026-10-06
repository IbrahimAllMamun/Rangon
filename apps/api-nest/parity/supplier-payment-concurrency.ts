/**
 * Race checks for supplier payments (phase 6 part 5), run by run.ts after the
 * comparison cases. Each puts the payments, the orders and the accounts back.
 *
 * A payment against an order is decided under the order's row lock, taken
 * before the account's: what is outstanding is read and raised under one
 * lock, so two payments cannot both be measured against the same balance.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { behind, type Check, message, statuses } from './races.ts';
import { send } from './run.ts';
import { resetPayments } from './supplier-payment-cases.ts';

export async function supplierPaymentConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const ids = await one<{ sent: string; sole: string; bank: string }>(
      `SELECT (SELECT id FROM purchasing_purchaseorder WHERE invoice_number = 'PAR-PO-SENT') AS sent,
              (SELECT id FROM purchasing_supplier WHERE code = 'PARITY-SOLE') AS sole,
              (SELECT id FROM finance_account WHERE name = 'Parity Payables Bank') AS bank`,
    );
    if (!ids?.sent || !ids.bank) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetPayments(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const pay = (api: URL, body: Record<string, unknown>, key?: string) =>
      send(api, {
        name: 'supplier payment',
        method: 'POST',
        path: '/api/v1/supplier-payments/',
        headers: {
          ...auth('owner'),
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify(body),
      });
    const against = (amount: string) => ({
      supplier: ids.sole,
      purchase_order: ids.sent,
      amount,
      method: 'BANK',
      account: ids.bank,
    });
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);
    const SIDES = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;
    /** The order's paid total and badge, the bank's balance against its ledger, and what was made. */
    const state = async () =>
      (await one<Record<string, string>>(
        `SELECT o.paid_total::text AS paid, o.payment_status AS badge, o.status,
                a.balance::text AS balance,
                (SELECT COALESCE(SUM(t.amount), 0)::numeric(14,2)::text FROM finance_accounttransaction t
                  WHERE t.account_id = a.id) AS ledger,
                (SELECT count(*)::text FROM purchasing_supplierpayment p
                  WHERE p.id NOT IN (SELECT id FROM "snap_purchasing_supplierpayment")) AS payments,
                (SELECT count(*)::text FROM finance_accounttransaction t
                  WHERE t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction")) AS movements
           FROM purchasing_purchaseorder o, finance_account a WHERE o.id = $1 AND a.id = $2`,
        [ids.sent, ids.bank],
      )) as Record<string, string>;

    // 1. Six payments of all that is owed, at once.
    await restore();
    let before = await state();
    const whole = await Promise.all(
      Array.from({ length: 6 }, (_, index) => pay(either(index), against('2160.00'))),
    );
    let end = await state();
    checks.push({
      name: 'supplier payments: 6 payments of all an order owes at once, across both APIs -- one is recorded, five exceed what is outstanding, the order paid once',
      passed:
        statuses(whole).join() === '201,422,422,422,422,422' &&
        end.paid === '2160.00' &&
        end.badge === 'PAID' &&
        end.payments === '1' &&
        end.movements === '1' &&
        Number(end.balance) === Number(before.balance) - 2160 &&
        end.balance === end.ledger,
      detail: `statuses ${statuses(whole).join(',')}, paid ${before.paid} -> ${end.paid} (${end.badge}), bank ${before.balance} -> ${end.balance}, ${end.payments} payment, ${end.movements} movement`,
    });

    // 2. A payment committed while another waits on the order's row.
    for (const [side, api] of SIDES) {
      await restore();
      before = await state();
      const held = await behind(
        db,
        [`SELECT id FROM purchasing_purchaseorder WHERE id = $1 FOR UPDATE`, [ids.sent]],
        '%purchasing_purchaseorder%',
        [() => pay(api, against('500.00'))],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_purchaseorder SET paid_total = 2060.00, payment_status = 'PARTIALLY_PAID'
              WHERE id = $1`,
            [ids.sent],
          );
        },
      );
      end = await state();
      const answer = held.responses[0];
      checks.push({
        name: `supplier payments: all but 100.00 paid while a payment of 500.00 (${side}) waits on the order's row -- it exceeds what is outstanding; the order's lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 422 &&
          end.paid === '2060.00' &&
          end.payments === '0' &&
          end.balance === before.balance,
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, paid ${end.paid}, ${end.payments} payments, bank ${before.balance} -> ${end.balance}`,
      });
    }

    // 3. An order cancelled while a payment waits on its row.
    for (const [side, api] of SIDES) {
      await restore();
      before = await state();
      const held = await behind(
        db,
        [`SELECT id FROM purchasing_purchaseorder WHERE id = $1 FOR UPDATE`, [ids.sent]],
        '%purchasing_purchaseorder%',
        [() => pay(api, against('500.00'))],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_purchaseorder SET status = 'CANCELLED' WHERE id = $1`,
            [ids.sent],
          );
        },
      );
      end = await state();
      const answer = held.responses[0];
      checks.push({
        name: `supplier payments: an order cancelled while a payment against it (${side}) waits on its row is not paid`,
        passed:
          held.queued === 1 &&
          answer?.status === 409 &&
          end.paid === '0.00' &&
          end.payments === '0' &&
          end.balance === before.balance,
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, paid ${end.paid}, ${end.payments} payments`,
      });
    }

    // 4. An account emptied while a payment waits on its row: nothing is left behind.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM finance_account WHERE id = $1 FOR UPDATE`, [ids.bank]],
        '%finance_account%',
        [() => pay(api, against('500.00'))],
        async (holder) => {
          await holder.query(
            `INSERT INTO finance_accounttransaction
               (id, created_at, updated_at, account_id, transaction_type, amount, balance_after,
                reference_type, reference_id, reason, notes, occurred_at)
             SELECT gen_random_uuid(), clock_timestamp(), clock_timestamp(), a.id, 'WITHDRAWAL',
                    100.00 - a.balance, 100.00, 'manual', '', 'Withdrawn by the harness mid-flight', '',
                    clock_timestamp()
               FROM finance_account a WHERE a.id = $1`,
            [ids.bank],
          );
          await holder.query(`UPDATE finance_account SET balance = 100.00 WHERE id = $1`, [
            ids.bank,
          ]);
        },
      );
      end = await state();
      const answer = held.responses[0];
      checks.push({
        name: `supplier payments: a payment (${side}) whose account is emptied mid-flight is refused whole -- no payment, the order as it was`,
        passed:
          held.queued === 1 &&
          answer?.status === 409 &&
          end.balance === '100.00' &&
          end.ledger === '100.00' &&
          end.payments === '0' &&
          end.paid === '0.00',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, bank ${end.balance}, ${end.payments} payments, paid ${end.paid}`,
      });
    }

    // 5. Six clicks of one payment under one key: against an order, and as an advance.
    for (const [what, body] of [
      ['against an order', against('300.00')],
      [
        'as an advance',
        { supplier: ids.sole, amount: '300.00', method: 'BANK', account: ids.bank },
      ],
    ] as const) {
      await restore();
      before = await state();
      const clicks = await Promise.all(
        Array.from({ length: 6 }, (_, index) => pay(either(index), body, 'parity-payment-clicked')),
      );
      end = await state();
      const paid = new Set(
        clicks.map((response) => (JSON.parse(response.body) as { id?: string }).id),
      );
      checks.push({
        name: `supplier payments: 6 clicks of one payment ${what} with one Idempotency-Key, across both APIs -- six 201s, one payment, the money out once`,
        passed:
          statuses(clicks).every((status) => status === 201) &&
          paid.size === 1 &&
          end.payments === '1' &&
          end.movements === '1' &&
          Number(end.balance) === Number(before.balance) - 300 &&
          end.balance === end.ledger,
        detail: `statuses ${statuses(clicks).join(',')}, ${paid.size} payment id, ${end.payments} payment, ${end.movements} movement, bank ${before.balance} -> ${end.balance}`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
