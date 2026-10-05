import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { RolePermissions } from '../auth/permissions';
import { localIso } from '../common/datetime';
import { charField, errorMessages, jsonField, pkRelatedField, runSerializer } from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import { orderingPlan, type OrderingTerm } from '../common/filtering';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { dataGet, parsePythonJson } from '../http/request-body';

/**
 * `HeldSaleViewSet`: carts parked at the counter. A hold reserves nothing and
 * prices nothing -- the register looks every line up again when it resumes
 * one. Unpaginated, the newest first, and only the holds of the branch the
 * request acts on: one at another branch is a 404.
 */

const H = '"orders_heldsale"';
const SELECT = `${H}."id", ${H}."created_at", ${H}."branch_id", ${H}."register", ${H}."label",
  ${H}."customer_id", ${H}."payload"::text AS "payload", ${H}."created_by_id"`;
const CUSTOMER_JOIN = `LEFT OUTER JOIN "customers_customer"
  ON (${H}."customer_id" = "customers_customer"."id")`;

/** `OrderingFilter`'s default: every field the serializer reads, by its source. */
const ORDERING: Record<string, OrderingTerm> = {
  id: `${H}."id"`,
  // A foreign key orders by the related model's own `Meta.ordering`.
  branch: {
    columns: ['"accounts_branch"."name"'],
    join: `INNER JOIN "accounts_branch" ON (${H}."branch_id" = "accounts_branch"."id")`,
  },
  register: `${H}."register"`,
  label: `${H}."label"`,
  customer: '"customers_customer"."name"',
  customer__name: '"customers_customer"."name"',
  payload: `${H}."payload"`,
  created_by__email: {
    columns: ['"accounts_user"."email"'],
    join: `LEFT OUTER JOIN "accounts_user" ON (${H}."created_by_id" = "accounts_user"."id")`,
  },
  created_at: `${H}."created_at"`,
};

interface HoldRow {
  id: string;
  created_at: string;
  branch_id: string;
  register: string;
  label: string;
  customer_id: string | null;
  payload: string;
  created_by_id: string | null;
}

type HoldData = Partial<{
  register: string;
  label: string;
  customer: string | null;
  payload: unknown;
}>;

