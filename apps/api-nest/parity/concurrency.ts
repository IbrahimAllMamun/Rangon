/**
 * Concurrency checks: invariants that hold only if a write takes the right
 * lock, driven with simultaneous requests -- across both APIs at once, which
 * is how they will run while paths are cut over one at a time.
 *
 * Run by run.ts after the comparison cases; each check restores what it wrote.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

import pg from 'pg';

import { resetCheckout } from './checkout-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function bearer(user: { id: string; password: string }, key: string, type = 'access', extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    token_type: type,
    exp: now + 600,
    iat: now,
    jti: `parity${randomBytes(13).toString('hex')}`,
    user_id: user.id,
    hash_password: createHash('md5').update(user.password).digest('hex').toUpperCase(),
    ...extra,
  })}`;
  return `${head}.${createHmac('sha256', key).update(head).digest('base64url')}`;
}

export async function concurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
  SIGNING_KEY: string;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const many = (
      await db.query<{ id: string; password: string; customer_id: string }>(
        `SELECT u.id, u.password, c.id AS customer_id FROM accounts_user u
           JOIN customers_customer c ON c.user_id = u.id WHERE u.email = 'parity.many@rangon.test'`,
      )
    ).rows[0];
    if (!many) return [];
    const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]?.now;

    // 1. One default address per customer. Twenty "add as the default"
    //    requests at once, half to each API: `add_address` locks the customer
    //    row, so they queue, and exactly one default must remain.
    const before = await db.query<{ id: string; is_default: boolean }>(
      `SELECT id, is_default FROM customers_customeraddress WHERE customer_id = $1`,
      [many.customer_id],
    );
    const token = bearer(many, apis.SIGNING_KEY);
    const statuses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        send(index % 2 ? apis.NEST : apis.DJANGO, {
          name: 'concurrent default',
          method: 'POST',
          path: '/api/v1/shop/account/addresses/',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            recipient_name: `Race ${index}`,
            phone: '01711000006',
            line1: 'Road',
            city: 'Dhaka',
            is_default: true,
          }),
        }).then((response) => response.status),
      ),
    );
    const after = await db.query<{ defaults: string; total: string }>(
      `SELECT count(*) FILTER (WHERE is_default) AS defaults, count(*) AS total
         FROM customers_customeraddress WHERE customer_id = $1`,
      [many.customer_id],
    );
    const { defaults, total } = after.rows[0] ?? { defaults: '?', total: '?' };
    checks.push({
      name: 'addresses: 20 simultaneous defaults across both APIs leave exactly one',
      passed:
        statuses.every((status) => status === 201) &&
        defaults === '1' &&
        Number(total) === before.rows.length + 20,
      detail: `statuses ${[...new Set(statuses)].join('/')}, ${defaults} default of ${total}`,
    });
    await db.query(
      `DELETE FROM customers_customeraddress WHERE customer_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [many.customer_id, before.rows.map((row) => row.id)],
    );
    for (const row of before.rows) {
      await db.query(`UPDATE customers_customeraddress SET is_default = $2 WHERE id = $1`, [
        row.id,
        row.is_default,
      ]);
    }

    // 2. A refresh token is spent once. Eight refreshes of one token at once
    //    to the Nest API: exactly one gets a new pair (Django's get_or_create
    //    can let several through; a documented difference).
    const refresh = bearer(many, apis.SIGNING_KEY, 'refresh', {
      exp: Math.floor(Date.now() / 1000) + 86400,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        send(apis.NEST, {
          name: 'concurrent refresh',
          method: 'POST',
          path: '/api/v1/auth/refresh/',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh }),
        }).then((response) => response.status),
      ),
    );
    const granted = results.filter((status) => status === 200).length;
    checks.push({
      name: 'refresh: 8 simultaneous uses of one token, exactly one rotates (Nest)',
      passed: granted === 1 && results.every((status) => status === 200 || status === 401),
      detail: `${granted} granted, statuses ${results.join(',')}`,
    });

    await db.query(`DELETE FROM token_blacklist_blacklistedtoken WHERE blacklisted_at >= $1`, [
      since,
    ]);
    await db.query(
      `DELETE FROM token_blacklist_outstandingtoken WHERE created_at >= $1 OR (created_at IS NULL AND jti LIKE 'parity%')`,
      [since],
    );
    await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);

    checks.push(...(await checkoutRaces(db, apis)));
  } finally {
    await db.end();
  }
  return checks;
}

/** Guest carts made for a race, each holding `quantity` of `sku`, optionally with a coupon. */
async function raceCarts(
  db: pg.Client,
  prefix: string,
  count: number,
  sku: string,
  quantity: number,
  couponId?: string,
): Promise<string[]> {
  const branch = (
    await db.query<{ id: string }>(`SELECT id FROM accounts_branch WHERE is_default LIMIT 1`)
  ).rows[0]?.id;
  const variant = (
    await db.query<{ id: string }>(`SELECT id FROM catalog_productvariant WHERE sku = $1`, [sku])
  ).rows[0]?.id;
  const tokens: string[] = [];
  for (let index = 0; index < count; index++) {
    const token = `${prefix}-${index}`;
    const cart = await db.query<{ id: string }>(
      `INSERT INTO orders_cart (id, created_at, updated_at, customer_id, token, branch_id, coupon_id, is_active, last_activity_at)
       VALUES (gen_random_uuid(), now(), now(), NULL, $1, $2, $3, true, now()) RETURNING id`,
      [token, branch, couponId ?? null],
    );
    await db.query(
      `INSERT INTO orders_cartitem (id, created_at, updated_at, cart_id, variant_id, quantity)
       VALUES (gen_random_uuid(), now(), now(), $1, $2, $3)`,
      [cart.rows[0]?.id, variant, quantity],
    );
    tokens.push(token);
  }
  return tokens;
}

