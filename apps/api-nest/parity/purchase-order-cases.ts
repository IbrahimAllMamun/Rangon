/**
 * Parity cases for purchase orders (phase 6 part 4): `/purchase-orders/`
 * raised, sent, cancelled, received and returned against. Receiving puts
 * stock on the shelf at its cost and a return takes it off again, so each
 * write is compared by the orders, lines, receipts and returns it made or
 * changed, by the shelf and its ledger, by each SKU's latest cost and its
 * supplier's price list, by the audit log, the number sequences and the
 * low-stock jobs queued.
 *
 * An order's lines, a receipt's and a return's carry no order of their own
 * (D161's kind): both APIs send the same statements, and a write case, whose
 * rows the restore between the two sides moves in the heap, compares them by
 * the SKU or the order line each is for.
 *
 * The orders are the demo seed's and fixture_purchasing.py's, named there by
 * their invoice numbers.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { STOCK_TABLES } from './inventory-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { SUPPLIER_EFFECTS, SUPPLIER_TABLES } from './purchasing-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const PURCHASE_TABLES = [
  'purchasing_purchasereturnitem',
  'purchasing_purchasereturn',
  'purchasing_purchasereceiptitem',
  'purchasing_purchasereceipt',
  'purchasing_purchaseorderitem',
  'purchasing_purchaseorder',
  ...SUPPLIER_TABLES,
  ...STOCK_TABLES,
  'catalog_productvariant',
];
const NEW = (alias: string, table: string) => `${alias}.id NOT IN (SELECT id FROM "snap_${table}")`;
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(snap) FROM "snap_${table}" snap WHERE snap.id = ${alias}.id)`;

export const PURCHASE_EFFECTS = [
  // 0. Orders a request made or changed.
  `SELECT o.number, s.code AS supplier, b.code AS branch, o.status, o.payment_status,
          o.invoice_number, o.ordered_at IS NOT NULL AS ordered, o.expected_at::text AS expected,
          o.completed_at IS NOT NULL AS completed, o.subtotal::text, o.discount_total::text,
          o.tax_total::text, o.shipping_total::text, o.grand_total::text, o.paid_total::text,
          o.credited_total::text, o.currency, o.notes, u.email AS created_by,
          ${NEW('o', 'purchasing_purchaseorder')} AS made
     FROM purchasing_purchaseorder o JOIN purchasing_supplier s ON s.id = o.supplier_id
     JOIN accounts_branch b ON b.id = o.branch_id LEFT JOIN accounts_user u ON u.id = o.created_by_id
    WHERE ${CHANGED('o', 'purchasing_purchaseorder')} ORDER BY o.number`,
  // 1. Their lines.
  `SELECT o.number, v.sku, i.quantity_ordered, i.quantity_received, i.quantity_returned,
          i.unit_cost::text, i.discount::text, i.tax_rate::text, i.line_total::text,
          ${NEW('i', 'purchasing_purchaseorderitem')} AS made
     FROM purchasing_purchaseorderitem i JOIN purchasing_purchaseorder o ON o.id = i.purchase_order_id
     LEFT JOIN catalog_productvariant v ON v.id = i.variant_id
    WHERE ${CHANGED('i', 'purchasing_purchaseorderitem')} ORDER BY o.number, v.sku, i.unit_cost`,
  // 2. Deliveries recorded, and their lines.
  `SELECT r.number, o.number AS purchase_order, u.email AS received_by, r.notes, r.is_posted,
          r.received_at >= $1 AS just_now, r.received_at <= r.created_at AS stamped_first,
          (SELECT string_agg(v.sku || ' x' || x.quantity || ' @' || x.unit_cost, ', ' ORDER BY v.sku)
             FROM purchasing_purchasereceiptitem x
             JOIN purchasing_purchaseorderitem i ON i.id = x.purchase_order_item_id
             JOIN catalog_productvariant v ON v.id = i.variant_id WHERE x.receipt_id = r.id) AS lines
     FROM purchasing_purchasereceipt r JOIN purchasing_purchaseorder o ON o.id = r.purchase_order_id
     LEFT JOIN accounts_user u ON u.id = r.received_by_id
    WHERE ${NEW('r', 'purchasing_purchasereceipt')} ORDER BY r.number`,
  // 3. Goods sent back, and their lines.
  `SELECT r.number, o.number AS purchase_order, r.reason, r.notes, r.credit_total::text,
          r.idempotency_key, u.email AS returned_by, r.returned_at >= $1 AS just_now,
          r.returned_at <= r.created_at AS stamped_first,
          (SELECT string_agg(v.sku || ' x' || x.quantity || ' @' || x.unit_cost, ', '
                             ORDER BY v.sku, x.quantity)
             FROM purchasing_purchasereturnitem x
             JOIN purchasing_purchaseorderitem i ON i.id = x.purchase_order_item_id
             JOIN catalog_productvariant v ON v.id = i.variant_id
            WHERE x.purchase_return_id = r.id) AS lines
     FROM purchasing_purchasereturn r JOIN purchasing_purchaseorder o ON o.id = r.purchase_order_id
     LEFT JOIN accounts_user u ON u.id = r.returned_by_id
    WHERE ${NEW('r', 'purchasing_purchasereturn')} ORDER BY r.number`,
  // 4. The shelf: every row a request made or changed.
  `SELECT b.code AS branch, v.sku, i.on_hand, i.reserved, i.average_cost::text, i.reorder_point,
          ${NEW('i', 'inventory_inventory')} AS made
     FROM inventory_inventory i JOIN accounts_branch b ON b.id = i.branch_id
     LEFT JOIN catalog_productvariant v ON v.id = i.variant_id
    WHERE ${CHANGED('i', 'inventory_inventory')} ORDER BY b.code, v.sku`,
  // 5. Its ledger: each row named by the receipt or the return that caused it.
  `SELECT b.code AS branch, v.sku, t.transaction_type, t.quantity, t.unit_cost::text,
          t.on_hand_after, t.reserved_after, t.reference_type,
          COALESCE((SELECT d.number FROM purchasing_purchasereceipt d WHERE d.id::text = t.reference_id),
                   (SELECT d.number FROM purchasing_purchasereturn d WHERE d.id::text = t.reference_id),
                   t.reference_id) AS reference,
          t.reason, t.notes, u.email AS created_by, t.idempotency_key
     FROM inventory_inventorytransaction t JOIN accounts_branch b ON b.id = t.branch_id
     LEFT JOIN catalog_productvariant v ON v.id = t.variant_id
     LEFT JOIN accounts_user u ON u.id = t.created_by_id
    WHERE ${NEW('t', 'inventory_inventorytransaction')}
    ORDER BY b.code, v.sku, t.on_hand_after, t.quantity`,
  // 6. SKUs whose latest cost moved.
  `SELECT v.sku, v.cost::text FROM catalog_productvariant v
    WHERE ${CHANGED('v', 'catalog_productvariant')} ORDER BY v.sku`,
  // 7, 8. The supplier's price list, and each SKU's preferred supplier.
  SUPPLIER_EFFECTS[1] as string,
  SUPPLIER_EFFECTS[3] as string,
  // 9. The audit log; a shelf's entry names its row, minted when a request made it.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
  `SELECT key, last_value FROM core_numbersequence ORDER BY key`,
];

export async function resetPurchases(client: pg.Client): Promise<void> {
  const snapped = await client.query(
    `SELECT to_regclass('pg_temp.snap_purchasing_supplierproduct') AS t`,
  );
  if (snapped.rows[0]?.t) {
    await client.query(
      `UPDATE purchasing_supplierproduct SET is_preferred = false
        WHERE is_preferred
          AND id NOT IN (SELECT id FROM "snap_purchasing_supplierproduct" WHERE is_preferred)`,
    );
  }
  await restoreTables(client, PURCHASE_TABLES);
  await restoreSequences(client);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

/** Lines in a fixed order: by the SKU or the order line each is for, then by quantity. */
export function sortLines(body: unknown): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    for (const [key, inner] of Object.entries(row)) {
      if (key === 'items' && Array.isArray(inner)) {
        inner.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
          const left = `${String(a.sku)} ${String(a.quantity ?? a.quantity_ordered).padStart(12, '0')}`;
          const right = `${String(b.sku)} ${String(b.quantity ?? b.quantity_ordered).padStart(12, '0')}`;
          return left < right ? -1 : left > right ? 1 : 0;
        });
      }
      walk(inner);
    }
  };
  walk(body);
}