@Injectable()
export class HoldsService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `HeldSaleSerializer(...).data`: the customer's name and the cashier's
   * email read per row. Each is a read-only field with a default, and DRF
   * skips such a field on a partial update when its source is not there: the
   * answer to a PATCH has no `customer_name` for a hold without a customer.
   */
  async serialise(rows: HoldRow[], partial = false, q: Queryable = this.db) {
    const customers = new Map(
      (
        await q.query<{ id: string; name: string }>(
          `SELECT "id", "name" FROM "customers_customer" WHERE "id" = ANY($1::uuid[])`,
          [[...new Set(rows.map((row) => row.customer_id).filter(Boolean))]],
        )
      ).map((row) => [row.id, row.name]),
    );
    const users = new Map(
      (
        await q.query<{ id: string; email: string }>(
          `SELECT "id", "email" FROM "accounts_user" WHERE "id" = ANY($1::uuid[])`,
          [[...new Set(rows.map((row) => row.created_by_id).filter(Boolean))]],
        )
      ).map((row) => [row.id, row.email]),
    );
    return rows.map((row) => ({
      id: row.id,
      branch: row.branch_id,
      register: row.register,
      label: row.label,
      customer: row.customer_id,
      ...(partial && !row.customer_id
        ? {}
        : { customer_name: (row.customer_id && customers.get(row.customer_id)) || '' }),
      payload: parsePythonJson(row.payload),
      ...(partial && !row.created_by_id
        ? {}
        : { created_by_email: (row.created_by_id && users.get(row.created_by_id)) || '' }),
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
    }));
  }

  /** The session's holds: the branch's newest twenty. */
  async recent(branchId: string) {
    return this.serialise(
      await this.db.query<HoldRow>(
        `SELECT ${SELECT} FROM ${H} WHERE ${H}."branch_id" = $1
          ORDER BY ${H}."created_at" DESC LIMIT 20`,
        [branchId],
      ),
    );
  }

  /** `get_queryset`: the holds of the branch `?branch=` resolves to. */
  private async branchId(user: RequestUser, query: QueryDict): Promise<string> {
    return (await this.permissions.resolveBranch(user, query.get('branch') ?? null)).id;
  }

  async list(user: RequestUser, query: QueryDict) {
    const branchId = await this.branchId(user, query);
    const plan = orderingPlan(query, ORDERING);
    const order = plan?.order ?? [`${H}."created_at" DESC`];
    return this.serialise(
      await this.db.query<HoldRow>(
        `SELECT ${SELECT} FROM ${H} ${plan?.joins.find((join) => join.startsWith('INNER')) ?? ''}
           ${CUSTOMER_JOIN} ${plan?.joins.find((join) => join.startsWith('LEFT')) ?? ''}
          WHERE ${H}."branch_id" = $1 ORDER BY ${order.join(', ')}`,
        [branchId],
      ),
    );
  }

  /** `get_object()`. */
  async find(user: RequestUser, pk: string, query: QueryDict): Promise<HoldRow> {
    const branchId = await this.branchId(user, query);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    const row = await this.db.one<HoldRow>(
      `SELECT ${SELECT} FROM ${H} ${CUSTOMER_JOIN}
        WHERE (${H}."branch_id" = $1 AND ${H}."id" = $2) LIMIT 21`,
      [branchId, id],
    );
    if (!row) throw new NotFound();
    return row;
  }

  /** `HeldSaleSerializer(data=...).is_valid(raise_exception=True)`. */
  private async validate(data: unknown, partial: boolean): Promise<HoldData> {
    const validated = await runSerializer<HoldData>(
      {
        register: charField({ required: false, allowBlank: true, maxLength: 32 }),
        label: charField({ required: false, allowBlank: true, maxLength: 64 }),
        customer: pkRelatedField(
          async (id) =>
            (await this.db.one(
              `SELECT 1 AS "a" FROM "customers_customer" WHERE "customers_customer"."id" = $1 LIMIT 1`,
              [id],
            )) !== null,
          { required: false, allowNull: true },
        ),
        payload: jsonField({ required: false }),
      },
      data,
      { partial },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    return validated.values;
  }

  /**
   * `create`: the hold belongs to the branch the body's `branch` resolves to
   * -- read after the serializer has passed, as `perform_create` reads it.
   */
  async create(user: RequestUser, data: unknown) {
    const values = await this.validate(data, false);
    const branch = await this.permissions.resolveBranch(user, dataGet(data, 'branch'));
    const row = (await this.db.one<HoldRow>(
      `INSERT INTO ${H} ("id", "created_at", "updated_at", "branch_id", "register", "label",
                         "customer_id", "payload", "created_by_id")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING ${SELECT}`,
      [
        randomUUID(),
        branch.id,
        values.register ?? '',
        values.label ?? '',
        values.customer ?? null,
        JSON.stringify(values.payload === undefined ? {} : values.payload),
        user.id,
      ],
    )) as HoldRow;
    // The answer is the instance as saved, not as jsonb gives it back.
    return (await this.serialise([row]))[0];
  }

  /** `update` / `partial_update`: every column written back, as `save()` writes them. */
  async update(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    partial: boolean,
  ) {
    // The body is read after the hold is found, as `get_object()` comes first.
    const hold = await this.find(user, pk, query);
    const values = await this.validate(data(), partial);
    const row = (await this.db.one<HoldRow>(
      `UPDATE ${H} SET "updated_at" = clock_timestamp(), "branch_id" = $2, "register" = $3,
              "label" = $4, "customer_id" = $5, "payload" = $6::jsonb, "created_by_id" = $7
        WHERE ${H}."id" = $1 RETURNING ${SELECT}`,
      [
        hold.id,
        hold.branch_id,
        values.register ?? hold.register,
        values.label ?? hold.label,
        values.customer === undefined ? hold.customer_id : values.customer,
        values.payload === undefined ? hold.payload : JSON.stringify(values.payload),
        hold.created_by_id,
      ],
    )) as HoldRow | null;
    // A hold resumed or deleted meanwhile: Django's `save()` finds no row to
    // update and inserts it again.
    if (!row) return this.reinsert(hold, values, partial);
    return (await this.serialise([row], partial))[0];
  }

  private async reinsert(hold: HoldRow, values: HoldData, partial: boolean) {
    const row = (await this.db.one<HoldRow>(
      `INSERT INTO ${H} ("id", "created_at", "updated_at", "branch_id", "register", "label",
                         "customer_id", "payload", "created_by_id")
       VALUES ($1, $2, clock_timestamp(), $3, $4, $5, $6, $7::jsonb, $8) RETURNING ${SELECT}`,
      [
        hold.id,
        hold.created_at,
        hold.branch_id,
        values.register ?? hold.register,
        values.label ?? hold.label,
        values.customer === undefined ? hold.customer_id : values.customer,
        values.payload === undefined ? hold.payload : JSON.stringify(values.payload),
        hold.created_by_id,
      ],
    )) as HoldRow;
    return (await this.serialise([row], partial))[0];
  }

  async destroy(user: RequestUser, pk: string, query: QueryDict): Promise<void> {
    const hold = await this.find(user, pk, query);
    await this.db.query(`DELETE FROM ${H} WHERE ${H}."id" IN ($1)`, [hold.id]);
  }

  /** `resume`: the parked cart, and the hold is gone. */
  async resume(user: RequestUser, pk: string, query: QueryDict) {
    const hold = await this.find(user, pk, query);
    await this.db.query(`DELETE FROM ${H} WHERE ${H}."id" IN ($1)`, [hold.id]);
    return { payload: parsePythonJson(hold.payload) };
  }
}
