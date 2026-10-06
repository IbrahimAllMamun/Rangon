/**
 * Parity cases for voiding a counter sale (phase 5 part 4):
 * `POST /pos/sales/<id>/void/`. A void puts the goods back under a
 * compensating RETURN, refunds what was paid through the cash book, gives a
 * coupon's use back and cancels the order -- one transaction, compared by
 * the same queries as the sale itself.
 *
 * The sales to void come from fixture_pos.py and the demo seed.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker, resetSales, SALE_EFFECTS } from './pos-sale-cases.ts';
import type { Case } from './run.ts';

export async function posVoidCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const byNote = new Map(
    (
      await db.query<{ key: string; id: string }>(
        `SELECT customer_note AS key, id FROM orders_order WHERE customer_note LIKE 'Parity%'`,
      )
    ).rows.map((row) => [row.key, row.id]),
  );
  const pick = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0]?.id;
  const replayed = await pick(
    `SELECT id FROM orders_order WHERE idempotency_key = 'parity-pos-replayed'`,
  );
  const mirpurSale = await pick(
    `SELECT o.id FROM orders_order o JOIN accounts_branch b ON b.id = o.branch_id
      WHERE o.channel = 'POS' AND b.code = 'PAR3' AND o.customer_note = ''`,
  );
  const online = await pick(
    `SELECT id FROM orders_order WHERE channel = 'ONLINE' AND status = 'DELIVERED' ORDER BY number LIMIT 1`,
  );
  const voided = await pick(
    `SELECT id FROM orders_order WHERE channel = 'POS' AND status = 'CANCELLED' ORDER BY number LIMIT 1`,
  );
  const returning = await pick(
    `SELECT id FROM orders_order WHERE channel = 'POS' AND status = 'RETURN_REQUESTED'
        AND payment_status = 'PAID' ORDER BY number LIMIT 1`,
  );
  const partRefunded = await pick(
    `SELECT id FROM orders_order WHERE channel = 'POS' AND payment_status = 'PARTIALLY_REFUNDED'
      ORDER BY number LIMIT 1`,
  );
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM orders_order UNION ALL SELECT id::text FROM orders_orderitem
       UNION ALL SELECT id::text FROM orders_payment UNION ALL SELECT id::text FROM orders_refund
       UNION ALL SELECT id::text FROM orders_orderevent UNION ALL SELECT id::text FROM accounts_branch
       UNION ALL SELECT id::text FROM customers_customer UNION ALL SELECT id::text FROM catalog_productvariant
       UNION ALL SELECT id::text FROM promotions_coupon UNION ALL SELECT id::text FROM finance_account`,
    )
  ).rows.map((row) => row.id);
  if (!replayed || !mirpurSale || !byNote.has('Parity void card')) {
    await db.end();
    console.log('SKIP  pos void: fixture_pos.py has not been applied');
    return [];
  }
  // Kept open: a case's `prepare` changes rows after the reset, before its request.
  const after =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };
  const blank = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const split = byNote.get('Parity split payment') as string;
  const carded = byNote.get('Parity void card') as string;
  const free = byNote.get('Parity void free') as string;
  const couponed = byNote.get('Parity void coupon') as string;
  const missing = '00000000-0000-4000-8000-000000000000';

  const cases: Case[] = [];
  const VOID = (id: string) => `/api/v1/pos/sales/${id}/void/`;
  const void_ = (
    name: string,
    id: string,
    body: unknown,
    who: Who = 'manager',
    extra: Partial<Case> = {},
  ) =>
    cases.push({
      name: `pos void: ${name}`,
      method: 'POST',
      path: VOID(id),
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: resetSales,
      effects: SALE_EFFECTS,
      jobs: true,
      normalize: blank,
      ...extra,
    });
  const why = { reason: 'Rung up twice' };

  // --- Who may void ------------------------------------------------------------------------
  for (const who of Object.keys(STAFF) as Who[]) {
    void_(`[${who}] a sale`, replayed, why, who);
    cases.push({
      name: `pos void: [${who}] GET`,
      path: VOID(replayed),
      headers: auth(who),
    });
  }

  // --- What is voided ------------------------------------------------------------------------
  for (const [name, id] of [
    ['a cash sale', replayed],
    ['a sale paid in cash and by card, with a coupon', split],
    ['a sale paid by card into no account', carded],
    ['a sale that came to nothing and was never paid', free],
    ['a sale with a twice-each coupon and change', couponed],
    ['a sale at another branch, by a manager bound elsewhere', mirpurSale],
    ['a sale with a return requested', returning as string],
    ['a sale partly refunded already', partRefunded as string],
    ['a sale already voided', voided as string],
    ['an online order', online as string],
    ['a sale that is not there', missing],
  ] as [string, string][]) {
    void_(name, id, why);
  }
  void_('a sale at its own branch, by its manager', mirpurSale, why, 'mirpur');
  void_('a sale at the home branch, by the other branch’s manager', replayed, why, 'mirpur');
  void_('a sale that is not a uuid', 'abc', why);
  void_('a sale, with an ordering Django cannot do', `${replayed}`, why, 'manager', {
    path: `${VOID(replayed)}?ordering=lines`,
  });

  // --- The reason ---------------------------------------------------------------------------
  for (const [name, body] of [
    ['no reason', {}],
    ['a blank reason', { reason: '' }],
    ['a reason of spaces', { reason: '  \t ' }],
    ['a padded reason', { reason: '  Wrong size rung up \n' }],
    ['a reason of 300 characters', { reason: 'r'.repeat(300) }],
    ['a reason in Bengali', { reason: 'ভুল সাইজ' }],
    ['a null reason', { reason: null }],
    ['a reason that is a number', { reason: 5 }],
    ['a reason that is a list', { reason: ['x'] }],
    ['a list', []],
    ['null', 'null'],
    ['broken JSON', '{"reason":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    void_(name, replayed, body);
  }
  void_('an already voided sale, with no reason', voided as string, {});
  void_('an already voided sale, with a body that is a list', voided as string, []);
  void_('an online order, with no reason', online as string, {});
  void_('a sale that is not there, with broken JSON', missing, '{"reason":');

  // --- Where the money goes back from ---------------------------------------------------------
  void_('a cash sale, the drawer short of the refund', replayed, why, 'manager', {
    prepare: after(
      `UPDATE finance_account SET balance = 100.00 WHERE name = 'Counter Cash Drawer'`,
    ),
  });
  void_('a cash sale, the drawer short but allowed to go overdrawn', replayed, why, 'manager', {
    prepare: after(
      `UPDATE finance_account SET balance = 100.00, allow_overdraft = true
        WHERE name = 'Counter Cash Drawer'`,
    ),
  });
  void_('a cash sale, the drawer since closed', replayed, why, 'manager', {
    prepare: after(
      `UPDATE finance_account SET is_active = false WHERE name = 'Counter Cash Drawer'`,
    ),
  });
  void_('a cash sale, its payment since moved to no account', replayed, why, 'manager', {
    prepare: after(
      `UPDATE orders_payment SET account_id = NULL
        WHERE order_id = (SELECT id FROM orders_order WHERE idempotency_key = 'parity-pos-replayed')`,
    ),
  });
  void_('a sale whose stock has since been counted away', replayed, why, 'manager', {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = 0
        WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-ESS-XL-WHI')
          AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`,
    ),
  });
  return cases;
}