export async function purchaseOrderCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const supplier = await map(`SELECT code AS key, id FROM purchasing_supplier`);
  const variant = await map(`SELECT sku AS key, id FROM catalog_productvariant`);
  const branch = await map(`SELECT code AS key, id FROM accounts_branch`);
  // An order by its number, and by its invoice number where it has one.
  const order = await map(
    `SELECT number AS key, id FROM purchasing_purchaseorder
     UNION ALL SELECT invoice_number, id FROM purchasing_purchaseorder WHERE invoice_number <> ''`,
  );
  // An order's line, as "<invoice> <sku>".
  const item = await map(
    `SELECT o.number || ' ' || v.sku AS key, i.id
       FROM purchasing_purchaseorderitem i JOIN purchasing_purchaseorder o ON o.id = i.purchase_order_id
       JOIN catalog_productvariant v ON v.id = i.variant_id
     UNION ALL
     SELECT o.invoice_number || ' ' || v.sku, i.id
       FROM purchasing_purchaseorderitem i JOIN purchasing_purchaseorder o ON o.id = i.purchase_order_id
       JOIN catalog_productvariant v ON v.id = i.variant_id WHERE o.invoice_number <> ''`,
  );
  if (!order.has('PAR-PO-DRAFT')) {
    await db.end();
    console.log('SKIP  purchase orders: fixture_purchasing.py has not been applied');
    return [];
  }
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM purchasing_purchaseorder UNION ALL SELECT id::text FROM purchasing_purchaseorderitem
       UNION ALL SELECT id::text FROM purchasing_purchasereceipt UNION ALL SELECT id::text FROM purchasing_purchasereceiptitem
       UNION ALL SELECT id::text FROM purchasing_purchasereturn UNION ALL SELECT id::text FROM purchasing_purchasereturnitem
       UNION ALL SELECT id::text FROM purchasing_supplier UNION ALL SELECT id::text FROM catalog_productvariant
       UNION ALL SELECT id::text FROM accounts_branch UNION ALL SELECT id::text FROM accounts_user`,
    )
  ).rows.map((row) => row.id);
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const normalize = (body: unknown) => {
    sortLines(body);
    minted(body);
  };
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  /** A statement run before each API's request, after the restore: a state no fixture holds. */
  const first =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `purchase orders: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    path: string,
    body: unknown,
    who: Who = 'owner',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `purchase orders: ${name}`,
      method: 'POST',
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetPurchases,
      effects: PURCHASE_EFFECTS,
      normalize,
      jobs: true,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const ORDERS = '/api/v1/purchase-orders/';
  const sole = supplier.get('PARITY-SOLE') as string;
  const a = variant.get('PAR-BUY-A') as string;
  const b = variant.get('PAR-BUY-B') as string;
  const c = variant.get('PAR-BUY-C') as string;
  // A name the fixture does not hold is a mistake in this file, not a case.
  const id = (invoice: string) => {
    const found = order.get(invoice);
    if (!found) throw new Error(`purchase-order-cases: no order ${invoice}`);
    return found;
  };
  const line = (key: string) => {
    const found = item.get(key);
    if (!found) throw new Error(`purchase-order-cases: no line ${key}`);
    return found;
  };
  const home = branch.get('DHK1') as string;
  const mirpur = branch.get('PAR3') as string;

  // === Reading =================================================================================
  for (const who of everyone) {
    read(`[${who}] the list`, `${ORDERS}?page_size=3`, who);
    read(`[${who}] an order`, `${ORDERS}${id('PAR-PO-PART')}/`, who);
    read(`[${who}] an order's receipts`, `${ORDERS}${id('PAR-PO-DONE')}/receipts/`, who);
    read(`[${who}] another branch's order`, `${ORDERS}${id('PAR-PO-MIRPUR')}/`, who);
  }
  for (const query of [
    '',
    'status=DRAFT',
    'status=SENT',
    'status=PARTIALLY_RECEIVED',
    'status=RECEIVED',
    'status=CLOSED',
    'status=CANCELLED',
    'status=sent',
    'status=',
    `supplier=${sole}`,
    `supplier=${supplier.get('SUP-002')}`,
    `supplier=${supplier.get('PARITY-IDLE')}`,
    `supplier=${MISSING}`,
    'supplier=abc',
    `branch=${home}&page_size=4`,
    `branch=${mirpur}`,
    `branch=${MISSING}`,
    'branch=abc',
    'payment_status=UNPAID&page_size=4',
    'payment_status=PARTIALLY_PAID',
    'payment_status=PAID',
    'payment_status=paid',
    `supplier=${sole}&status=SENT&payment_status=UNPAID`,
    'status=x&supplier=y&branch=z&payment_status=w',
    'ordering=created_at&page_size=5',
    'ordering=-created_at&page_size=5',
    'ordering=expected_at&page_size=5',
    'ordering=-expected_at&page_size=5',
    'ordering=-expected_at,created_at&page_size=5',
    'ordering=expected_at,-created_at&page_size=5',
    'ordering=supplier&page_size=5',
    'ordering=number&page_size=5',
    'date_from=2026-01-01&page_size=2',
    'date_from=2099-01-01',
    'date_to=2020-01-01',
    'date_from=2026-01-01&date_to=2099-12-31&page_size=2',
    'date_from=2026-09-01T10:30:00%2B06:00&page_size=2',
    'date_from=abc',
    'date_to=2026-02-30',
    'date_from=abc&status=nope',
    'date_from=&date_to=&page_size=2',
    'search=PO-000001&page_size=2',
    'page_size=5&page=2',
    'page_size=100',
    'page=99',
  ]) {
    read(`the list ?${query}`, `${ORDERS}?${query}`);
  }
  for (const invoice of [
    'PAR-PO-DRAFT',
    'PAR-PO-SENT',
    'PAR-PO-DONE',
    'PAR-PO-CANCELLED',
    'PAR-PO-CLOSED',
    'PAR-PO-PAID',
    'PO-000001',
    'PO-000004',
  ]) {
    read(`the order ${invoice}`, `${ORDERS}${id(invoice)}/`);
    read(`the receipts of ${invoice}`, `${ORDERS}${id(invoice)}/receipts/`);
  }
  read('an order that is not there', `${ORDERS}${MISSING}/`);
  read('an order that is not a uuid', `${ORDERS}abc/`);
  read('an order, filtered out', `${ORDERS}${id('PAR-PO-SENT')}/?status=DRAFT`);
  read(
    'an order, filtered in and ordered',
    `${ORDERS}${id('PAR-PO-SENT')}/?status=SENT&ordering=expected_at`,
  );
  read('an order, outside the window', `${ORDERS}${id('PAR-PO-SENT')}/?date_to=2020-01-01`);
  read(
    'an order, with a window that is not a date',
    `${ORDERS}${id('PAR-PO-SENT')}/?date_from=abc`,
  );
  read('an order with a filter that is not a choice', `${ORDERS}${id('PAR-PO-SENT')}/?status=nope`);
  read('receipts of an order that is not there', `${ORDERS}${MISSING}/receipts/`);
  read('receipts, filtered out', `${ORDERS}${id('PAR-PO-DONE')}/receipts/?status=DRAFT`);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    for (const who of ['owner', 'manager', 'cashier'] as Who[])
      read(`[${who}] ${method} an order`, `${ORDERS}${id('PAR-PO-DRAFT')}/`, who, { method });
  }
  read('GET send', `${ORDERS}${id('PAR-PO-DRAFT')}/send/`);
  read('POST receipts', `${ORDERS}${id('PAR-PO-DRAFT')}/receipts/`, 'owner', { method: 'POST' });

  // === Raising =================================================================================
  const one = { variant: a, quantity: 3, unit_cost: '200.00' };
  const basic = { supplier: sole, lines: [one] };
  for (const who of everyone) write(`[${who}] raise an order`, ORDERS, basic, who);
  for (const [name, body] of [
    ['a supplier and a line', basic],
    [
      'everything stated',
      {
        supplier: sole,
        branch: home,
        lines: [
          { variant: a, quantity: 10, unit_cost: '199.99', discount: '99.90', tax_rate: '0.1500' },
          { variant: b, quantity: 1, unit_cost: 50, discount: 0, tax_rate: 0 },
          { variant: c, quantity: 7, unit_cost: '33.33', tax_rate: '0.0750' },
        ],
        expected_at: '2026-12-01',
        invoice_number: ' INV-77 ',
        shipping_total: '120.5',
        notes: 'Call before delivery',
      },
    ],
    [
      'tax that rounds half up',
      {
        supplier: sole,
        lines: [{ variant: a, quantity: 1, unit_cost: '1.00', tax_rate: '0.0050' }],
      },
    ],
    [
      'tax of the whole line',
      { supplier: sole, lines: [{ variant: a, quantity: 2, unit_cost: '10.00', tax_rate: '1' }] },
    ],
    [
      'a discount of the whole line',
      {
        supplier: sole,
        lines: [{ variant: a, quantity: 2, unit_cost: '10.00', discount: '20.00' }],
      },
    ],
    [
      'a discount past its line',
      {
        supplier: sole,
        lines: [{ variant: a, quantity: 2, unit_cost: '10.00', discount: '20.01' }],
      },
    ],
    ['a discount below zero', { supplier: sole, lines: [{ ...one, discount: '-1' }] }],
    ['a null discount', { supplier: sole, lines: [{ ...one, discount: null }] }],
    ['a cost of nothing', { supplier: sole, lines: [{ ...one, unit_cost: '0' }] }],
    ['a cost below zero', { supplier: sole, lines: [{ ...one, unit_cost: '-0.01' }] }],
    ['a cost to three places', { supplier: sole, lines: [{ ...one, unit_cost: '1.005' }] }],
    ['a cost that is a word', { supplier: sole, lines: [{ ...one, unit_cost: 'cheap' }] }],
    ['a null cost', { supplier: sole, lines: [{ ...one, unit_cost: null }] }],
    ['no cost', { supplier: sole, lines: [{ variant: a, quantity: 3 }] }],
    ['a tax rate past one', { supplier: sole, lines: [{ ...one, tax_rate: '1.0001' }] }],
    ['a tax rate typed as a percentage', { supplier: sole, lines: [{ ...one, tax_rate: 15 }] }],
    ['a tax rate below zero', { supplier: sole, lines: [{ ...one, tax_rate: '-0.1' }] }],
    ['a tax rate to five places', { supplier: sole, lines: [{ ...one, tax_rate: '0.12345' }] }],
    ['a quantity of nothing', { supplier: sole, lines: [{ ...one, quantity: 0 }] }],
    ['a quantity below zero', { supplier: sole, lines: [{ ...one, quantity: -2 }] }],
    ['a quantity as a string', { supplier: sole, lines: [{ ...one, quantity: '3' }] }],
    ['a quantity of 2.5', { supplier: sole, lines: [{ ...one, quantity: 2.5 }] }],
    ['a quantity past an int', { supplier: sole, lines: [{ ...one, quantity: 2147483648 }] }],
    [
      'a quantity past a decimal',
      `{"supplier":"${sole}","lines":[{"variant":"${a}","quantity":1${'0'.repeat(30)},"unit_cost":"200.00"}]}`,
    ],
    ['a null quantity', { supplier: sole, lines: [{ ...one, quantity: null }] }],
    ['one SKU on two lines', { supplier: sole, lines: [one, { ...one, quantity: 1 }] }],
    ['two SKUs', { supplier: sole, lines: [one, { variant: c, quantity: 2, unit_cost: '300' }] }],
    ['a SKU that is not there', { supplier: sole, lines: [{ ...one, variant: MISSING }] }],
    ['a SKU that is not a uuid', { supplier: sole, lines: [{ ...one, variant: 'abc' }] }],
    ['a SKU that is a number', { supplier: sole, lines: [{ ...one, variant: 7 }] }],
    [
      'an archived SKU',
      { supplier: sole, lines: [{ ...one, variant: variant.get('PAR-TEE-M-BLK') }] },
    ],
    ['no lines', { supplier: sole }],
    ['an empty list of lines', { supplier: sole, lines: [] }],
    ['lines that are not a list', { supplier: sole, lines: one }],
    ['lines that are a string', { supplier: sole, lines: 'x' }],
    ['a line that is null', { supplier: sole, lines: [one, null] }],
    ['a line that is a string', { supplier: sole, lines: ['x'] }],
    ['an empty line', { supplier: sole, lines: [{}] }],
    ['a good line and a bad one', { supplier: sole, lines: [one, { variant: 'x', quantity: 0 }] }],
    ['null lines', { supplier: sole, lines: null }],
    ['a supplier that is not there', { supplier: MISSING, lines: [one] }],
    ['a supplier that is not a uuid', { supplier: 'abc', lines: [one] }],
    ['a null supplier', { supplier: null, lines: [one] }],
    ['no supplier', { lines: [one] }],
    ['an inactive supplier', { supplier: supplier.get('PARITY-IDLE'), lines: [one] }],
    ['for another branch', { ...basic, branch: mirpur }],
    ['for a branch that is not there', { ...basic, branch: MISSING }],
    ['for a branch that is not a uuid', { ...basic, branch: 'abc' }],
    ['for a null branch', { ...basic, branch: null }],
    ['for a blank branch', { ...basic, branch: '' }],
    ['expected on a day', { ...basic, expected_at: '2026-12-01' }],
    ['expected on a day long past', { ...basic, expected_at: '2001-01-01' }],
    ['expected on no day', { ...basic, expected_at: null }],
    ['expected on a blank', { ...basic, expected_at: '' }],
    ['expected on a day typed the local way', { ...basic, expected_at: '01/12/2026' }],
    ['expected at a moment', { ...basic, expected_at: '2026-12-01T10:00:00Z' }],
    ['an invoice number of 64 characters', { ...basic, invoice_number: 'i'.repeat(64) }],
    ['an invoice number of 65 characters', { ...basic, invoice_number: 'i'.repeat(65) }],
    ['a null invoice number', { ...basic, invoice_number: null }],
    ['shipping below zero', { ...basic, shipping_total: '-1' }],
    ['shipping to three places', { ...basic, shipping_total: '12.345' }],
    ['shipping that is a number', { ...basic, shipping_total: 75 }],
    ['null shipping', { ...basic, shipping_total: null }],
    ['null notes', { ...basic, notes: null }],
    [
      'what it may not state',
      { ...basic, status: 'RECEIVED', paid_total: '5', number: 'PO-1', grand_total: '1' },
    ],
    [
      'every field wrong',
      {
        supplier: 'x',
        branch: 'y',
        lines: [{}],
        expected_at: 'z',
        invoice_number: 5,
        shipping_total: 'w',
        notes: [],
      },
    ],
    ['a body that is a list', [basic]],
    ['broken JSON', '{"supplier":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`raise an order: ${name}`, ORDERS, body);
  }
  write('raise an order: [mirpur] for their own branch, unstated', ORDERS, basic, 'mirpur');
  write(
    'raise an order: [mirpur] for another branch',
    ORDERS,
    { ...basic, branch: home },
    'mirpur',
  );
  write(
    'raise an order: [mirpur] for their own branch, stated',
    ORDERS,
    { ...basic, branch: mirpur },
    'mirpur',
  );

  // === Sending =================================================================================
  const act = (
    name: string,
    invoice: string,
    action: string,
    body: unknown = undefined,
    who: Who = 'owner',
    extra: Partial<Case> = {},
    query = '',
  ) =>
    write(
      name,
      `${ORDERS}${invoice === 'missing' ? MISSING : id(invoice)}/${action}/${query}`,
      body,
      who,
      extra,
    );
  for (const who of everyone) act(`[${who}] send a draft`, 'PAR-PO-DRAFT', 'send', undefined, who);
  for (const invoice of [
    'PAR-PO-SENT',
    'PAR-PO-PART',
    'PAR-PO-DONE',
    'PAR-PO-CANCELLED',
    'PAR-PO-CLOSED',
    'PO-000004',
  ])
    act(`send ${invoice}`, invoice, 'send');
  act('send: with a body', 'PAR-PO-DRAFT', 'send', { status: 'RECEIVED' });
  act('send: with broken JSON', 'PAR-PO-DRAFT', 'send', '{');
  act('send: one that is not there', 'missing', 'send');
  act('send: filtered out', 'PAR-PO-DRAFT', 'send', undefined, 'owner', {}, '?status=SENT');
  act(
    'send: with a window that is not a date',
    'PAR-PO-DRAFT',
    'send',
    undefined,
    'owner',
    {},
    '?date_from=abc',
  );
  act('send: [manager] another branch’s order', 'PAR-PO-MIRPUR', 'send', undefined, 'manager');

  // === Cancelling ==============================================================================
  for (const who of everyone)
    act(`[${who}] cancel a draft`, 'PAR-PO-DRAFT', 'cancel', { reason: 'Ordered twice' }, who);
  for (const invoice of [
    'PAR-PO-SENT',
    'PAR-PO-PART',
    'PAR-PO-DONE',
    'PAR-PO-CANCELLED',
    'PAR-PO-CLOSED',
    'PAR-PO-PAID',
    'PO-000001',
  ])
    act(`cancel ${invoice}`, invoice, 'cancel', { reason: 'No longer wanted' });
  for (const [name, body] of [
    ['no reason', {}],
    ['no body', undefined],
    ['a blank reason', { reason: '' }],
    ['a padded reason', { reason: '  wrong supplier  ' }],
    ['a reason of 300 characters', { reason: 'r'.repeat(300) }],
    ['a reason that is a number', { reason: 42 }],
    ['a reason that is a float', { reason: 1.5 }],
    ['a reason that is true', { reason: true }],
    ['a reason that is a list', { reason: ['a', 1, null] }],
    ['a reason that is an object', { reason: { why: 'x' } }],
    ['a null reason', { reason: null }],
    ['a body that is a list', ['x']],
    ['a body that is a string', '"x"'],
    ['broken JSON', '{"reason":'],
  ] as [string, unknown][]) {
    act(`cancel: ${name}`, 'PAR-PO-DRAFT', 'cancel', body);
  }
  act('cancel: one that is not there', 'missing', 'cancel', { reason: 'x' });
  act('cancel: one that is not there, with a body that is a list', 'missing', 'cancel', []);
  act(
    'cancel: filtered out',
    'PAR-PO-DRAFT',
    'cancel',
    { reason: 'x' },
    'owner',
    {},
    '?status=SENT',
  );
  act(
    'cancel: [manager] another branch’s order',
    'PAR-PO-MIRPUR',
    'cancel',
    { reason: 'x' },
    'manager',
  );
  act(
    'cancel: an order with a delivery, set back to SENT',
    'PAR-PO-PART',
    'cancel',
    { reason: 'x' },
    'owner',
    {
      prepare: first(
        `UPDATE purchasing_purchaseorder SET status = 'SENT' WHERE invoice_number = 'PAR-PO-PART'`,
      ),
    },
  );

  // === Receiving ===============================================================================
  const take = (key: string, quantity: unknown, extra: Record<string, unknown> = {}) => ({
    item: line(key),
    quantity,
    ...extra,
  });
  for (const who of everyone)
    act(
      `[${who}] receive a line`,
      'PAR-PO-SENT',
      'receive',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 2)] },
      who,
    );
  for (const [name, invoice, body] of [
    ['part of one line', 'PAR-PO-SENT', { lines: [take('PAR-PO-SENT PAR-BUY-A', 1)] }],
    [
      'one line in full',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 6)], notes: 'First van' },
    ],
    [
      'every line in full',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 6), take('PAR-PO-SENT PAR-BUY-C', 3)] },
    ],
    [
      'every line in full, the lines the other way round',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-C', 3), take('PAR-PO-SENT PAR-BUY-A', 6)] },
    ],
    [
      'at a cost above the order’s',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 6, { unit_cost: '260.55' })] },
    ],
    [
      'at a cost below the order’s',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 3, { unit_cost: '99.99' })] },
    ],
    [
      'at no cost',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 3, { unit_cost: '0' })] },
    ],
    [
      'at a null cost',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 3, { unit_cost: null })] },
    ],
    [
      'at a blank cost',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 3, { unit_cost: '' })] },
    ],
    [
      'at a cost below zero',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 3, { unit_cost: '-5' })] },
    ],
    [
      'at a cost that is a word',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 3, { unit_cost: 'x' })] },
    ],
    [
      'a good line, then one at a cost below zero',
      'PAR-PO-SENT',
      {
        lines: [
          take('PAR-PO-SENT PAR-BUY-A', 1),
          take('PAR-PO-SENT PAR-BUY-C', 1, { unit_cost: '-5' }),
        ],
      },
    ],
    ['more than is outstanding', 'PAR-PO-SENT', { lines: [take('PAR-PO-SENT PAR-BUY-A', 7)] }],
    [
      'a good line, then more than is outstanding',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-C', 3), take('PAR-PO-SENT PAR-BUY-A', 7)] },
    ],
    [
      'a quantity past an int',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 2147483648)] },
    ],
    ['a quantity of nothing', 'PAR-PO-SENT', { lines: [take('PAR-PO-SENT PAR-BUY-A', 0)] }],
    ['a quantity as a string', 'PAR-PO-SENT', { lines: [take('PAR-PO-SENT PAR-BUY-A', '2')] }],
    ['another order’s line', 'PAR-PO-SENT', { lines: [take('PAR-PO-PART PAR-BUY-A', 1)] }],
    ['a line that is not there', 'PAR-PO-SENT', { lines: [{ item: MISSING, quantity: 1 }] }],
    ['a line that is not a uuid', 'PAR-PO-SENT', { lines: [{ item: 'abc', quantity: 1 }] }],
    [
      'one line twice',
      'PAR-PO-SENT',
      { lines: [take('PAR-PO-SENT PAR-BUY-A', 1), take('PAR-PO-SENT PAR-BUY-A', 2)] },
    ],
    [
      'one line twice, spelled two ways',
      'PAR-PO-SENT',
      {
        lines: [
          take('PAR-PO-SENT PAR-BUY-A', 1),
          { item: line('PAR-PO-SENT PAR-BUY-A').replaceAll('-', '').toUpperCase(), quantity: 2 },
        ],
      },
    ],
    ['no lines', 'PAR-PO-SENT', {}],
    ['an empty list of lines', 'PAR-PO-SENT', { lines: [] }],
    ['null notes', 'PAR-PO-SENT', { lines: [take('PAR-PO-SENT PAR-BUY-A', 1)], notes: null }],
    ['blank notes', 'PAR-PO-SENT', { lines: [take('PAR-PO-SENT PAR-BUY-A', 1)], notes: '' }],
    ['a body that is a list', 'PAR-PO-SENT', []],
    ['broken JSON', 'PAR-PO-SENT', '{"lines":'],
    ['no body', 'PAR-PO-SENT', undefined],
    [
      'a draft never sent',
      'PAR-PO-DRAFT',
      { lines: [take('PAR-PO-DRAFT PAR-BUY-A', 10), take('PAR-PO-DRAFT PAR-BUY-B', 4)] },
    ],
    [
      'the rest of a part delivery',
      'PAR-PO-PART',
      { lines: [take('PAR-PO-PART PAR-BUY-A', 3), take('PAR-PO-PART PAR-BUY-B', 5)] },
    ],
    [
      'more of a part delivery, not all',
      'PAR-PO-PART',
      { lines: [take('PAR-PO-PART PAR-BUY-A', 3)] },
    ],
    [
      'a SKU nobody has supplied before',
      'PAR-PO-PART',
      { lines: [take('PAR-PO-PART PAR-BUY-B', 2)] },
    ],
    ['an order received in full', 'PAR-PO-DONE', { lines: [take('PAR-PO-DONE PAR-BUY-A', 1)] }],
    ['an order received in full, nothing named', 'PAR-PO-DONE', { lines: [] }],
    ['a cancelled order', 'PAR-PO-CANCELLED', { lines: [take('PAR-PO-CANCELLED PAR-BUY-B', 1)] }],
    ['a cancelled order, nothing named', 'PAR-PO-CANCELLED', { lines: [] }],
    ['a closed order', 'PAR-PO-CLOSED', { lines: [take('PAR-PO-CLOSED PAR-BUY-C', 1)] }],
    ['a paid order', 'PAR-PO-PAID', { lines: [take('PAR-PO-PAID PAR-BUY-C', 5)] }],
    [
      'at a branch that never held the SKU',
      'PAR-PO-MIRPUR',
      { lines: [take('PAR-PO-MIRPUR PAR-BUY-A', 3)] },
    ],
    ['a seeded order’s remainder', 'PO-000004', { lines: [take('PO-000004 PAR-TWB', 2)] }],
    ['one that is not there', 'missing', { lines: [take('PAR-PO-SENT PAR-BUY-A', 1)] }],
    ['one that is not there, with a body that is wrong', 'missing', { lines: 'x' }],
  ] as [string, string, unknown][]) {
    act(`receive: ${name}`, invoice, 'receive', body);
  }
  act(
    'receive: filtered out',
    'PAR-PO-SENT',
    'receive',
    { lines: [take('PAR-PO-SENT PAR-BUY-A', 1)] },
    'owner',
    {},
    '?status=DRAFT',
  );
  act(
    'receive: [stock] another branch’s order',
    'PAR-PO-MIRPUR',
    'receive',
    { lines: [take('PAR-PO-MIRPUR PAR-BUY-A', 1)] },
    'stock',
  );
  act(
    'receive: [mirpur] their own branch’s order',
    'PAR-PO-MIRPUR',
    'receive',
    { lines: [take('PAR-PO-MIRPUR PAR-BUY-A', 1)] },
    'mirpur',
  );
  act(
    'receive: onto a shelf that is short',
    'PAR-PO-SENT',
    'receive',
    { lines: [take('PAR-PO-SENT PAR-BUY-A', 6, { unit_cost: '100.00' })] },
    'owner',
    {
      prepare: first(
        `UPDATE inventory_inventory SET on_hand = -3 WHERE variant_id = '${a}' AND branch_id = '${home}'`,
      ),
    },
  );
  act(
    'receive: a SKU whose supplier had withdrawn it',
    'PAR-PO-SENT',
    'receive',
    { lines: [take('PAR-PO-SENT PAR-BUY-C', 1)] },
    'owner',
    {
      prepare: first(
        `UPDATE purchasing_supplierproduct SET is_active = false
        WHERE variant_id = '${c}' AND supplier_id = '${sole}'`,
      ),
    },
  );
  act('receive: a SKU another supplier is preferred for', 'PAR-PO-MIRPUR', 'receive', {
    lines: [take('PAR-PO-MIRPUR PAR-BUY-A', 2, { unit_cost: '180.00' })],
  });

  // === Sending goods back ======================================================================
  const back = (lines: unknown, extra: Record<string, unknown> = {}) => ({
    lines,
    reason: 'DAMAGED',
    ...extra,
  });
  for (const who of everyone)
    act(
      `[${who}] send goods back`,
      'PAR-PO-DONE',
      'return',
      back([take('PAR-PO-DONE PAR-BUY-A', 1)]),
      who,
    );
  for (const [name, invoice, body, key] of [
    ['one unit', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 1)])],
    [
      'a whole line',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 4)], { notes: 'All faulty' }),
    ],
    ['all that is left of a line', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-C', 4)])],
    [
      'two lines',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 2), take('PAR-PO-DONE PAR-BUY-C', 1)], {
        reason: 'DEFECTIVE',
      }),
    ],
    ['more than came', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 5)])],
    ['more than is left of a line', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-C', 5)])],
    [
      'a good line, then more than came',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-C', 1), take('PAR-PO-DONE PAR-BUY-A', 5)]),
    ],
    [
      'one line twice, within what came',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-C', 2), take('PAR-PO-DONE PAR-BUY-C', 2)]),
    ],
    [
      'one line twice, past what came',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-C', 3), take('PAR-PO-DONE PAR-BUY-C', 3)]),
    ],
    ['a quantity past an int', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 2147483648)])],
    ['a quantity of nothing', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 0)])],
    ['another order’s line', 'PAR-PO-DONE', back([take('PAR-PO-PART PAR-BUY-A', 1)])],
    ['a line that is not there', 'PAR-PO-DONE', back([{ item: MISSING, quantity: 1 }])],
    ['a line that is not a uuid', 'PAR-PO-DONE', back([{ item: 'abc', quantity: 1 }])],
    ['no lines', 'PAR-PO-DONE', { reason: 'DAMAGED' }],
    ['an empty list of lines', 'PAR-PO-DONE', back([])],
    ['no reason', 'PAR-PO-DONE', { lines: [take('PAR-PO-DONE PAR-BUY-A', 1)] }],
    [
      'a reason that is not a choice',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 1)], { reason: 'UGLY' }),
    ],
    [
      'a reason in lower case',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 1)], { reason: 'damaged' }),
    ],
    ['a blank reason', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 1)], { reason: '' })],
    ['a null reason', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 1)], { reason: null })],
    ['null notes', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 1)], { notes: null })],
    [
      'a cost stated',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 1, { unit_cost: '1.00' })]),
    ],
    [
      'under a new key',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 1)]),
      'parity-return-new',
    ],
    [
      'under a key already used',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 1)]),
      'parity-return-keyed',
    ],
    [
      'under a key another order’s return holds',
      'PAR-PO-PART',
      back([take('PAR-PO-PART PAR-BUY-A', 1)]),
      'parity-return-keyed',
    ],
    [
      'under a used key, on a draft',
      'PAR-PO-DRAFT',
      back([take('PAR-PO-DRAFT PAR-BUY-A', 1)]),
      'parity-return-keyed',
    ],
    [
      'under a used key, with a body that is wrong',
      'PAR-PO-DONE',
      { lines: 'x' },
      'parity-return-keyed',
    ],
    ['under an empty key', 'PAR-PO-DONE', back([take('PAR-PO-DONE PAR-BUY-A', 1)]), ''],
    [
      'under a key of 80 characters',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 1)]),
      'k'.repeat(80),
    ],
    [
      'under a key of 81 characters',
      'PAR-PO-DONE',
      back([take('PAR-PO-DONE PAR-BUY-A', 1)]),
      'k'.repeat(81),
    ],
    [
      'from a part delivery, received below the order’s cost',
      'PAR-PO-PART',
      back([take('PAR-PO-PART PAR-BUY-A', 5)], { reason: 'WRONG_ITEM' }),
    ],
    [
      'a line nothing of which came',
      'PAR-PO-PART',
      back([take('PAR-PO-PART PAR-BUY-B', 1)], { reason: 'OVER_DELIVERED' }),
    ],
    ['from a draft', 'PAR-PO-DRAFT', back([take('PAR-PO-DRAFT PAR-BUY-A', 1)])],
    ['from a cancelled order', 'PAR-PO-CANCELLED', back([take('PAR-PO-CANCELLED PAR-BUY-B', 1)])],
    [
      'from a sent order',
      'PAR-PO-SENT',
      back([take('PAR-PO-SENT PAR-BUY-A', 1)], { reason: 'EXPIRED' }),
    ],
    [
      'from a closed order',
      'PAR-PO-CLOSED',
      back([take('PAR-PO-CLOSED PAR-BUY-C', 1)], { reason: 'OTHER' }),
    ],
    ['from a seeded order', 'PO-000003', back([{ item: MISSING, quantity: 1 }])],
    ['a body that is a list', 'PAR-PO-DONE', []],
    ['broken JSON', 'PAR-PO-DONE', '{"lines":'],
    ['no body', 'PAR-PO-DONE', undefined],
    ['from one that is not there', 'missing', back([take('PAR-PO-DONE PAR-BUY-A', 1)])],
    ['from one that is not there, with a body that is wrong', 'missing', { lines: 'x' }],
  ] as [string, string, unknown, string?][]) {
    act(
      `send back: ${name}`,
      invoice,
      'return',
      body,
      'owner',
      key === undefined ? {} : { headers: { 'idempotency-key': key } },
    );
  }
  act(
    'send back: filtered out',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-A', 1)]),
    'owner',
    {},
    '?status=DRAFT',
  );
  const shelf = (set: string, sku = c) =>
    first(
      `UPDATE inventory_inventory SET ${set} WHERE variant_id = '${sku}' AND branch_id = '${home}'`,
    );
  act(
    'send back: more than the shelf holds',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-C', 3)]),
    'owner',
    {
      prepare: shelf('on_hand = 2'),
    },
  );
  act(
    'send back: all the shelf holds',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-C', 3)]),
    'owner',
    {
      prepare: shelf('on_hand = 3'),
    },
  );
  act(
    'send back: from a shelf worth less than the goods',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-C', 2)]),
    'owner',
    {
      prepare: shelf(`average_cost = 10.00`),
    },
  );
  act(
    'send back: from a shelf valued above the goods',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-C', 1)]),
    'owner',
    {
      prepare: shelf(`average_cost = 333.33`),
    },
  );
  act(
    'send back: down to the reorder point',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-C', 2)]),
    'owner',
    {
      prepare: shelf(`reorder_point = 2`),
    },
  );
  act(
    'send back: some of the shelf reserved',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-C', 3)]),
    'owner',
    {
      prepare: shelf(`reserved = 3`),
    },
  );
  act(
    'send back: from an order paid in full',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-A', 1)]),
    'owner',
    {
      prepare: first(
        `UPDATE purchasing_purchaseorder SET paid_total = grand_total - credited_total, payment_status = 'PAID'
        WHERE invoice_number = 'PAR-PO-DONE'`,
      ),
    },
  );
  act(
    'send back: enough to settle what is owed',
    'PAR-PO-DONE',
    'return',
    back([take('PAR-PO-DONE PAR-BUY-C', 4)]),
    'owner',
    {
      prepare: first(
        `UPDATE purchasing_purchaseorder SET paid_total = grand_total - 1800.00, payment_status = 'PARTIALLY_PAID'
        WHERE invoice_number = 'PAR-PO-DONE'`,
      ),
    },
  );
  act(
    'send back: [stock] another branch’s order',
    'PAR-PO-MIRPUR',
    'return',
    back([take('PAR-PO-MIRPUR PAR-BUY-A', 1)]),
    'stock',
  );

  return cases;
}
