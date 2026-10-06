/**
 * Parity cases for shipping in the back office (phase 6 part 8):
 * `/shipping-zones/`, `/shipping-methods/`, `/couriers/` -- where the shop
 * delivers, what it costs and who carries it -- and `/shipments/`, a parcel
 * booked against an order and what the courier then says happened to it. A
 * tracking update moves the order, so a parcel's writes are compared by the
 * queries a sale is compared by, and then by the parcels, their history and
 * the settings.
 *
 * The parcels come from fixture_shipping.py (orders H01 to H08) and
 * fixture_orders.py; the zones and methods from the demo seed and
 * fixture_cart.py.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker, SALE_EFFECTS, SALE_TABLES } from './pos-sale-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const SHIPPING_TABLES = [
  ...SALE_TABLES,
  'shipping_shipmentevent',
  'shipping_shipment',
  'shipping_shippingmethod',
  'shipping_shippingzone',
  'shipping_courier',
];
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(snap) FROM "snap_${table}" snap WHERE snap.id = ${alias}.id)`;
const GONE = (table: string) =>
  `FROM "snap_${table}" x WHERE x.id NOT IN (SELECT id FROM "${table}")`;

export const SHIPPING_EFFECTS = [
  ...SALE_EFFECTS,
  // Parcels a request booked or changed. A stamp is compared by whether it is
  // the one the parcel had, never by its value.
  `SELECT o.number, k.code AS courier, m.code AS method, s.tracking_number, s.status,
          s.cost::text, s.notes, u.email AS created_by, s.dispatched_at IS NOT NULL AS dispatched,
          s.delivered_at IS NOT NULL AS delivered,
          s.dispatched_at IS NOT DISTINCT FROM
            (SELECT snap.dispatched_at FROM "snap_shipping_shipment" snap WHERE snap.id = s.id)
            AS dispatched_as_before,
          s.delivered_at IS NOT DISTINCT FROM
            (SELECT snap.delivered_at FROM "snap_shipping_shipment" snap WHERE snap.id = s.id)
            AS delivered_as_before,
          s.id NOT IN (SELECT id FROM "snap_shipping_shipment") AS made
     FROM shipping_shipment s JOIN orders_order o ON o.id = s.order_id
     LEFT JOIN shipping_courier k ON k.id = s.courier_id
     LEFT JOIN shipping_shippingmethod m ON m.id = s.shipping_method_id
     LEFT JOIN accounts_user u ON u.id = s.created_by_id
    WHERE ${CHANGED('s', 'shipping_shipment')}
    ORDER BY o.number, s.tracking_number, s.notes`,
  `SELECT x.tracking_number, x.notes, x.status ${GONE('shipping_shipment')}
    ORDER BY x.tracking_number, x.notes`,
  // Their history: an update with no time of its own is stamped before it is written.
  `SELECT o.number, s.tracking_number, e.status, e.message, e.location, e.raw::text AS raw,
          u.email AS created_by,
          CASE WHEN e.occurred_at >= $1 AND e.occurred_at <= e.created_at THEN 'now'
               ELSE (e.occurred_at AT TIME ZONE 'UTC')::text END AS occurred
     FROM shipping_shipmentevent e JOIN shipping_shipment s ON s.id = e.shipment_id
     JOIN orders_order o ON o.id = s.order_id LEFT JOIN accounts_user u ON u.id = e.created_by_id
    WHERE e.id NOT IN (SELECT id FROM "snap_shipping_shipmentevent")
    ORDER BY e.created_at`,
  `SELECT x.status, x.message, x.location ${GONE('shipping_shipmentevent')}
    ORDER BY x.occurred_at`,
  // Zones, methods and couriers made, changed or deleted.
  `SELECT z.name, z.description, z.cities::text AS cities, z.is_default, z.position, z.is_active,
          z.id NOT IN (SELECT id FROM "snap_shipping_shippingzone") AS made
     FROM shipping_shippingzone z WHERE ${CHANGED('z', 'shipping_shippingzone')} ORDER BY z.name`,
  `SELECT x.name ${GONE('shipping_shippingzone')} ORDER BY x.name`,
  `SELECT z.name AS zone, m.name, m.code, m.description, m.price::text, m.free_over::text,
          m.min_days, m.max_days, m.is_pickup, m.supports_cod, m.is_active, m.position,
          m.id NOT IN (SELECT id FROM "snap_shipping_shippingmethod") AS made
     FROM shipping_shippingmethod m JOIN shipping_shippingzone z ON z.id = m.zone_id
    WHERE ${CHANGED('m', 'shipping_shippingmethod')} ORDER BY z.name, m.code`,
  `SELECT x.code, x.name ${GONE('shipping_shippingmethod')} ORDER BY x.code, x.name`,
  `SELECT k.name, k.code, k.phone, k.tracking_url_template, k.integration, k.is_active,
          k.id NOT IN (SELECT id FROM "snap_shipping_courier") AS made
     FROM shipping_courier k WHERE ${CHANGED('k', 'shipping_courier')} ORDER BY k.code`,
  `SELECT x.code ${GONE('shipping_courier')} ORDER BY x.code`,
  // Orders left without the method they named.
  `SELECT o.number, m.code FROM orders_order o JOIN "snap_orders_order" s ON s.id = o.id
     LEFT JOIN shipping_shippingmethod m ON m.id = o.shipping_method_id
    WHERE o.shipping_method_id IS DISTINCT FROM s.shipping_method_id ORDER BY o.number`,
];

export async function resetShipping(client: pg.Client): Promise<void> {
  await restoreTables(client, SHIPPING_TABLES);
  await restoreSequences(client);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function shippingCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (what: string, sql: string) => {
    const found = new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
    // A name the fixtures do not hold is a mistake in this file, not a case.
    return (key: string) => {
      const id = found.get(key);
      if (!id) throw new Error(`shipping-cases: no ${what} called ${key}`);
      return id;
    };
  };
  if (!(await db.query(`SELECT 1 FROM orders_order WHERE number = 'RGN-PARITY-H01'`)).rowCount) {
    await db.end();
    console.log('SKIP  shipping: fixture_shipping.py has not been applied');
    return [];
  }
  const zone = await map('zone', `SELECT name AS key, id FROM shipping_shippingzone`);
  const method = await map(
    'method',
    `SELECT z.name || '/' || m.code AS key, m.id FROM shipping_shippingmethod m
       JOIN shipping_shippingzone z ON z.id = m.zone_id`,
  );
  const courier = await map('courier', `SELECT code AS key, id FROM shipping_courier`);
  const order = await map('order', `SELECT number AS key, id FROM orders_order`);
  // A parcel by its tracking number, or by its order when it has none.
  const parcel = await map(
    'parcel',
    `SELECT COALESCE(NULLIF(s.tracking_number, ''), o.number || ' untracked') AS key, s.id
       FROM shipping_shipment s JOIN orders_order o ON o.id = s.order_id`,
  );
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM orders_order UNION ALL SELECT id::text FROM shipping_shipment
       UNION ALL SELECT id::text FROM shipping_shipmentevent
       UNION ALL SELECT id::text FROM shipping_shippingmethod
       UNION ALL SELECT id::text FROM shipping_shippingzone
       UNION ALL SELECT id::text FROM shipping_courier`,
    )
  ).rows.map((row) => row.id);
  // Kept open: a case's `prepare` changes rows after the reset, before its request.
  const after =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `shipping: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    method_: string,
    path: string,
    body: unknown,
    who: Who = 'owner',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `shipping: ${name}`,
      method: method_,
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetShipping,
      effects: SHIPPING_EFFECTS,
      jobs: true,
      normalize: minted,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const ZONES = '/api/v1/shipping-zones/';
  const METHODS = '/api/v1/shipping-methods/';
  const COURIERS = '/api/v1/couriers/';
  const PARCELS = '/api/v1/shipments/';
  const long = (n: number) => 'x'.repeat(n);
  const NOT_OBJECTS: [string, unknown][] = [
    ['a list', []],
    ['a string', '"zone"'],
    ['a number', '7'],
    ['null', 'null'],
    ['broken JSON', '{"name": '],
    ['nothing', undefined],
  ];

  // === Who may do what =========================================================================
  for (const who of everyone) {
    for (const [what, base, id] of [
      ['zones', ZONES, zone('Parity Zone')],
      ['methods', METHODS, method('Parity Zone/p-std')],
      ['couriers', COURIERS, courier('parity-courier')],
      ['parcels', PARCELS, parcel('PAR-H03')],
    ] as const) {
      read(`[${who}] ${what}`, base, who);
      read(`[${who}] one of the ${what}`, `${base}${id}/`, who);
      // Refused before the body is read, or for the body: nothing is written.
      write(`[${who}] ${what}: create`, 'POST', base, {}, who);
      write(`[${who}] ${what}: replace`, 'PUT', `${base}${id}/`, {}, who);
      write(`[${who}] ${what}: edit one that is not there`, 'PATCH', `${base}${MISSING}/`, {}, who);
      write(
        `[${who}] ${what}: delete one that is not there`,
        'DELETE',
        `${base}${MISSING}/`,
        undefined,
        who,
      );
    }
    write(
      `[${who}] parcels: an update to one that is not there`,
      'POST',
      `${PARCELS}${MISSING}/events/`,
      {},
      who,
    );
    write(
      `[${who}] parcels: an update to a closed one`,
      'POST',
      `${PARCELS}${parcel('PAR-H06')}/events/`,
      {},
      who,
    );
  }
  for (const [what, base] of [
    ['zones', ZONES],
    ['methods', METHODS],
    ['couriers', COURIERS],
    ['parcels', PARCELS],
  ] as const) {
    read(`${what}: one that is not there`, `${base}${MISSING}/`);
    read(`${what}: a key that is no id`, `${base}abc/`);
    read(`${what}: no trailing slash`, base.slice(0, -1));
    write(`${what}: a list cannot be deleted`, 'DELETE', base, undefined);
    write(`${what}: one cannot be posted to`, 'POST', `${base}${MISSING}/`, {});
    for (const [kind, body] of NOT_OBJECTS)
      write(`${what}: create from ${kind}`, 'POST', base, body);
  }

  // === Zones ===================================================================================
  for (const ordering of [
    'name',
    '-name',
    'position',
    '-position,name',
    'cities',
    '-cities',
    'is_default,-name',
    'is_active,name',
    'description,name',
    'id',
    'methods',
    '-methods',
    'methods,-name',
    'methods__price',
    'eta_label',
    'nope',
    '',
    'name,nope',
    ' name',
  ]) {
    read(
      `zones ordered by ${ordering || 'nothing'}`,
      `${ZONES}?ordering=${encodeURIComponent(ordering)}`,
    );
  }
  read('zones: paging is not offered', `${ZONES}?page_size=1&page=2`);
  read('zones: a search is not offered', `${ZONES}?search=dhaka&is_active=false`);
  for (const name of ['Inside Dhaka', 'Outside Dhaka', 'Parity Zone', 'Parity Empty Zone']) {
    read(`the zone ${name}`, `${ZONES}${zone(name)}/`);
    read(`the zone ${name}, ordered by its methods`, `${ZONES}${zone(name)}/?ordering=methods`);
  }

  const zoneWrite = (name: string, body: unknown, extra: Partial<Case> = {}) =>
    write(`a new zone: ${name}`, 'POST', ZONES, body, 'owner', extra);
  zoneWrite('everything', {
    name: 'Parity North',
    description: 'Rajshahi and around',
    cities: [' Rajshahi ', 'RAJSHAHI', '', 'Bogura', 'bogura ', 'Naogaon'],
    is_default: false,
    position: 4,
    is_active: false,
    methods: [{ name: 'ignored' }],
    id: MISSING,
  });
  zoneWrite('a name alone', { name: 'Parity Bare' });
  zoneWrite('a name with space around it', { name: '  Parity Trim  ', description: '  d  ' });
  zoneWrite('no name', { cities: ['x'] });
  zoneWrite('a blank name', { name: '   ' });
  zoneWrite('a null name', { name: null });
  zoneWrite('a name that is a number', { name: 42 });
  zoneWrite('a name that is a list', { name: ['a'] });
  zoneWrite('the longest name', { name: long(120) });
  zoneWrite('a name too long', { name: long(121) });
  zoneWrite('a name taken', { name: 'Inside Dhaka' });
  zoneWrite('a name taken in other letters', { name: 'inside dhaka' });
  zoneWrite('a description too long', { name: 'Parity D', description: long(256) });
  zoneWrite('a null description', { name: 'Parity D', description: null });
  for (const [what, cities] of [
    ['one name, not a list', 'dhaka'],
    ['an object', { dhaka: true }],
    ['a number in the list', ['dhaka', 4000]],
    ['a null in the list', ['dhaka', null]],
    ['a list in the list', [['dhaka']]],
    ['a number', 7],
    ['true', true],
    ['null', null],
    ['an empty list', []],
    ['only blanks', ['', '   ']],
    ['Bengali names', ['ঢাকা', ' ঢাকা', 'İstanbul', 'STRASSE', 'Straße']],
  ] as [string, unknown][]) {
    zoneWrite(`cities as ${what}`, { name: 'Parity Cities', cities });
  }
  zoneWrite('a second fallback zone', { name: 'Parity Fallback', is_default: true });
  for (const [what, body] of [
    ['is_default as a word', { is_default: 'maybe' }],
    ['is_default as "yes"', { is_default: 'yes' }],
    ['is_default as null', { is_default: null }],
    ['is_active as 0', { is_active: 0 }],
    ['is_active as null', { is_active: null }],
    ['a position below zero', { position: -1 }],
    ['the largest position', { position: 2147483647 }],
    ['a position too large', { position: 2147483648 }],
    ['a position in words', { position: 'first' }],
    ['a position with a fraction', { position: 1.5 }],
    ['a position as text', { position: ' 7 ' }],
    ['a position as true', { position: true }],
    ['a null position', { position: null }],
  ] as [string, Record<string, unknown>][]) {
    zoneWrite(what, { name: 'Parity Typed', ...body });
  }
  zoneWrite('several things wrong', { name: '', cities: 'x', position: -1, is_default: 'q' });
  cases.push({
    name: 'shipping: a new zone, its cities as JSON text: a form body',
    method: 'POST',
    path: ZONES,
    headers: { ...auth('owner'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Parity+Form&cities=%5B%22Khulna%22%5D&position=3',
    reset: resetShipping,
    effects: SHIPPING_EFFECTS,
    normalize: minted,
  });
  cases.push({
    name: 'shipping: a new zone, its cities not JSON: a form body',
    method: 'POST',
    path: ZONES,
    headers: { ...auth('owner'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Parity+Form&cities=Khulna',
    reset: resetShipping,
    effects: SHIPPING_EFFECTS,
    normalize: minted,
  });

  const INSIDE = `${ZONES}${zone('Inside Dhaka')}/`;
  const PARITY_ZONE = `${ZONES}${zone('Parity Zone')}/`;
  for (const [what, body] of [
    ['nothing', {}],
    ['its name', { name: 'Dhaka Metro' }],
    ['its own name again', { name: 'Inside Dhaka' }],
    ["another zone's name", { name: 'Outside Dhaka' }],
    ['a blank name', { name: '' }],
    ['its cities', { cities: ['Dhaka', 'Savar', 'savar'] }],
    ['its cities to none', { cities: [] }],
    ['its cities to one name', { cities: 'dhaka' }],
    ['its cities to null', { cities: null }],
    ['the fallback flag', { is_default: true }],
    ['its position', { position: 7 }],
    ['a position below zero', { position: -3 }],
    ['switching it off', { is_active: false }],
    ['its description', { description: 'The city itself' }],
    ['its methods and id', { methods: [], id: MISSING }],
  ] as [string, unknown][]) {
    write(`a zone edited: ${what}`, 'PATCH', INSIDE, body);
  }
  // Its stored cities are not clean: an edit of something else leaves them as they are.
  write('a zone with unclean cities edited elsewhere', 'PATCH', PARITY_ZONE, { position: 5 });
  write('a zone with unclean cities, its cities resent', 'PATCH', PARITY_ZONE, {
    cities: ['  Chattogram ', 'SYLHET'],
  });
  write('a zone replaced', 'PUT', INSIDE, { name: 'Inside Dhaka', cities: ['dhaka'] });
  write('a zone replaced by its name alone', 'PUT', PARITY_ZONE, { name: 'Parity Zone' });
  write('a zone replaced without a name', 'PUT', INSIDE, { cities: ['dhaka'] });
  write('a zone edited: one that is no id', 'PATCH', `${ZONES}abc/`, { name: 'x' });
  for (const [kind, body] of NOT_OBJECTS)
    write(`a zone edited from ${kind}`, 'PATCH', INSIDE, body);
  for (const name of ['Parity Empty Zone', 'Inside Dhaka', 'Parity Zone', 'Outside Dhaka']) {
    write(`a zone deleted: ${name}`, 'DELETE', `${ZONES}${zone(name)}/`, undefined);
  }
  write('a zone deleted: with a body and a query', 'DELETE', `${PARITY_ZONE}?ordering=methods`, {
    name: 'ignored',
  });

  // === Methods =================================================================================
  for (const query of [
    '',
    `zone=${zone('Inside Dhaka')}`,
    `zone=${zone('Parity Zone')}&is_active=true`,
    `zone=${zone('Parity Zone')}&is_active=false`,
    `zone=${zone('Parity Empty Zone')}`,
    `zone=${MISSING}`,
    'zone=abc',
    'zone=',
    'is_active=true',
    'is_active=false',
    'is_active=True',
    'is_active=1',
    'is_active=maybe',
    'is_active=',
    `zone=abc&is_active=maybe`,
    'ordering=zone',
    'ordering=-zone',
    'ordering=zone,-price',
    'ordering=zone__name,-price',
    'ordering=-zone__name,code',
    'ordering=zone_name',
    'ordering=eta_label',
    'ordering=-eta_label,code',
    'ordering=name',
    'ordering=-code,name',
    'ordering=price,code',
    'ordering=-free_over,code',
    'ordering=free_over,code',
    'ordering=min_days,max_days,code',
    'ordering=-max_days,code',
    'ordering=is_pickup,code,zone__name',
    'ordering=supports_cod,code,zone__name',
    'ordering=is_active,code,zone__name',
    'ordering=position,code,zone__name',
    'ordering=description,code,zone__name',
    'ordering=id',
    'ordering=zone__position',
    'ordering=nope',
    'page_size=2',
    'search=express',
  ]) {
    read(`methods ${query || 'unfiltered'}`, `${METHODS}?${query}`);
  }
  const STD = `${METHODS}${method('Parity Zone/p-std')}/`;
  const OFF = `${METHODS}${method('Parity Zone/p-off')}/`;
  for (const key of [
    'Inside Dhaka/standard',
    'Inside Dhaka/express',
    'Inside Dhaka/pickup',
    'Outside Dhaka/standard',
    'Parity Zone/p-std',
    'Parity Zone/p-off',
  ]) {
    read(`the method ${key}`, `${METHODS}${method(key)}/`);
  }
  read('a method read through a filter that holds it', `${STD}?zone=${zone('Parity Zone')}`);
  read('a method read through a filter that does not', `${STD}?zone=${zone('Inside Dhaka')}`);
  read('a retired method read among the live ones', `${OFF}?is_active=true`);
  read('a method read through a filter that is wrong', `${STD}?zone=abc`);

  const PZ = zone('Parity Zone');
  const methodWrite = (name: string, body: unknown, extra: Partial<Case> = {}) =>
    write(`a new method: ${name}`, 'POST', METHODS, body, 'owner', extra);
  const base = { zone: PZ, name: 'Parity New', code: 'p-new' };
  methodWrite('everything', {
    ...base,
    description: 'Two to four days',
    price: '99.5',
    free_over: '2500',
    min_days: 2,
    max_days: 4,
    is_pickup: false,
    supports_cod: false,
    is_active: false,
    position: 6,
    zone_name: 'ignored',
    eta_label: 'ignored',
  });
  methodWrite('the three it needs', base);
  methodWrite('nothing', {});
  methodWrite('no zone', { name: 'x', code: 'x' });
  methodWrite('no name', { zone: PZ, code: 'x' });
  methodWrite('no code', { zone: PZ, name: 'x' });
  for (const [what, value] of [
    ['that is not there', MISSING],
    ['that is no id', 'abc'],
    ['that is null', null],
    ['that is blank', ''],
    ['that is a number', 7],
    ['that is a list', [PZ]],
    ['that is an object', { id: PZ }],
    ['in capitals', PZ.toUpperCase()],
  ] as [string, unknown][]) {
    methodWrite(`a zone ${what}`, { ...base, zone: value });
  }
  for (const [what, value] of [
    ['with a space', 'Probe Code'],
    ['in capitals', 'P-NEW'],
    ['with an underscore', 'p_new'],
    ['with a dot', 'p.new'],
    ['in Bengali', 'ঢাকা'],
    ['that is blank', ''],
    ['that is null', null],
    ['that is a number', 42],
    ['the longest', long(48)],
    ['too long', long(49)],
    ['the zone already has', 'p-std'],
    ['the zone has in other letters', 'P-STD'],
    ['another zone has', 'express'],
    ['with space around it', '  p-new  '],
  ] as [string, unknown][]) {
    methodWrite(`a code ${what}`, { ...base, code: value });
  }
  methodWrite('a code taken and the days backwards', {
    ...base,
    code: 'p-std',
    min_days: 5,
    max_days: 2,
  });
  methodWrite('a code taken and a price below zero', { ...base, code: 'p-std', price: '-1' });
  for (const [what, body] of [
    ['a price below zero', { price: '-0.01' }],
    ['a price of nothing', { price: '0' }],
    ['a price of minus nothing', { price: '-0.00' }],
    ['a price with three places', { price: '10.005' }],
    ['a price too large', { price: '1000000000000.00' }],
    ['the largest price', { price: '999999999999.99' }],
    ['a price in words', { price: 'free' }],
    ['a null price', { price: null }],
    ['a blank price', { price: '' }],
    ['a price as a number', { price: 70.5 }],
    ['a price in exponent form', { price: '1e2' }],
    ['a price that is not a number', { price: 'NaN' }],
    ['a free-over below zero', { free_over: '-1' }],
    ['a free-over of nothing', { free_over: '0.00' }],
    ['a null free-over', { free_over: null }],
    ['a blank free-over', { free_over: '' }],
    ['a free-over in words', { free_over: 'never' }],
    ['a price and a free-over below zero', { price: '-1', free_over: '-1' }],
    ['the shortest alone, above the usual longest', { min_days: 5 }],
    ['the longest alone, below the usual shortest', { max_days: 0 }],
    ['the days backwards', { min_days: 5, max_days: 2 }],
    ['the days equal', { min_days: 2, max_days: 2 }],
    ['one day', { min_days: 1, max_days: 1 }],
    ['the same day', { min_days: 0, max_days: 0 }],
    ['days below zero', { min_days: -1, max_days: 3 }],
    ['the most days', { min_days: 32767, max_days: 32767 }],
    ['too many days', { min_days: 1, max_days: 32768 }],
    ['days in words', { min_days: 'one', max_days: 'two' }],
    ['null days', { min_days: null, max_days: null }],
    ['days as text', { min_days: '2', max_days: '4' }],
    ['days with a fraction', { min_days: 1.0, max_days: 2.5 }],
    ['a pickup', { is_pickup: true, min_days: 0, max_days: 1, price: '0' }],
    ['a pickup in words', { is_pickup: 'collect' }],
    ['cash on delivery as null', { supports_cod: null }],
    ['a position below zero', { position: -1 }],
    ['a position too large', { position: 2147483648 }],
    ['a description too long', { description: long(256) }],
    ['a name too long', { name: long(121) }],
    ['a blank name', { name: ' ' }],
  ] as [string, Record<string, unknown>][]) {
    methodWrite(what, { ...base, ...body });
  }

  for (const [what, body] of [
    ['nothing', {}],
    ['its price', { price: '95' }],
    ['a price below zero', { price: '-5' }],
    ['its free-over cleared', { free_over: null }],
    ['its free-over below zero', { free_over: '-5' }],
    ['the shortest above its longest', { min_days: 3 }],
    ['the longest below its shortest', { max_days: 1 }],
    ['both, the right way round', { min_days: 3, max_days: 6 }],
    ['both, backwards', { min_days: 6, max_days: 3 }],
    ['the shortest as null', { min_days: null }],
    ["a code its zone's other method has", { code: 'p-off' }],
    ['its own code again', { code: 'p-std' }],
    ['a zone where its code is taken', { zone: zone('Inside Dhaka'), code: 'standard' }],
    ['a zone where its code is free', { zone: zone('Inside Dhaka') }],
    ['a zone that is not there', { zone: MISSING }],
    ['switching it off', { is_active: false }],
    ['making it a pickup', { is_pickup: true }],
    ['its name and description', { name: 'Parity usual', description: 'Two days' }],
    ['its position', { position: 9 }],
    ['what cannot be written', { zone_name: 'x', eta_label: 'x', id: MISSING }],
  ] as [string, unknown][]) {
    write(`a method edited: ${what}`, 'PATCH', STD, body);
  }
  write('a method edited through a filter that holds it', 'PATCH', `${STD}?is_active=true`, {
    is_active: false,
  });
  write('a method edited through a filter that does not', 'PATCH', `${OFF}?is_active=true`, {
    price: '1',
  });
  write('a method edited through a filter that is wrong', 'PATCH', `${STD}?zone=abc`, {
    price: '1',
  });
  write('a method replaced', 'PUT', STD, { ...base, code: 'p-std', price: '91.00' });
  write('a method replaced, its days left out', 'PUT', STD, { zone: PZ, name: 'P', code: 'p-std' });
  write('a method replaced without a code', 'PUT', STD, { zone: PZ, name: 'P' });
  for (const [kind, body] of NOT_OBJECTS) write(`a method edited from ${kind}`, 'PATCH', STD, body);
  for (const key of ['Parity Zone/p-std', 'Parity Zone/p-off', 'Inside Dhaka/standard']) {
    write(`a method deleted: ${key}`, 'DELETE', `${METHODS}${method(key)}/`, undefined);
  }
  write(
    'a method deleted through a filter that does not hold it',
    'DELETE',
    `${OFF}?is_active=true`,
    undefined,
  );
  write(
    'a method deleted through a filter that holds it',
    'DELETE',
    `${OFF}?is_active=false`,
    undefined,
  );

  // === Couriers ================================================================================
  for (const ordering of [
    '',
    'name',
    '-name',
    'code',
    '-code',
    'phone,code',
    'tracking_url_template,code',
    'integration,-code',
    'is_active,code',
    '-is_active,-code',
    'id',
    'shipments',
    'nope',
  ]) {
    read(`couriers ordered by ${ordering || 'nothing'}`, `${COURIERS}?ordering=${ordering}`);
  }
  read('couriers: no filter is offered', `${COURIERS}?is_active=false&search=pathao&page_size=1`);
  for (const code of ['pathao', 'in-house', 'parity-courier', 'parity-idle']) {
    read(`the courier ${code}`, `${COURIERS}${courier(code)}/`);
  }

  const courierWrite = (name: string, body: unknown) =>
    write(`a new courier: ${name}`, 'POST', COURIERS, body);
  const carrier = { name: 'Parity Fast', code: 'parity-fast' };
  courierWrite('everything', {
    ...carrier,
    phone: '01711-000 111',
    tracking_url_template: 'https://fast.parity.test/t/{tracking_number}',
    integration: 'fast-api',
    is_active: false,
    id: MISSING,
  });
  courierWrite('a name and a code', carrier);
  courierWrite('nothing', {});
  courierWrite('no code', { name: 'Parity Fast' });
  courierWrite('no name', { code: 'parity-fast' });
  for (const [what, body] of [
    ['a name taken', { name: 'Pathao Courier' }],
    ['a name taken in other letters', { name: 'pathao courier' }],
    ['a name taken, with space around it', { name: '  Pathao Courier ' }],
    ['a name too long', { name: long(121) }],
    ['a blank name', { name: '' }],
    ['a code taken', { code: 'pathao' }],
    ['a code taken in other letters', { code: 'PATHAO' }],
    ['a code with a space', { code: 'parity fast' }],
    ['the longest code', { code: long(32) }],
    ['a code too long', { code: long(33) }],
    ['a null code', { code: null }],
    ['a name and a code both taken', { name: 'Pathao Courier', code: 'pathao' }],
    ['a mobile with its country code', { phone: '+8801711000111' }],
    ['a mobile with 880 and spaces', { phone: '880 1711 000111' }],
    ['a hotline', { phone: '16516' }],
    ['a landline', { phone: '02-9881234' }],
    ['a phone in words', { phone: 'call the office' }],
    ['a phone in Bengali digits', { phone: '০১৭১১০০০১১১' }],
    ['a blank phone', { phone: '' }],
    ['a null phone', { phone: null }],
    ['the longest phone', { phone: '1'.repeat(32) }],
    ['a phone too long', { phone: '1'.repeat(33) }],
    ['a phone as a number', { phone: 1711000111 }],
    ['a page with no placeholder', { tracking_url_template: 'https://fast.parity.test/track' }],
    [
      'a page with another placeholder',
      { tracking_url_template: 'https://fast.parity.test/{number}' },
    ],
    ['a page that is no address', { tracking_url_template: 'ask the driver' }],
    ['a page too long', { tracking_url_template: `https://x.test/${long(241)}` }],
    ['a null page', { tracking_url_template: null }],
    ['a blank integration', { integration: '' }],
    ['a null integration', { integration: null }],
    ['an integration too long', { integration: long(33) }],
    ['active as a word', { is_active: 'sometimes' }],
  ] as [string, Record<string, unknown>][]) {
    courierWrite(what, { ...carrier, ...body });
  }
  const PARITY_COURIER = `${COURIERS}${courier('parity-courier')}/`;
  for (const [what, body] of [
    ['nothing', {}],
    ['its name', { name: 'Parity Couriers Ltd' }],
    ["another courier's name", { name: 'Pathao Courier' }],
    ['its own name and code again', { name: 'Parity Courier', code: 'parity-courier' }],
    ["another courier's code", { code: 'pathao' }],
    ['its code', { code: 'parity-couriers' }],
    ['its phone', { phone: '01811000222' }],
    ['its page', { tracking_url_template: 'https://track.parity.test/v2/{tracking_number}' }],
    ['its page cleared', { tracking_url_template: '' }],
    ['switching it off', { is_active: false }],
    ['its integration', { integration: 'parity-api' }],
  ] as [string, unknown][]) {
    write(`a courier edited: ${what}`, 'PATCH', PARITY_COURIER, body);
  }
  write('a courier replaced', 'PUT', PARITY_COURIER, {
    name: 'Parity Courier',
    code: 'parity-courier',
  });
  write('a courier replaced without a code', 'PUT', PARITY_COURIER, { name: 'Parity Courier' });
  for (const [kind, body] of NOT_OBJECTS)
    write(`a courier edited from ${kind}`, 'PATCH', PARITY_COURIER, body);
  for (const code of ['parity-idle', 'pathao', 'parity-courier', 'in-house']) {
    write(`a courier deleted: ${code}`, 'DELETE', `${COURIERS}${courier(code)}/`, undefined);
  }

  // === Parcels: reading ========================================================================
  for (const query of [
    '',
    'page_size=3',
    'page_size=3&page=2',
    'page=last&page_size=4',
    'page=99',
    'page_size=0',
    `order=${order('RGN-PARITY-H03')}`,
    `order=${order('RGN-PARITY-H04')}&status=PENDING`,
    `order=${order('RGN-PARITY-H07')}`,
    `order=${order('RGN-PARITY-H05')}`,
    `order=${MISSING}`,
    'order=abc',
    'order=',
    ...[
      'PENDING',
      'DISPATCHED',
      'IN_TRANSIT',
      'DELIVERED',
      'FAILED',
      'RETURNED',
      'pending',
      'NOPE',
      '',
    ].map((status) => `status=${status}`),
    `courier=${courier('pathao')}`,
    `courier=${courier('parity-courier')}&status=DELIVERED`,
    `courier=${courier('parity-idle')}`,
    `courier=${MISSING}`,
    'courier=abc',
    'courier=null',
    'order=abc&status=NOPE&courier=abc',
    'ordering=created_at',
    'ordering=-created_at',
    'ordering=tracking_number,created_at',
    'ordering=-tracking_number,created_at',
    'ordering=status,-created_at',
    'ordering=cost,created_at',
    'ordering=-cost,created_at',
    'ordering=dispatched_at,created_at',
    'ordering=-dispatched_at,created_at',
    'ordering=delivered_at,created_at',
    'ordering=notes,created_at',
    'ordering=order,created_at',
    'ordering=-order,created_at',
    'ordering=order__number,created_at',
    'ordering=order_number,created_at',
    'ordering=courier,created_at',
    'ordering=-courier,created_at',
    'ordering=courier__name,created_at',
    'ordering=courier_name,created_at',
    'ordering=shipping_method,created_at',
    'ordering=-shipping_method,created_at',
    'ordering=events,created_at',
    'ordering=-events,created_at',
    'ordering=events&page_size=3',
    'ordering=tracking_url,created_at',
    'ordering=id',
    'ordering=nope,created_at',
    'search=PAR-H0',
  ]) {
    read(`parcels ${query || 'unfiltered'}`, `${PARCELS}?${query}`);
  }
  read('parcels: a branch manager sees their own', `${PARCELS}?ordering=created_at`, 'mirpur');
  read(
    "parcels: a branch manager filters by another branch's order",
    `${PARCELS}?order=${order('RGN-PARITY-H03')}`,
    'mirpur',
  );
  read(
    'parcels: the home manager sees theirs',
    `${PARCELS}?ordering=created_at&page_size=50`,
    'manager',
  );
  for (const key of [
    'PAR-H01',
    'PAR-H02',
    'PAR-H03',
    'RGN-PARITY-H03 untracked',
    'PAR-H04',
    'PAR-H04-B',
    'RD-5',
    'PAR-H06',
    'PAR-H08',
    'PT 0001/ü',
    'RGN-PARITY-0001 untracked',
  ]) {
    read(`the parcel ${key}`, `${PARCELS}${parcel(key)}/`);
    read(`the parcel ${key}, as a branch manager`, `${PARCELS}${parcel(key)}/`, 'mirpur');
    read(`the parcel ${key}, as the home manager`, `${PARCELS}${parcel(key)}/`, 'manager');
  }
  const H04 = `${PARCELS}${parcel('PAR-H04')}/`;
  read('a parcel read through a filter that holds it', `${H04}?status=DELIVERED`);
  read('a parcel read through a filter that does not', `${H04}?status=PENDING`);
  read('a parcel read through a filter that is wrong', `${H04}?courier=abc`);
  read('a parcel read ordered by its history', `${H04}?ordering=events`);
  read('a parcel read ordered by its method', `${H04}?ordering=shipping_method`);
  read("a parcel's updates cannot be listed", `${H04}events/`);
  // What a courier's tracking page makes of the number, when the page is mistyped.
  for (const [what, template] of [
    ['another placeholder', 'https://t.test/{number}'],
    ['a numbered placeholder', 'https://t.test/{0}'],
    ['an empty placeholder', 'https://t.test/{}'],
    ['an open brace', 'https://t.test/{tracking_number'],
    ['a closing brace', 'https://t.test/tracking_number}'],
    ['doubled braces', 'https://t.test/{{tracking_number}}'],
    ['the number twice', 'https://t.test/{tracking_number}/{tracking_number}'],
    ['the number as a repr', 'https://t.test/{tracking_number!r}'],
    ['the number padded', 'https://t.test/{tracking_number:>12}'],
    ['the number cut short', 'https://t.test/{tracking_number:.3}'],
    ['the number centred', 'https://t.test/{tracking_number:*^11s}'],
    ['the number as a figure', 'https://t.test/{tracking_number:d}'],
    ['an attribute of the number', 'https://t.test/{tracking_number.real}'],
    ['a method of the number', 'https://t.test/{tracking_number.upper}'],
    ['a letter of the number', 'https://t.test/{tracking_number[0]}'],
    ['no placeholder', 'https://t.test/track'],
  ] as const) {
    cases.push({
      name: `shipping: a parcel whose courier's page has ${what}`,
      path: `${PARCELS}${parcel('PAR-H03')}/`,
      headers: auth('owner'),
      reset: resetShipping,
      prepare: after(
        `UPDATE shipping_courier SET tracking_url_template = '${template}' WHERE code = 'parity-courier'`,
      ),
    });
  }

  // The same page as the customer's own order shows it.
  for (const [what, template] of [
    ['another placeholder', 'https://t.test/{number}'],
    ['a numbered placeholder', 'https://t.test/{0}'],
    ['the number padded', 'https://t.test/{tracking_number:>12}'],
    ['an attribute the number lacks', 'https://t.test/{tracking_number.real}'],
  ] as const) {
    cases.push({
      name: `shipping: a customer's order whose courier's page has ${what}`,
      path: '/api/v1/shop/orders/RGN-PARITY-H03/',
      headers: auth('customer'),
      reset: resetShipping,
      prepare: after(
        `UPDATE shipping_courier SET tracking_url_template = '${template}' WHERE code = 'parity-courier'`,
      ),
    });
  }

  // === Parcels: booking ========================================================================
  const H = (n: number) => order(`RGN-PARITY-H0${n}`);
  const book = (name: string, body: unknown, who: Who = 'manager', extra: Partial<Case> = {}) =>
    write(`a parcel booked: ${name}`, 'POST', PARCELS, body, who, extra);
  book('everything', {
    order: H(7),
    courier: courier('pathao'),
    shipping_method: method('Inside Dhaka/standard'),
    tracking_number: '  PX-1  ',
    cost: '55.5',
    notes: '  Two boxes  ',
    status: 'DELIVERED',
    dispatched_at: '2026-10-01T10:00:00+06:00',
    delivered_at: '2026-10-02T10:00:00+06:00',
    events: [{ status: 'DELIVERED' }],
    created_by: MISSING,
    id: MISSING,
  });
  book('the order alone', { order: H(7) });
  book('by the owner', { order: H(7), courier: courier('in-house') }, 'owner');
  for (const [what, number] of [
    ['a pending order', 'RGN-PARITY-S03'],
    ['a confirmed order', 'RGN-PARITY-H01'],
    ['a packed order', 'RGN-PARITY-H02'],
    ['a shipped order', 'RGN-PARITY-H03'],
    ['a delivered order', 'RGN-PARITY-H04'],
    ['a cancelled order', 'RGN-PARITY-0003'],
    ['a returned order', 'RGN-PARITY-0004'],
  ] as const) {
    book(`for ${what}`, {
      order: order(number),
      courier: courier('pathao'),
      tracking_number: 'PX-2',
    });
  }
  for (const status of ['RETURN_REQUESTED', 'REFUNDED', 'PROCESSING', 'NOPE']) {
    book(`for an order that is ${status}`, { order: H(7) }, 'manager', {
      prepare: after(
        `UPDATE orders_order SET status = '${status}' WHERE number = 'RGN-PARITY-H07'`,
      ),
    });
  }
  for (const [what, value] of [
    ['that is not there', MISSING],
    ['that is no id', 'abc'],
    ['that is null', null],
    ['that is blank', ''],
    ['that is a number', 7],
    ['that is a list', [H(7)]],
    ['by its number', 'RGN-PARITY-H07'],
  ] as [string, unknown][]) {
    book(`for an order ${what}`, { order: value });
  }
  book('nothing', {});
  book("for another branch's order, by the home manager", { order: H(5) });
  book("for another branch's order, by the owner", { order: H(5) }, 'owner');
  book(
    'for their own order, by a branch manager',
    { order: H(5), courier: courier('in-house') },
    'mirpur',
  );
  book("for the home branch's order, by a branch manager", { order: H(7) }, 'mirpur');
  for (const [what, body] of [
    ['a number and no courier', { tracking_number: 'PX-3' }],
    ['a number and a null courier', { tracking_number: 'PX-3', courier: null }],
    ['only spaces for a number and no courier', { tracking_number: '   ' }],
    ['a blank number', { tracking_number: '', courier: courier('pathao') }],
    ['a null number', { tracking_number: null, courier: courier('pathao') }],
    ['a number as a figure', { tracking_number: 12345, courier: courier('pathao') }],
    ['the longest number', { tracking_number: long(120), courier: courier('pathao') }],
    ['a number too long', { tracking_number: long(121), courier: courier('pathao') }],
    [
      'a number its courier has used',
      { tracking_number: 'PAR-H03', courier: courier('parity-courier') },
    ],
    [
      'a used number, with space around it',
      { tracking_number: ' PAR-H03 ', courier: courier('parity-courier') },
    ],
    [
      'a used number in other letters',
      { tracking_number: 'par-h03', courier: courier('parity-courier') },
    ],
    ["another courier's number", { tracking_number: 'PAR-H03', courier: courier('pathao') }],
    [
      'a used number and a cost below zero',
      { tracking_number: 'PAR-H03', courier: courier('parity-courier'), cost: '-1' },
    ],
    [
      'a number with marks in it',
      { tracking_number: 'PT 0002/ü?&#', courier: courier('parity-courier') },
    ],
    ['no number, a courier who has such parcels', { courier: courier('parity-courier') }],
    ['a courier that is not there', { courier: MISSING }],
    ['a courier that is no id', { courier: 'abc' }],
    ['a courier switched off', { courier: courier('parity-idle'), tracking_number: 'ID-1' }],
    ['a courier with no page', { courier: courier('in-house'), tracking_number: 'RD-9' }],
    ['a method that is not there', { shipping_method: MISSING }],
    ['a method that is no id', { shipping_method: 'abc' }],
    ['a null method', { shipping_method: null }],
    ['a method switched off', { shipping_method: method('Parity Zone/p-off') }],
    ['a cost below zero', { cost: '-0.01' }],
    ['a cost below zero and a number with no courier', { cost: '-1', tracking_number: 'PX-3' }],
    ['a cost of nothing', { cost: '0' }],
    ['a cost of minus nothing', { cost: '-0.00' }],
    ['a cost with three places', { cost: '10.005' }],
    ['a cost too large', { cost: '1000000000000' }],
    ['the largest cost', { cost: '999999999999.99' }],
    ['a cost in words', { cost: 'cheap' }],
    ['a null cost', { cost: null }],
    ['a blank cost', { cost: '' }],
    ['a cost as a number', { cost: 60 }],
    ['null notes', { notes: null }],
    ['blank notes', { notes: '' }],
    ['long notes', { notes: long(3000) }],
    ['notes of several lines', { notes: 'Ring first\n  Leave at the gate\n' }],
    [
      'several things wrong',
      { courier: 'abc', shipping_method: 'abc', cost: 'x', tracking_number: long(121) },
    ],
  ] as [string, Record<string, unknown>][]) {
    book(`with ${what}`, { order: H(7), ...body });
  }
  cases.push({
    name: 'shipping: a parcel booked: a form body',
    method: 'POST',
    path: PARCELS,
    headers: { ...auth('manager'), 'content-type': 'application/x-www-form-urlencoded' },
    body: `order=${H(7)}&courier=${courier('pathao')}&tracking_number=PX-FORM&cost=45`,
    reset: resetShipping,
    effects: SHIPPING_EFFECTS,
    normalize: minted,
  });
  cases.push({
    name: 'shipping: a parcel booked, its courier blank: a form body',
    method: 'POST',
    path: PARCELS,
    headers: { ...auth('manager'), 'content-type': 'application/x-www-form-urlencoded' },
    body: `order=${H(7)}&courier=&shipping_method=&tracking_number=`,
    reset: resetShipping,
    effects: SHIPPING_EFFECTS,
    normalize: minted,
  });

  // === Parcels: editing and deleting ===========================================================
  const one = (key: string) => `${PARCELS}${parcel(key)}/`;
  const BARE = one('RGN-PARITY-H03 untracked');
  const TRACKED = one('PAR-H03');
  for (const [what, path, body] of [
    ['nothing, with no courier', BARE, {}],
    ['nothing, with a courier', TRACKED, {}],
    ['a number given to one with no courier', BARE, { tracking_number: 'T-9' }],
    ['a courier and a number given', BARE, { courier: courier('pathao'), tracking_number: 'T-9' }],
    ['a cost below zero', BARE, { cost: '-5' }],
    ['a cost in words', BARE, { cost: 'x' }],
    ['its courier taken away, its number kept', TRACKED, { courier: null }],
    ["a number its courier's other parcel has", TRACKED, { tracking_number: 'PAR-H04' }],
    ['its own number again', TRACKED, { tracking_number: 'PAR-H03' }],
    ['a number with space around it', TRACKED, { tracking_number: '  PAR-H03-X ' }],
    [
      'a courier whose parcel has its number',
      one('PAR-H02'),
      { courier: courier('parity-courier'), tracking_number: 'PAR-H03' },
    ],
    ['its number blanked', TRACKED, { tracking_number: '' }],
    ['moved to another order', TRACKED, { order: H(7) }],
    ['moved to a cancelled order', TRACKED, { order: order('RGN-PARITY-0003') }],
    ["moved to another branch's order", TRACKED, { order: H(5) }],
    ['moved to an order that is not there', TRACKED, { order: MISSING }],
    ['moved to a null order', TRACKED, { order: null }],
    [
      'its status, stamps and history',
      TRACKED,
      {
        status: 'DELIVERED',
        dispatched_at: null,
        delivered_at: '2026-10-02T10:00:00Z',
        events: [],
      },
    ],
    ['its method', TRACKED, { shipping_method: method('Parity Zone/p-off') }],
    ['its method cleared', one('PAR-H01'), { shipping_method: null }],
    ['its notes', TRACKED, { notes: '  Left at the gate ' }],
    ['a courier switched off', TRACKED, { courier: courier('parity-idle') }],
    [
      'a delivered one, its cost and number',
      one('PAR-H04'),
      { cost: '75.25', tracking_number: 'PAR-H04-FIXED' },
    ],
    ['a returned one, its courier', one('PAR-H06'), { courier: courier('parity-courier') }],
  ] as [string, string, unknown][]) {
    write(`a parcel edited: ${what}`, 'PATCH', path, body, 'manager');
  }
  write(
    "a parcel edited: another branch's, by the home manager",
    'PATCH',
    one('RD-5'),
    { notes: 'x' },
    'manager',
  );
  write(
    'a parcel edited: their own, by a branch manager',
    'PATCH',
    one('RD-5'),
    { notes: 'x' },
    'mirpur',
  );
  write(
    "a parcel edited: their own moved to the home branch's order",
    'PATCH',
    one('RD-5'),
    { order: H(7) },
    'mirpur',
  );
  write(
    "a parcel edited: the home branch's, by a branch manager",
    'PATCH',
    TRACKED,
    { notes: 'x' },
    'mirpur',
  );
  write('a parcel edited through a filter that holds it', 'PATCH', `${TRACKED}?status=DISPATCHED`, {
    notes: 'x',
  });
  write('a parcel edited through a filter that does not', 'PATCH', `${TRACKED}?status=PENDING`, {
    notes: 'x',
  });
  write(
    'a parcel replaced',
    'PUT',
    TRACKED,
    { order: H(3), courier: courier('parity-courier'), tracking_number: 'PAR-H03', cost: '61' },
    'manager',
  );
  write('a parcel replaced by its order alone', 'PUT', TRACKED, { order: H(3) }, 'manager');
  write(
    'a parcel with no courier replaced',
    'PUT',
    BARE,
    { order: H(3), notes: 'Still the second box' },
    'manager',
  );
  write('a parcel replaced without its order', 'PUT', TRACKED, { cost: '61' }, 'manager');
  for (const [kind, body] of NOT_OBJECTS)
    write(`a parcel edited from ${kind}`, 'PATCH', TRACKED, body);
  for (const key of ['RGN-PARITY-H03 untracked', 'PAR-H03', 'PAR-H04', 'PAR-H06', 'PAR-H01']) {
    write(`a parcel deleted: ${key}`, 'DELETE', one(key), undefined, 'manager');
  }
  write(
    "a parcel deleted: another branch's, by the home manager",
    'DELETE',
    one('RD-5'),
    undefined,
    'manager',
  );
  write(
    'a parcel deleted: their own, by a branch manager',
    'DELETE',
    one('RD-5'),
    undefined,
    'mirpur',
  );
  write(
    'a parcel deleted through a filter that does not hold it',
    'DELETE',
    `${TRACKED}?status=PENDING`,
    undefined,
  );
  write('a parcel deleted: a key that is no id', 'DELETE', `${PARCELS}abc/`, undefined);

  // === Parcels: tracking updates ===============================================================
  const told = (
    name: string,
    key: string,
    body: unknown,
    who: Who = 'manager',
    extra: Partial<Case> = {},
  ) => write(`an update: ${name}`, 'POST', `${one(key)}events/`, body, who, extra);
  const STATUSES = ['PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED'];
  const PARCEL_STATES: [string, string][] = [
    ['a pending parcel of a confirmed order', 'PAR-H01'],
    ['a pending parcel of a packed order', 'PAR-H02'],
    ['a dispatched parcel of a shipped order', 'PAR-H03'],
    ['the second, pending parcel of a shipped order', 'RGN-PARITY-H03 untracked'],
    ['a delivered parcel', 'PAR-H04'],
    ['the second, pending parcel of a delivered order', 'PAR-H04-B'],
    ['a returned parcel', 'PAR-H06'],
    ['a failed parcel of a shipped order', 'PAR-H08'],
    ['a parcel on its way to a guest', 'RD-5'],
  ];
  for (const [what, key] of PARCEL_STATES) {
    told(`nothing said of ${what}`, key, {}, 'owner');
    for (const status of STATUSES) {
      told(`${status} for ${what}`, key, { status, message: `Parity ${status}` }, 'owner');
    }
  }
  // The order has moved on, or back, since the parcel was booked.
  for (const status of [
    'PENDING',
    'CONFIRMED',
    'PROCESSING',
    'PACKED',
    'DELIVERED',
    'CANCELLED',
    'RETURN_REQUESTED',
    'RETURNED',
    'REFUNDED',
  ]) {
    const moved = after(
      `UPDATE orders_order SET status = '${status}' WHERE number = 'RGN-PARITY-H03'`,
    );
    for (const said of ['DISPATCHED', 'DELIVERED', 'PENDING']) {
      told(
        `${said} for a pending parcel, its order now ${status}`,
        'RGN-PARITY-H03 untracked',
        { status: said },
        'manager',
        { prepare: moved },
      );
    }
    told(
      `DELIVERED for a dispatched parcel, its order now ${status}`,
      'PAR-H03',
      { status: 'DELIVERED' },
      'manager',
      { prepare: moved },
    );
    told(
      `DISPATCHED again for a dispatched parcel, its order now ${status}`,
      'PAR-H03',
      { status: 'DISPATCHED' },
      'manager',
      { prepare: moved },
    );
  }
  told('by the home manager, for another branch', 'RD-5', { status: 'DELIVERED' }, 'manager');
  told(
    'by a branch manager, for their own',
    'RD-5',
    { status: 'DELIVERED', message: 'Signed for' },
    'mirpur',
  );
  told('by a branch manager, for the home branch', 'PAR-H03', { status: 'DELIVERED' }, 'mirpur');
  told('through a filter that holds the parcel', 'PAR-H03', { status: 'IN_TRANSIT' }, 'manager', {
    path: `${TRACKED}events/?status=DISPATCHED`,
  });
  told('through a filter that does not', 'PAR-H03', { status: 'IN_TRANSIT' }, 'manager', {
    path: `${TRACKED}events/?status=PENDING`,
  });
  for (const [what, body] of [
    [
      'everything',
      {
        status: 'IN_TRANSIT',
        message: '  At the hub  ',
        location: ' Tejgaon ',
        occurred_at: '2026-10-05T09:30:00+06:00',
        raw: { a: 1 },
        id: MISSING,
        created_at: '2020-01-01T00:00:00Z',
      },
    ],
    ['a status that is none', { status: 'LOST' }],
    ['a status in small letters', { status: 'delivered' }],
    ['a blank status', { status: '' }],
    ['a null status', { status: null }],
    ['a status as a number', { status: 3 }],
    ['a status as a list', { status: ['DELIVERED'] }],
    ['the longest message', { message: long(255) }],
    ['a message too long', { message: long(256) }],
    ['a null message', { message: null }],
    ['a blank message', { message: '' }],
    ['a message as a number', { message: 42 }],
    ['a message in Bengali', { message: 'পৌঁছে গেছে', location: 'ঢাকা' }],
    ['the longest place', { location: long(120) }],
    ['a place too long', { location: long(121) }],
    ['a null place', { location: null }],
    ['a time with no zone', { occurred_at: '2026-10-05T09:30:00' }],
    ['a time in UTC', { occurred_at: '2026-10-05T09:30:00Z' }],
    ['a time to the microsecond', { occurred_at: '2026-10-05T09:30:00.123456+06:00' }],
    ['a time with a space', { occurred_at: '2026-10-05 09:30' }],
    ['a day with no time', { occurred_at: '2026-10-05' }],
    ['a time yet to come', { occurred_at: '2031-01-01T00:00:00Z' }],
    ['a time long ago', { occurred_at: '1999-12-31T23:59:59+06:00' }],
    ['a time that is none', { occurred_at: 'yesterday' }],
    ['a time that cannot be', { occurred_at: '2026-02-30T10:00:00Z' }],
    ['a null time', { occurred_at: null }],
    ['a blank time', { occurred_at: '' }],
    ['a time as a number', { occurred_at: 1759800000 }],
    [
      'several things wrong',
      { status: 'LOST', message: long(256), location: long(121), occurred_at: 'x' },
    ],
  ] as [string, unknown][]) {
    told(`with ${what}`, 'PAR-H03', body);
  }
  // Earlier than what it has: the history reads by when things happened.
  told('one that happened before the last', 'PAR-H08', {
    status: 'IN_TRANSIT',
    occurred_at: '2026-01-01T00:00:00Z',
  });
  for (const [kind, body] of NOT_OBJECTS) told(`from ${kind}`, 'PAR-H03', body);
  for (const [kind, body] of NOT_OBJECTS)
    told(`from ${kind}, for a closed parcel`, 'PAR-H06', body);
  cases.push({
    name: 'shipping: an update: a form body',
    method: 'POST',
    path: `${TRACKED}events/`,
    headers: { ...auth('manager'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'status=DELIVERED&message=Signed+for&location=Dhanmondi',
    reset: resetShipping,
    effects: SHIPPING_EFFECTS,
    jobs: true,
    normalize: minted,
  });
  // The customer of the order has an account: told in the app, by email and by text.
  told(
    'DELIVERED for the parcel of an order whose customer has no phone',
    'PAR-H03',
    { status: 'DELIVERED' },
    'manager',
    {
      prepare: after(
        `UPDATE customers_customer SET phone = '' WHERE id = (SELECT customer_id FROM orders_order WHERE number = 'RGN-PARITY-H03')`,
      ),
    },
  );
  told('DISPATCHED for the parcel of an order with money still owed', 'PAR-H02', {
    status: 'DISPATCHED',
    message: 'Collected',
    location: 'Panthapath',
  });

  return cases;
}
