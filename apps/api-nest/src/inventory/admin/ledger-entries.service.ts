import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { branchCondition } from '../../auth/permissions';
import { CataloguePayloads, type VariantRow } from '../../catalog/admin/catalogue-payloads';
import { parseWindow } from '../../common/dates';
import { localIso } from '../../common/datetime';
import { NotFound, ValidationError } from '../../common/errors';
import {
  applyFilters,
  charFilter,
  choiceFilter,
  modelFilter,
  orderingFrom,
} from '../../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../../common/pagination';
import { compareCodePoints, pyStrip } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { TRANSACTION_LABELS, TRANSACTION_TYPES } from '../stock.service';

/**
 * `InventoryTransactionViewSet` and `InventoryTransactionSerializer`: the
 * stock ledger, newest first, each row with the document that caused it.
 *
 * The list reads the shop's date window (`core.dates`), a family of
 * movement types (`types=DAMAGE,LOSS`) and a search over SKU and product
 * name; django-filter takes branch, variant, type and reference type; and
 * only `created_at` may be ordered by. A branch-bound user sees their own
 * branch's rows.
 */

const T = '"inventory_inventorytransaction"';

const FILTERS = [
  modelFilter('branch', `${T}."branch_id"`, 'accounts_branch'),
  modelFilter('variant', `${T}."variant_id"`, 'catalog_productvariant'),
  choiceFilter('transaction_type', `${T}."transaction_type"`, TRANSACTION_TYPES),
  charFilter('reference_type', `${T}."reference_type"`),
];

const COLUMNS = {
  [T]: [
    'id',
    'created_at',
    'updated_at',
    'branch_id',
    'variant_id',
    'transaction_type',
    'quantity',
    'unit_cost',
    'on_hand_after',
    'reserved_after',
    'reference_type',
    'reference_id',
    'reason',
    'notes',
    'created_by_id',
    'idempotency_key',
  ],
  '"accounts_branch"': ['code'],
  '"catalog_productvariant"': ['sku', 'name', 'product_id'],
  '"catalog_product"': ['name'],
  '"accounts_user"': ['email'],
} as const;

const PREFIX: Record<string, string> = {
  [T]: '',
  '"accounts_branch"': 'b_',
  '"catalog_productvariant"': 'v_',
  '"catalog_product"': 'p_',
  '"accounts_user"': 'u_',
};

const SELECT = Object.entries(COLUMNS)
  .flatMap(([table, columns]) =>
    columns.map((column) => `${table}."${column}" AS "${PREFIX[table]}${column}"`),
  )
  .join(', ');

const FROM = `FROM ${T}
  INNER JOIN "accounts_branch" ON (${T}."branch_id" = "accounts_branch"."id")
  INNER JOIN "catalog_productvariant" ON (${T}."variant_id" = "catalog_productvariant"."id")
  INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
  LEFT OUTER JOIN "accounts_user" ON (${T}."created_by_id" = "accounts_user"."id")`;

const ORDERING = { created_at: `${T}."created_at"` };
const DEFAULT_ORDER = [`${T}."created_at" DESC`, `${T}."id" DESC`];

export interface LedgerRow {
  id: string;
  created_at: string;
  branch_id: string;
  variant_id: string;
  transaction_type: string;
  quantity: number;
  unit_cost: string | null;
  on_hand_after: number;
  reserved_after: number;
  reference_type: string;
  reference_id: string;
  reason: string;
  notes: string;
  created_by_id: string | null;
  b_code: string;
  v_sku: string;
  v_name: string;
  v_product_id: string;
  p_name: string;
  u_email: string | null;
}

interface Document {
  kind: string;
  id: string;
  label: string;
}

/** `documents._RESOLVERS`: what each kind of reference opens, and how it is labelled. */
const RESOLVERS: Record<
  string,
  { sql: string; document: (row: Record<string, string>) => Document }
> = {
  order: numbered('orders_order', 'order'),
  order_void: numbered('orders_order', 'order', ' (voided)'),
  return: numbered('orders_returnrequest', 'return'),
  purchase_receipt: onPurchaseOrder('purchasing_purchasereceipt'),
  purchase_return: onPurchaseOrder('purchasing_purchasereturn'),
  stock_count: numbered('inventory_stockcount', 'stock_count'),
  stock_transfer: numbered('inventory_stocktransfer', 'stock_transfer'),
};

function numbered(table: string, kind: string, suffix = '') {
  return {
    sql: `SELECT "id"::text AS "id", "number" FROM "${table}" WHERE "id" = ANY($1::uuid[])`,
    document: (row: Record<string, string>) => ({
      kind,
      id: row.id as string,
      label: `${row.number}${suffix}`,
    }),
  };
}

