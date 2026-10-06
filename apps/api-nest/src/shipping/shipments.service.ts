import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { branchCondition } from '../auth/permissions';
import { NoticesService } from '../checkout/notices.service';
import { money, quantize } from '../checkout/pricing';
import type { AuditContext } from '../common/audit';
import { localIso } from '../common/datetime';
import { type AwareMoment, dateTimeField } from '../common/datetime-field';
import {
  charField,
  choiceField,
  decimalField,
  errorMessages,
  type Fields,
  pkRelatedField,
  runSerializer,
} from '../common/drf';
import { Conflict, NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingPlan,
  type OrderingTerm,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pySlice, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { CeleryService } from '../jobs/celery.service';
import { type Moved, OrderLifecycle } from '../orders/order-lifecycle.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { trackingUrl } from './tracking-url';

/**
 * `ShipmentViewSet` and `shipping.services`: a parcel booked against an
 * order, and what the courier then says happened to it. A parcel does not
 * own its order's status but drives it: its first DISPATCHED moves a packed
 * order to SHIPPED, a DELIVERED moves it to DELIVERED. Both services take
 * the order's row before anything else.
 */

const S = '"shipping_shipment"';
const O = '"orders_order"';
const K = '"shipping_courier"';
const SELECT = `${S}."id", ${S}."created_at", ${S}."order_id", ${S}."courier_id",
  ${S}."shipping_method_id", ${S}."tracking_number", ${S}."status", ${S}."cost",
  ${S}."dispatched_at", ${S}."delivered_at", ${S}."notes", ${S}."created_by_id",
  ${O}."number" AS "order_number", ${K}."name" AS "courier_name",
  ${K}."tracking_url_template" AS "tracking_url_template"`;
const FROM = `FROM ${S} INNER JOIN ${O} ON (${S}."order_id" = ${O}."id")
  LEFT OUTER JOIN ${K} ON (${S}."courier_id" = ${K}."id")`;
const STATUSES = [
  'PENDING',
  'DISPATCHED',
  'IN_TRANSIT',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const;
/** `get_status_display().lower()` for a parcel whose journey has ended. */
const FINISHED: Readonly<Record<string, string>> = {
  DELIVERED: 'delivered',
  RETURNED: 'returned to sender',
};
/** `Order.get_status_display().lower()`. */
const ORDER_WORDS: Readonly<Record<string, string>> = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  PACKED: 'packed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  RETURN_REQUESTED: 'return requested',
  RETURNED: 'returned',
  REFUNDED: 'refunded',
};
/** Orders a parcel may be booked for; SHIPPED because a split delivery is real. */
const SHIPPABLE = new Set(['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED']);
/** Orders whose parcel may leave the shop (D98). */
const DISPATCHABLE = new Set(['PACKED', 'SHIPPED', 'DELIVERED']);
const FILTERS: readonly FilterField[] = [
  modelFilter('order', `${S}."order_id"`, 'orders_order'),
  choiceFilter('status', `${S}."status"`, STATUSES),
  modelFilter('courier', `${S}."courier_id"`, 'shipping_courier'),
];
const JOIN_METHOD = `LEFT OUTER JOIN "shipping_shippingmethod"
  ON (${S}."shipping_method_id" = "shipping_shippingmethod"."id")`;
const JOIN_EVENTS = `LEFT OUTER JOIN "shipping_shipmentevent"
  ON (${S}."id" = "shipping_shipmentevent"."shipment_id")`;
/** The view names no `ordering_fields`: every serializer field the model holds, by its source. */
const ORDERING: Readonly<Record<string, OrderingTerm>> = {
  ...Object.fromEntries(
    [
      'id',
      'tracking_number',
      'status',
      'cost',
      'dispatched_at',
      'delivered_at',
      'notes',
      'created_at',
    ].map((name) => [name, `${S}."${name}"`]),
  ),
  order: { columns: [`${O}."placed_at" DESC`] },
  order__number: `${O}."number"`,
  courier: { columns: [`${K}."name"`] },
  courier__name: `${K}."name"`,
  shipping_method: {
    columns: [`"shipping_shippingmethod"."position"`, `"shipping_shippingmethod"."price"`],
    join: JOIN_METHOD,
  },
  // A parcel's events order it by theirs, one row per event.
  events: { columns: [`"shipping_shipmentevent"."occurred_at"`], join: JOIN_EVENTS },
};

interface ShipmentRow {
  id: string;
  created_at: string;
  order_id: string;
  courier_id: string | null;
  shipping_method_id: string | null;
  tracking_number: string;
  status: string;
  cost: string;
  dispatched_at: string | null;
  delivered_at: string | null;
  notes: string;
  created_by_id: string | null;
  order_number: string;
  courier_name: string | null;
  tracking_url_template: string | null;
}

interface EventRow {
  id: string;
  created_at: string;
  shipment_id: string;
  status: string;
  message: string;
  location: string;
  occurred_at: string;
}

type ShipmentData = Partial<{
  order: string;
  courier: string | null;
  shipping_method: string | null;
  tracking_number: string;
  cost: string;
  notes: string;
}>;

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly db: Database,
    private readonly lifecycle: OrderLifecycle,
    private readonly orders: OrderWritesService,
    private readonly stock: StockService,
    private readonly notices: NoticesService,
    private readonly celery: CeleryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  /** `ShipmentEventSerializer(event).data`. */
  private event(row: EventRow) {
    return {
      id: row.id,
      status: row.status,
      message: row.message,
      location: row.location,
      occurred_at: this.iso(row.occurred_at),
      created_at: this.iso(row.created_at),
    };
  }

  /** `ShipmentSerializer(shipments, many=True).data`: each parcel with its events, oldest first. */
  private async serialise(rows: ShipmentRow[], q: Queryable = this.db) {
    const ids = [...new Set(rows.map((row) => row.id))];
    const sql = new SqlParams();
    const events = ids.length
      ? await q.query<EventRow>(
          `SELECT "id", "created_at", "shipment_id", "status", "message", "location", "occurred_at"
             FROM "shipping_shipmentevent"
            WHERE "shipping_shipmentevent"."shipment_id" IN ${sql.list(ids, 'uuid')}
            ORDER BY "shipping_shipmentevent"."occurred_at" ASC`,
          sql.values,
        )
      : [];
    return rows.map((row) => ({
      id: row.id,
      order: row.order_id,
      order_number: row.order_number,
      courier: row.courier_id,
      courier_name: row.courier_id ? (row.courier_name ?? '') : '',
      shipping_method: row.shipping_method_id,
      tracking_number: row.tracking_number,
      tracking_url: trackingUrl(row.courier_id, row.tracking_url_template, row.tracking_number),
      status: row.status,
      cost: row.cost,
      dispatched_at: this.iso(row.dispatched_at),
      delivered_at: this.iso(row.delivered_at),
      notes: row.notes,
      events: events.filter((event) => event.shipment_id === row.id).map((e) => this.event(e)),
      created_at: this.iso(row.created_at),
    }));
  }

  /** `branch_queryset(..., field="order__branch")`, then the declared filters. */
  private async conditions(user: RequestUser, query: QueryDict, sql: SqlParams) {
    const where: string[] = [];
    const scope = branchCondition(user, [`${O}."branch_id"`], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const plan = orderingPlan(query, ORDERING);
    const order = plan?.order ?? [`${S}."created_at" DESC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${S} INNER JOIN ${O} ON (${S}."order_id" = ${O}."id")
            ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<ShipmentRow>(
      `SELECT ${SELECT} ${FROM} ${(plan?.joins ?? []).join(' ')} ${whereSql}
        ORDER BY ${order.join(', ')} LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  /** `get_object()`: the scoped, filtered queryset, then the key. */
  private async find(user: RequestUser, pk: string, query: QueryDict): Promise<ShipmentRow> {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${S}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<ShipmentRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    return (await this.serialise([await this.find(user, pk, query)]))[0];
  }

  /**
   * The parcel as a write answers with it. A partial update leaves
   * `courier_name` out of a parcel with no courier: the field has a default,
   * and DRF skips a defaulted field whose source is missing when the
   * serializer is partial. The cost is the one validated, not the one stored:
   * a cost of "-0" is answered as "-0.00" and kept as 0.00.
   */
  private async byId(id: string, partial = false, cost?: string) {
    const row = (await this.db.one<ShipmentRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${S}."id" = $1 LIMIT 21`,
      [id],
    )) as ShipmentRow;
    const answer = (await this.serialise([row]))[0] as Record<string, unknown>;
    if (partial && row.courier_id === null) delete answer.courier_name;
    if (cost !== undefined) answer.cost = cost;
    return answer;
  }

  private exists(table: string) {
    return async (id: string) =>
      (await this.db.one(`SELECT 1 AS "a" FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
  }

  /**
   * `ShipmentSerializer(instance, data, partial)`, its `order` field narrowed
   * to the orders this user may see: one at another branch reads as one that
   * does not exist.
   */
  private async validate(user: RequestUser, data: unknown, partial: boolean) {
    const scope = branchCondition(user, [`${O}."branch_id"`], 2);
    const fields: Fields = {
      order: pkRelatedField(
        async (id) =>
          (await this.db.one(
            `SELECT 1 AS "a" FROM ${O} WHERE (${scope ? `${scope.sql} AND ` : ''}${O}."id" = $1)
              LIMIT 21`,
            scope ? [id, ...scope.values] : [id],
          )) !== null,
      ),
      courier: pkRelatedField(this.exists('shipping_courier'), {
        required: false,
        allowNull: true,
      }),
      shipping_method: pkRelatedField(this.exists('shipping_shippingmethod'), {
        required: false,
        allowNull: true,
      }),
      tracking_number: charField({ required: false, allowBlank: true, maxLength: 120 }),
      cost: decimalField(14, 2, { required: false }),
      notes: charField({ required: false, allowBlank: true }),
    };
    const result = await runSerializer<ShipmentData>(fields, data, { partial });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  private duplicate(courier: string, trackingNumber: string): Conflict {
    return new Conflict(`${courier} already has a parcel with tracking number ${trackingNumber}.`, {
      details: { courier, tracking_number: trackingNumber },
    });
  }

  /**
   * `create` and `create_shipment`: a parcel booked, always PENDING -- its
   * status is the tail of its event log and nothing else -- and written to
   * the order's timeline, under the order's row lock.
   */
  async create(user: RequestUser, data: unknown) {
    const values = await this.validate(user, data, false);
    const trackingNumber = pyStrip(values.tracking_number || '');
    const cost = quantize(values.cost ?? '0.00');
    const courierId = values.courier ?? null;

    const id = await this.db.transaction(async (tx) => {
      if (cost.lt(0)) throw new ValidationError('A shipment cost cannot be negative.');
      // A tracking number is issued by a courier: without one it identifies nothing.
      if (trackingNumber && courierId === null) {
        throw new ValidationError('A tracking number needs the courier that issued it.', {
          details: { tracking_number: trackingNumber },
        });
      }
      const order = (await tx.one<{ id: string; number: string; status: string }>(
        `SELECT ${O}."id", ${O}."number", ${O}."status" FROM ${O}
          WHERE ${O}."id" = $1 LIMIT 21 FOR UPDATE`,
        [values.order],
      )) as { id: string; number: string; status: string };
      if (!SHIPPABLE.has(order.status)) {
        throw new Conflict(
          `A ${ORDER_WORDS[order.status] ?? order.status.toLowerCase()} order cannot be shipped.`,
          { details: { order: order.number, status: order.status } },
        );
      }
      const courier = courierId
        ? await tx.one<{ name: string }>(`SELECT "name" FROM ${K} WHERE "id" = $1 LIMIT 21`, [
            courierId,
          ])
        : null;
      if (trackingNumber && courier) {
        const clash = await tx.one(
          `SELECT 1 AS "a" FROM ${S}
            WHERE (${S}."courier_id" = $1 AND ${S}."tracking_number" = $2) LIMIT 1`,
          [courierId, trackingNumber],
        );
        if (clash) throw this.duplicate(courier.name, trackingNumber);
      }
      const shipmentId = randomUUID();
      await tx.query('SAVEPOINT create_shipment');
      try {
        await tx.query(
          `INSERT INTO ${S} ("id", "created_at", "updated_at", "order_id", "courier_id",
             "shipping_method_id", "tracking_number", "status", "cost", "dispatched_at",
             "delivered_at", "notes", "created_by_id")
           VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, 'PENDING', $6, NULL,
                   NULL, $7, $8)`,
          [
            shipmentId,
            order.id,
            courierId,
            values.shipping_method ?? null,
            trackingNumber,
            money(cost),
            values.notes ?? '',
            user.id,
          ],
        );
        await tx.query('RELEASE SAVEPOINT create_shipment');
      } catch (error) {
        if (!String((error as { code?: string }).code).startsWith('23')) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT create_shipment');
        if (courier && trackingNumber) throw this.duplicate(courier.name, trackingNumber);
        throw error;
      }
      await this.orders.logEvent(
        tx,
        order.id,
        'SHIPMENT_CREATED',
        `Shipment created${courier ? ` (${courier.name})` : ''}`,
        { data: { tracking_number: trackingNumber }, actorId: user.id },
      );
      return shipmentId;
    });
    return this.byId(id, false, money(cost));
  }

  /**
   * `update` and `partial_update`: a plain `serializer.save()`, with none of
   * `create_shipment`'s rules. Every column is written back as read.
   */
  async update(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    partial: boolean,
  ) {
    const instance = await this.find(user, pk, query);
    const values = await this.validate(user, data(), partial);
    const has = (key: keyof ShipmentData) => Object.hasOwn(values, key);
    await this.db.query(
      `UPDATE ${S} SET "updated_at" = clock_timestamp(), "order_id" = $2, "courier_id" = $3,
         "shipping_method_id" = $4, "tracking_number" = $5, "status" = $6, "cost" = $7,
         "dispatched_at" = $8::timestamptz, "delivered_at" = $9::timestamptz, "notes" = $10,
         "created_by_id" = $11
       WHERE ${S}."id" = $1`,
      [
        instance.id,
        values.order ?? instance.order_id,
        has('courier') ? values.courier : instance.courier_id,
        has('shipping_method') ? values.shipping_method : instance.shipping_method_id,
        values.tracking_number ?? instance.tracking_number,
        instance.status,
        values.cost ?? instance.cost,
        instance.dispatched_at,
        instance.delivered_at,
        values.notes ?? instance.notes,
        instance.created_by_id,
      ],
    );
    return this.byId(instance.id, partial, values.cost);
  }

  /** `destroy`: the parcel deleted, its tracking history with it (`CASCADE`). */
  async destroy(user: RequestUser, pk: string, query: QueryDict): Promise<void> {
    const instance = await this.find(user, pk, query);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `DELETE FROM "shipping_shipmentevent" WHERE "shipping_shipmentevent"."shipment_id" IN ($1)`,
        [instance.id],
      );
      await tx.query(`DELETE FROM ${S} WHERE ${S}."id" IN ($1)`, [instance.id]);
    });
  }

  /** `_notify_status`, once the move has committed: the in-app row, then the email and the SMS. */
  private async notify(moved: Moved | null): Promise<void> {
    if (!moved?.notice) return;
    const customer = await this.db.one<{ user_id: string | null }>(
      `SELECT "user_id" FROM "customers_customer" WHERE "id" = $1`,
      [moved.customerId],
    );
    const jobs = await this.notices.notifyCustomer(
      this.db,
      { id: moved.id, number: moved.number, customerUserId: customer?.user_id ?? null },
      moved.notice[0],
      moved.notice[1],
    );
    for (const job of jobs) await this.celery.delay(job.task, job.args);
  }

  /**
   * `events` and `record_event`: a tracking update, appended, and the order
   * kept in step. The parcel is found before the body is read. Under the
   * order's lock and then the parcel's: a parcel delivered or returned takes
   * no more history; a parcel's first movement needs its order packed.
   */
  async recordEvent(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const found = await this.find(user, pk, query);
    const validated = await runSerializer<{
      status?: string;
      message?: string;
      location?: string;
      occurred_at?: AwareMoment;
    }>(
      {
        status: choiceField(STATUSES, { required: false }),
        message: charField({ required: false, allowBlank: true, maxLength: 255 }),
        location: charField({ required: false, allowBlank: true, maxLength: 120 }),
        occurred_at: dateTimeField(this.env.DJANGO_TIME_ZONE, { required: false }),
      } as Fields,
      data(),
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const asked = validated.values;
    const actor = { id: user.id, email: user.email };
    const message = asked.message ?? '';

    const { eventId, moved } = await this.stock.run(async (tx: Queryable, after: AfterCommit) => {
      const order = (await tx.one<{ id: string; number: string; status: string }>(
        `SELECT ${O}."id", ${O}."number", ${O}."status" FROM ${O}
          WHERE ${O}."id" = $1 LIMIT 21 FOR UPDATE`,
        [found.order_id],
      )) as { id: string; number: string; status: string };
      const locked = (await tx.one<{
        status: string;
        dispatched_at: string | null;
        delivered_at: string | null;
      }>(
        `SELECT ${S}."status", ${S}."dispatched_at", ${S}."delivered_at" FROM ${S}
          WHERE ${S}."id" = $1 LIMIT 21 FOR UPDATE`,
        [found.id],
      )) as { status: string; dispatched_at: string | null; delivered_at: string | null };

      const finished = FINISHED[locked.status];
      if (finished) {
        throw new Conflict(
          `This parcel is already ${finished}; its tracking history cannot be added to.`,
          { details: { status: locked.status } },
        );
      }
      const status = asked.status || 'IN_TRANSIT';
      const leaving = locked.status === 'PENDING' && status !== 'PENDING';
      if (leaving && !DISPATCHABLE.has(order.status)) {
        throw new Conflict(
          `Pack ${order.number} before its parcel leaves: the order is still ` +
            `${ORDER_WORDS[order.status] ?? order.status.toLowerCase()}.`,
          { details: { order: order.number, status: order.status } },
        );
      }

      const now = async () =>
        ((await tx.one<{ now: string }>(`SELECT clock_timestamp() AS now`)) as { now: string }).now;
      const id = randomUUID();
      await tx.query(
        `INSERT INTO "shipping_shipmentevent"
           ("id", "created_at", "updated_at", "shipment_id", "status", "message", "location",
            "occurred_at", "raw", "created_by_id")
         VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6::timestamptz,
                 '{}'::jsonb, $7)`,
        [
          id,
          found.id,
          status,
          message,
          asked.location ?? '',
          asked.occurred_at?.pg ?? (await now()),
          actor.id,
        ],
      );
      const dispatchedAt =
        status === 'DISPATCHED' && !locked.dispatched_at ? await now() : locked.dispatched_at;
      const deliveredAt =
        status === 'DELIVERED' && !locked.delivered_at ? await now() : locked.delivered_at;
      await tx.query(
        `UPDATE ${S} SET "status" = $2, "dispatched_at" = $3::timestamptz,
                "delivered_at" = $4::timestamptz, "updated_at" = clock_timestamp()
          WHERE ${S}."id" = $1`,
        [found.id, status, dispatchedAt, deliveredAt],
      );
      await this.orders.logEvent(
        tx,
        order.id,
        'SHIPMENT_EVENT',
        pySlice(`${status}: ${message}`, 255),
        { data: { shipment_id: found.id, status }, actorId: actor.id },
      );

      let transitioned: Moved | null = null;
      if (status === 'DISPATCHED' && order.status === 'PACKED') {
        transitioned = await this.lifecycle.transition(
          tx,
          after,
          context,
          order.id,
          'SHIPPED',
          '',
          actor,
        );
      } else if (
        status === 'DELIVERED' &&
        (order.status === 'SHIPPED' || order.status === 'PACKED')
      ) {
        transitioned = await this.lifecycle.transition(
          tx,
          after,
          context,
          order.id,
          'DELIVERED',
          '',
          actor,
        );
      }
      return { eventId: id, moved: transitioned };
    });
    await this.notify(moved);
    return this.event(
      (await this.db.one<EventRow>(
        `SELECT "id", "created_at", "shipment_id", "status", "message", "location", "occurred_at"
           FROM "shipping_shipmentevent" WHERE "id" = $1`,
        [eventId],
      )) as EventRow,
    );
  }
}
