/**
 * Parity cases for supplier payments (phase 6 part 5): `/supplier-payments/`,
 * listed and recorded. A payment takes money out of one of the business's
 * accounts and, against an order, raises what was paid on it, so each write
 * is compared by the payments made, the orders changed, every account's
 * balance, the movements made, the audit log and the number sequences.
 *
 * The payments are fixture_purchasing.py's; the demo seed has none.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { FINANCE_EFFECTS, FINANCE_TABLES } from './finance-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { PURCHASE_EFFECTS } from './purchase-order-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const PAYMENT_TABLES = [
  'purchasing_supplierpayment',
  'purchasing_purchaseorder',
  ...FINANCE_TABLES,
];
const WHEN = (column: string) =>
  `CASE WHEN ${column} < $1 THEN (${column} AT TIME ZONE 'UTC')::text ELSE 'now' END`;

export const PAYMENT_EFFECTS = [
  // 0. Payments made.
  `SELECT s.code AS supplier, o.number AS purchase_order, p.amount::text, p.method, p.reference,
          ${WHEN('p.paid_at')} AS paid, p.paid_at <= p.created_at AS stamped_first, p.notes,
          a.name AS account, u.email AS created_by, p.idempotency_key
     FROM purchasing_supplierpayment p JOIN purchasing_supplier s ON s.id = p.supplier_id
     LEFT JOIN purchasing_purchaseorder o ON o.id = p.purchase_order_id
     LEFT JOIN finance_account a ON a.id = p.account_id
     LEFT JOIN accounts_user u ON u.id = p.created_by_id
    WHERE p.id NOT IN (SELECT id FROM "snap_purchasing_supplierpayment") ORDER BY p.created_at`,
  // 1. Orders changed: what was paid, and the badge.
  PURCHASE_EFFECTS[0] as string,
  // 2. Every balance.
  FINANCE_EFFECTS[1] as string,
  // 3. The movements made, each beside the payment that caused it.
  `SELECT a.name AS account, t.transaction_type, t.amount::text, t.balance_after::text,
          t.reference_type,
          (SELECT s.code || ' ' || p.amount FROM purchasing_supplierpayment p
             JOIN purchasing_supplier s ON s.id = p.supplier_id WHERE p.id::text = t.reference_id)
            AS reference,
          t.occurred_at = (SELECT p.paid_at FROM purchasing_supplierpayment p
                            WHERE p.id::text = t.reference_id) AS at_the_payment,
          t.reason, t.notes, u.email AS created_by, t.idempotency_key,
          ${WHEN('t.occurred_at')} AS occurred
     FROM finance_accounttransaction t JOIN finance_account a ON a.id = t.account_id
     LEFT JOIN accounts_user u ON u.id = t.created_by_id
    WHERE t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction")
    ORDER BY t.created_at, a.name`,
  // 4. The audit log, and the number sequences.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
  `SELECT key, last_value FROM core_numbersequence ORDER BY key`,
];

export async function resetPayments(client: pg.Client): Promise<void> {
  // One default per branch and kind is a unique index, checked row by row.
  const snapped = await client.query(`SELECT to_regclass('pg_temp.snap_finance_account') AS t`);
  if (snapped.rows[0]?.t) {
    await client.query(
      `UPDATE finance_account SET is_default = false
        WHERE is_default AND id NOT IN (SELECT id FROM "snap_finance_account" WHERE is_default)`,
    );
  }
  await restoreTables(client, PAYMENT_TABLES);
  await restoreSequences(client);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function supplierPaymentCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (sql: string) => {
    const found = new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
    // A name the fixtures do not hold is a mistake in this file, not a case.
    return (key: string) => {
      const id = found.get(key);
      if (!id) throw new Error(`supplier-payment-cases: nothing called ${key}`);
      return id;
    };
  };
  const marker = await db.query(
    `SELECT 1 FROM finance_account WHERE name = 'Parity Payables Float'`,
  );
  if (!marker.rows.length) {
    await db.end();
    console.log('SKIP  supplier payments: fixture_purchasing.py has not been applied');
    return [];
  }
  const supplier = await map(`SELECT code AS key, id FROM purchasing_supplier`);
  const order = await map(
    `SELECT invoice_number AS key, id FROM purchasing_purchaseorder WHERE invoice_number <> ''`,
  );
  const account = await map(`SELECT name AS key, id FROM finance_account`);
  const branch = await map(`SELECT code AS key, id FROM accounts_branch`);
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM purchasing_supplierpayment UNION ALL SELECT id::text FROM purchasing_supplier
       UNION ALL SELECT id::text FROM purchasing_purchaseorder UNION ALL SELECT id::text FROM finance_account
       UNION ALL SELECT id::text FROM accounts_branch`,
    )
  ).rows.map((row) => row.id);
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const first =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };

  const cases: Case[] = [];
  const PAYMENTS = '/api/v1/supplier-payments/';
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `supplier payments: ${name}`, path, headers: auth(who), ...extra });
  const pay = (name: string, body: unknown, who: Who = 'owner', extra: Partial<Case> = {}) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `supplier payments: ${name}`,
      method: 'POST',
      path: PAYMENTS,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetPayments,
      effects: PAYMENT_EFFECTS,
      normalize: minted,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const sole = supplier('PARITY-SOLE');
  const leather = supplier('SUP-002');
  const sent = order('PAR-PO-SENT');
  const done = order('PAR-PO-DONE');
  const float = account('Parity Payables Float');
  const bank = account('Parity Payables Bank');

  // === Reading =================================================================================
  for (const who of everyone) read(`[${who}] the list`, PAYMENTS, who);
  for (const query of [
    `supplier=${sole}`,
    `supplier=${leather}`,
    `supplier=${supplier('PARITY-IDLE')}`,
    `supplier=${MISSING}`,
    'supplier=abc',
    `purchase_order=${done}`,
    `purchase_order=${sent}`,
    `purchase_order=${MISSING}`,
    'purchase_order=abc',
    'method=CASH',
    'method=BANK',
    'method=CHEQUE',
    'method=MOBILE_MFS',
    'method=cash',
    'method=',
    `supplier=${sole}&method=BANK&purchase_order=${done}`,
    'supplier=x&purchase_order=y&method=z',
    'ordering=paid_at',
    'ordering=-paid_at',
    'ordering=amount',
    'ordering=-amount,id',
    'ordering=supplier',
    'ordering=-supplier,amount',
    'ordering=supplier__name,-paid_at',
    'ordering=supplier_name',
    'ordering=purchase_order,amount',
    'ordering=-purchase_order,amount',
    'ordering=purchase_order__number,amount',
    'ordering=purchase_number',
    'ordering=account,amount',
    'ordering=-account,amount',
    'ordering=account__name,amount',
    'ordering=account__name,account,supplier',
    'ordering=account_name',
    'ordering=method,reference,notes,created_at',
    'ordering=id',
    'ordering=created_by',
    'search=TT-1001',
    'page_size=2',
    'page_size=2&page=2',
    'page=99',
  ]) {
    read(`the list ?${query}`, `${PAYMENTS}?${query}`);
  }
  for (const query of ['', 'ordering=account,supplier', 'ordering=purchase_order', 'method=CASH'])
    read(`[mirpur] the list ?${query}`, `${PAYMENTS}?${query}`, 'mirpur');
  read('a payment by its id', `${PAYMENTS}${MISSING}/`);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    for (const who of ['owner', 'accountant', 'cashier'] as Who[])
      read(`[${who}] ${method} the list`, PAYMENTS, who, { method });
  }

  // === Recording ===============================================================================
  const advance = { supplier: leather, amount: '250.00', method: 'CASH' };
  const against = { supplier: sole, purchase_order: sent, amount: '500.00', method: 'BANK' };
  for (const who of everyone) {
    pay(`[${who}] an advance`, advance, who);
    pay(`[${who}] against an order`, against, who);
  }
  for (const [name, body] of [
    ['an advance in cash', advance],
    ['an advance by cheque', { ...advance, method: 'CHEQUE', reference: ' CHQ-9 ' }],
    ['an advance by mobile wallet', { ...advance, method: 'MOBILE_MFS' }],
    ['an advance by other means', { ...advance, method: 'OTHER' }],
    ['an advance from a named account', { ...advance, account: float, notes: 'From the float' }],
    ['an advance from an account of the wrong kind', { ...advance, account: bank }],
    [
      'an advance from another branch’s account',
      { ...advance, account: account('Parity Mirpur Payables') },
    ],
    [
      'an advance from a closed account',
      { ...advance, method: 'BANK', account: account('Parity Closed Bank') },
    ],
    ['an advance from an account that is not there', { ...advance, account: MISSING }],
    ['an advance from a null account', { ...advance, account: null }],
    [
      'an advance of more than the account holds',
      { ...advance, amount: '19500.01', account: float },
    ],
    ['an advance of all the account holds', { ...advance, amount: '19500.00', account: float }],
    ['an advance of more than the drawer holds', { ...advance, amount: '99999999.00' }],
    [
      'an advance from an account that may go overdrawn',
      { ...advance, method: 'OTHER', amount: '5000.00' },
    ],
    ['an advance at another branch', { ...advance, branch: branch('PAR3') }],
    ['an advance at a branch that is closed', { ...advance, branch: branch('PAR2') }],
    ['an advance at a branch that is not there', { ...advance, branch: MISSING }],
    ['an advance at a branch that is not a uuid', { ...advance, branch: 'abc' }],
    ['an advance at a branch that is a number', { ...advance, branch: 7 }],
    ['an advance at a null branch', { ...advance, branch: null }],
    ['an advance at a blank branch', { ...advance, branch: '' }],
    ['an advance to an inactive supplier', { ...advance, supplier: supplier('PARITY-IDLE') }],
    ['dated in the past', { ...advance, paid_at: '2026-09-01T10:30:00+06:00' }],
    ['dated without a zone', { ...advance, paid_at: '2026-09-01 10:30' }],
    ['dated in the future', { ...advance, paid_at: '2099-01-01T00:00:00Z' }],
    ['dated by a day alone', { ...advance, paid_at: '2026-09-01' }],
    ['dated with a null', { ...advance, paid_at: null }],
    ['dated with a blank', { ...advance, paid_at: '' }],
    ['dated with a word', { ...advance, paid_at: 'yesterday' }],
    ['an amount of nothing', { ...advance, amount: '0' }],
    ['an amount below zero', { ...advance, amount: '-5' }],
    ['an amount to three places', { ...advance, amount: '1.005' }],
    ['an amount that is a number', { ...advance, amount: 250.5 }],
    ['an amount that is a word', { ...advance, amount: 'lots' }],
    ['an amount of fifteen digits', { ...advance, amount: '1234567890123.45' }],
    ['a null amount', { ...advance, amount: null }],
    ['no amount', { supplier: leather, method: 'CASH' }],
    [
      'no amount, at a branch that is not there',
      { supplier: leather, method: 'CASH', branch: MISSING },
    ],
    [
      'no amount, against another branch’s order',
      { supplier: supplier('SUP-001'), method: 'CASH', purchase_order: order('PAR-PO-MIRPUR') },
    ],
    ['a method that is not one', { ...advance, method: 'BITCOIN' }],
    ['a method in lower case', { ...advance, method: 'cash' }],
    ['a method the counter knows and this does not', { ...advance, method: 'CARD' }],
    ['no method', { supplier: leather, amount: '5' }],
    ['a reference of 120 characters', { ...advance, reference: 'r'.repeat(120) }],
    ['a reference of 121 characters', { ...advance, reference: 'r'.repeat(121) }],
    ['null notes', { ...advance, notes: null }],
    ['a supplier that is not there', { ...advance, supplier: MISSING }],
    ['a supplier that is not a uuid', { ...advance, supplier: 'abc' }],
    ['a null supplier', { ...advance, supplier: null }],
    ['no supplier', { amount: '5', method: 'CASH' }],
    ['against an order, in part', against],
    ['against an order, in full', { ...against, amount: '2160.00' }],
    ['against an order, a paisa over', { ...against, amount: '2160.01' }],
    [
      'against an order, with everything stated',
      {
        ...against,
        reference: 'TT-2002',
        notes: 'Second instalment',
        paid_at: '2026-09-25T09:00:00+06:00',
        account: bank,
      },
    ],
    ['against an order, in cash from the drawer', { ...against, method: 'CASH' }],
    ['against an order, from an account of the wrong kind', { ...against, account: float }],
    [
      'against an order with credit, all that is owed',
      { supplier: sole, purchase_order: done, amount: '1020.00', method: 'BANK' },
    ],
    [
      'against an order with credit, a paisa over',
      { supplier: sole, purchase_order: done, amount: '1020.01', method: 'BANK' },
    ],
    [
      'against an order with credit, what the total was',
      { supplier: sole, purchase_order: done, amount: '1620.00', method: 'BANK' },
    ],
    [
      'against an order with money on it, the rest',
      { supplier: sole, purchase_order: order('PAR-PO-PAID'), amount: '1000.00', method: 'BANK' },
    ],
    [
      'against a part-received order',
      { supplier: sole, purchase_order: order('PAR-PO-PART'), amount: '75.00', method: 'BANK' },
    ],
    [
      'against a closed order',
      { supplier: sole, purchase_order: order('PAR-PO-CLOSED'), amount: '600.00', method: 'BANK' },
    ],
    [
      'against a draft',
      { supplier: sole, purchase_order: order('PAR-PO-DRAFT'), amount: '5', method: 'BANK' },
    ],
    [
      'against a cancelled order',
      { supplier: sole, purchase_order: order('PAR-PO-CANCELLED'), amount: '5', method: 'BANK' },
    ],
    [
      'against another supplier’s order',
      { supplier: leather, purchase_order: sent, amount: '5', method: 'BANK' },
    ],
    [
      'against another supplier’s draft',
      { supplier: leather, purchase_order: order('PAR-PO-DRAFT'), amount: '5', method: 'BANK' },
    ],
    [
      'against a seeded order',
      {
        supplier: supplier('SUP-002'),
        purchase_order: order('CLC-2026-0118'),
        amount: '323361.60',
        method: 'BANK',
      },
    ],
    [
      'against another branch’s order',
      {
        supplier: supplier('SUP-001'),
        purchase_order: order('PAR-PO-MIRPUR'),
        amount: '100.00',
        method: 'CASH',
      },
    ],
    [
      'against another branch’s order, naming this branch',
      {
        supplier: supplier('SUP-001'),
        purchase_order: order('PAR-PO-MIRPUR'),
        amount: '100.00',
        method: 'CASH',
        branch: branch('DHK1'),
      },
    ],
    ['against an order, at a branch that is not there', { ...against, branch: MISSING }],
    ['against an order that is not there', { ...against, purchase_order: MISSING }],
    ['against an order that is not a uuid', { ...against, purchase_order: 'abc' }],
    ['against a null order', { ...against, purchase_order: null }],
    ['against a blank order', { ...against, purchase_order: '' }],
    [
      'what it may not state',
      { ...advance, id: MISSING, created_at: '2020-01-01', supplier_name: 'x', account_name: 'y' },
    ],
    [
      'every field wrong',
      {
        supplier: 'x',
        purchase_order: 'y',
        amount: 'z',
        method: 'w',
        reference: [],
        paid_at: 'v',
        notes: {},
        account: 'u',
      },
    ],
    ['a body that is a list', [advance]],
    ['broken JSON', '{"supplier":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    pay(name, body);
  }
  pay('[mirpur] an advance at their own branch', advance, 'mirpur');
  pay(
    '[accountant] against another branch’s order',
    {
      supplier: supplier('SUP-001'),
      purchase_order: order('PAR-PO-MIRPUR'),
      amount: '100.00',
      method: 'CASH',
    },
    'accountant',
  );
  for (const [name, body, key] of [
    ['under a new key', against, 'parity-payment-new'],
    ['under a key already used', against, 'parity-payment-keyed'],
    ['under a used key, an advance', advance, 'parity-payment-keyed'],
    ['under a used key, an amount of nothing', { ...advance, amount: '0' }, 'parity-payment-keyed'],
    [
      'under a used key, against a draft',
      { supplier: sole, purchase_order: order('PAR-PO-DRAFT'), amount: '5', method: 'BANK' },
      'parity-payment-keyed',
    ],
    [
      'under a used key, with no amount',
      { supplier: leather, method: 'CASH' },
      'parity-payment-keyed',
    ],
    ['under an empty key', advance, ''],
    ['under a key of 80 characters', advance, 'k'.repeat(80)],
    ['under a key of 81 characters', advance, 'k'.repeat(81)],
  ] as [string, unknown, string][]) {
    pay(name, body, 'owner', { headers: { 'idempotency-key': key } });
  }
  pay('from the branch’s account once its default is closed', advance, 'owner', {
    prepare: first(
      `UPDATE finance_account SET is_active = false WHERE name = 'Counter Cash Drawer'`,
    ),
  });
  pay('from no account, every cash account closed', advance, 'owner', {
    prepare: first(
      `UPDATE finance_account SET is_active = false
        WHERE kind = 'CASH' AND branch_id = '${branch('DHK1')}'`,
    ),
  });
  pay('against an order paid in full', { ...against, amount: '0.01' }, 'owner', {
    prepare: first(
      `UPDATE purchasing_purchaseorder SET paid_total = grand_total, payment_status = 'PAID'
        WHERE invoice_number = 'PAR-PO-SENT'`,
    ),
  });
  pay(
    'against an order overpaid by a return',
    { supplier: sole, purchase_order: done, amount: '0.01', method: 'BANK' },
    'owner',
    {
      prepare: first(
        `UPDATE purchasing_purchaseorder SET paid_total = grand_total, payment_status = 'PAID'
        WHERE invoice_number = 'PAR-PO-DONE'`,
      ),
    },
  );
  return cases;
}
