/**
 * Race checks for shipping (phase 6 part 8), run by run.ts after the
 * comparison cases. Each puts the parcels, the orders and the settings back.
 *
 * A parcel is booked under its order's row lock, and a tracking update is
 * decided under the order's lock and then the parcel's: the order's status
 * is what a booking and a parcel's leaving are decided on, and the parcel's
 * is what closes its history. A parcel's own edit takes no lock at all.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { behind, type Check, message, statuses } from './races.ts';
import { send } from './run.ts';
import { resetShipping } from './shipping-cases.ts';

export async function shippingConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const order = async (number: string) =>
      (await one<{ id: string }>(`SELECT id FROM orders_order WHERE number = $1`, [number]))?.id;
    const parcelOf = async (tracking: string) =>
      (
        await one<{ id: string }>(`SELECT id FROM shipping_shipment WHERE tracking_number = $1`, [
          tracking,
        ])
      )?.id;
    const ids = {
      processing: await order('RGN-PARITY-H07'),
      confirmed: await order('RGN-PARITY-H01'),
      packed: await order('RGN-PARITY-H02'),
      shipped: await order('RGN-PARITY-H03'),
      packedParcel: await parcelOf('PAR-H02'),
      dispatchedParcel: await parcelOf('PAR-H03'),
      secondParcel: (
        await one<{ id: string }>(
          `SELECT s.id FROM shipping_shipment s JOIN orders_order o ON o.id = s.order_id
            WHERE o.number = 'RGN-PARITY-H03' AND s.tracking_number = ''`,
        )
      )?.id,
      pathao: (await one<{ id: string }>(`SELECT id FROM shipping_courier WHERE code = 'pathao'`))
        ?.id,
      zone: (
        await one<{ id: string }>(`SELECT id FROM shipping_shippingzone WHERE name = 'Parity Zone'`)
      )?.id,
    };
    if (!ids.processing || !ids.packedParcel || !ids.secondParcel) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetShipping(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const request = (api: URL, method: string, path: string, body: unknown) =>
      send(api, {
        name: 'shipping',
        method,
        path,
        headers: { ...auth('owner'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const book = (api: URL, body: Record<string, unknown>) =>
      request(api, 'POST', '/api/v1/shipments/', body);
    const tell = (api: URL, parcel: string | undefined, body: Record<string, unknown>) =>
      request(api, 'POST', `/api/v1/shipments/${parcel}/events/`, body);
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);
    const SIDES = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;
    /** What an order has come to, and what was written for it since the restore. */
    const state = async (orderId: string | undefined) =>
      (await one<Record<string, string>>(
        `SELECT o.status,
                (SELECT count(*)::text FROM shipping_shipment s
                  WHERE s.id NOT IN (SELECT id FROM "snap_shipping_shipment")) AS booked,
                (SELECT count(*)::text FROM shipping_shipmentevent e
                  WHERE e.id NOT IN (SELECT id FROM "snap_shipping_shipmentevent")) AS updates,
                (SELECT count(*)::text FROM orders_orderevent e
                  WHERE e.order_id = o.id AND e.event_type = 'STATUS_CHANGED'
                    AND e.id NOT IN (SELECT id FROM "snap_orders_orderevent")) AS moves,
                (SELECT count(*)::text FROM orders_orderevent e
                  WHERE e.order_id = o.id AND e.event_type IN ('SHIPMENT_CREATED', 'SHIPMENT_EVENT')
                    AND e.id NOT IN (SELECT id FROM "snap_orders_orderevent")) AS entries,
                (SELECT count(*)::text FROM notifications_notification n
                  WHERE n.notification_type IN ('ORDER_SHIPPED', 'ORDER_DELIVERED')
                    AND n.id NOT IN (SELECT id FROM "snap_notifications_notification")) AS notices
           FROM orders_order o WHERE o.id = $1`,
        [orderId],
      )) as Record<string, string>;
    const parcel = async (id: string | undefined) =>
      (await one<{ status: string; dispatched: boolean; delivered: boolean; stamps: string }>(
        `SELECT s.status, s.dispatched_at IS NOT NULL AS dispatched,
                s.delivered_at IS NOT NULL AS delivered,
                (SELECT count(DISTINCT e.created_at)::text FROM shipping_shipmentevent e
                  WHERE e.shipment_id = s.id
                    AND e.id NOT IN (SELECT id FROM "snap_shipping_shipmentevent")) AS stamps
           FROM shipping_shipment s WHERE s.id = $1`,
        [id],
      )) as { status: string; dispatched: boolean; delivered: boolean; stamps: string };

    // 1. One tracking number booked six times for one order.
    await restore();
    const sameOrder = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        book(either(index), {
          order: ids.processing,
          courier: ids.pathao,
          tracking_number: 'PX-RACE',
        }),
      ),
    );
    let end = await state(ids.processing);
    checks.push({
      name: 'shipping: 6 bookings of one tracking number for one order at once, across both APIs -- one parcel, five told the courier already has it',
      passed:
        statuses(sameOrder).join() === '201,409,409,409,409,409' &&
        end.booked === '1' &&
        end.entries === '1' &&
        sameOrder
          .filter((response) => response.status === 409)
          .every((response) => message(response.body).includes('already has a parcel')),
      detail: `statuses ${statuses(sameOrder).join(',')}, ${end.booked} parcel, ${end.entries} timeline entry`,
    });

    // 2. The same number for two orders: nothing but the unique index is between them.
    await restore();
    const twoOrders = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        book(either(index), {
          order: index < 3 ? ids.processing : ids.packed,
          courier: ids.pathao,
          tracking_number: 'PX-RACE',
        }),
      ),
    );
    end = await state(ids.processing);
    const entries = await one<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders_orderevent e
        WHERE e.event_type = 'SHIPMENT_CREATED'
          AND e.id NOT IN (SELECT id FROM "snap_orders_orderevent")`,
    );
    checks.push({
      name: 'shipping: 6 bookings of one tracking number across two orders at once, across both APIs -- one parcel, one timeline entry, five conflicts and no 500',
      passed:
        statuses(twoOrders).join() === '201,409,409,409,409,409' &&
        end.booked === '1' &&
        entries?.count === '1' &&
        twoOrders
          .filter((response) => response.status === 409)
          .every((response) => message(response.body).includes('already has a parcel')),
      detail: `statuses ${statuses(twoOrders).join(',')}, ${end.booked} parcel, ${entries?.count} timeline entries`,
    });

    // 3. An order cancelled while a booking waits on its row.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM orders_order WHERE id = $1 FOR UPDATE`, [ids.processing]],
        '%orders_order%',
        [() => book(api, { order: ids.processing, courier: ids.pathao, tracking_number: 'PX-R3' })],
        async (holder) => {
          await holder.query(`UPDATE orders_order SET status = 'CANCELLED' WHERE id = $1`, [
            ids.processing,
          ]);
        },
      );
      end = await state(ids.processing);
      const answer = held.responses[0];
      checks.push({
        name: `shipping: an order cancelled while a booking for it (${side}) waits on its row gets no parcel -- the order's lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 409 &&
          message(answer.body) === 'A cancelled order cannot be shipped.' &&
          end.booked === '0' &&
          end.entries === '0',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, ${end.booked} parcels`,
      });
    }

    // 4. An order unpacked while its parcel's first movement waits on the order's row.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM orders_order WHERE id = $1 FOR UPDATE`, [ids.packed]],
        '%orders_order%',
        [() => tell(api, ids.packedParcel, { status: 'DISPATCHED' })],
        async (holder) => {
          await holder.query(`UPDATE orders_order SET status = 'RETURN_REQUESTED' WHERE id = $1`, [
            ids.packed,
          ]);
        },
      );
      end = await state(ids.packed);
      const answer = held.responses[0];
      const now = await parcel(ids.packedParcel);
      checks.push({
        name: `shipping: an order taken off the packing bench while its parcel's DISPATCHED (${side}) waits on the order's row -- the parcel does not leave; the order's lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 409 &&
          message(answer.body).startsWith('Pack RGN-PARITY-H02 before its parcel leaves') &&
          end.updates === '0' &&
          now.status === 'PENDING' &&
          end.status === 'RETURN_REQUESTED',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the lock' : 'never waited'}, ${end.updates} updates, parcel ${now.status}`,
      });
    }

    // 5. A parcel delivered while another update for it waits on the parcel's row.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM shipping_shipment WHERE id = $1 FOR UPDATE`, [ids.dispatchedParcel]],
        '%shipping_shipment%',
        [() => tell(api, ids.dispatchedParcel, { status: 'FAILED', message: 'Nobody home' })],
        async (holder) => {
          await holder.query(
            `UPDATE shipping_shipment SET status = 'DELIVERED', delivered_at = clock_timestamp()
              WHERE id = $1`,
            [ids.dispatchedParcel],
          );
        },
      );
      end = await state(ids.shipped);
      const answer = held.responses[0];
      const now = await parcel(ids.dispatchedParcel);
      checks.push({
        name: `shipping: a parcel delivered while a FAILED for it (${side}) waits on the parcel's row -- its history is closed; the parcel's lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 409 &&
          message(answer.body).startsWith('This parcel is already delivered') &&
          end.updates === '0' &&
          end.entries === '0' &&
          now.status === 'DELIVERED',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, ${end.updates} updates, parcel ${now.status}`,
      });
    }

    // 6. Six DELIVERED for one parcel at once.
    await restore();
    const delivered = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        tell(either(index), ids.dispatchedParcel, { status: 'DELIVERED' }),
      ),
    );
    end = await state(ids.shipped);
    let now = await parcel(ids.dispatchedParcel);
    checks.push({
      name: 'shipping: 6 DELIVERED for one parcel at once, across both APIs -- one is recorded and five find the parcel delivered; the order delivered once, its customer told once',
      passed:
        statuses(delivered).join() === '201,409,409,409,409,409' &&
        end.updates === '1' &&
        end.entries === '1' &&
        end.status === 'DELIVERED' &&
        end.moves === '1' &&
        end.notices === '1' &&
        now.status === 'DELIVERED' &&
        now.delivered,
      detail: `statuses ${statuses(delivered).join(',')}, ${end.updates} update, order ${end.status} in ${end.moves} move, ${end.notices} notice`,
    });

    // 7. Six DISPATCHED for a packed order's parcel at once: nothing closes a parcel
    // to a second DISPATCHED, so all six are history (copied); the order ships once.
    await restore();
    const dispatched = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        tell(either(index), ids.packedParcel, { status: 'DISPATCHED' }),
      ),
    );
    end = await state(ids.packed);
    now = await parcel(ids.packedParcel);
    checks.push({
      name: "shipping: 6 DISPATCHED for a packed order's parcel at once, across both APIs -- six updates recorded (copied: nothing refuses a repeat), the order shipped once, its customer told once",
      passed:
        statuses(dispatched).join() === '201,201,201,201,201,201' &&
        end.updates === '6' &&
        end.entries === '6' &&
        end.status === 'SHIPPED' &&
        end.moves === '1' &&
        end.notices === '1' &&
        now.status === 'DISPATCHED' &&
        now.dispatched,
      detail: `statuses ${statuses(dispatched).join(',')}, ${end.updates} updates, order ${end.status} in ${end.moves} move, ${end.notices} notice`,
    });

    // 8. Both parcels of a split delivery handed over at once, and the order moved by hand.
    await restore();
    const split = await Promise.all([
      tell(apis.DJANGO, ids.dispatchedParcel, { status: 'DELIVERED' }),
      tell(apis.NEST, ids.secondParcel, { status: 'DELIVERED' }),
      tell(apis.NEST, ids.dispatchedParcel, { status: 'IN_TRANSIT' }),
      tell(apis.DJANGO, ids.secondParcel, { status: 'DISPATCHED' }),
      request(apis.DJANGO, 'POST', `/api/v1/orders/${ids.shipped}/status/`, {
        to_status: 'DELIVERED',
      }),
      request(apis.NEST, 'POST', `/api/v1/orders/${ids.shipped}/status/`, {
        to_status: 'DELIVERED',
      }),
    ]);
    end = await state(ids.shipped);
    checks.push({
      name: 'shipping: both parcels of a split delivery updated at once while the order is marked delivered by hand, across both APIs -- no deadlock, no 500; the order delivered once, its customer told once',
      passed:
        split.every((response) => response.status < 500) &&
        split.slice(4).every((response) => response.status === 200) &&
        end.status === 'DELIVERED' &&
        end.moves === '1' &&
        end.notices === '1',
      detail: `statuses ${split.map((response) => response.status).join(',')}, order ${end.status} in ${end.moves} move, ${end.notices} notice, ${end.updates} updates`,
    });

    // 9. A parcel's edit takes no lock: delivered while the edit's write waits, the
    // parcel is written back as the edit read it (copied).
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM shipping_shipment WHERE id = $1 FOR UPDATE`, [ids.dispatchedParcel]],
        '%UPDATE%shipping_shipment%',
        [
          () =>
            request(api, 'PATCH', `/api/v1/shipments/${ids.dispatchedParcel}/`, {
              notes: 'Ring first',
            }),
        ],
        async (holder) => {
          await holder.query(
            `UPDATE shipping_shipment SET status = 'DELIVERED', delivered_at = clock_timestamp()
              WHERE id = $1`,
            [ids.dispatchedParcel],
          );
        },
      );
      const answer = held.responses[0];
      now = await parcel(ids.dispatchedParcel);
      checks.push({
        name: `shipping: a parcel delivered while an edit of its notes (${side}) waits to write -- the edit puts back the status it read, and the delivery is gone (copied: the edit takes no lock)`,
        passed:
          held.queued === 1 &&
          answer?.status === 200 &&
          now.status === 'DISPATCHED' &&
          !now.delivered,
        detail: `${answer?.status}, ${held.queued ? 'its write waited' : 'never waited'}, parcel ${now.status}, delivered stamp ${now.delivered ? 'kept' : 'lost'}`,
      });
    }

    // 10. Six couriers of one code, and six methods of one code in one zone, at once.
    for (const [what, path, body, count] of [
      [
        'couriers with one code',
        '/api/v1/couriers/',
        (index: number) => ({ name: `Parity Racer ${index}`, code: 'parity-racer' }),
        `SELECT count(*)::text AS count FROM shipping_courier WHERE code = 'parity-racer'`,
      ],
      [
        'methods with one code in one zone',
        '/api/v1/shipping-methods/',
        (index: number) => ({ zone: ids.zone, name: `Parity Racer ${index}`, code: 'p-racer' }),
        `SELECT count(*)::text AS count FROM shipping_shippingmethod WHERE code = 'p-racer'`,
      ],
    ] as const) {
      await restore();
      const made = await Promise.all(
        Array.from({ length: 6 }, (_, index) => request(either(index), 'POST', path, body(index))),
      );
      const rows = await one<{ count: string }>(count);
      const codes = statuses(made);
      checks.push({
        name: `shipping: 6 ${what} at once, across both APIs -- one is made; the rest are refused by the check or by the index, none a 500`,
        passed:
          codes[0] === 201 &&
          codes.slice(1).every((status) => status === 400 || status === 409) &&
          rows?.count === '1',
        detail: `statuses ${codes.join(',')}, ${rows?.count} made`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