function onPurchaseOrder(table: string) {
  return {
    sql: `SELECT r."id"::text AS "id", r."number", r."purchase_order_id"::text AS "order_id",
                 o."number" AS "order_number"
            FROM "${table}" r JOIN "purchasing_purchaseorder" o ON o."id" = r."purchase_order_id"
           WHERE r."id" = ANY($1::uuid[])`,
    document: (row: Record<string, string>) => ({
      kind: 'purchase_order',
      id: row.order_id as string,
      label: `${row.order_number} · ${row.number}`,
    }),
  };
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Django's `prep_for_like_query`: a literal inside `LIKE '%...%'`. */
function likeContains(text: string): string {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

@Injectable()
export class LedgerEntries {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `get_queryset` then `filter_queryset`: the conditions every read applies. */
  private async conditions(user: RequestUser, query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    const scope = branchCondition(user, [`${T}."branch_id"`], sql.values.length + 1);
    if (scope) {
      sql.values.push(...scope.values);
      where.push(scope.sql);
    }
    const [from, to] = parseWindow(query, this.env.DJANGO_TIME_ZONE);
    if (from) where.push(`${T}."created_at" >= ${sql.add(from, 'timestamptz')}`);
    if (to) where.push(`${T}."created_at" <= ${sql.add(to, 'timestamptz')}`);

    const types = query.get('types');
    if (types) {
      const wanted = new Set(
        types
          .split(',')
          .filter((part) => pyStrip(part))
          .map((part) => pyStrip(part).toUpperCase()),
      );
      const unknown = [...wanted]
        .filter((type) => !(TRANSACTION_TYPES as readonly string[]).includes(type))
        .sort(compareCodePoints);
      if (unknown.length) {
        throw new ValidationError(`Unknown movement type: ${unknown.join(', ')}.`, {
          details: { types: [`Choose from ${TRANSACTION_TYPES.join(', ')}.`] },
        });
      }
      // `transaction_type__in=set()` matches nothing.
      where.push(wanted.size ? `${T}."transaction_type" IN ${sql.list([...wanted])}` : 'FALSE');
    }

    const search = pyStrip(query.get('search', ''));
    if (search) {
      const like = sql.add(likeContains(search));
      where.push(
        `(UPPER("catalog_productvariant"."sku"::text) LIKE UPPER(${like})
          OR UPPER("catalog_product"."name"::text) LIKE UPPER(${like}))`,
      );
    }
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? DEFAULT_ORDER;
    const pageSize = pageSizeFrom(query, STANDARD_PAGINATION);
    const count = where.includes('FALSE')
      ? 0
      : Number(
          (
            await this.db.one<{ count: string }>(
              `SELECT COUNT(*) AS "count" ${FROM} ${whereSql}`,
              sql.values,
            )
          )?.count ?? 0,
        );
    const page = resolvePage(query, count, pageSize);
    const rows = count
      ? await this.db.query<LedgerRow>(
          `SELECT ${SELECT} ${FROM} ${whereSql} ORDER BY ${order.join(', ')}
            LIMIT ${page.limit}${page.offset ? ` OFFSET ${page.offset}` : ''}`,
          sql.values,
        )
      : [];
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  /** `retrieve`: the same conditions, then the row. */
  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id || where.includes('FALSE')) throw new NotFound();
    where.push(`${T}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<LedgerRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return (await this.serialise([row]))[0];
  }

  /** One row as a write answers it: `InventoryTransactionSerializer(entry).data`. */
  async entry(id: string, q: Queryable = this.db): Promise<Record<string, unknown>> {
    const row = await q.one<LedgerRow>(`SELECT ${SELECT} ${FROM} WHERE ${T}."id" = $1::uuid`, [id]);
    return (await this.serialise([row as LedgerRow], q))[0] as Record<string, unknown>;
  }

  /** `documents.resolve(rows)`: one query per kind of document on the page. */
  private async documents(rows: LedgerRow[], q: Queryable): Promise<Map<string, Document>> {
    const wanted = new Map<string, Set<string>>();
    for (const row of rows) {
      // A reference that is not a UUID has no link; one in another spelling
      // is looked up but keyed by its canonical form, so it finds nothing.
      if (!Object.hasOwn(RESOLVERS, row.reference_type)) continue;
      if (!CANONICAL_UUID.test(row.reference_id)) continue;
      const ids = wanted.get(row.reference_type) ?? new Set<string>();
      ids.add(row.reference_id);
      wanted.set(row.reference_type, ids);
    }
    const found = new Map<string, Document>();
    for (const [type, ids] of wanted) {
      const resolver = RESOLVERS[type] as (typeof RESOLVERS)[string];
      for (const row of await q.query<Record<string, string>>(resolver.sql, [[...ids]])) {
        found.set(`${type} ${row.id}`, resolver.document(row));
      }
    }
    return found;
  }

  async serialise(rows: LedgerRow[], q: Queryable = this.db): Promise<Record<string, unknown>[]> {
    const links = await this.payloads.links([...new Set(rows.map((row) => row.variant_id))], q);
    const documents = await this.documents(rows, q);
    return rows.map((row) => ({
      id: row.id,
      branch: row.branch_id,
      branch_code: row.b_code,
      variant: row.variant_id,
      variant_label: this.payloads.label(
        { id: row.variant_id, name: row.v_name } as VariantRow,
        links,
      ),
      product: row.v_product_id,
      sku: row.v_sku,
      product_name: row.p_name,
      transaction_type: row.transaction_type,
      transaction_type_label: TRANSACTION_LABELS[row.transaction_type] ?? row.transaction_type,
      quantity: row.quantity,
      unit_cost: row.unit_cost,
      on_hand_after: row.on_hand_after,
      reserved_after: row.reserved_after,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
      document: documents.get(`${row.reference_type} ${row.reference_id}`) ?? null,
      reason: row.reason,
      notes: row.notes,
      created_by: row.created_by_id,
      created_by_email: row.u_email ?? '',
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
    }));
  }
}