/** A COD checkout of one cart; `phone` is the shopper's -- a different one per shopper. */
function checkout(
  base: URL,
  token: string,
  key: string,
  phone: string,
): Promise<{ status: number; body: string }> {
  return send(base, {
    name: 'race',
    method: 'POST',
    path: '/api/v1/shop/checkout/',
    headers: { 'content-type': 'application/json', 'x-cart-token': token, 'idempotency-key': key },
    body: JSON.stringify({
      shipping_address: { recipient_name: 'Race', phone, line1: 'L', city: 'Dhaka' },
      payment_method: 'COD',
      contact_phone: phone,
    }),
  });
}

/** A distinct mobile per shopper. */
const shopper = (index: number) => `0171100${6100 + index}`;

async function count(db: pg.Client, sql: string, values: unknown[] = []): Promise<number> {
  return Number((await db.query<{ count: string }>(sql, values)).rows[0]?.count ?? -1);
}

/**
 * The three races CLAUDE.md section 9 names for checkout, each across both
 * APIs at once: the last units, a double-clicked "Place order", a coupon's
 * last use. Each starts from, and returns to, the fixtures' state.
 */
async function checkoutRaces(
  db: pg.Client,
  apis: { DJANGO: URL; NEST: URL; SIGNING_KEY: string },
): Promise<Check[]> {
  const checks: Check[] = [];
  const side = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);

  // 1. Oversell: seven units left, ten shoppers wanting three each.
  await resetCheckout(db);
  await db.query(
    `UPDATE inventory_inventory SET reserved = on_hand - 7
      WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI')`,
  );
  const shelf = await raceCarts(db, 'parity-race-shelf', 10, 'RGN-CLA-L-WHI', 3);
  const shelfResults = await Promise.all(
    shelf.map((token, index) =>
      checkout(side(index), token, `race-shelf-${index}`, shopper(index)),
    ),
  );
  const left = await count(
    db,
    `SELECT on_hand - reserved AS count FROM inventory_inventory
      WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI')`,
  );
  const reservations = await count(
    db,
    `SELECT count(*) AS count FROM inventory_inventorytransaction t JOIN orders_order o ON o.id::text = t.reference_id
      WHERE o.idempotency_key LIKE 'race-shelf-%' AND t.transaction_type = 'RESERVATION'`,
  );
  const sold = shelfResults.filter((result) => result.status === 201).length;
  const refused = shelfResults.filter(
    (result) => result.status === 409 && result.body.includes('INSUFFICIENT_STOCK'),
  ).length;
  checks.push({
    name: 'checkout: 10 shoppers for the last 7 units, 3 each, across both APIs -- 2 sell, none oversold',
    passed: sold === 2 && refused === 8 && reservations === 2 && left === 1,
    detail: `${sold} sold, ${refused} refused, ${reservations} reservations, ${left} left`,
  });
  await resetCheckout(db);

  // 2. A double click: six submits of one cart with one Idempotency-Key. A
  //    returning shopper (the customer exists) gets the one order six times.
  //    A first-time guest's clicks race to create the same customer, and the
  //    losers are 409 CONFLICT in both APIs -- a Django defect copied (D114)
  //    -- but there is still exactly one order, reserved once.
  for (const [label, phone] of [
    ['a returning shopper', '01711000001'],
    ['a first-time guest', shopper(99)],
  ] as const) {
    const [dup] = await raceCarts(db, `parity-race-click-${phone}`, 1, 'RGN-CLA-L-NAV', 1);
    const key = `race-click-${phone}`;
    const clicks = await Promise.all(
      Array.from({ length: 6 }, (_, index) => checkout(side(index), dup as string, key, phone)),
    );
    const numbers = new Set(
      clicks
        .filter((result) => result.status === 201)
        .map((result) => (JSON.parse(result.body) as { order: { number: string } }).order.number),
    );
    const orders = await count(
      db,
      `SELECT count(*) AS count FROM orders_order WHERE idempotency_key = $1`,
      [key],
    );
    const held = await count(
      db,
      `SELECT count(*) AS count FROM inventory_inventorytransaction t JOIN orders_order o ON o.id::text = t.reference_id
        WHERE o.idempotency_key = $1`,
      [key],
    );
    const answered =
      label === 'a returning shopper'
        ? clicks.every((result) => result.status === 201)
        : clicks.every(
            (result) =>
              result.status === 201 ||
              (result.status === 409 && result.body.includes('"CONFLICT"')),
          );
    checks.push({
      name: `checkout: 6 simultaneous clicks, one key, ${label}, across both APIs -- one order, reserved once`,
      passed: answered && numbers.size === 1 && orders === 1 && held === 1,
      detail: `statuses ${clicks.map((result) => result.status).join(',')}, ${numbers.size} number(s), ${orders} order(s), ${held} reservation(s)`,
    });
    await resetCheckout(db);
  }

  // 2b. The storefront and the counter sell the same shelf (CLAUDE.md section
  //     1): five online checkouts through this API, five counter sales
  //     through Django's, all at once. Online checkouts queue on the
  //     order-number lock among themselves; against the counter -- another
  //     number sequence -- only the inventory row lock stops a lost update.
  //     Checked: the cached row still equals the ledger, and every online
  //     reservation fitted what was available when it was made. (Whether the
  //     counter may sell stock held for online orders is Django's rule, not
  //     this API's: today it may, which D115 records as a defect.)
  const cashier = (
    await db.query<{ id: string; password: string }>(
      `SELECT id, password FROM accounts_user WHERE email = 'parity.staff@rangon.test'`,
    )
  ).rows[0];
  if (cashier) {
    await db.query(
      `UPDATE inventory_inventory SET reserved = on_hand - 7
        WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI')`,
    );
    const before = (
      await db.query<{ on_hand: number; reserved: number }>(
        `SELECT on_hand, reserved FROM inventory_inventory
          WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI')`,
      )
    ).rows[0] as { on_hand: number; reserved: number };
    const white = (
      await db.query<{ id: string }>(
        `SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI'`,
      )
    ).rows[0]?.id;
    const online = await raceCarts(db, 'parity-race-counter', 5, 'RGN-CLA-L-WHI', 3);
    const cashierToken = bearer(cashier, apis.SIGNING_KEY);
    const results = await Promise.all([
      ...online.map((token, index) =>
        checkout(apis.NEST, token, `race-counter-web-${index}`, shopper(40 + index)).then(
          (result) => ({
            ...result,
            channel: 'online',
          }),
        ),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        send(apis.DJANGO, {
          name: 'counter sale',
          method: 'POST',
          path: '/api/v1/pos/sales/',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cashierToken}`,
            'idempotency-key': `race-counter-pos-${index}`,
          },
          body: JSON.stringify({
            lines: [{ variant: white, quantity: 3 }],
            payments: [{ method: 'CASH', amount: '7350.00' }],
          }),
        }).then((result) => ({ ...result, channel: 'counter' })),
      ),
    ]);
    const after = (
      await db.query<{ on_hand: number; reserved: number }>(
        `SELECT on_hand, reserved FROM inventory_inventory
          WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI')`,
      )
    ).rows[0] as { on_hand: number; reserved: number };
    // The cached row must equal what the ledger says happened to it.
    const moved = (
      await db.query<{ type: string; total: string }>(
        `SELECT transaction_type AS type, sum(quantity) AS total FROM inventory_inventorytransaction
          WHERE variant_id = $1 AND id NOT IN (SELECT id FROM parity_ledger)
          GROUP BY transaction_type`,
        [white],
      )
    ).rows;
    const sum = (type: string) => Number(moved.find((row) => row.type === type)?.total ?? 0);
    const consistent =
      after.on_hand === before.on_hand + sum('SALE') &&
      after.reserved === before.reserved + sum('RESERVATION');
    // Each reservation this API wrote, as the row stood when it was written.
    const overheld = await count(
      db,
      `SELECT count(*) AS count FROM inventory_inventorytransaction t JOIN orders_order o ON o.id::text = t.reference_id
        WHERE o.idempotency_key LIKE 'race-counter-web-%' AND t.transaction_type = 'RESERVATION'
          AND t.reserved_after > t.on_hand_after`,
    );
    const web = results.filter((result) => result.channel === 'online');
    checks.push({
      name: 'stock: 5 online checkouts (Nest) racing 5 counter sales (Django) -- no lost update, no online oversell',
      passed:
        consistent &&
        overheld === 0 &&
        web.every(
          (result) =>
            result.status === 201 ||
            (result.status === 409 && result.body.includes('INSUFFICIENT_STOCK')),
        ),
      detail: `online ${web.map((result) => result.status).join(',')}, counter ${results
        .filter((result) => result.channel === 'counter')
        .map((result) => result.status)
        .join(
          ',',
        )}, row ${consistent ? 'matches' : 'DRIFTS FROM'} the ledger, ${overheld} online over-reservation(s)`,
    });
    await resetCheckout(db);
  }

  // 2c. The same, made certain rather than likely. The harness takes the
  //     stock row's lock, lets one online checkout reach it, sells three units
  //     as Django's `sell` does (the row and its ledger entry) and commits.
  //     With its lock the checkout waited, then read the new row; without it,
  //     it read the old row first and its write would put the sold units back
  //     -- a lost update the ledger no longer agrees with.
  {
    const whiteId = (
      await db.query<{ id: string }>(
        `SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-WHI'`,
      )
    ).rows[0]?.id as string;
    const [cart] = await raceCarts(db, 'parity-race-held', 1, 'RGN-CLA-L-WHI', 3);
    const counter = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await counter.connect();
    await counter.query('BEGIN');
    const row = (
      await counter.query<{ id: string; branch_id: string; on_hand: number; reserved: number }>(
        `SELECT id, branch_id, on_hand, reserved FROM inventory_inventory
          WHERE variant_id = $1 AND branch_id = (SELECT id FROM accounts_branch WHERE is_default LIMIT 1)
          FOR UPDATE`,
        [whiteId],
      )
    ).rows[0] as { id: string; branch_id: string; on_hand: number; reserved: number };
    const pending = checkout(apis.NEST, cart as string, 'race-held', shopper(60));
    let waiting = 0;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      waiting = await count(
        db,
        `SELECT count(*) AS count FROM pg_stat_activity
          WHERE application_name = 'rangon-api-nest' AND wait_event_type = 'Lock'`,
      );
    }
    await counter.query(
      `UPDATE inventory_inventory SET on_hand = on_hand - 3, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await counter.query(
      `INSERT INTO inventory_inventorytransaction
         (id, created_at, updated_at, branch_id, variant_id, transaction_type, quantity, unit_cost, on_hand_after,
          reserved_after, reference_type, reference_id, reason, notes, created_by_id, idempotency_key)
       VALUES (gen_random_uuid(), now(), now(), $1, $2, 'SALE', -3, NULL, $3, $4, 'order', 'parity-counter', '', '',
               NULL, NULL)`,
      [row.branch_id, whiteId, row.on_hand - 3, row.reserved],
    );
    await counter.query('COMMIT');
    await counter.end();
    const result = await pending;
    const after = (
      await db.query<{ on_hand: number; reserved: number }>(
        `SELECT on_hand, reserved FROM inventory_inventory WHERE id = $1`,
        [row.id],
      )
    ).rows[0] as { on_hand: number; reserved: number };
    const expected = {
      on_hand: row.on_hand - 3,
      reserved: row.reserved + (result.status === 201 ? 3 : 0),
    };
    checks.push({
      name: 'stock: an online checkout (Nest) that meets a counter sale mid-flight keeps the sale -- the row lock holds',
      passed:
        waiting > 0 &&
        result.status === 201 &&
        after.on_hand === expected.on_hand &&
        after.reserved === expected.reserved,
      detail: `checkout ${result.status}, ${waiting ? 'waited on the lock' : 'NEVER reached the lock'}, on hand ${after.on_hand} (ledger says ${expected.on_hand}), reserved ${after.reserved} (ledger says ${expected.reserved})`,
    });
    await resetCheckout(db);
  }

  // 3. A coupon's last use: six checkouts, a coupon good for one.
  const coupon = (
    await db.query<{ id: string }>(
      `INSERT INTO promotions_coupon (id, created_at, updated_at, code, description, discount_type, value,
         minimum_order_value, maximum_discount, starts_at, ends_at, usage_limit, usage_limit_per_customer,
         used_count, channels, is_active, created_by_id)
       VALUES (gen_random_uuid(), now(), now(), 'PARITY-RACE', '', 'FIXED', 100, 0, NULL, NULL, NULL, 1, NULL, 0,
               '[]'::jsonb, true, NULL) RETURNING id`,
    )
  ).rows[0]?.id as string;
  const couponCarts = await raceCarts(db, 'parity-race-coupon', 6, 'RGN-CLA-L-NAV', 1, coupon);
  const couponResults = await Promise.all(
    couponCarts.map((token, index) =>
      checkout(side(index), token, `race-coupon-${index}`, shopper(20 + index)),
    ),
  );
  const used = await count(db, `SELECT used_count AS count FROM promotions_coupon WHERE id = $1`, [
    coupon,
  ]);
  const redemptions = await count(
    db,
    `SELECT count(*) AS count FROM promotions_couponredemption WHERE coupon_id = $1`,
    [coupon],
  );
  const discounted = await count(
    db,
    `SELECT count(*) AS count FROM orders_order WHERE coupon_id = $1`,
    [coupon],
  );
  checks.push({
    name: 'checkout: 6 checkouts for a coupon good once, across both APIs -- redeemed once',
    passed:
      used === 1 &&
      redemptions === 1 &&
      discounted === 1 &&
      couponResults.every(
        (result) =>
          result.status === 201 ||
          (result.status === 422 && result.body.includes('COUPON_INVALID')),
      ),
    detail: `statuses ${couponResults.map((result) => result.status).join(',')}, used ${used}, ${redemptions} redemption(s), ${discounted} discounted order(s)`,
  });
  await resetCheckout(db);
  await db.query(`DELETE FROM promotions_coupon WHERE id = $1`, [coupon]);
  return checks;
}
