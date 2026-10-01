import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { branchCondition, RolePermissions } from '../../auth/permissions';
import type { AuditActor, AuditContext } from '../../common/audit';
import { localIso } from '../../common/datetime';
import {
  charField,
  errorMessages,
  integerField,
  Invalid,
  nestedListField,
  pkRelatedField,
  runSerializer,
  uuidField,
  withDefault,
} from '../../common/drf';
import { Conflict, NotFound, ValidationError } from '../../common/errors';
import { orderingPlan, type OrderingTerm } from '../../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../../common/pagination';
import { compareCodePoints } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { nextNumber } from '../../common/sequence';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { dataGet } from '../../http/request-body';
import { COUNT_STATUS_LABELS, StockService } from '../stock.service';
import { BRANCH_COLUMNS } from './transfers.service';

/**
 * `StockCountViewSet`: a physical stock take. A count is created with a
 * snapshot of what the branch's rows say, filled in with `record`, then
 * applied as adjustments (`apply_stock_count`) or cancelled.
 *
 * A `ModelViewSet` whose `required_permissions` names no `destroy`: only an
 * owner or a superuser may delete a count -- an applied one too (D127). An
 * edit saves every column from the row as read, branch included (D126).
 */

const C = '"inventory_stockcount"';
const COUNT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'number',
  'branch_id',
  'status',
  'notes',
  'created_by_id',
  'applied_at',
  'applied_by_id',
];
const SELECT = [
  ...COUNT_COLUMNS.map((column) => `${C}."${column}" AS "${column}"`),
  ...BRANCH_COLUMNS.map((column) => `"accounts_branch"."${column}" AS "b_${column}"`),
].join(', ');
const FROM = `FROM ${C} INNER JOIN "accounts_branch" ON (${C}."branch_id" = "accounts_branch"."id")`;
const ITEMS_JOIN = `LEFT OUTER JOIN "inventory_stockcountitem"
  ON (${C}."id" = "inventory_stockcountitem"."stock_count_id")`;
const ITEM_COLUMNS = `"inventory_stockcountitem"."id", "inventory_stockcountitem"."created_at",
  "inventory_stockcountitem"."updated_at", "inventory_stockcountitem"."stock_count_id",
  "inventory_stockcountitem"."variant_id", "inventory_stockcountitem"."expected_quantity",
  "inventory_stockcountitem"."counted_quantity", "inventory_stockcountitem"."notes"`;

const ORDERING: Record<string, OrderingTerm> = {
  id: `${C}."id"`,
  number: `${C}."number"`,
  branch: { columns: ['"accounts_branch"."name"'] },
  branch__code: '"accounts_branch"."code"',
  status: `${C}."status"`,
  notes: `${C}."notes"`,
  items: { columns: ['"inventory_stockcountitem"."id"'], join: ITEMS_JOIN },
  created_at: `${C}."created_at"`,
  applied_at: `${C}."applied_at"`,
};

export interface CountRow {
  id: string;
  created_at: string;
  updated_at: string;
  number: string;
  branch_id: string;
  status: string;
  notes: string;
  created_by_id: string | null;
  applied_at: string | null;
  applied_by_id: string | null;
  b_code: string;
}

interface ItemRow {
  id: string;
  stock_count_id: string;
  variant_id: string;
  expected_quantity: number;
  counted_quantity: number | null;
  notes: string;
}

