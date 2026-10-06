/**
 * Race checks for expenses (phase 6 part 2), run by run.ts after the
 * comparison cases. Each puts the finance tables back.
 *
 * An expense is a document and a movement in one transaction: the movement
 * takes the account's row, and a void takes the expense's own first, so two
 * voids of one expense put the money back once.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { resetExpenses } from './expenses-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export async function expensesConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const drawer = (
      await one<{ id: string }>(`SELECT id FROM finance_account WHERE name = 'Counter Cash Drawer'`)
    )?.id;
    const supplies = (
      await one<{ id: string }>(`SELECT id FROM finance_expensecategory WHERE code = 'SUPPLIES'`)
    )?.id;
    const filed = (
      await one<{ id: string }>(`SELECT id FROM finance_expense WHERE note LIKE 'Parity receipt%'`)
    )?.id;
    if (!drawer || !supplies || !filed) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetExpenses(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const post = (api: URL, path: string, body: unknown, key?: string) =>
      send(api, {
        name: 'expense',
        method: 'POST',
        path,
        headers: {
          ...auth('accountant'),
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify(body),
      });
    const EXPENSES = '/api/v1/expenses/';
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);
    const message = (body: string) => {
      try {
        return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        return '';
      }
    };
    const statuses = (responses: { status: number }[]) =>
      responses.map((response) => response.status).sort((a, b) => a - b);
    /** The drawer's balance against its ledger, and the expenses and movements made since the restore. */
    const state = async () =>
      (await one<Record<string, string>>(
        `SELECT a.balance::text AS balance,
                (SELECT COALESCE(SUM(t.amount), 0)::numeric(14,2)::text FROM finance_accounttransaction t
                  WHERE t.account_id = a.id) AS ledger,
                (SELECT count(*)::text FROM finance_expense e
                  WHERE e.id NOT IN (SELECT id FROM "snap_finance_expense")) AS expenses,
                (SELECT count(*)::text FROM finance_accounttransaction t
                  WHERE t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction")) AS movements,
                (SELECT status FROM finance_expense WHERE id = $2) AS filed
           FROM finance_account a WHERE a.id = $1`,
        [drawer, filed],
      )) as Record<string, string>;
    const behind = async (
      lock: [sql: string, values: unknown[]],
      waitsOn: string,
      requests: (() => Promise<{ status: number; body: string }>)[],
      change: (holder: pg.Client) => Promise<void> = async () => {},
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(lock[0], lock[1]);
      const pending = requests.map((request) => request());
      let queued = 0;
      for (let attempt = 0; attempt < 160 && queued < requests.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        queued = Number(
          (
            await one<{ count: string }>(
              `SELECT count(*) AS count FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND state = 'active'
                  AND query ILIKE $1 AND query NOT ILIKE '%pg_stat_activity%'`,
              [waitsOn],
            )
          )?.count ?? 0,
        );
      }
      await change(holder);
      await holder.query('COMMIT');
      await holder.end();
      return { queued, responses: await Promise.all(pending) };
    };
    const spend = (amount: string) => ({ category: supplies, account: drawer, amount });

    // 1. Two voids of one expense queued on its row: the money goes back once.
    for (const [how, a, b] of [
      ['one per API', apis.DJANGO, apis.NEST],
      ['both through Django', apis.DJANGO, apis.DJANGO],
      ['both through Nest', apis.NEST, apis.NEST],
    ] as const) {
      await restore();
      const before = (await state()).balance;
      const run = await behind(
        [`SELECT id FROM finance_expense WHERE id = $1 FOR UPDATE`, [filed]],
        '%finance_expense%',
        [a, b].map(
          (api) => () => post(api, `${EXPENSES}${filed}/void/`, { reason: 'Entered twice' }),
        ),
      );
      const end = await state();
      const refused = run.responses
        .filter((response) => response.status !== 200)
        .map((response) => message(response.body));
      checks.push({
        name: `expenses: two voids of one expense, ${how}, queue on its row -- one voids it, the money goes back once`,
        passed:
          run.queued === 2 &&
          statuses(run.responses).join() === '200,400' &&
          refused.join().endsWith('has already been voided.') &&
          end.filed === 'VOID' &&
          end.movements === '1' &&
          Number(end.balance) === Number(before) + 325.5 &&
          end.balance === end.ledger,
        detail: `statuses ${statuses(run.responses).join(',')} (${refused.join('; ')}), ${run.queued} queued on the expense, ${end.movements} reversal, drawer ${before} -> ${end.balance}`,
      });
    }

    // 2. Six expenses of all the drawer holds, at once.
    await restore();
    const whole = (await state()).balance;
    const takes = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), EXPENSES, spend(whole as string)),
      ),
    );
    let end = await state();
    checks.push({
      name: 'expenses: 6 expenses of all a drawer holds at once, across both APIs -- one is recorded, and no refused one leaves a document',
      passed:
        statuses(takes).join() === '201,409,409,409,409,409' &&
        end.balance === '0.00' &&
        end.ledger === '0.00' &&
        end.expenses === '1' &&
        end.movements === '1',
      detail: `statuses ${statuses(takes).join(',')}, drawer ${whole} -> ${end.balance}, ${end.expenses} expense, ${end.movements} movement`,
    });

    // 3. Six clicks of one expense under one key.
    await restore();
    const clicks = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), EXPENSES, spend('150.00'), 'parity-expense-clicked'),
      ),
    );
    end = await state();
    const ids = new Set(
      clicks.map((response) => (JSON.parse(response.body) as { id?: string }).id),
    );
    checks.push({
      name: 'expenses: 6 clicks of one expense with one Idempotency-Key, across both APIs -- six 201s, one expense, one movement',
      passed:
        statuses(clicks).every((status) => status === 201) &&
        ids.size === 1 &&
        end.expenses === '1' &&
        end.movements === '1' &&
        end.balance === end.ledger,
      detail: `statuses ${statuses(clicks).join(',')}, ${ids.size} expense id, ${end.expenses} expense, ${end.movements} movement`,
    });

    // 4. An expense that meets its drawer emptied mid-flight leaves nothing behind.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await restore();
      const held = await behind(
        [`SELECT id FROM finance_account WHERE id = $1 FOR UPDATE`, [drawer]],
        '%finance_account%',
        [() => post(api, EXPENSES, spend('500.00'))],
        async (holder) => {
          await holder.query(
            `INSERT INTO finance_accounttransaction
               (id, created_at, updated_at, account_id, transaction_type, amount, balance_after,
                reference_type, reference_id, reason, notes, occurred_at)
             SELECT gen_random_uuid(), clock_timestamp(), clock_timestamp(), a.id, 'WITHDRAWAL',
                    100.00 - a.balance, 100.00, 'manual', '', 'Banked by the harness mid-flight', '',
                    clock_timestamp()
               FROM finance_account a WHERE a.id = $1`,
            [drawer],
          );
          await holder.query(`UPDATE finance_account SET balance = 100.00 WHERE id = $1`, [drawer]);
        },
      );
      end = await state();
      checks.push({
        name: `expenses: an expense (${side}) whose drawer is emptied mid-flight is refused, document and all -- the account lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 409 &&
          end.balance === '100.00' &&
          end.ledger === '100.00' &&
          end.expenses === '0',
        detail: `${held.responses[0]?.status} ${message(held.responses[0]?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, drawer ${end.balance}, ${end.expenses} expenses`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
