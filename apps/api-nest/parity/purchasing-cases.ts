/**
 * Parity cases for suppliers and their price lists (phase 6 part 3):
 * `/suppliers/` and `/supplier-products/`, with `set-preferred`. Neither
 * moves stock or money; each write is compared by the suppliers and offers
 * it made, changed or deleted, by which offer each SKU prefers, and by the
 * audit log.
 *
 * The suppliers are the demo seed's and fixture_purchasing.py's.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const SUPPLIER_TABLES = ['purchasing_supplierproduct', 'purchasing_supplier'];
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(snap) FROM "snap_${table}" snap WHERE snap.id = ${alias}.id)`;

export const SUPPLIER_EFFECTS = [
  // Suppliers a request made or changed.
  `SELECT s.name, s.code, s.contact_person, s.phone, s.email, s.address, s.tax_id,
          s.payment_terms_days, s.lead_time_days, s.status, s.notes,
          s.id NOT IN (SELECT id FROM "snap_purchasing_supplier") AS made,
          s.updated_at > (SELECT x.updated_at FROM "snap_purchasing_supplier" x WHERE x.id = s.id)
            AS touched,
          s.created_at = (SELECT x.created_at FROM "snap_purchasing_supplier" x WHERE x.id = s.id)
            AS kept
     FROM purchasing_supplier s WHERE ${CHANGED('s', 'purchasing_supplier')} ORDER BY s.code`,
  // Offers a request made or changed.
  `SELECT s.code AS supplier, v.sku, o.supplier_sku, o.last_cost::text, o.lead_time_days,
          o.minimum_order_quantity, o.is_preferred, o.is_active,
          (o.last_purchased_at AT TIME ZONE 'UTC')::text AS last_purchased, o.notes,
          u.email AS created_by,
          o.id NOT IN (SELECT id FROM "snap_purchasing_supplierproduct") AS made,
          o.updated_at > (SELECT x.updated_at FROM "snap_purchasing_supplierproduct" x WHERE x.id = o.id)
            AS touched,
          o.created_at = (SELECT x.created_at FROM "snap_purchasing_supplierproduct" x WHERE x.id = o.id)
            AS kept
     FROM purchasing_supplierproduct o JOIN purchasing_supplier s ON s.id = o.supplier_id
     JOIN catalog_productvariant v ON v.id = o.variant_id
     LEFT JOIN accounts_user u ON u.id = o.created_by_id
    WHERE ${CHANGED('o', 'purchasing_supplierproduct')} ORDER BY s.code, v.sku`,
  // What a request deleted.
  `SELECT 'supplier' AS kind, x.code AS what FROM "snap_purchasing_supplier" x
    WHERE x.id NOT IN (SELECT id FROM purchasing_supplier)
   UNION ALL
   SELECT 'offer', x.id::text FROM "snap_purchasing_supplierproduct" x
    WHERE x.id NOT IN (SELECT id FROM purchasing_supplierproduct) ORDER BY 1, 2`,
  // The SKUs whose preferred supplier is not the snapshot's.
  `SELECT v.sku, (SELECT s.code FROM purchasing_supplierproduct o JOIN purchasing_supplier s
                    ON s.id = o.supplier_id WHERE o.variant_id = v.id AND o.is_preferred) AS now,
          (SELECT s.code FROM "snap_purchasing_supplierproduct" o JOIN "snap_purchasing_supplier" s
             ON s.id = o.supplier_id WHERE o.variant_id = v.id AND o.is_preferred) AS before
     FROM catalog_productvariant v
    WHERE (SELECT o.id FROM purchasing_supplierproduct o WHERE o.variant_id = v.id AND o.is_preferred)
          IS DISTINCT FROM
          (SELECT o.id FROM "snap_purchasing_supplierproduct" o WHERE o.variant_id = v.id AND o.is_preferred)
    ORDER BY v.sku`,
  // The audit log.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
];

export async function resetSuppliers(client: pg.Client): Promise<void> {
  // One preferred offer per SKU is a unique index, checked row by row: a
  // preference a case made steps down before the snapshot's own is put back.
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
  await restoreTables(client, SUPPLIER_TABLES);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function purchasingCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const supplier = await map(`SELECT code AS key, id FROM purchasing_supplier`);
  const variant = await map(`SELECT sku AS key, id FROM catalog_productvariant`);
  const product = await map(`SELECT slug AS key, id FROM catalog_product`);
  const offer = await map(
    `SELECT s.code || ' ' || v.sku AS key, o.id FROM purchasing_supplierproduct o
       JOIN purchasing_supplier s ON s.id = o.supplier_id
       JOIN catalog_productvariant v ON v.id = o.variant_id`,
  );
  if (!supplier.has('PARITY-IDLE')) {
    await db.end();
    console.log('SKIP  purchasing: fixture_purchasing.py has not been applied');
    return [];
  }
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM purchasing_supplier UNION ALL SELECT id::text FROM purchasing_supplierproduct
       UNION ALL SELECT id::text FROM catalog_productvariant UNION ALL SELECT id::text FROM catalog_product`,
    )
  ).rows.map((row) => row.id);
  await db.end();
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `purchasing: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    path: string,
    body: unknown,
    who: Who = 'owner',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `purchasing: ${name}`,
      method: 'POST',
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetSuppliers,
      effects: SUPPLIER_EFFECTS,
      normalize: minted,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const idle = supplier.get('PARITY-IDLE') as string;
  const sole = supplier.get('PARITY-SOLE') as string;
  const textile = supplier.get('SUP-001') as string;
  const leather = supplier.get('SUP-002') as string;

  // === Suppliers: reading ======================================================================
  const SUPPLIERS = '/api/v1/suppliers/';
  for (const who of everyone) {
    read(`[${who}] suppliers`, SUPPLIERS, who);
    read(`[${who}] a supplier`, `${SUPPLIERS}${textile}/`, who);
  }
  for (const query of [
    'status=ACTIVE',
    'status=INACTIVE',
    'status=active',
    'status=',
    'status=GONE',
    'search=tex',
    'search=SUP-002',
    'search=018',
    'search=9612345',
    'search=parity%20idle',
    'search=parity,agent',
    'search=%22Leather%20Co%22',
    'search=zzzz',
    'search=a%00b',
    'search=parity&status=INACTIVE',
    'ordering=name',
    'ordering=-name',
    'ordering=created_at',
    'ordering=-created_at,name',
    'ordering=code',
    'ordering=outstanding_orders',
    'page_size=1&page=2',
    'page_size=3',
    'page=99',
    'page=abc',
  ]) {
    read(`suppliers ?${query}`, `${SUPPLIERS}?${query}`);
  }
  read('a supplier nothing was ordered from', `${SUPPLIERS}${idle}/`);
  read('a supplier with nothing on its way', `${SUPPLIERS}${leather}/`);
  read('a supplier that is not there', `${SUPPLIERS}${MISSING}/`);
  read('a supplier that is not a uuid', `${SUPPLIERS}abc/`);
  read('a supplier, filtered out', `${SUPPLIERS}${textile}/?status=INACTIVE`);
  read('a supplier, searched out', `${SUPPLIERS}${textile}/?search=leather`);
  read('a supplier, searched in and ordered', `${SUPPLIERS}${textile}/?search=tex&ordering=-name`);
  read('a supplier with a filter that is not a choice', `${SUPPLIERS}${textile}/?status=GONE`);
  read('POST to a supplier', `${SUPPLIERS}${textile}/`, 'owner', { method: 'POST' });

  // === Suppliers: writing ======================================================================
  for (const who of everyone)
    write(`[${who}] add a supplier`, SUPPLIERS, { name: 'Parity New Mills' }, who);
  for (const [name, body] of [
    ['a name alone', { name: 'Parity New Mills' }],
    ['a name with punctuation', { name: '  Rahman & Sons (Pvt.) Ltd.  ' }],
    ['a name longer than a code', { name: 'The Parity Long Established Trading Company' }],
    ['a name whose 24th character is a break', { name: 'Parity Established Tradi ng Company' }],
    ['a name in Bengali', { name: 'চা নাস্তা' }],
    ['a name of punctuation', { name: '!!!' }],
    ['a name whose code is taken', { name: 'Parity Idle' }],
    ['a name whose code is taken, with spaces', { name: 'sup 001' }],
    ['a name of 200 characters', { name: 'n'.repeat(200) }],
    ['a name of 201 characters', { name: 'n'.repeat(201) }],
    ['a blank name', { name: '' }],
    ['a name of spaces', { name: '   ' }],
    ['a null name', { name: null }],
    ['a name that is a number', { name: 42 }],
    ['a name that is a list', { name: ['x'] }],
    ['no name', { code: 'PNM' }],
    ['a name and a code', { name: 'Parity New Mills', code: 'pnm 01' }],
    ['a code another supplier has', { name: 'Parity New Mills', code: 'SUP-001' }],
    ['a code another has, in another case', { name: 'Parity New Mills', code: 'sup-001' }],
    ['a blank code', { name: 'Parity New Mills', code: '' }],
    ['a code of spaces', { name: 'Parity New Mills', code: '   ' }],
    ['a null code', { name: 'Parity New Mills', code: null }],
    ['a code of 32 characters', { name: 'Parity New Mills', code: 'C'.repeat(32) }],
    ['a code of 33 characters', { name: 'Parity New Mills', code: 'C'.repeat(33) }],
    ['a code taken and too long', { name: 'Parity New Mills', code: `SUP-001${' '.repeat(40)}x` }],
    ['a mobile with a trunk prefix', { name: 'Parity New Mills', phone: '01711-111111' }],
    ['a mobile with a country code', { name: 'Parity New Mills', phone: '+880 1711 111111' }],
    ['a mobile in Bengali digits', { name: 'Parity New Mills', phone: '০১৭১১১১১১১১' }],
    ['a landline', { name: 'Parity New Mills', phone: ' 02-9612345 ' }],
    ['a hotline', { name: 'Parity New Mills', phone: '+8809610003030' }],
    ['a phone that is a number', { name: 'Parity New Mills', phone: 1711111111 }],
    ['a phone of 33 characters', { name: 'Parity New Mills', phone: '9'.repeat(33) }],
    ['a blank phone', { name: 'Parity New Mills', phone: '' }],
    ['a null phone', { name: 'Parity New Mills', phone: null }],
    ['an email', { name: 'Parity New Mills', email: ' Sales@Parity-Mills.test ' }],
    ['an email that is not one', { name: 'Parity New Mills', email: 'sales at mills' }],
    ['a blank email', { name: 'Parity New Mills', email: '' }],
    [
      'an email of 255 characters',
      { name: 'Parity New Mills', email: `${'a'.repeat(245)}@mills.test` },
    ],
    ['terms of 30 days', { name: 'Parity New Mills', payment_terms_days: 30 }],
    ['terms as a string', { name: 'Parity New Mills', payment_terms_days: '30' }],
    ['terms of 30.0 days', { name: 'Parity New Mills', payment_terms_days: 30.0 }],
    ['terms of 2.5 days', { name: 'Parity New Mills', payment_terms_days: 2.5 }],
    ['terms below zero', { name: 'Parity New Mills', payment_terms_days: -1 }],
    ['terms of 32767 days', { name: 'Parity New Mills', payment_terms_days: 32767 }],
    ['terms of 32768 days', { name: 'Parity New Mills', payment_terms_days: 32768 }],
    ['terms that are true', { name: 'Parity New Mills', payment_terms_days: true }],
    ['null terms', { name: 'Parity New Mills', payment_terms_days: null }],
    ['a lead time of nothing', { name: 'Parity New Mills', lead_time_days: 0 }],
    ['a lead time that is a word', { name: 'Parity New Mills', lead_time_days: 'soon' }],
    ['made inactive', { name: 'Parity New Mills', status: 'INACTIVE' }],
    ['a status in lower case', { name: 'Parity New Mills', status: 'inactive' }],
    ['a blank status', { name: 'Parity New Mills', status: '' }],
    ['a null status', { name: 'Parity New Mills', status: null }],
    ['null notes', { name: 'Parity New Mills', notes: null }],
    ['a tax id of 65 characters', { name: 'Parity New Mills', tax_id: 't'.repeat(65) }],
    ['a contact of 121 characters', { name: 'Parity New Mills', contact_person: 'c'.repeat(121) }],
    [
      'everything stated',
      {
        name: 'Parity New Mills',
        code: 'PNM',
        contact_person: 'Mr Karim',
        phone: '01911222333',
        email: 'karim@mills.test',
        address: 'Tongi\nGazipur',
        tax_id: 'BIN-9',
        payment_terms_days: 15,
        lead_time_days: 4,
        status: 'ACTIVE',
        notes: 'Cash only',
      },
    ],
    [
      'what it may not state',
      { name: 'Parity New Mills', id: MISSING, outstanding_orders: 9, created_at: '2020-01-01' },
    ],
    [
      'every field wrong',
      {
        name: '',
        code: 'SUP-001',
        email: 'x',
        payment_terms_days: -1,
        lead_time_days: 99999,
        status: 'GONE',
      },
    ],
    ['a body that is a list', [{ name: 'Parity New Mills' }]],
    ['broken JSON', '{"name":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`add a supplier: ${name}`, SUPPLIERS, body);
  }

  const edit = (name: string, path: string, body: unknown, who: Who = 'owner', method = 'PATCH') =>
    write(name, path, body, who, { method });
  for (const who of everyone)
    edit(`[${who}] edit a supplier`, `${SUPPLIERS}${idle}/`, { notes: 'Back in March' }, who);
  for (const [name, body] of [
    ['renamed', { name: 'Parity Idle Trading' }],
    ['renamed to nothing', { name: '' }],
    ['its code changed', { code: 'IDLE' }],
    ['its code changed to another’s', { code: 'SUP-001' }],
    ['its code restated', { code: 'PARITY-IDLE' }],
    ['its code blanked', { code: '' }],
    ['its code nulled', { code: null }],
    ['its phone changed to a mobile', { phone: '01811-000000' }],
    ['its phone blanked', { phone: '' }],
    ['brought back', { status: 'ACTIVE' }],
    ['its terms changed', { payment_terms_days: 0, lead_time_days: 1 }],
    ['nothing at all', {}],
    ['what it may not state', { outstanding_orders: 5, created_at: '2020-01-01' }],
    ['a body that is a list', []],
    ['broken JSON', '{"name":'],
  ] as [string, unknown][]) {
    edit(`edit a supplier: ${name}`, `${SUPPLIERS}${idle}/`, body);
    if (['renamed', 'nothing at all', 'its code changed', 'its code blanked'].includes(name))
      edit(`edit a supplier: ${name}, by PUT`, `${SUPPLIERS}${idle}/`, body, 'owner', 'PUT');
  }
  edit(
    'edit a supplier: everything, by PUT',
    `${SUPPLIERS}${idle}/`,
    { name: 'Parity Idle Trading', code: 'IDLE', phone: '', email: '', status: 'ACTIVE' },
    'owner',
    'PUT',
  );
  edit('edit a supplier: one with orders on their way', `${SUPPLIERS}${textile}/`, {
    lead_time_days: 12,
  });
  edit('edit a supplier: one that is not there', `${SUPPLIERS}${MISSING}/`, { name: 'x' });
  edit('edit a supplier: one that is not there, with broken JSON', `${SUPPLIERS}${MISSING}/`, '{');
  edit('edit a supplier: filtered out', `${SUPPLIERS}${idle}/?status=ACTIVE`, { notes: 'x' });
  edit('edit a supplier: filtered in', `${SUPPLIERS}${idle}/?status=INACTIVE&search=idle`, {
    notes: 'x',
  });

  const remove = (name: string, path: string, who: Who = 'owner') =>
    write(name, path, undefined, who, { method: 'DELETE' });
  for (const who of everyone) remove(`[${who}] delete a supplier`, `${SUPPLIERS}${idle}/`, who);
  remove('delete a supplier: one whose offer is preferred', `${SUPPLIERS}${sole}/`);
  remove('delete a supplier: one ordered from', `${SUPPLIERS}${textile}/`);
  remove('delete a supplier: one ordered from and received', `${SUPPLIERS}${leather}/`);
  remove('delete a supplier: one that is not there', `${SUPPLIERS}${MISSING}/`);
  remove('delete a supplier: filtered out', `${SUPPLIERS}${idle}/?status=ACTIVE`);

  // === Offers: reading =========================================================================
  const OFFERS = '/api/v1/supplier-products/';
  const idleWhite = offer.get('PARITY-IDLE PAR-TEE-S-WHT') as string;
  const idleBlack = offer.get('PARITY-IDLE PAR-TEE-S-BLK') as string;
  const soleWhite = offer.get('PARITY-SOLE PAR-TEE-S-WHT') as string;
  const leatherOlive = offer.get('SUP-002 RGN-ESS-L-OLI') as string;
  const white = variant.get('PAR-TEE-S-WHT') as string;
  const black = variant.get('PAR-TEE-S-BLK') as string;
  const free = variant.get('PAR-FREE') as string;
  const tee = product.get('essential-cotton-t-shirt') as string;
  for (const who of everyone) {
    read(`[${who}] offers`, `${OFFERS}?page_size=3`, who);
    read(`[${who}] an offer`, `${OFFERS}${idleWhite}/`, who);
  }
  for (const query of [
    '',
    `supplier=${idle}`,
    `supplier=${leather}&page_size=30`,
    `supplier=${MISSING}`,
    'supplier=abc',
    'supplier=',
    `variant=${white}`,
    `variant=${free}`,
    `variant=${MISSING}`,
    'variant=abc',
    `product=${tee}&page_size=40`,
    `product=${tee.replaceAll('-', '')}`,
    `product=%20${tee}%20`,
    `product=%7B${tee}%7D`,
    `product=${MISSING}`,
    'product=abc',
    'product=',
    'is_preferred=true&page_size=5',
    'is_preferred=false&page_size=5',
    'is_preferred=maybe&page_size=5',
    'is_active=false',
    'is_active=0',
    `supplier=${idle}&variant=${white}&is_active=true`,
    `supplier=${textile}&product=${tee}&is_preferred=true`,
    `variant=${white}&search=parity`,
    `supplier=${idle}&search=tee`,
    `product=${tee}&search=olive`,
    'supplier=abc&variant=x&product=y&is_preferred=maybe&is_active=maybe',
    'search=IDLE-TS',
    'search=PAR-TEE',
    'search=essential&page_size=4',
    'search=leather&page_size=4',
    'search=parity%20sole',
    'search=leather,olive',
    'search=zzzz',
    'search=a%00b',
    'ordering=last_cost&page_size=6',
    'ordering=-last_cost&page_size=6',
    'ordering=last_purchased_at&page_size=6',
    'ordering=-last_purchased_at,created_at&page_size=6',
    'ordering=created_at&page_size=6',
    'ordering=-created_at&page_size=6',
    'ordering=supplier&page_size=6',
    'page_size=10&page=3',
    'page_size=100',
    'page=99',
  ]) {
    read(`offers ?${query}`, `${OFFERS}?${query}`);
  }
  read('an offer since withdrawn', `${OFFERS}${idleBlack}/`);
  read('an offer that is preferred', `${OFFERS}${soleWhite}/`);
  read('an offer that is not there', `${OFFERS}${MISSING}/`);
  read('an offer that is not a uuid', `${OFFERS}abc/`);
  read('an offer, filtered out', `${OFFERS}${idleWhite}/?is_preferred=true`);
  read('an offer, filtered in', `${OFFERS}${idleWhite}/?supplier=${idle}&variant=${white}`);
  read('an offer, searched out', `${OFFERS}${idleWhite}/?search=leather`);
  read(
    'an offer, searched in and ordered',
    `${OFFERS}${idleWhite}/?search=idle&ordering=last_cost`,
  );
  read('an offer with a filter that is not a uuid', `${OFFERS}${idleWhite}/?product=abc`);
  read('GET set-preferred', `${OFFERS}${idleWhite}/set-preferred/`);

  // === Offers: writing =========================================================================
  const quote = { supplier: idle, variant: free };
  for (const who of everyone) write(`[${who}] add an offer`, OFFERS, quote, who);
  for (const [name, body] of [
    ['a supplier and a SKU', quote],
    [
      'everything stated',
      {
        ...quote,
        supplier_sku: ' IDLE-FREE ',
        last_cost: '149.5',
        lead_time_days: 2,
        minimum_order_quantity: 24,
        is_active: false,
        notes: 'Quoted by phone',
      },
    ],
    [
      'what it may not state',
      { ...quote, is_preferred: true, last_purchased_at: '2026-01-01T00:00:00Z', id: MISSING },
    ],
    ['a pair already quoted', { supplier: idle, variant: white }],
    [
      'a pair already quoted, with everything else wrong',
      { supplier: idle, variant: white, last_cost: 'x' },
    ],
    ['an archived SKU', { supplier: sole, variant: variant.get('PAR-TEE-M-BLK') }],
    ['a supplier that is not there', { supplier: MISSING, variant: free }],
    ['a SKU that is not there', { supplier: idle, variant: MISSING }],
    ['a supplier that is not a uuid', { supplier: 'abc', variant: free }],
    ['a supplier that is a number', { supplier: 7, variant: free }],
    ['a supplier that is true', { supplier: true, variant: free }],
    ['a blank supplier', { supplier: '', variant: free }],
    ['a null SKU', { supplier: idle, variant: null }],
    ['no supplier and no SKU', { last_cost: '5' }],
    ['a cost of nothing', { ...quote, last_cost: '0' }],
    ['a cost below zero', { ...quote, last_cost: '-1' }],
    ['a cost to three places', { ...quote, last_cost: '1.005' }],
    ['a cost of thirteen whole digits', { ...quote, last_cost: '1234567890123' }],
    ['a cost that is a word', { ...quote, last_cost: 'cheap' }],
    ['a cost that is a number', { ...quote, last_cost: 149.5 }],
    ['a null cost', { ...quote, last_cost: null }],
    ['a null lead time', { ...quote, lead_time_days: null }],
    ['a lead time below zero', { ...quote, lead_time_days: -1 }],
    ['a lead time of 32768', { ...quote, lead_time_days: 32768 }],
    ['a blank lead time', { ...quote, lead_time_days: '' }],
    ['a minimum of nothing', { ...quote, minimum_order_quantity: 0 }],
    ['a minimum below zero', { ...quote, minimum_order_quantity: -1 }],
    ['a minimum past an int', { ...quote, minimum_order_quantity: 2147483648 }],
    ['a null minimum', { ...quote, minimum_order_quantity: null }],
    ['their code of 65 characters', { ...quote, supplier_sku: 's'.repeat(65) }],
    ['an active switch that is not a boolean', { ...quote, is_active: 'maybe' }],
    ['null notes', { ...quote, notes: null }],
    ['a body that is a list', [quote]],
    ['broken JSON', '{"supplier":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`add an offer: ${name}`, OFFERS, body);
  }
  for (const who of everyone)
    edit(`[${who}] edit an offer`, `${OFFERS}${idleWhite}/`, { last_cost: '215.00' }, who);
  for (const [name, body] of [
    ['its cost', { last_cost: '215' }],
    ['its cost below zero', { last_cost: '-0.01' }],
    ['their code', { supplier_sku: 'IDLE-NEW' }],
    ['its lead time taken off', { lead_time_days: null }],
    ['its minimum set to nothing', { minimum_order_quantity: 0 }],
    ['withdrawn', { is_active: false }],
    ['moved to a SKU nobody quotes', { variant: free }],
    ['moved to a SKU it already quotes', { variant: black }],
    ['moved to a supplier that quotes it', { supplier: sole }],
    ['moved to a supplier that does not', { supplier: leather }],
    ['its supplier and SKU restated', { supplier: idle, variant: white }],
    ['its supplier restated and its cost changed', { supplier: idle, last_cost: '1' }],
    ['made preferred by hand', { is_preferred: true }],
    ['nothing at all', {}],
    ['a supplier that is not there', { supplier: MISSING }],
    ['a body that is a list', []],
    ['broken JSON', '{'],
  ] as [string, unknown][]) {
    edit(`edit an offer: ${name}`, `${OFFERS}${idleWhite}/`, body);
    if (['its cost', 'nothing at all', 'moved to a SKU it already quotes'].includes(name))
      edit(`edit an offer: ${name}, by PUT`, `${OFFERS}${idleWhite}/`, body, 'owner', 'PUT');
  }
  edit(
    'edit an offer: restated whole, by PUT',
    `${OFFERS}${idleWhite}/`,
    { supplier: idle, variant: white },
    'owner',
    'PUT',
  );
  edit(
    'edit an offer: a preferred one, restated by PUT',
    `${OFFERS}${soleWhite}/`,
    { supplier: sole, variant: white, last_cost: '200.00', notes: 'Agreed' },
    'owner',
    'PUT',
  );
  edit('edit an offer: one that is not there', `${OFFERS}${MISSING}/`, { last_cost: '1' });
  edit('edit an offer: one that is not there, with broken JSON', `${OFFERS}${MISSING}/`, '{');
  edit('edit an offer: filtered out', `${OFFERS}${idleWhite}/?is_active=false`, { notes: 'x' });
  for (const who of everyone) remove(`[${who}] delete an offer`, `${OFFERS}${idleWhite}/`, who);
  remove('delete an offer: the preferred one', `${OFFERS}${soleWhite}/`);
  remove('delete an offer: one bought through', `${OFFERS}${leatherOlive}/`);
  remove('delete an offer: one that is not there', `${OFFERS}${MISSING}/`);
  remove('delete an offer: filtered out', `${OFFERS}${idleWhite}/?is_preferred=true`);

  const prefer = (
    name: string,
    id: string,
    who: Who = 'owner',
    body: unknown = undefined,
    query = '',
  ) => write(`prefer an offer: ${name}`, `${OFFERS}${id}/set-preferred/${query}`, body, who);
  for (const who of everyone) prefer(`[${who}]`, idleWhite, who);
  prefer('over the incumbent', idleWhite);
  prefer('the incumbent itself', soleWhite);
  prefer('one since withdrawn', idleBlack);
  prefer('over a seeded incumbent', leatherOlive);
  prefer('with a body', idleWhite, 'owner', { supplier: sole });
  prefer('with broken JSON', idleWhite, 'owner', '{');
  prefer('one that is not there', MISSING);
  prefer('filtered out', idleWhite, 'owner', undefined, '?is_active=false');
  prefer('filtered in', idleWhite, 'owner', undefined, `?supplier=${idle}`);

  return cases;
}
