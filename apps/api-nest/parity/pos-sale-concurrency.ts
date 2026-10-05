/**
 * Race checks for the counter sale (phase 5 part 3), run by run.ts after the
 * comparison cases. Each puts the sale's tables back.
 *
 * Every counter sale takes the `order:POS` number sequence's row lock before
 * it touches stock, so sales through either API already run one after
 * another; a burst passes with the stock lock removed. What proves a lock is
 * the mid-flight check: the harness holds the row, starts one sale, waits
 * until it is queued behind the row, makes the competing change and commits.
 * The sale must then act on what was committed.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { resetSales } from './pos-sale-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export async function posSaleConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const linen = await one<{ id: string; branch_id: string; variant_id: string }>(
      `SELECT i.id, i.branch_id, i.variant_id FROM inventory_inventory i
         JOIN accounts_branch b ON b.id = i.branch_id JOIN catalog_productvariant v ON v.id = i.variant_id
        WHERE b.code = 'DHK1' AND v.sku = 'RGN-LIN-M-WHI'`,
    );
    const mirpur = await one<{ id: string }>(`SELECT id FROM accounts_branch WHERE code = 'PAR3'`);
    const tee = await one<{ id: string }>(
      `SELECT id FROM catalog_productvariant WHERE sku = 'PAR-TEE-S-WHT'`,
    );
    const shirt = await one<{ id: string }>(
      `SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI'`,
    );
    const drawer = await one<{ id: string }>(
      `SELECT id FROM finance_account WHERE name = 'Counter Cash Drawer'`,
    );
    const shopper = await one<{ id: string }>(
      `SELECT id FROM customers_customer WHERE email = 'customer@rangon.test'`,
    );
    const coupon = await one<{ id: string }>(
      `SELECT id FROM promotions_coupon WHERE code = 'STORE100'`,
    );
    const marker = await one(
      `SELECT 1 FROM orders_order WHERE idempotency_key = 'parity-pos-replayed'`,
    );
    if (!linen || !mirpur || !tee || !shirt || !drawer || !shopper || !coupon || !marker) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetSales(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const sides = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;
    const sell = (api: URL, body: unknown, who: Who = 'cashier', key?: string) =>
      send(api, {
        name: 'counter sale',
        method: 'POST',
        path: '/api/v1/pos/sales/',
        headers: {
          ...auth(who),
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify(body),
      });
    const card = [{ method: 'CARD', amount: '99999.00' }];
    const linenSale = (quantity: number) => ({
      lines: [{ variant: linen.variant_id, quantity }],
      payments: card,
    });
    /** The row's cached figures, and what its ledger adds up to. */
    const shelf = async () =>
      (await one<{ on_hand: number; reserved: number; ledger: number }>(
        `SELECT i.on_hand, i.reserved,
                COALESCE((SELECT SUM(t.quantity) FROM inventory_inventorytransaction t
                           WHERE t.branch_id = i.branch_id AND t.variant_id = i.variant_id
                             AND t.transaction_type NOT IN ('RESERVATION', 'RESERVATION_RELEASE')), 0)::int
                  AS ledger
           FROM inventory_inventory i WHERE i.id = $1`,
        [linen.id],
      )) as { on_hand: number; reserved: number; ledger: number };
    /**
     * Hold a row (`lock`), start `request`, wait until a statement matching
     * `waitsOn` is queued on a lock, run `change` in the holder's transaction,
     * and commit.
     */
    const behind = async (
      lock: [sql: string, values: unknown[]],
      waitsOn: string,
      request: () => Promise<{ status: number; body: string }>,
      change: (holder: pg.Client) => Promise<void>,
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(lock[0], lock[1]);
      const pending = request();
      let waited = false;
      for (let attempt = 0; attempt < 160 && !waited; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const found = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'
              AND query ILIKE $1 AND query NOT ILIKE '%pg_stat_activity%'`,
          [waitsOn],
        );
        waited = Number(found.rows[0]?.count ?? 0) > 0;
      }
      await change(holder);
      await holder.query('COMMIT');
      await holder.end();
      return { waited, response: await pending };
    };
    const LINEN_LOCK: [string, unknown[]] = [
      `SELECT id FROM inventory_inventory WHERE id = $1 FOR UPDATE`,
      [linen.id],
    ];
    const message = (body: string) => {
      try {
        return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        return '';
      }
    };

    // 1. The last five of a SKU, eight cashiers at once, across both APIs.
    await restore();
    const start = await shelf();
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sell(index % 2 ? apis.NEST : apis.DJANGO, linenSale(1)),
      ),
    );
    const sold = burst.filter((response) => response.status === 201).length;
    const refused = burst.filter((response) => response.status === 409).length;
    let end = await shelf();
    checks.push({
      name: `counter: 8 sales at once for the last ${start.on_hand} of a SKU, across both APIs -- ${start.on_hand} sell, none oversold`,
      passed:
        sold === start.on_hand &&
        refused === 8 - start.on_hand &&
        end.on_hand === 0 &&
        end.ledger === 0,
      detail: `statuses ${burst.map((response) => response.status).join(',')}, shelf ${start.on_hand} -> ${end.on_hand}, ledger ${end.ledger}`,
    });

    // 2. A sale of the whole shelf that meets another sale mid-flight.
    for (const [side, api] of sides) {
      await restore();
      const before = await shelf();
      const { waited, response } = await behind(
        LINEN_LOCK,
        '%inventory_inventory%',
        () => sell(api, linenSale(before.on_hand)),
        async (holder) => {
          await holder.query(
            `INSERT INTO inventory_inventorytransaction
               (id, created_at, updated_at, branch_id, variant_id, transaction_type, quantity, unit_cost,
                on_hand_after, reserved_after, reference_type, reference_id, reason, notes)
             VALUES (gen_random_uuid(), clock_timestamp(), clock_timestamp(), $1, $2, 'SALE', -1, NULL, $3,
                     $4, 'manual', '', 'Sold by the harness mid-flight', '')`,
            [linen.branch_id, linen.variant_id, before.on_hand - 1, before.reserved],
          );
          await holder.query(`UPDATE inventory_inventory SET on_hand = on_hand - 1 WHERE id = $1`, [
            linen.id,
          ]);
        },
      );
      end = await shelf();
      checks.push({
        name: `counter: a sale of the whole shelf (${side}) that meets another sale mid-flight is refused -- the stock lock holds`,
        passed:
          waited &&
          response.status === 409 &&
          end.on_hand === before.on_hand - 1 &&
          end.ledger === end.on_hand,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, shelf ${end.on_hand} (expected ${before.on_hand - 1}), ledger ${end.ledger}`,
      });
    }

    // 3. A sale of the whole shelf that meets an online reservation mid-flight
    //    (business rule 1.4, D115): the unit is no longer the counter's.
    for (const [side, api] of sides) {
      await restore();
      const before = await shelf();
      const { waited, response } = await behind(
        LINEN_LOCK,
        '%inventory_inventory%',
        () => sell(api, linenSale(before.on_hand)),
        async (holder) => {
          await holder.query(
            `INSERT INTO inventory_inventorytransaction
               (id, created_at, updated_at, branch_id, variant_id, transaction_type, quantity, unit_cost,
                on_hand_after, reserved_after, reference_type, reference_id, reason, notes)
             VALUES (gen_random_uuid(), clock_timestamp(), clock_timestamp(), $1, $2, 'RESERVATION', 1,
                     NULL, $3, $4, 'order', gen_random_uuid()::text, '', '')`,
            [linen.branch_id, linen.variant_id, before.on_hand, before.reserved + 1],
          );
          await holder.query(
            `UPDATE inventory_inventory SET reserved = reserved + 1 WHERE id = $1`,
            [linen.id],
          );
        },
      );
      end = await shelf();
      checks.push({
        name: `counter: a sale of the whole shelf (${side}) that meets an online reservation mid-flight leaves the reserved unit -- the stock lock holds`,
        passed:
          waited &&
          response.status === 409 &&
          message(response.body).includes('held for online orders') &&
          end.on_hand === before.on_hand &&
          end.reserved === before.reserved + 1,
        detail: `${response.status} ${message(response.body).slice(0, 70)}, ${waited ? 'waited on the lock' : 'never waited'}, shelf ${end.on_hand}, reserved ${end.reserved}`,
      });
    }

    // 4. Six clicks with one Idempotency-Key, across both APIs: one sale.
    await restore();
    const clicks = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        sell(index % 2 ? apis.NEST : apis.DJANGO, linenSale(1), 'cashier', 'parity-pos-race'),
      ),
    );
    const numbers = new Set(
      clicks.map((response) => {
        try {
          return (JSON.parse(response.body) as { number?: string }).number ?? '';
        } catch {
          return '';
        }
      }),
    );
    const made = Number(
      (
        await one<{ count: string }>(
          `SELECT count(*) AS count FROM orders_order WHERE idempotency_key = 'parity-pos-race'`,
        )
      )?.count,
    );
    end = await shelf();
    checks.push({
      name: 'counter: 6 clicks with one Idempotency-Key, across both APIs -- one sale, one unit sold',
      passed:
        clicks.every((response) => response.status === 201) &&
        numbers.size === 1 &&
        made === 1 &&
        end.on_hand === start.on_hand - 1 &&
        end.ledger === end.on_hand,
      detail: `statuses ${clicks.map((response) => response.status).join(',')}, ${numbers.size} number(s), ${made} order(s), shelf ${start.on_hand} -> ${end.on_hand}`,
    });

    // 5. A coupon's last use, taken by someone else while a sale waits on the
    //    coupon's row: the sale is refused and the count stays right.
    for (const [side, api] of sides) {
      await restore();
      await db.query(`UPDATE promotions_coupon SET usage_limit = 1, used_count = 0 WHERE id = $1`, [
        coupon.id,
      ]);
      const { waited, response } = await behind(
        [`SELECT id FROM promotions_coupon WHERE id = $1 FOR UPDATE`, [coupon.id]],
        '%promotions_coupon%',
        () =>
          sell(api, {
            lines: [{ variant: shirt.id, quantity: 1 }],
            coupon_code: 'STORE100',
            payments: card,
          }),
        async (holder) => {
          await holder.query(`UPDATE promotions_coupon SET used_count = 1 WHERE id = $1`, [
            coupon.id,
          ]);
        },
      );
      const after = await one<{ used_count: number; redemptions: string; orders: string }>(
        `SELECT c.used_count,
                (SELECT count(*) FROM promotions_couponredemption r WHERE r.coupon_id = c.id
                    AND r.id NOT IN (SELECT id FROM "snap_promotions_couponredemption")) AS redemptions,
                (SELECT count(*) FROM orders_order o
                  WHERE o.id NOT IN (SELECT id FROM "snap_orders_order")) AS orders
           FROM promotions_coupon c WHERE c.id = $1`,
        [coupon.id],
      );
      checks.push({
        name: `counter: a sale (${side}) whose coupon is used up mid-flight is refused -- the coupon lock holds`,
        passed:
          waited &&
          response.status === 422 &&
          after?.used_count === 1 &&
          Number(after.redemptions) === 0 &&
          Number(after.orders) === 0,
        detail: `${response.status} ${message(response.body).slice(0, 50)}, ${waited ? 'waited on the lock' : 'never waited'}, used ${after?.used_count}, ${after?.redemptions} redemption(s), ${after?.orders} order(s)`,
      });
    }

    // 6. Six anonymous sales at once at a branch with no walk-in record yet,
    //    across both APIs: one record, shared by all six.
    await restore();
    const anonymous = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        sell(
          index % 2 ? apis.NEST : apis.DJANGO,
          { lines: [{ variant: tee.id, quantity: 1 }], payments: card, branch: mirpur.id },
          'owner',
        ),
      ),
    );
    const walkIns = await one<{ records: string; orders: string }>(
      `SELECT (SELECT count(*) FROM customers_customer WHERE name = 'Walk-in (PAR3)') AS records,
              (SELECT count(*) FROM orders_order o JOIN customers_customer c ON c.id = o.customer_id
                WHERE c.name = 'Walk-in (PAR3)') AS orders`,
    );
    checks.push({
      name: 'counter: 6 anonymous sales at once at a branch with no walk-in record, across both APIs -- one record, six sales',
      passed:
        anonymous.every((response) => response.status === 201) &&
        Number(walkIns?.records) === 1 &&
        Number(walkIns?.orders) === 6,
      detail: `statuses ${anonymous.map((response) => response.status).join(',')}, ${walkIns?.records} record(s), ${walkIns?.orders} sale(s) on it`,
    });

    // 7. A payment that meets another movement of its account mid-flight
    //    lands on the committed balance.
    for (const [side, api] of sides) {
      await restore();
      const opening = (
        await one<{ balance: string }>(`SELECT balance::text FROM finance_account WHERE id = $1`, [
          drawer.id,
        ])
      )?.balance as string;
      const { waited, response } = await behind(
        [`SELECT id FROM finance_account WHERE id = $1 FOR UPDATE`, [drawer.id]],
        '%finance_account%',
        () =>
          sell(api, {
            lines: [{ variant: shirt.id, quantity: 1 }],
            payments: [{ method: 'CASH', amount: '2450.00' }],
          }),
        async (holder) => {
          await holder.query(
            `INSERT INTO finance_accounttransaction
               (id, created_at, updated_at, account_id, transaction_type, amount, balance_after,
                reference_type, reference_id, reason, notes, occurred_at)
             VALUES (gen_random_uuid(), clock_timestamp(), clock_timestamp(), $1, 'DEPOSIT', 100.00,
                     $2::numeric + 100, 'manual', '', 'Put in by the harness mid-flight', '',
                     clock_timestamp())`,
            [drawer.id, opening],
          );
          await holder.query(`UPDATE finance_account SET balance = balance + 100 WHERE id = $1`, [
            drawer.id,
          ]);
        },
      );
      const money = await one<{ balance: string; expected: string; last: string }>(
        `SELECT a.balance::text, ($2::numeric + 100 + 2450)::text AS expected,
                (SELECT t.balance_after::text FROM finance_accounttransaction t
                  WHERE t.account_id = a.id AND t.transaction_type = 'SALE_PAYMENT'
                    AND t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction")) AS last
           FROM finance_account a WHERE a.id = $1`,
        [drawer.id, opening],
      );
      checks.push({
        name: `counter: a cash payment (${side}) that meets another movement of the drawer mid-flight lands on the committed balance -- the account lock holds`,
        passed:
          waited &&
          response.status === 201 &&
          money?.balance === money?.expected &&
          money?.last === money?.expected,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, balance ${money?.balance} (expected ${money?.expected}), the payment's movement ${money?.last}`,
      });
    }

    // 8. D146, copied: a customer's totals are written from the figures read
    //    when the sale was priced. One that changed while the sale was under
    //    way is overwritten: five orders become one.
    for (const [side, api] of sides) {
      await restore();
      const { waited, response } = await behind(
        [`SELECT id FROM customers_customer WHERE id = $1 FOR UPDATE`, [shopper.id]],
        'UPDATE "customers_customer"%',
        () =>
          sell(api, {
            lines: [{ variant: shirt.id, quantity: 1 }],
            customer: shopper.id,
            payments: card,
          }),
        async (holder) => {
          await holder.query(
            `UPDATE customers_customer SET total_orders = 5, total_spent = 5000.00 WHERE id = $1`,
            [shopper.id],
          );
        },
      );
      const totals = await one<{ total_orders: number; total_spent: string }>(
        `SELECT total_orders, total_spent::text FROM customers_customer WHERE id = $1`,
        [shopper.id],
      );
      checks.push({
        name: `counter: a sale (${side}) to a customer whose totals changed mid-flight writes its own stale figures over them (D146, copied)`,
        passed:
          waited &&
          response.status === 201 &&
          totals?.total_orders === 1 &&
          totals.total_spent === '2450.00',
        detail: `${response.status}, ${waited ? 'waited on the row' : 'never waited'}, ${totals?.total_orders} order(s), ${totals?.total_spent} spent (5 and 5000.00 were committed mid-flight)`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
