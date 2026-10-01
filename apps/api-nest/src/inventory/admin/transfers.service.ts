import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { branchCondition, RolePermissions } from '../../auth/permissions';
import type { AuditActor, AuditContext } from '../../common/audit';
import { localIso } from '../../common/datetime';
import {
  charField,
  errorMessages,
  integerField,
  nestedListField,
  runSerializer,
  uuidField,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import { orderingPlan, type OrderingTerm } from '../../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../../common/pagination';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { type Count, StockService } from '../stock.service';

/**
 * `StockTransferViewSet`: stock moved between branches, read from either
 * end (D94), and made through `inventory.services.transfer`.
 *
 * The view names no `ordering_fields`, so `OrderingFilter` allows every
 * field the serializer reads: a branch orders by its name, `items` by the
 * lines' ids through a join -- one row per line, as Django returns it.
 */

const T = '"inventory_stocktransfer"';
const TRANSFER_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'number',
  'source_branch_id',
  'target_branch_id',
  'status',
  'notes',
  'created_by_id',
  'received_at',
  'received_by_id',
  'idempotency_key',
];
export const BRANCH_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'organization_id',
  'name',
  'code',
  'address',
  'phone',
  'email',
  'is_default',
  'fulfils_online_orders',
  'register_count',
  'status',
];

const SELECT = [
  ...TRANSFER_COLUMNS.map((column) => `${T}."${column}" AS "${column}"`),
  ...BRANCH_COLUMNS.map((column) => `"accounts_branch"."${column}" AS "s_${column}"`),
  ...BRANCH_COLUMNS.map((column) => `T3."${column}" AS "t_${column}"`),
].join(', ');

const FROM = `FROM ${T}
  INNER JOIN "accounts_branch" ON (${T}."source_branch_id" = "accounts_branch"."id")
  INNER JOIN "accounts_branch" T3 ON (${T}."target_branch_id" = T3."id")`;

const ITEMS_JOIN = `LEFT OUTER JOIN "inventory_stocktransferitem"
  ON (${T}."id" = "inventory_stocktransferitem"."transfer_id")`;

const ORDERING: Record<string, OrderingTerm> = {
  id: `${T}."id"`,
  number: `${T}."number"`,
  source_branch: { columns: ['"accounts_branch"."name"'] },
  source_branch__code: '"accounts_branch"."code"',
  target_branch: { columns: ['T3."name"'] },
  target_branch__code: 'T3."code"',
  status: `${T}."status"`,
  notes: `${T}."notes"`,
  items: { columns: ['"inventory_stocktransferitem"."id"'], join: ITEMS_JOIN },
  created_at: `${T}."created_at"`,
  received_at: `${T}."received_at"`,
};

interface TransferRow {
  id: string;
  number: string;
  source_branch_id: string;
  target_branch_id: string;
  status: string;
  notes: string;
  created_at: string;
  received_at: string | null;
  s_code: string;
  t_code: string;
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly stock: StockService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private scope(user: RequestUser, sql: SqlParams): string[] {
    const scope = branchCondition(
      user,
      [`${T}."source_branch_id"`, `${T}."target_branch_id"`],
      sql.values.length + 1,
    );
    if (!scope) return [];
    sql.values.push(...scope.values);
    return [scope.sql];
  }

