/**
 * Parity cases for a payment provider's webhook, `shop/payments/<provider>/webhook/`.
 *
 * The one provider either API ships, `manual`, takes no webhooks, so the
 * capture path is reached through `paritypay`, the stand-in gateway both APIs
 * install in the parity stack only (gateway/, gateway.ts). Each case starts
 * both APIs from the fixture's payments (fixture_payments.py) and compares
 * every row each writes: the event, the payment, the order's payment status,
 * the cash book and the balances, the timeline and the audit log -- and that
 * neither queued a job.
 */
import pg from 'pg';

import { type Case } from './run.ts';

// A row is the request's when its id is not in the snapshot `resetPayments` took.
// Payloads as jsonb's own text: read into JavaScript, 3.0 would be 3 and a 20-digit int would round.
const EVENTS = `SELECT e.provider, e.provider_event_id, e.event_type, e.payload::text AS payload, e.processed, e.result,
    o.number AS order_number, p.method AS payment_method, p.amount AS payment_amount
  FROM orders_paymentevent e LEFT JOIN orders_order o ON o.id = e.order_id
  LEFT JOIN orders_payment p ON p.id = e.payment_id
  WHERE e.id NOT IN (SELECT id FROM parity_pay_events) ORDER BY e.provider_event_id`;
const PAYMENTS = `SELECT o.number, p.method, p.status, p.amount, p.provider, p.provider_reference, p.payload::text AS payload,
    p.captured_at IS NOT NULL AS captured, p.failed_at IS NOT NULL AS failed, a.name AS account,
    p.updated_at >= p.captured_at AS stamped_after_capture, p.updated_at >= p.failed_at AS stamped_after_failure
  FROM orders_payment p JOIN parity_pay_payments s ON s.id = p.id
  JOIN orders_order o ON o.id = p.order_id LEFT JOIN finance_account a ON a.id = p.account_id
  WHERE p.updated_at <> s.updated_at ORDER BY o.number, p.created_at`;
const ORDERS = `SELECT o.number, o.payment_status, o.paid_total, o.refunded_total
  FROM orders_order o JOIN parity_pay_orders s ON s.id = o.id
  WHERE o.updated_at <> s.updated_at ORDER BY o.number`;
const POSTINGS = `SELECT a.name AS account, t.transaction_type, t.amount, t.balance_after, t.reference_type,
    o.number AS order_number, p.method AS payment_method, t.reason, t.notes,
    t.occurred_at = p.captured_at AS at_capture, t.created_by_id, t.idempotency_key
  FROM finance_accounttransaction t JOIN finance_account a ON a.id = t.account_id
  LEFT JOIN orders_payment p ON p.id::text = t.reference_id LEFT JOIN orders_order o ON o.id = p.order_id
  WHERE t.id NOT IN (SELECT id FROM parity_pay_postings) ORDER BY a.name`;
const ACCOUNTS = `SELECT a.name, a.balance, a.is_active
  FROM finance_account a JOIN parity_pay_accounts s ON s.id = a.id
  WHERE a.updated_at <> s.updated_at ORDER BY a.name`;
const TIMELINE = `SELECT o.number, e.event_type, e.message, e.data - 'payment_id' AS data,
    (SELECT p.method || ' ' || p.amount FROM orders_payment p WHERE p.id::text = e.data->>'payment_id') AS payment,
    e.is_customer_visible, e.actor_id
  FROM orders_orderevent e JOIN orders_order o ON o.id = e.order_id
  WHERE e.id NOT IN (SELECT id FROM parity_pay_order_events) ORDER BY e.created_at`;
const AUDIT = `SELECT a.action, a.entity_type, a.entity_label, a.actor_id, a.actor_label, a.old_values,
    a.new_values, a.reason, a.user_agent, a.request_id, b.code AS branch,
    (SELECT o.number FROM orders_payment p JOIN orders_order o ON o.id = p.order_id
      WHERE p.id::text = a.entity_id) AS payment_of
  FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
  WHERE a.created_at >= $1 ORDER BY a.created_at`;

/**
 * Everything a webhook writes, put back. Copied once, on the harness's
 * connection, at the first webhook case; rows are told apart by id.
 */
