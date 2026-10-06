/**
 * Race checks for the back office's customers and its call-back list
 * (phase 6 part 6), run by run.ts after the comparison cases. Each puts the
 * customer tables back.
 *
 * The one invariant here that a lock holds is the one phase 2 proved for the
 * storefront: one default address per customer, under the customer's row.
 * The back office reaches the same service.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { resetCustomers } from './customers-cases.ts';
import { behind, type Check, statuses } from './races.ts';
import { send } from './run.ts';

export async function customersConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const ids = await one<{ lady: string; lead: string; order: string }>(
      `SELECT (SELECT id FROM customers_customer WHERE name = 'Parity Ledger Lady') AS lady,
              (SELECT id FROM orders_abandonedcheckout WHERE phone = '8801711000078') AS lead,
              (SELECT id FROM orders_order WHERE channel = 'ONLINE' ORDER BY number LIMIT 1) AS order`,
    );
    if (!ids?.lady || !ids.lead) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetCustomers(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const call = (api: URL, method: string, path: string, body: unknown) =>
      send(api, {
        name: 'customers',
        method,
        path,
        headers: { ...auth('owner'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);

    // 1. Ten addresses added as the default at once.
    await restore();
    const added = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        call(either(index), 'POST', `/api/v1/customers/${ids.lady}/addresses/`, {
          recipient_name: 'Ledger Lady',
          phone: '01911000301',
          line1: `Parity race ${index}`,
          city: 'Dhaka',
          is_default: true,
        }),
      ),
    );
    const defaults = await one<{ addresses: string; defaults: string }>(
      `SELECT count(*)::text AS addresses, count(*) FILTER (WHERE is_default)::text AS defaults
         FROM customers_customeraddress WHERE customer_id = $1`,
      [ids.lady],
    );
    checks.push({
      name: 'customers: 10 addresses added as the default at once from the back office, across both APIs -- one default',
      passed:
        statuses(added).every((status) => status === 201) &&
        defaults?.addresses === '12' &&
        defaults.defaults === '1',
      detail: `statuses ${statuses(added).join(',')}, ${defaults?.addresses} addresses, ${defaults?.defaults} default`,
    });

    // 2. Six customers under one new number at once.
    await restore();
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        call(either(index), 'POST', '/api/v1/customers/', {
          name: `Parity Twin ${index}`,
          phone: '01911000388',
        }),
      ),
    );
    const twins = await one<{ count: string }>(
      `SELECT count(*)::text AS count FROM customers_customer WHERE phone = '8801911000388'`,
    );
    checks.push({
      name: 'customers: 6 customers under one new number at once, across both APIs -- one is made; the rest are told the number is taken (400) or meet the unique index (409)',
      passed:
        made.filter((response) => response.status === 201).length === 1 &&
        statuses(made).every((status) => [201, 400, 409].includes(status)) &&
        twins?.count === '1',
      detail: `statuses ${statuses(made).join(',')}, ${twins?.count} customer under the number`,
    });

    // 3. A lead recovered while a note on it waits at its UPDATE.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM orders_abandonedcheckout WHERE id = $1 FOR UPDATE`, [ids.lead]],
        '%orders_abandonedcheckout%',
        [
          () =>
            call(api, 'PATCH', `/api/v1/abandoned-checkouts/${ids.lead}/`, {
              note: 'Called at noon',
            }),
        ],
        async (holder) => {
          await holder.query(
            `UPDATE orders_abandonedcheckout SET status = 'RECOVERED', recovered_at = now(),
                    recovered_order_id = $2 WHERE id = $1`,
            [ids.lead, ids.order],
          );
        },
      );
      const end = await one<{ status: string; order: string | null; note: string }>(
        `SELECT status, recovered_order_id AS order, note FROM orders_abandonedcheckout WHERE id = $1`,
        [ids.lead],
      );
      checks.push({
        name: `customers: a lead recovered while a note on it (${side}) waits at its UPDATE is opened again by the note, its order forgotten (D200, copied) -- no lock is involved`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 200 &&
          end?.status === 'OPEN' &&
          end.order === null &&
          end.note === 'Called at noon',
        detail: `${held.responses[0]?.status}, ${held.queued ? 'waited at its UPDATE' : 'never waited'}, the lead ${end?.status}, order ${end?.order ?? 'none'}`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