@Injectable()
export class CountsService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly stock: StockService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private scope(user: RequestUser, sql: SqlParams): string[] {
    const scope = branchCondition(user, [`${C}."branch_id"`], sql.values.length + 1);
    if (!scope) return [];
    sql.values.push(...scope.values);
    return [scope.sql];
  }

  /**
   * The lines of these counts: by the prefetch's `IN` list, or -- for a
   * count just written, which has no prefetch -- by its own `=`. Neither
   * orders them; Django's statements are used so they come back alike.
   */
  private async items(ids: string[], prefetched: boolean, q: Queryable = this.db) {
    if (!ids.length) return [];
    const sql = new SqlParams();
    const condition = prefetched
      ? `"inventory_stockcountitem"."stock_count_id" IN ${sql.list(ids, 'uuid')}`
      : `"inventory_stockcountitem"."stock_count_id" = ${sql.add(ids[0], 'uuid')}`;
    return q.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM "inventory_stockcountitem" WHERE ${condition}`,
      sql.values,
    );
  }

  async serialise(rows: CountRow[], prefetched = true, q: Queryable = this.db) {
    const items = await this.items([...new Set(rows.map((row) => row.id))], prefetched, q);
    const names = new Map(
      (
        await q.query<{ id: string; sku: string; product_name: string }>(
          `SELECT v.id, v.sku, p.name AS product_name FROM catalog_productvariant v
             JOIN catalog_product p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])`,
          [[...new Set(items.map((item) => item.variant_id))]],
        )
      ).map((row) => [row.id, row]),
    );
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      branch: row.branch_id,
      branch_code: row.b_code,
      status: row.status,
      notes: row.notes,
      items: items
        .filter((item) => item.stock_count_id === row.id)
        .map((item) => {
          const variant = names.get(item.variant_id);
          return {
            id: item.id,
            variant: item.variant_id,
            sku: variant?.sku,
            product_name: variant?.product_name,
            expected_quantity: item.expected_quantity,
            counted_quantity: item.counted_quantity,
            difference:
              item.counted_quantity === null
                ? null
                : item.counted_quantity - item.expected_quantity,
            notes: item.notes,
          };
        }),
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
      applied_at: localIso(row.applied_at, this.env.DJANGO_TIME_ZONE),
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
          `SELECT COUNT(*) AS "count" FROM ${C} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const order = plan?.order ?? [`${C}."created_at" DESC`];
    const rows = count
      ? await this.db.query<CountRow>(
          `SELECT ${SELECT} ${FROM} ${plan?.joins.join(' ') ?? ''} ${whereSql}
            ORDER BY ${order.join(', ')}
            LIMIT ${page.limit}${page.offset ? ` OFFSET ${page.offset}` : ''}`,
          sql.values,
        )
      : [];
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  /** `get_object`. */
  async find(user: RequestUser, pk: string, q: Queryable = this.db): Promise<CountRow> {
    const sql = new SqlParams();
    const where = this.scope(user, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${C}."id" = ${sql.add(id, 'uuid')}`);
    const row = await q.one<CountRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(user: RequestUser, pk: string) {
    return (await this.serialise([await this.find(user, pk)]))[0];
  }

  /** `StockCountSerializer`'s writable fields: the branch (any branch) and the notes. */
  private fields() {
    return {
      branch: pkRelatedField(
        async (id) =>
          (await this.db.one(
            `SELECT "accounts_branch"."id" FROM "accounts_branch" WHERE "accounts_branch"."id" = $1 LIMIT 21`,
            [id],
          )) !== null,
      ),
      notes: charField({ required: false, allowBlank: true }),
    };
  }

  /**
   * `perform_create`: the serializer, then the branch the user may act on
   * (`resolve_branch`, read from the raw body), a number, and a line per
   * inventory row of that branch with the figure the system holds.
   */
  async create(user: RequestUser, data: unknown, actor: AuditActor) {
    const validated = await runSerializer<{ branch: string; notes?: string }>(this.fields(), data);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const branch = await this.permissions.resolveBranch(user, dataGet(data, 'branch'));
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      const number = await nextNumber(tx, 'stock_count', 'SC');
      await tx.query(
        `INSERT INTO ${C} (id, created_at, updated_at, number, branch_id, status, notes, created_by_id,
                           applied_at, applied_by_id)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3::uuid, 'COUNTING', $4, $5::uuid,
                 NULL, NULL)`,
        [id, number, branch.id, validated.values.notes ?? '', actor.id],
      );
      // Django's statement: the lines are written in the order it returns the rows.
      const rows = await tx.query<{ variant_id: string; on_hand: number }>(
        `SELECT "inventory_inventory"."id", "inventory_inventory"."created_at",
                "inventory_inventory"."updated_at", "inventory_inventory"."branch_id",
                "inventory_inventory"."variant_id", "inventory_inventory"."on_hand",
                "inventory_inventory"."reserved", "inventory_inventory"."average_cost",
                "inventory_inventory"."reorder_point", "inventory_inventory"."bin_location",
                "catalog_productvariant"."id" AS "v_id", "catalog_productvariant"."created_at" AS "v_created_at",
                "catalog_productvariant"."updated_at" AS "v_updated_at",
                "catalog_productvariant"."product_id", "catalog_productvariant"."sku",
                "catalog_productvariant"."barcode", "catalog_productvariant"."name",
                "catalog_productvariant"."price", "catalog_productvariant"."compare_at_price",
                "catalog_productvariant"."cost", "catalog_productvariant"."weight_grams",
                "catalog_productvariant"."position", "catalog_productvariant"."status",
                "catalog_productvariant"."batch_number", "catalog_productvariant"."expiry_date"
           FROM "inventory_inventory"
           INNER JOIN "catalog_productvariant"
             ON ("inventory_inventory"."variant_id" = "catalog_productvariant"."id")
          WHERE "inventory_inventory"."branch_id" = $1::uuid`,
        [branch.id],
      );
      if (rows.length) {
        const sql = new SqlParams();
        const values = rows.map(
          (row) =>
            `(${sql.add(randomUUID(), 'uuid')}, clock_timestamp(), clock_timestamp(), ${sql.add(id, 'uuid')},
              ${sql.add(row.variant_id, 'uuid')}, ${sql.add(row.on_hand)}, NULL, '')`,
        );
        await tx.query(
          `INSERT INTO "inventory_stockcountitem"
             (id, created_at, updated_at, stock_count_id, variant_id, expected_quantity,
              counted_quantity, notes)
           VALUES ${values.join(', ')}`,
          sql.values,
        );
      }
    });
    const row = await this.find(user, id);
    return (await this.serialise([row], false))[0];
  }

  /**
   * `update` and `partial_update`: branch and notes through the serializer,
   * then `instance.save()` -- every column written back from the row as it
   * was read (D126).
   */
  async update(row: CountRow, data: unknown, partial: boolean) {
    const validated = await runSerializer<{ branch?: string; notes?: string }>(
      this.fields(),
      data,
      { partial },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const branchId = validated.values.branch ?? row.branch_id;
    const notes = validated.values.notes ?? row.notes;
    await this.db.query(
      `UPDATE ${C} SET created_at = $2, updated_at = clock_timestamp(), number = $3,
              branch_id = $4::uuid, status = $5, notes = $6, created_by_id = $7::uuid,
              applied_at = $8, applied_by_id = $9::uuid
        WHERE ${C}."id" = $1::uuid`,
      [
        row.id,
        row.created_at,
        row.number,
        branchId,
        row.status,
        notes,
        row.created_by_id,
        row.applied_at,
        row.applied_by_id,
      ],
    );
    const code = (
      await this.db.one<{ code: string }>(`SELECT code FROM accounts_branch WHERE id = $1::uuid`, [
        branchId,
      ])
    )?.code as string;
    return (await this.serialise([{ ...row, branch_id: branchId, notes, b_code: code }], false))[0];
  }

  /** `destroy`: the count and its lines (`CASCADE`). */
  async destroy(row: CountRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `DELETE FROM "inventory_stockcountitem" WHERE "inventory_stockcountitem"."stock_count_id" IN ($1::uuid)`,
        [row.id],
      );
      await tx.query(`DELETE FROM ${C} WHERE ${C}."id" IN ($1::uuid)`, [row.id]);
    });
  }

  /** `record`: what was on the shelf, written onto the sheet while it is being counted. */
  async record(row: CountRow, data: unknown) {
    if (row.status !== 'COUNTING') {
      const label = (COUNT_STATUS_LABELS[row.status] ?? row.status).toLowerCase();
      throw new Conflict(
        `${row.number} is ${label}; figures can only be recorded while it is still being counted.`,
        { details: { status: row.status } },
      );
    }
    // `count.items.count()` reads the prefetch get_object made.
    const total = (await this.items([row.id], true)).length;
    const validated = await runSerializer<{
      lines: { variant: string; counted_quantity: number; notes: string }[];
    }>(
      {
        lines: nestedListField(
          {
            variant: uuidField(),
            counted_quantity: integerField({ minValue: 0 }),
            notes: withDefault(
              charField({ maxLength: 255, required: false, allowBlank: true }),
              () => '',
            ),
          },
          { allowEmpty: false },
        ),
      },
      data,
      {
        hooks: {
          // `validate_lines`.
          lines: (lines: { variant: string }[]) => {
            const seen = new Set<string>();
            for (const line of lines) {
              if (seen.has(line.variant))
                throw Invalid.of(`${line.variant} appears twice; send one figure per variant.`);
              seen.add(line.variant);
            }
            return lines;
          },
        },
      },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const byVariant = new Map(validated.values.lines.map((line) => [line.variant, line]));
    const sql = new SqlParams();
    const items = await this.db.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM "inventory_stockcountitem"
        WHERE ("inventory_stockcountitem"."stock_count_id" = ${sql.add(row.id, 'uuid')}
          AND "inventory_stockcountitem"."variant_id" IN ${sql.list([...byVariant.keys()], 'uuid')})`,
      sql.values,
    );
    if (items.length !== byVariant.size) {
      const found = new Set(items.map((item) => item.variant_id));
      throw new ValidationError('Some variants are not on this count sheet.', {
        details: {
          unknown: [...byVariant.keys()].filter((id) => !found.has(id)).sort(compareCodePoints),
        },
      });
    }
    // `bulk_update`: the figure and the note; `updated_at` is written back unchanged.
    await this.db.transaction(async (tx) => {
      for (const item of items) {
        const line = byVariant.get(item.variant_id) as { counted_quantity: number; notes: string };
        await tx.query(
          `UPDATE "inventory_stockcountitem" SET counted_quantity = $2, notes = $3 WHERE id = $1::uuid`,
          [item.id, line.counted_quantity, line.notes],
        );
      }
    });
    const counted = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM "inventory_stockcountitem"
            WHERE ("inventory_stockcountitem"."stock_count_id" = $1::uuid
              AND "inventory_stockcountitem"."counted_quantity" IS NOT NULL)`,
          [row.id],
        )
      )?.count ?? 0,
    );
    return { recorded: items.length, counted, total };
  }

  /** `cancel`: abandon a count that has not been applied, touching no stock. */
  async cancel(row: CountRow) {
    if (row.status === 'APPLIED') {
      throw new Conflict(
        `${row.number} has already been applied; its adjustments are in the ledger.`,
        { details: { status: row.status } },
      );
    }
    await this.db.query(
      `UPDATE ${C} SET status = 'CANCELLED', updated_at = clock_timestamp() WHERE ${C}."id" = $1::uuid`,
      [row.id],
    );
    return (await this.serialise([{ ...row, status: 'CANCELLED' }]))[0];
  }

  /** `apply`: `apply_stock_count`. */
  async apply(row: CountRow, actor: AuditActor, context: AuditContext) {
    const applied = await this.stock.run((tx, after) =>
      this.stock.applyStockCount(tx, after, context, row.id, actor),
    );
    return { adjusted_lines: applied, status: 'APPLIED' };
  }
}