export async function resetPayments(client: pg.Client): Promise<void> {
  const snapshot = [
    `CREATE TEMP TABLE IF NOT EXISTS parity_pay_events AS SELECT id FROM orders_paymentevent`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_pay_payments AS SELECT * FROM orders_payment`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_pay_orders AS
       SELECT id, payment_status, paid_total, refunded_total, updated_at FROM orders_order`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_pay_postings AS SELECT id FROM finance_accounttransaction`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_pay_accounts AS SELECT * FROM finance_account`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_pay_order_events AS SELECT id FROM orders_orderevent`,
  ];
  for (const statement of snapshot) await client.query(statement);
  const statements = [
    `DELETE FROM orders_paymentevent WHERE id NOT IN (SELECT id FROM parity_pay_events)`,
    `DELETE FROM finance_accounttransaction WHERE id NOT IN (SELECT id FROM parity_pay_postings)`,
    `DELETE FROM orders_orderevent WHERE id NOT IN (SELECT id FROM parity_pay_order_events)`,
    `UPDATE orders_payment p SET status = s.status, captured_at = s.captured_at, failed_at = s.failed_at,
            authorized_at = s.authorized_at, provider_reference = s.provider_reference, payload = s.payload,
            account_id = s.account_id, updated_at = s.updated_at
       FROM parity_pay_payments s WHERE s.id = p.id AND p.updated_at <> s.updated_at`,
    `UPDATE orders_order o SET payment_status = s.payment_status, paid_total = s.paid_total,
            refunded_total = s.refunded_total, updated_at = s.updated_at
       FROM parity_pay_orders s WHERE s.id = o.id AND o.updated_at <> s.updated_at`,
    `UPDATE finance_account a SET balance = s.balance, is_active = s.is_active, is_default = s.is_default,
            updated_at = s.updated_at
       FROM parity_pay_accounts s WHERE s.id = a.id AND a.updated_at <> s.updated_at`,
  ];
  for (const statement of statements) await client.query(statement);
}

export async function paymentCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const fixture = await db.query(`SELECT 1 FROM orders_order WHERE number = 'RGN-PARITY-P01'`);
  if (!fixture.rowCount) {
    await db.end();
    console.log('SKIP  webhook: fixture_payments.py has not been applied');
    return [];
  }
  // Kept open: a case's `prepare` changes rows after the reset, before its request.
  const after = (statement: string) => async () => {
    await db.query(statement);
    return {};
  };

  const effects = [EVENTS, PAYMENTS, ORDERS, POSTINGS, ACCOUNTS, TIMELINE, AUDIT];
  const cases: Case[] = [];
  let sequence = 0;
  const hook = (name: string, provider: string, event: unknown, extra: Partial<Case> = {}) => {
    sequence += 1;
    cases.push({
      name: `webhook: ${name}`,
      method: 'POST',
      path: `/api/v1/shop/payments/${provider}/webhook/`,
      body: typeof event === 'string' ? event : JSON.stringify(event),
      reset: resetPayments,
      effects,
      jobs: true,
      ...extra,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'rangon-parity',
        'x-request-id': `parity-webhook-${sequence}`,
        ...extra.headers,
      },
    });
  };
  // A number exactly as written: JavaScript would send 3.0 as 3, and cannot hold 20 digits.
  const raw = (text: string) =>
    (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(text);
  const capture = (order: string, extra: Record<string, unknown> = {}) => ({
    event_id: `evt-${order.toLowerCase()}`,
    event_type: 'payment.captured',
    order_number: `RGN-PARITY-${order}`,
    ...extra,
  });

  // --- Which provider -------------------------------------------------------------------
  hook('an unknown provider', 'stripe', capture('P01'));
  hook('the manual provider takes none', 'manual', capture('P03'));
  hook('an unknown name with a space and a non-ASCII letter', 'pay%20%C3%BC', capture('P01'));
  hook('an encoded slash is no provider name', 'pay%2Fpal', capture('P01'));
  hook('no authentication: a bad bearer token is not read', 'manual', capture('P03'), {
    headers: { authorization: 'Bearer not-a-token' },
  });
  hook('the body is never parsed by the view: a form body', 'manual', 'a=1&b=2', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  hook('the body is never parsed by the view: malformed JSON', 'manual', '{"event_id":');
  hook('GET', 'manual', '', { method: 'GET' });
  hook('PUT', 'paritypay', capture('P01'), { method: 'PUT' });

  // --- Capture ----------------------------------------------------------------------------
  hook('captured, the amount as a string', 'paritypay', capture('P01', { amount: '1000.00' }));
  hook('captured, no amount given', 'paritypay', capture('P01'));
  hook('captured, the amount an int', 'paritypay', capture('P01', { amount: 1000 }));
  hook(
    'captured, the amount right to the cent',
    'paritypay',
    capture('P01', { amount: '1000.004' }),
  );
  hook('refused, a half cent rounds up', 'paritypay', capture('P01', { amount: '1000.005' }));
  hook('refused, a different amount (D100)', 'paritypay', capture('P01', { amount: '999.99' }));
  hook(
    'captured, "payment.success"',
    'paritypay',
    capture('P01', { event_type: 'payment.success' }),
  );
  hook('captured, an authorised wallet payment', 'paritypay', capture('P02'));
  hook('captured, the older of two waiting', 'paritypay', capture('P05'));
  hook('captured, store credit: no account holds it', 'paritypay', capture('P07'));
  hook(
    'captured, the payload merged into the payment',
    'paritypay',
    capture('P01', {
      session: 'overridden',
      customer: { name: 'রঙন', tags: ['a', 1, 2.5, null, true] },
      fee: 12.5,
      whole: raw('3.0'),
      big: raw('12345678901234567890'),
    }),
  );
  hook(
    'captured, the default bank closed: the next open one by name',
    'paritypay',
    capture('P01'),
    {
      prepare: after(`UPDATE finance_account SET is_active = false, updated_at = now()
      WHERE name = 'City Bank Current'`),
    },
  );
  hook('captured, every bank closed: nothing posted', 'paritypay', capture('P01'), {
    prepare: after(`UPDATE finance_account SET is_active = false, updated_at = now()
      WHERE name IN ('City Bank Current', 'Agrani Parity Savings')`),
  });

  // --- Failed, ignored, refused -----------------------------------------------------------------
  hook('failed', 'paritypay', capture('P01', { event_type: 'payment.failed' }));
  hook('cancelled', 'paritypay', capture('P01', { event_type: 'payment.cancelled' }));
  hook(
    'ignored, an event it does not act on',
    'paritypay',
    capture('P01', { event_type: 'payment.refunded' }),
  );
  hook('ignored, an event type that is a number', 'paritypay', capture('P01', { event_type: 5 }));
  hook('an event id that is a number', 'paritypay', capture('P01', { event_id: 77 }));
  hook("ignored, cash on delivery is not the gateway's (D100)", 'paritypay', capture('P03'));
  hook('ignored, nothing left to take', 'paritypay', capture('P06'));
  hook('ignored, an unknown order', 'paritypay', capture('P99'));
  hook('ignored, no order number', 'paritypay', {
    event_id: 'evt-none',
    event_type: 'payment.captured',
  });
  hook('refused, a named account of the wrong kind', 'paritypay', capture('P04'));
  hook('refused, a named account that is closed', 'paritypay', capture('P08'));
  hook("refused, another branch's account", 'paritypay', capture('P09'));
  hook('a body the gateway cannot read', 'paritypay', '{"event_id":');

  // --- Replays ----------------------------------------------------------------------------------
  const seen = (id: string, result: string) =>
    after(`INSERT INTO orders_paymentevent
             (id, created_at, updated_at, payment_id, order_id, provider, provider_event_id, event_type,
              payload, processed, result)
           VALUES (gen_random_uuid(), now(), now(), NULL,
                   (SELECT id FROM orders_order WHERE number = 'RGN-PARITY-P01'), 'paritypay', '${id}',
                   'payment.captured', '{}', true, '${result}')`);
  hook(
    'a replay answers the stored result and does nothing',
    'paritypay',
    capture('P01', { event_id: 'evt-seen' }),
    {
      prepare: seen('evt-seen', 'captured'),
    },
  );
  hook(
    'a replay of an ignored event stays ignored',
    'paritypay',
    capture('P01', { event_id: 'evt-was-ignored' }),
    {
      prepare: seen('evt-was-ignored', 'ignored'),
    },
  );
  hook('the same event id from another provider is not a replay', 'paritypay', capture('P01'), {
    prepare: after(`INSERT INTO orders_paymentevent
             (id, created_at, updated_at, payment_id, order_id, provider, provider_event_id, event_type,
              payload, processed, result)
           VALUES (gen_random_uuid(), now(), now(), NULL, NULL, 'othergateway', 'evt-p01',
                   'payment.captured', '{}', true, 'ignored')`),
  });

  return cases;
}
