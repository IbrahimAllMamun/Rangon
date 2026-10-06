/**
 * Race checks for the cash book (phase 6 part 1), run by run.ts after the
 * comparison cases. Each puts the finance tables back.
 *
 * Every movement takes its account's row; a transfer takes both, lowest id
 * first, so two transfers in opposite directions cannot deadlock. A burst
 * shows the invariant -- a balance is the sum of its ledger and never goes
 * below zero without leave -- and a mid-flight check proves the lock: the
 * harness holds the account's row, lets the request queue behind it, takes
 * the money out and commits.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { resetFinance } from './finance-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export async function financeConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const account = async (name: string) =>
      (await one<{ id: string }>(`SELECT id FROM finance_account WHERE name = $1`, [name]))?.id;
    const drawer = await account('Counter Cash Drawer');
    const bank = await account('City Bank Current');
    const petty = await account('Parity Petty Cash');
    const home = (await one<{ id: string }>(`SELECT id FROM accounts_branch WHERE code = 'DHK1'`))
      ?.id;
    if (!drawer || !bank || !petty || !home) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetFinance(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const post = (api: URL, path: string, body: unknown, key?: string, who: Who = 'accountant') =>
      send(api, {
        name: 'finance',
        method: 'POST',
        path,
        headers: {
          ...auth(who),
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify(body),
      });
    const MOVE = '/api/v1/accounts/record-movement/';
    const TRANSFERS = '/api/v1/account-transfers/';
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);
    const message = (body: string) => {
      try {
        return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        return '';
      }
    };
    const idOf = (body: string) => (JSON.parse(body) as { id?: string }).id;
    const statuses = (responses: { status: number }[]) =>
      responses.map((response) => response.status).sort((a, b) => a - b);
    /** An account's cached balance, the sum of its ledger, and what was written since the restore. */
    const state = async (id: string) =>
      (await one<Record<string, string>>(
        `SELECT a.balance::text AS balance,
                COALESCE((SELECT SUM(t.amount) FROM finance_accounttransaction t
                           WHERE t.account_id = a.id), 0)::numeric(14,2)::text AS ledger,
                (SELECT count(*) FROM finance_accounttransaction t WHERE t.account_id = a.id
                    AND t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction"))::text AS made
           FROM finance_account a WHERE a.id = $1`,
        [id],
      )) as Record<string, string>;
    const transfersMade = async () =>
      Number(
        (
          await one<{ made: string }>(
            `SELECT count(*) AS made FROM finance_accounttransfer
              WHERE id NOT IN (SELECT id FROM "snap_finance_accounttransfer")`,
          )
        )?.made,
      );
    /** Hold a row, start the requests, wait until they queue on a lock, change, commit. */
    const behind = async (
      accountId: string,
      requests: (() => Promise<{ status: number; body: string }>)[],
      change: (holder: pg.Client) => Promise<void> = async () => {},
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM finance_account WHERE id = $1 FOR UPDATE`, [accountId]);
      const pending = requests.map((request) => request());
      let queued = 0;
      for (let attempt = 0; attempt < 160 && queued < requests.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        queued = Number(
          (
            await one<{ count: string }>(
              `SELECT count(*) AS count FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND state = 'active'
                  AND query ILIKE '%finance_account%' AND query NOT ILIKE '%pg_stat_activity%'`,
            )
          )?.count ?? 0,
        );
      }
      await change(holder);
      await holder.query('COMMIT');
      await holder.end();
      return { queued, responses: await Promise.all(pending) };
    };
    /** Take an account down to 100.00 as a withdrawal the ledger records. */
    const emptied = (accountId: string) => async (holder: pg.Client) => {
      await holder.query(
        `INSERT INTO finance_accounttransaction
           (id, created_at, updated_at, account_id, transaction_type, amount, balance_after,
            reference_type, reference_id, reason, notes, occurred_at)
         SELECT gen_random_uuid(), clock_timestamp(), clock_timestamp(), a.id, 'WITHDRAWAL',
                100.00 - a.balance, 100.00, 'manual', '', 'Banked by the harness mid-flight', '',
                clock_timestamp()
           FROM finance_account a WHERE a.id = $1`,
        [accountId],
      );
      await holder.query(`UPDATE finance_account SET balance = 100.00 WHERE id = $1`, [accountId]);
    };

    // 1. Six withdrawals of all the drawer holds, at once.
    await restore();
    const whole = (await state(drawer)).balance;
    const takes = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), MOVE, {
          account: drawer,
          transaction_type: 'WITHDRAWAL',
          amount: whole,
          reason: 'Banked',
        }),
      ),
    );
    let end = await state(drawer);
    checks.push({
      name: 'cash book: 6 withdrawals of all a drawer holds at once, across both APIs -- one is paid, the drawer never goes below nothing',
      passed:
        statuses(takes).join() === '201,409,409,409,409,409' &&
        end.balance === '0.00' &&
        end.ledger === '0.00' &&
        end.made === '1',
      detail: `statuses ${statuses(takes).join(',')}, drawer ${whole} -> ${end.balance}, ledger sums to ${end.ledger}, ${end.made} movement`,
    });

    // 2. Six clicks of one deposit under one key.
    await restore();
    const before = (await state(drawer)).balance;
    const clicks = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(
          either(index),
          MOVE,
          { account: drawer, transaction_type: 'DEPOSIT', amount: '100.00' },
          'parity-deposit-clicked',
        ),
      ),
    );
    end = await state(drawer);
    checks.push({
      name: 'cash book: 6 clicks of one deposit with one Idempotency-Key, across both APIs -- six 201s, one movement',
      passed:
        statuses(clicks).every((status) => status === 201) &&
        new Set(clicks.map((response) => idOf(response.body))).size === 1 &&
        end.made === '1' &&
        Number(end.balance) === Number(before) + 100 &&
        end.balance === end.ledger,
      detail: `statuses ${statuses(clicks).join(',')}, ${new Set(clicks.map((response) => idOf(response.body))).size} movement id, drawer ${before} -> ${end.balance}, ${end.made} movement`,
    });

    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      // 3. A withdrawal that meets its drawer emptied mid-flight is refused.
      await restore();
      let held = await behind(
        drawer,
        [
          () =>
            post(api, MOVE, {
              account: drawer,
              transaction_type: 'WITHDRAWAL',
              amount: '500.00',
              reason: 'Banked',
            }),
        ],
        emptied(drawer),
      );
      end = await state(drawer);
      checks.push({
        name: `cash book: a withdrawal (${side}) whose drawer is emptied mid-flight is refused -- the account lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 409 &&
          end.balance === '100.00' &&
          end.ledger === '100.00',
        detail: `${held.responses[0]?.status} ${message(held.responses[0]?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, drawer ${end.balance}, ledger sums to ${end.ledger}`,
      });

      // 4. A transfer that meets its source emptied mid-flight moves nothing.
      await restore();
      const bankBefore = (await state(bank)).balance;
      held = await behind(
        drawer,
        [
          () =>
            post(api, TRANSFERS, {
              source_account: drawer,
              target_account: bank,
              amount: '500.00',
            }),
        ],
        emptied(drawer),
      );
      end = await state(drawer);
      const bankAfter = await state(bank);
      checks.push({
        name: `cash book: a transfer (${side}) whose source is emptied mid-flight moves nothing -- the account lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 409 &&
          end.balance === '100.00' &&
          bankAfter.balance === bankBefore &&
          (await transfersMade()) === 0,
        detail: `${held.responses[0]?.status} ${message(held.responses[0]?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, drawer ${end.balance}, bank ${bankBefore} -> ${bankAfter.balance}, ${await transfersMade()} transfers`,
      });

      // 5. Two deposits under one key, queued on the account, through one API.
      await restore();
      held = await behind(
        drawer,
        [0, 1].map(
          () => () =>
            post(
              api,
              MOVE,
              { account: drawer, transaction_type: 'DEPOSIT', amount: '100.00' },
              'parity-deposit-queued',
            ),
        ),
      );
      end = await state(drawer);
      checks.push({
        name: `cash book: two deposits under one key queued on the account (${side}) -- both answer with one movement`,
        passed:
          held.queued === 2 &&
          statuses(held.responses).join() === '201,201' &&
          idOf(held.responses[0]?.body ?? '{}') === idOf(held.responses[1]?.body ?? '{}') &&
          end.made === '1' &&
          end.balance === end.ledger,
        detail: `statuses ${statuses(held.responses).join(',')}, ${held.queued} queued on the account, ${end.made} movement, drawer ${end.balance}`,
      });
    }

    // 6. Transfers in opposite directions at once: no deadlock, nothing made or lost.
    await restore();
    const total = Number((await state(drawer)).balance) + Number((await state(bank)).balance);
    const crossing = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        post(
          either(index),
          TRANSFERS,
          index % 4 < 2
            ? { source_account: drawer, target_account: bank, amount: '100.00' }
            : { source_account: bank, target_account: drawer, amount: '100.00' },
        ),
      ),
    );
    const drawerEnd = await state(drawer);
    const bankEnd = await state(bank);
    const numbers = new Set(
      crossing.map((response) => (JSON.parse(response.body) as { number?: string }).number),
    );
    checks.push({
      name: 'cash book: 8 transfers between two accounts, four each way, at once across both APIs -- all go through, no money made or lost',
      passed:
        statuses(crossing).every((status) => status === 201) &&
        numbers.size === 8 &&
        Number(drawerEnd.balance) + Number(bankEnd.balance) === total &&
        drawerEnd.balance === drawerEnd.ledger &&
        bankEnd.balance === bankEnd.ledger &&
        (await transfersMade()) === 8,
      detail: `statuses ${statuses(crossing).join(',')}, ${numbers.size} numbers, the two accounts hold ${Number(drawerEnd.balance) + Number(bankEnd.balance)} of ${total}, each equal to its ledger`,
    });

    // 7. Six clicks of one transfer under one key.
    await restore();
    const sent = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(
          either(index),
          TRANSFERS,
          { source_account: drawer, target_account: bank, amount: '100.00' },
          'parity-transfer-clicked',
        ),
      ),
    );
    end = await state(drawer);
    checks.push({
      name: 'cash book: 6 clicks of one transfer with one Idempotency-Key, across both APIs -- six 201s, one transfer',
      passed:
        statuses(sent).every((status) => status === 201) &&
        new Set(sent.map((response) => idOf(response.body))).size === 1 &&
        (await transfersMade()) === 1 &&
        end.made === '1',
      detail: `statuses ${statuses(sent).join(',')}, ${await transfersMade()} transfer, ${end.made} movement out of the drawer`,
    });

    // 8. Six accounts opened as the branch's default cash account, at once.
    await restore();
    const opened = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), '/api/v1/accounts/', {
          branch: home,
          name: `Parity Racing Default ${index}`,
          kind: 'CASH',
          is_default: true,
        }),
      ),
    );
    const defaults = Number(
      (
        await one<{ count: string }>(
          `SELECT count(*) AS count FROM finance_account
            WHERE branch_id = $1 AND kind = 'CASH' AND is_default`,
          [home],
        )
      )?.count,
    );
    checks.push({
      name: 'cash book: 6 accounts opened as one branch’s default cash account at once, across both APIs -- one default remains; the index decides',
      passed:
        statuses(opened).every((status) => status === 201 || status === 409) &&
        statuses(opened).includes(201) &&
        defaults === 1,
      detail: `statuses ${statuses(opened).join(',')}, ${defaults} default cash account`,
    });

    // 9. Six accounts opened under one name at once.
    await restore();
    const named = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), '/api/v1/accounts/', { branch: home, name: 'Parity Racing Name' }),
      ),
    );
    const rows = Number(
      (
        await one<{ count: string }>(
          `SELECT count(*) AS count FROM finance_account WHERE name = 'Parity Racing Name'`,
        )
      )?.count,
    );
    checks.push({
      name: 'cash book: 6 accounts opened under one name at once, across both APIs -- one is opened; the index decides',
      passed:
        statuses(named).filter((status) => status === 201).length === 1 &&
        statuses(named).every((status) => [201, 400, 409].includes(status)) &&
        rows === 1,
      detail: `statuses ${statuses(named).join(',')}, ${rows} account`,
    });
    void petty;
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
