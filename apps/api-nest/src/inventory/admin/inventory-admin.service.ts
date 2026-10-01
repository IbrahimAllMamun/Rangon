import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { branchCondition, RolePermissions } from '../../auth/permissions';
import { CataloguePayloads, type VariantRow } from '../../catalog/admin/catalogue-payloads';
import type { AuditActor, AuditContext } from '../../common/audit';
import { localIso } from '../../common/datetime';
import { Dec } from '../../common/decimal';
import {
  charField,
  choiceField,
  errorMessages,
  integerField,
  runSerializer,
  uuidField,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import { applyFilters, modelFilter, orderingFrom } from '../../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../../common/pagination';
import { PyFloat, pyStr } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { dataGet, isDict, pyIntOf, pythonTypeName, pyTruthy } from '../../http/request-body';
import { StockService } from '../stock.service';
import { LedgerEntries } from './ledger-entries.service';

/**
 * `inventory.api.views.InventoryViewSet`: stock positions per branch, and
 * the admin's ways of moving them -- each through `StockService`, never by
 * writing the cached columns.
 *
 * The list and detail read Django's own statement (every column of the
 * inventory row, its branch, variant, product and category, and whether the
 * branch has ever received the variant), so rows that tie under `?ordering=`
 * come back in the order PostgreSQL gives Django.
 */

const I = '"inventory_inventory"';

const COLUMNS: [table: string, prefix: string, columns: string[]][] = [
  [
    I,
    '',
    [
      'id',
      'created_at',
      'updated_at',
      'branch_id',
      'variant_id',
      'on_hand',
      'reserved',
      'average_cost',
      'reorder_point',
      'bin_location',
    ],
  ],
  [
    '"accounts_branch"',
    'b_',
    [
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
    ],
  ],
  [
    '"catalog_productvariant"',
    'v_',
    [
      'id',
      'created_at',
      'updated_at',
      'product_id',
      'sku',
      'barcode',
      'name',
      'price',
      'compare_at_price',
      'cost',
      'weight_grams',
      'position',
      'status',
      'batch_number',
      'expiry_date',
    ],
  ],
  [
    '"catalog_product"',
    'p_',
    [
      'id',
      'created_at',
      'updated_at',
      'name',
      'slug',
      'category_id',
      'brand_id',
      'short_description',
      'description',
      'material',
      'care_instructions',
      'status',
      'published',
      'featured',
      'is_final_sale',
      'size_chart_id',
      'seo_title',
      'seo_description',
      'created_by_id',
    ],
  ],
  [
    '"catalog_category"',
    'c_',
    [
      'id',
      'created_at',
      'updated_at',
      'parent_id',
      'name',
      'slug',
      'description',
      'image',
      'position',
      'is_active',
      'show_in_navigation',
      'tax_rate',
      'seo_title',
      'seo_description',
    ],
  ],
];

const column = (table: string, prefix: string, name: string) =>
  `${table}."${name}" AS "${prefix}${name}"`;

const RECEIVED = `EXISTS(SELECT 1 AS "a" FROM "inventory_inventorytransaction" U0
  WHERE (U0."branch_id" = (${I}."branch_id") AND U0."transaction_type" IN ('TRANSFER_IN', 'PURCHASE')
    AND U0."variant_id" = (${I}."variant_id")) LIMIT 1) AS "received"`;

const [own, ...related] = COLUMNS as [(typeof COLUMNS)[number], ...typeof COLUMNS];
const SELECT = [
  ...own[2].map((name) => column(own[0], own[1], name)),
  RECEIVED,
  ...related.flatMap(([table, prefix, names]) => names.map((name) => column(table, prefix, name))),
].join(', ');

const INTEGRITY_SELECT = COLUMNS.slice(0, 3)
  .flatMap(([table, prefix, names]) => names.map((name) => column(table, prefix, name)))
  .join(', ');

const FROM = `FROM ${I}
  INNER JOIN "accounts_branch" ON (${I}."branch_id" = "accounts_branch"."id")
  INNER JOIN "catalog_productvariant" ON (${I}."variant_id" = "catalog_productvariant"."id")
  INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
  INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")`;

const FILTERS = [
  modelFilter('branch', `${I}."branch_id"`, 'accounts_branch'),
  modelFilter('variant', `${I}."variant_id"`, 'catalog_productvariant'),
];
const ORDERING = { on_hand: `${I}."on_hand"`, updated_at: `${I}."updated_at"` };

interface InventoryRow {
  id: string;
  updated_at: string;
  branch_id: string;
  variant_id: string;
  on_hand: number;
  reserved: number;
  average_cost: string;
  reorder_point: number;
  bin_location: string;
  received: boolean;
  b_code: string;
  v_sku: string;
  v_barcode: string | null;
  v_name: string;
  v_price: string;
  p_name: string;
  c_name: string;
}

/** What the serializer reads `reorder_point` and `bin_location` from: the instance, as set. */
interface Overrides {
  reorderPoint?: unknown;
  binLocation?: unknown;
  updatedAt?: string;
}

/** Django's `prep_for_like_query`: a literal inside `LIKE '%...%'`. */
function likeContains(text: string): string {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/** Python `key in container`, for whatever `request.data` was parsed as. */
function pyContains(container: unknown, key: string): boolean {
  if (isDict(container)) return Object.hasOwn(container, key);
  if (Array.isArray(container)) return container.some((item) => item === key);
  if (typeof container === 'string') return container.includes(key);
  throw new TypeError(`argument of type '${pythonTypeName(container)}' is not iterable`);
}

/** Python `container[key]`: a dict's value, or the TypeError a list or str raises. */
function pyGetItem(container: unknown, key: string): unknown {
  if (isDict(container)) return container[key];
  throw new TypeError(`${pythonTypeName(container)} indices must be integers`);
}

/** `int(value)` as the serializer's `IntegerField.to_representation` applies it. */
function representInt(value: unknown): number | bigint {
  const parsed = pyIntOf(value);
  return parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(parsed)
    : parsed;
}

/** `available <= reorder_point` with the instance's value as set: a str is a TypeError. */
function atOrBelow(available: number, reorderPoint: unknown): boolean {
  if (typeof reorderPoint === 'boolean') return available <= Number(reorderPoint);
  if (typeof reorderPoint === 'number' || typeof reorderPoint === 'bigint')
    return available <= reorderPoint;
  if (reorderPoint instanceof PyFloat) return available <= reorderPoint.value;
  throw new TypeError(
    `'<=' not supported between instances of 'int' and '${pythonTypeName(reorderPoint)}'`,
  );
}

/** A count PostgreSQL sums as `bigint`: Python's int. */
function pgInt(text: string | null): number | bigint | null {
  if (text === null) return null;
  const value = BigInt(text);
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/** A `numeric` straight into a response dict: DRF's encoder writes `float(value)`. */
function pgFloat(text: string | null): PyFloat | null {
  return text === null ? null : new PyFloat(Number(text));
}

/**
 * `DecimalField(max_digits=16, decimal_places=2).to_representation` of
 * `average_cost * on_hand`: Python's sign rules (nothing times a shortfall
 * is `-0.00`), and more than sixteen digits is the `InvalidOperation` it raises.
 */
function stockValue(averageCost: string, onHand: number): string {
  const value = new Dec(averageCost).times(onHand);
  const negative = value.isNegative() || (value.isZero() && onHand < 0);
  const text = value.abs().toFixed(2);
  if (text.replace('.', '').replace(/^0+(?=\d)/, '').length > 16)
    throw new Error('decimal.InvalidOperation: stock value exceeds max_digits');
  return negative ? `-${text}` : text;
}

@Injectable()
export class InventoryAdminService {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    private readonly permissions: RolePermissions,
    private readonly stock: StockService,
    private readonly ledger: LedgerEntries,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `get_queryset`: the user's branches, the `filter`, `category` and `search` parameters. */
  private scope(user: RequestUser, query: QueryDict, sql: SqlParams) {
    const where: string[] = [];
    const scope = branchCondition(user, [`${I}."branch_id"`], sql.values.length + 1);
    if (scope) {
      sql.values.push(...scope.values);
      where.push(scope.sql);
    }
    let order = [`"catalog_product"."name" ASC`, `"catalog_productvariant"."position" ASC`];
    const filter = query.get('filter');
    if (filter === 'low-stock') where.push(`${I}."on_hand" <= (${I}."reorder_point")`);
    else if (filter === 'out-of-stock') where.push(`${I}."on_hand" <= (${I}."reserved")`);
    else if (filter === 'expiring') {
      where.push(`"catalog_productvariant"."expiry_date" IS NOT NULL`);
      order = [`"catalog_productvariant"."expiry_date" ASC`];
    }
    const category = query.get('category');
    if (category) where.push(`"catalog_category"."slug" = ${sql.add(category)}`);
    const search = query.get('search');
    if (search) {
      const like = sql.add(likeContains(search));
      where.push(
        `(UPPER("catalog_productvariant"."sku"::text) LIKE UPPER(${like})
          OR "catalog_productvariant"."barcode" = ${sql.add(search)}
          OR UPPER("catalog_product"."name"::text) LIKE UPPER(${like}))`,
      );
    }
    return { where, order: [...order, `${I}."id" ASC`] };
  }

  private async serialise(
    rows: InventoryRow[],
    overrides: Overrides = {},
  ): Promise<Record<string, unknown>[]> {
    const links = await this.payloads.links([...new Set(rows.map((row) => row.variant_id))]);
    return rows.map((row) => {
      const available = row.on_hand - row.reserved;
      const reorderPoint = 'reorderPoint' in overrides ? overrides.reorderPoint : row.reorder_point;
      const binLocation = 'binLocation' in overrides ? overrides.binLocation : row.bin_location;
      return {
        id: row.id,
        branch: row.branch_id,
        branch_code: row.b_code,
        variant: row.variant_id,
        sku: row.v_sku,
        barcode: row.v_barcode,
        product_name: row.p_name,
        variant_label: this.payloads.label(
          { id: row.variant_id, name: row.v_name } as VariantRow,
          links,
        ),
        category: row.c_name,
        on_hand: row.on_hand,
        reserved: row.reserved,
        available,
        average_cost: row.average_cost,
        price: row.v_price,
        stock_value: stockValue(row.average_cost, row.on_hand),
        reorder_point: representInt(reorderPoint),
        is_low_stock: atOrBelow(available, reorderPoint),
        bin_location: typeof binLocation === 'string' ? binLocation : pyStr(binLocation),
        received: row.received,
        updated_at: localIso(overrides.updatedAt ?? row.updated_at, this.env.DJANGO_TIME_ZONE),
      };
    });
  }

  private async page(
    user: RequestUser,
    query: QueryDict,
    absoluteUrl: string,
    options: { filters: boolean; lowStock: boolean },
  ) {
    const sql = new SqlParams();
    const { where, order: defaultOrder } = this.scope(user, query, sql);
    if (options.lowStock) where.push(`${I}."on_hand" <= (${I}."reorder_point")`);
    let order = defaultOrder;
    if (options.filters) {
      await applyFilters(this.db, query, FILTERS, sql, where);
      order = orderingFrom(query, ORDERING) ?? defaultOrder;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${FROM} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = count
      ? await this.db.query<InventoryRow>(
          `SELECT ${SELECT} ${FROM} ${whereSql} ORDER BY ${order.join(', ')}
            LIMIT ${page.limit}${page.offset ? ` OFFSET ${page.offset}` : ''}`,
          sql.values,
        )
      : [];
    return { page, results: await this.serialise(rows) };
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const { page, results } = await this.page(user, query, absoluteUrl, {
      filters: true,
      lowStock: false,
    });
    return paginated(page, results, absoluteUrl);
  }

  /**
   * `low_stock`: `get_queryset()` (not `filter_queryset`) at or below the
   * reorder point. An empty page is answered as a bare list, unpaginated.
   */
  async lowStock(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const { page, results } = await this.page(user, query, absoluteUrl, {
      filters: false,
      lowStock: true,
    });
    return results.length ? paginated(page, results, absoluteUrl) : [];
  }

  /** `get_object`: the list's conditions, then the row. */
  async find(user: RequestUser, pk: string, query: QueryDict): Promise<InventoryRow> {
    const sql = new SqlParams();
    const { where } = this.scope(user, query, sql);
    await applyFilters(this.db, query, FILTERS, sql, where);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${I}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<InventoryRow>(
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
   * `update`: only the reorder point and the bin, taken from the body as
   * they are -- no serializer -- and saved with `int()` and `str()`, which is
   * all Django's model fields do on the way to the database. The answer
   * reads the instance as set: a reorder point sent as a string is saved and
   * then fails `is_low_stock`, a 500 after the commit, as in the Django API.
   */
  async update(row: InventoryRow, data: unknown) {
    const set: Overrides = {};
    if (pyContains(data, 'reorder_point')) set.reorderPoint = pyGetItem(data, 'reorder_point');
    if (pyContains(data, 'bin_location')) set.binLocation = pyGetItem(data, 'bin_location');
    const reorderPoint = 'reorderPoint' in set ? set.reorderPoint : row.reorder_point;
    const binLocation = 'binLocation' in set ? set.binLocation : row.bin_location;
    // `get_db_prep_save`, field by field in the model's order.
    // `IntegerField.get_prep_value`: `int()`, its failure a 500.
    const reorderValue =
      reorderPoint === null || reorderPoint === undefined ? null : pyIntOf(reorderPoint).toString();
    const binValue =
      binLocation === null || binLocation === undefined
        ? null
        : typeof binLocation === 'string'
          ? binLocation
          : pyStr(binLocation);
    const saved = await this.db.one<{ updated_at: string }>(
      `UPDATE ${I} SET "updated_at" = clock_timestamp(), "reorder_point" = $2, "bin_location" = $3
        WHERE ${I}."id" = $1::uuid RETURNING "updated_at"`,
      [row.id, reorderValue, binValue],
    );
    if (!saved) throw new Error('Save with update_fields did not affect any rows.');
    return (
      await this.serialise([row], {
        reorderPoint,
        binLocation,
        updatedAt: saved.updated_at,
      })
    )[0];
  }

  /** `AdjustStockSerializer`, then `inventory.services.adjust`. */
  async adjust(user: RequestUser, data: unknown, actor: AuditActor, context: AuditContext) {
    const validated = await runSerializer<{
      variant: string;
      branch?: string;
      new_on_hand: number | bigint;
      reason: string;
    }>(
      {
        variant: uuidField(),
        branch: uuidField({ required: false }),
        new_on_hand: integerField({ minValue: 0 }),
        reason: charField({ maxLength: 255 }),
      },
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const values = validated.values;
    const branch = await this.permissions.resolveBranch(user, values.branch);
    const entry = await this.stock.run((tx, after) =>
      this.stock.adjust(tx, after, context, {
        branch,
        variantId: values.variant,
        newOnHand: values.new_on_hand,
        reason: values.reason,
        actor,
      }),
    );
    if (!entry) return { status: 200, body: { detail: 'Stock already matches that figure.' } };
    return { status: 201, body: await this.ledger.entry(entry.id) };
  }

  /** `WriteOffSerializer`, then `inventory.services.write_off`, keyed by `Idempotency-Key`. */
  async writeOff(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    actor: AuditActor,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{
      variant: string;
      branch?: string;
      quantity: number | bigint;
      transaction_type: string;
      reason: string;
      notes?: string;
    }>(
      {
        variant: uuidField(),
        branch: uuidField({ required: false }),
        quantity: integerField({ minValue: 1 }),
        transaction_type: choiceField(['DAMAGE', 'LOSS']),
        reason: charField({ maxLength: 255 }),
        notes: charField({ required: false, allowBlank: true }),
      },
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const values = validated.values;
    const branch = await this.permissions.resolveBranch(user, values.branch);
    const entry = await this.stock.run((tx, after) =>
      this.stock.writeOff(tx, after, context, {
        branch,
        variantId: values.variant,
        quantity: values.quantity,
        type: values.transaction_type,
        reason: values.reason,
        notes: values.notes ?? '',
        actor,
        idempotencyKey,
      }),
    );
    return this.ledger.entry(entry.id);
  }

  /** `valuation`: stock at weighted average cost, and at retail, per branch. */
  async valuation(user: RequestUser) {
    const sql = new SqlParams();
    const where: string[] = [];
    const scope = branchCondition(user, [`${I}."branch_id"`], 1);
    if (scope) {
      sql.values.push(...scope.values);
      where.push(scope.sql);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totals = (await this.db.one<{
      units: string | null;
      value: string | null;
      retail: string | null;
    }>(
      `SELECT SUM(${I}."on_hand") AS "units", SUM((${I}."on_hand" * ${I}."average_cost")) AS "value",
              SUM((${I}."on_hand" * "catalog_productvariant"."price")) AS "retail"
         FROM ${I} INNER JOIN "catalog_productvariant" ON (${I}."variant_id" = "catalog_productvariant"."id")
        ${whereSql}`,
      sql.values,
    )) as { units: string | null; value: string | null; retail: string | null };
    const byBranch = await this.db.query<{
      code: string;
      name: string;
      units: string | null;
      value: string | null;
    }>(
      `SELECT "accounts_branch"."code", "accounts_branch"."name", SUM(${I}."on_hand") AS "units",
              SUM((${I}."on_hand" * ${I}."average_cost")) AS "value"
         FROM ${I} INNER JOIN "accounts_branch" ON (${I}."branch_id" = "accounts_branch"."id")
        ${whereSql}
        GROUP BY "accounts_branch"."code", "accounts_branch"."name"`,
      sql.values,
    );
    return {
      totals: {
        units: pgInt(totals.units),
        value: pgFloat(totals.value),
        retail: pgFloat(totals.retail),
      },
      by_branch: byBranch.map((row) => ({
        branch__code: row.code,
        branch__name: row.name,
        units: pgInt(row.units),
        value: pgFloat(row.value),
      })),
    };
  }

  /** `verify_integrity`: replay the ledger against the cached columns. */
  async verifyIntegrity(user: RequestUser, data: unknown) {
    const requested = dataGet(data, 'branch');
    const branch = pyTruthy(requested)
      ? await this.permissions.resolveBranch(user, dataGet(data, 'branch'))
      : null;
    const ledger = await this.db.query<{
      branch_id: string;
      variant_id: string;
      on_hand: string | null;
      reserved: string | null;
    }>(
      `SELECT "inventory_inventorytransaction"."branch_id", "inventory_inventorytransaction"."variant_id",
              SUM("inventory_inventorytransaction"."quantity") FILTER (WHERE NOT ("inventory_inventorytransaction"."transaction_type" IN ('RESERVATION_RELEASE', 'RESERVATION'))) AS "on_hand",
              SUM("inventory_inventorytransaction"."quantity") FILTER (WHERE "inventory_inventorytransaction"."transaction_type" IN ('RESERVATION_RELEASE', 'RESERVATION')) AS "reserved"
         FROM "inventory_inventorytransaction"
        ${branch ? 'WHERE "inventory_inventorytransaction"."branch_id" = $1::uuid' : ''}
        GROUP BY "inventory_inventorytransaction"."branch_id", "inventory_inventorytransaction"."variant_id"`,
      branch ? [branch.id] : [],
    );
    const totals = new Map(
      ledger.map((row) => [
        `${row.branch_id} ${row.variant_id}`,
        [pgInt(row.on_hand) ?? 0, pgInt(row.reserved) ?? 0] as const,
      ]),
    );
    // Django's statement, every column of the three tables: the issues come
    // back in the order PostgreSQL returns the rows.
    const inventories = await this.db.query<InventoryRow>(
      `SELECT ${INTEGRITY_SELECT} FROM ${I}
         INNER JOIN "accounts_branch" ON (${I}."branch_id" = "accounts_branch"."id")
         INNER JOIN "catalog_productvariant" ON (${I}."variant_id" = "catalog_productvariant"."id")
        ${branch ? `WHERE ${I}."branch_id" = $1::uuid` : ''}`,
      branch ? [branch.id] : [],
    );
    const issues: Record<string, unknown>[] = [];
    for (const inventory of inventories) {
      const [onHand, reserved] = totals.get(`${inventory.branch_id} ${inventory.variant_id}`) ?? [
        0, 0,
      ];
      // Python compares ints exactly, a bigint sum included.
      if (
        BigInt(inventory.on_hand) !== BigInt(onHand) ||
        BigInt(inventory.reserved) !== BigInt(reserved)
      ) {
        issues.push({
          sku: inventory.v_sku,
          branch: inventory.b_code,
          cached_on_hand: inventory.on_hand,
          ledger_on_hand: onHand,
          cached_reserved: inventory.reserved,
          ledger_reserved: reserved,
        });
      }
    }
    return { clean: !issues.length, issue_count: issues.length, issues };
  }
}