  /** `StockTransferSerializer(many=True).data`: each transfer's lines read by its own query. */
  async serialise(rows: TransferRow[], q: Queryable = this.db) {
    const lines = new Map<string, Record<string, unknown>[]>();
    const variants = new Set<string>();
    for (const id of new Set(rows.map((row) => row.id))) {
      const items = await q.query<{
        id: string;
        variant_id: string;
        quantity: number;
        unit_cost: string | null;
      }>(
        `SELECT "inventory_stocktransferitem"."id", "inventory_stocktransferitem"."created_at",
                "inventory_stocktransferitem"."updated_at", "inventory_stocktransferitem"."transfer_id",
                "inventory_stocktransferitem"."variant_id", "inventory_stocktransferitem"."quantity",
                "inventory_stocktransferitem"."unit_cost"
           FROM "inventory_stocktransferitem"
          WHERE "inventory_stocktransferitem"."transfer_id" = $1::uuid`,
        [id],
      );
      for (const item of items) variants.add(item.variant_id);
      lines.set(
        id,
        items.map((item) => ({ ...item }) as unknown as Record<string, unknown>),
      );
    }
    const names = new Map(
      (
        await q.query<{ id: string; sku: string; product_name: string }>(
          `SELECT v.id, v.sku, p.name AS product_name FROM catalog_productvariant v
             JOIN catalog_product p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])`,
          [[...variants]],
        )
      ).map((row) => [row.id, row]),
    );
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      source_branch: row.source_branch_id,
      source_code: row.s_code,
      target_branch: row.target_branch_id,
      target_code: row.t_code,
      status: row.status,
      notes: row.notes,
      items: (lines.get(row.id) ?? []).map((item) => {
        const variant = names.get(item.variant_id as string);
        return {
          id: item.id,
          variant: item.variant_id,
          sku: variant?.sku,
          product_name: variant?.product_name,
          quantity: item.quantity,
          unit_cost: item.unit_cost,
        };
      }),
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
      received_at: localIso(row.received_at, this.env.DJANGO_TIME_ZONE),
    }));
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = this.scope(user, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const plan = orderingPlan(query, ORDERING);
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${T} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const order = plan?.order ?? [`${T}."created_at" DESC`];
    const rows = count
      ? await this.db.query<TransferRow>(
          `SELECT ${SELECT} ${FROM} ${plan?.joins.join(' ') ?? ''} ${whereSql}
            ORDER BY ${order.join(', ')}
            LIMIT ${page.limit}${page.offset ? ` OFFSET ${page.offset}` : ''}`,
          sql.values,
        )
      : [];
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  private async row(id: string, where: string[], sql: SqlParams, q: Queryable = this.db) {
    where.push(`${T}."id" = ${sql.add(id, 'uuid')}`);
    return q.one<TransferRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
  }

  async retrieve(user: RequestUser, pk: string) {
    const sql = new SqlParams();
    const where = this.scope(user, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    const row = await this.row(id, where, sql);
    if (!row) throw new NotFound();
    return (await this.serialise([row]))[0];
  }

  /** `create`: `CreateTransferSerializer`, the source as the acting branch, then `transfer`. */
  async create(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    actor: AuditActor,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{
      source_branch: string;
      target_branch: string;
      lines: { variant: string; quantity: Count }[];
      notes?: string;
    }>(
      {
        source_branch: uuidField(),
        target_branch: uuidField(),
        lines: nestedListField({ variant: uuidField(), quantity: integerField({ minValue: 1 }) }),
        notes: charField({ required: false, allowBlank: true }),
      },
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const values = validated.values;
    const source = await this.permissions.resolveBranch(user, values.source_branch);
    const target = await this.db.one<{ id: string; code: string }>(
      `SELECT "accounts_branch"."id", "accounts_branch"."code" FROM "accounts_branch"
        WHERE ("accounts_branch"."id" = $1::uuid AND "accounts_branch"."status" = 'ACTIVE')
        ORDER BY "accounts_branch"."name" ASC LIMIT 1`,
      [values.target_branch],
    );
    if (!target) {
      throw new ValidationError('That branch is not available.', {
        details: { target_branch: ['That branch is not available.'] },
      });
    }
    const id = await this.stock.run((tx, after) =>
      this.stock.transfer(tx, after, context, {
        source,
        target,
        lines: values.lines.map((line) => [line.variant, line.quantity]),
        actor,
        notes: values.notes ?? '',
        idempotencyKey,
      }),
    );
    const row = await this.row(id, [], new SqlParams());
    return (await this.serialise([row as TransferRow]))[0];
  }
}
