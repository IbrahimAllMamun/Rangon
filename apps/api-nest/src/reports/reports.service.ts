import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { canCrossBranch } from '../auth/permissions';
import { money, quantize, ZERO } from '../checkout/pricing';
import { pyIsoformat, utcIso } from '../common/datetime';
import { Dec } from '../common/decimal';
import { invalidUuid, NotFound, PermissionDenied } from '../common/errors';
import { PyFloat } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { type DateRange, localOrdinal, MAX_ORDINAL, momentJson, ordinalDate } from './date-range';

/**
 * `reports.services`: every figure aggregated in the database, by the
 * statements Django sends -- a sum of unrounded shares, a `ROUND(..., 2)`, a
 * tie under `ORDER BY 3 DESC LIMIT 10` come out as PostgreSQL makes them, so
 * the statements are Django's own. What Python then does with the numbers
 * (`quantize`, a margin, a share) is done here with `Dec`, in its context.
 *
 * A report's values keep their Python type until they are written: a
 * `Decimal` is a string in JSON and its own text in a CSV cell, a datetime
 * `isoformat()` with a `Z` in one and `str()` in the other.
 */

/** A `Decimal`, as Python's `str()` prints it. */
export class Dcm {
  constructor(readonly text: string) {}
}

/** An aware datetime read from a `timestamptz` column: UTC. */
export class Moment {
  constructor(readonly pg: string) {}
}

export type Cell = string | number | bigint | null | Dcm | Moment;
export type Row = Record<string, Cell>;
export type Payload = { [key: string]: Cell | Payload | Row[] | Payload[] };

/** What DRF's JSON encoder writes: a Decimal as a string (`_json_safe`), or bare, as a float. */
export function toJson(value: unknown, decimalsAsFloat = false): unknown {
  // `float(value)`, written as Python's `json` writes a float: `8230.0`.
  if (value instanceof Dcm) return decimalsAsFloat ? new PyFloat(Number(value.text)) : value.text;
  if (value instanceof Moment) return utcIso(value.pg);
  if (Array.isArray(value)) return value.map((item) => toJson(item, decimalsAsFloat));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJson(item, decimalsAsFloat)]),
    );
  }
  return value;
}

/** What `csv.writer` writes for a cell: `str(value)`, and nothing for `None`. */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (value instanceof Dcm) return value.text;
  if (value instanceof Moment) return (pyIsoformat(value.pg) as string).replace('T', ' ');
  return String(value);
}

const O = '"orders_order"';
const I = '"orders_orderitem"';
const R = '"orders_returnrequest"';
const RI = '"orders_returnitem"';
const P = '"purchasing_purchaseorder"';
const PI = '"purchasing_purchaseorderitem"';
const PR = '"purchasing_purchasereturn"';
const PRI = '"purchasing_purchasereturnitem"';
const E = '"finance_expense"';
const EC = '"finance_expensecategory"';
const INV = '"inventory_inventory"';

/** `SOLD_STATUSES`: orders that are real trade. */
const SOLD = `('CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'REFUNDED')`;

/** A line after its share of the order's discount; unrounded, so the sum is what rounds. */
const AFTER_DISCOUNT = `CASE WHEN ${O}."subtotal" > 0.00 THEN (${I}."line_total" - ((${I}."line_total" * ${O}."discount_total") / ${O}."subtotal")) ELSE ${I}."line_total" END`;
/** `NET_LINE_REVENUE`: and with the VAT taken out where the price held it. */
const NET_LINE = `CASE WHEN ${O}."tax_mode" = 'INCLUSIVE' THEN (${AFTER_DISCOUNT} - ${I}."tax_amount") ELSE ${AFTER_DISCOUNT} END`;
/** `_net_revenue(filter=...)`. */
const netRevenue = (filter = '') =>
  `COALESCE(ROUND(SUM(${NET_LINE})${filter ? ` FILTER (WHERE ${filter})` : ''}, 2), 0.00)`;
const COGS = `COALESCE(SUM((${I}."unit_cost" * ${I}."quantity")), 0.00)`;
/** `RETURNED_LINE_VAT`, `RETURNED_LINE_BASE`, `RETURNED_PURCHASE_VAT`. */
const RETURNED_LINE_VAT = `((${I}."tax_amount" * ${RI}."quantity") / ${I}."quantity")`;
const RETURNED_LINE_BASE = `((${NET_LINE} * ${RI}."quantity") / ${I}."quantity")`;
const RETURNED_PURCHASE_VAT = `((${PRI}."unit_cost" * ${PRI}."quantity") * ${PI}."tax_rate")`;
const ITEMS_FROM = `FROM ${I} INNER JOIN ${O} ON (${I}."order_id" = ${O}."id")`;

/** `_MAX_FILLED_DAYS`. */
const MAX_FILLED_DAYS = 370;

/** A whole number from PostgreSQL: an `int4` arrives a number, an `int8` text. */
function int(value: unknown): number | bigint {
  if (typeof value === 'number') return value;
  const text = String(value);
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : BigInt(text);
}

const dcm = (value: Dec) => new Dcm(money(value));
/** `quantize(part / whole * 100) if whole else ZERO`. */
const percent = (part: Dec, whole: Dec) =>
  whole.isZero() ? ZERO : quantize(part.div(whole).times(100));

type Raw = Record<string, unknown>;

interface Scope {
  range: DateRange;
  branchId: string | null;
}

interface GrossProfit {
  revenue: Dec;
  refunds: Dec;
  netRevenue: Dec;
  cogs: Dec;
  cogsRecovered: Dec;
  netCogs: Dec;
  grossProfit: Dec;
}

interface ExpenseTotals {
  total: Dec;
  count: number | bigint;
  byCategory: {
    category_id: string;
    category: string;
    code: string;
    total: Dec;
    count: number | bigint;
    share: Dec;
  }[];
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `_branch_for(request)`: which branch to report on, or null for all. A
   * branch named is honoured only for one the caller may see (D93); one that
   * does not exist is refused, never read as "every branch".
   */
  async branchFor(user: RequestUser, query: QueryDict): Promise<string | null> {
    const crosses = canCrossBranch(user) || user.isSuperuser;
    const asked = query.get('branch');
    if (!asked) return crosses ? null : user.branchId;
    const id = parseUuid(asked);
    if (!id) throw invalidUuid(asked);
    const branch = await this.db.one<{ id: string }>(
      `SELECT "accounts_branch"."id" FROM "accounts_branch" WHERE "accounts_branch"."id" = $1::uuid
        ORDER BY "accounts_branch"."name" ASC LIMIT 1`,
      [id],
    );
    if (!branch) {
      throw new NotFound('That branch does not exist.', {
        details: { branch: ['Unknown branch.'] },
      });
    }
    if (!crosses && user.branchId && branch.id !== user.branchId) {
      throw new PermissionDenied('You may only report on your own branch.');
    }
    return branch.id;
  }

  // --- The fragments every report is built from ---------------------------------------------

  /** `sold_orders(...)`'s conditions over the orders table under `alias`. */
  private sold(sql: SqlParams, alias: string, scope: Scope, channel = ''): string {
    let where =
      `${alias}."placed_at" >= ${sql.add(scope.range.start, 'timestamptz')}` +
      ` AND ${alias}."placed_at" <= ${sql.add(scope.range.end, 'timestamptz')}` +
      ` AND ${alias}."status" IN ${SOLD}`;
    if (scope.branchId) where += ` AND ${alias}."branch_id" = ${sql.add(scope.branchId, 'uuid')}`;
    if (channel) where += ` AND ${alias}."channel" = ${sql.add(channel)}`;
    return where;
  }

  /** `order__in=orders`. */
  private soldLines(sql: SqlParams, scope: Scope): string {
    return `${I}."order_id" IN (SELECT U0."id" FROM ${O} U0 WHERE (${this.sold(sql, 'U0', scope)}))`;
  }

  /** A window on one of a table's timestamps, and the branch through `branchColumn`. */
  private window(
    sql: SqlParams,
    column: string,
    scope: Scope,
    branchColumn: string,
    between = '',
  ): string {
    return (
      `${column} >= ${sql.add(scope.range.start, 'timestamptz')}` +
      ` AND ${column} <= ${sql.add(scope.range.end, 'timestamptz')}` +
      between +
      (scope.branchId ? ` AND ${branchColumn} = ${sql.add(scope.branchId, 'uuid')}` : '')
    );
  }

  /** The returns completed in the window: as a `FROM ... WHERE`, the order joined only for a branch. */
  private completedReturns(sql: SqlParams, scope: Scope): string {
    const join = scope.branchId ? ` INNER JOIN ${O} ON (${R}."order_id" = ${O}."id")` : '';
    return `FROM ${R}${join} WHERE (${this.window(
      sql,
      `${R}."completed_at"`,
      scope,
      `${O}."branch_id"`,
      ` AND ${R}."status" = 'COMPLETED'`,
    )})`;
  }

  /** `return_request__in=completed_returns`. */
  private completedReturnLines(sql: SqlParams, scope: Scope): string {
    const join = scope.branchId ? ` INNER JOIN ${O} U1 ON (U0."order_id" = U1."id")` : '';
    return `${RI}."return_request_id" IN (SELECT U0."id" FROM ${R} U0${join} WHERE (${this.window(
      sql,
      'U0."completed_at"',
      scope,
      'U1."branch_id"',
      ` AND U0."status" = 'COMPLETED'`,
    )}))`;
  }

  /** The purchase orders raised in the window that are purchases: not drafts, not cancelled. */
  private purchased(sql: SqlParams, alias: string, scope: Scope): string {
    return this.window(
      sql,
      `${alias}."created_at"`,
      scope,
      `${alias}."branch_id"`,
      ` AND NOT (${alias}."status" IN ('DRAFT', 'CANCELLED'))`,
    );
  }

  /** `purchase_return__in=supplier_returns`. */
  private supplierReturnLines(sql: SqlParams, scope: Scope): string {
    const join = scope.branchId ? ` INNER JOIN ${P} U1 ON (U0."purchase_order_id" = U1."id")` : '';
    return `${PRI}."purchase_return_id" IN (SELECT U0."id" FROM ${PR} U0${join} WHERE (${this.window(
      sql,
      'U0."returned_at"',
      scope,
      'U1."branch_id"',
    )}))`;
  }

  private async one(text: string, sql: SqlParams): Promise<Raw> {
    return (await this.db.one<Raw>(text, sql.values)) as Raw;
  }

  private async count(text: string, sql: SqlParams): Promise<number | bigint> {
    return int((await this.one(`SELECT COUNT(*) AS "count" ${text}`, sql)).count);
  }

  private trunc(sql: SqlParams, kind: 'date' | 'month', column: string): string {
    const local = `${column} AT TIME ZONE ${sql.add(this.env.DJANGO_TIME_ZONE)}`;
    return kind === 'date' ? `(${local})::date` : `DATE_TRUNC('month', ${local})`;
  }

  /** `_gross_profit`: the window's completed returns applied to its sales. */
  private async grossProfit(scope: Scope, revenue: Dec, cogs: Dec): Promise<GrossProfit> {
    let sql = new SqlParams();
    const refunds = quantize(
      (
        await this.one(
          `SELECT COALESCE(SUM(${R}."refund_amount"), 0.00) AS "total" ${this.completedReturns(sql, scope)}`,
          sql,
        )
      ).total as string,
    );
    sql = new SqlParams();
    const cogsRecovered = quantize(
      (
        await this.one(
          `SELECT COALESCE(SUM((${I}."unit_cost" * ${RI}."quantity")), 0.00) AS "total"
             FROM ${RI} INNER JOIN ${I} ON (${RI}."order_item_id" = ${I}."id")
            WHERE (${RI}."restock_decision" = 'RESTOCK' AND ${this.completedReturnLines(sql, scope)})`,
          sql,
        )
      ).total as string,
    );
    const sold = quantize(revenue);
    const cost = quantize(cogs);
    const netRevenueValue = quantize(sold.minus(refunds));
    const netCogs = quantize(cost.minus(cogsRecovered));
    return {
      revenue: sold,
      refunds,
      netRevenue: netRevenueValue,
      cogs: cost,
      cogsRecovered,
      netCogs,
      grossProfit: quantize(netRevenueValue.minus(netCogs)),
    };
  }

  /** `finance.selectors.expense_totals`: what was spent, voids left out, and by category. */
  private async expenseTotals(scope: Scope): Promise<ExpenseTotals> {
    const where = (sql: SqlParams) =>
      `(${E}."status" = 'RECORDED'` +
      (scope.branchId ? ` AND ${E}."branch_id" = ${sql.add(scope.branchId, 'uuid')}` : '') +
      ` AND ${E}."spent_at" >= ${sql.add(scope.range.start, 'timestamptz')}` +
      ` AND ${E}."spent_at" <= ${sql.add(scope.range.end, 'timestamptz')})`;
    let sql = new SqlParams();
    const summed = await this.one(
      `SELECT SUM(${E}."amount") AS "total" FROM ${E} WHERE ${where(sql)}`,
      sql,
    );
    const total = quantize((summed.total as string | null) ?? ZERO);
    sql = new SqlParams();
    const count = await this.count(`FROM ${E} WHERE ${where(sql)}`, sql);
    sql = new SqlParams();
    const rows = await this.db.query<Raw>(
      `SELECT ${E}."category_id", ${EC}."name", ${EC}."code", SUM(${E}."amount") AS "total",
              COUNT(${E}."id") AS "count"
         FROM ${E} INNER JOIN ${EC} ON (${E}."category_id" = ${EC}."id") WHERE ${where(sql)}
        GROUP BY ${E}."category_id", ${EC}."name", ${EC}."code" ORDER BY 4 DESC`,
      sql.values,
    );
    return {
      total,
      count,
      byCategory: rows.map((row) => ({
        category_id: row.category_id as string,
        category: row.name as string,
        code: row.code as string,
        total: quantize((row.total as string | null) ?? ZERO),
        count: int(row.count),
        share: total.gt(ZERO)
          ? quantize(new Dec((row.total as string | null) ?? ZERO).div(total).times(100))
          : ZERO,
      })),
    };
  }

  /** `purchase_shipping`: what purchase orders charged to bring goods in, by their first delivery. */
  private async purchaseShipping(scope: Scope): Promise<{ total: Dec; orders: number | bigint }> {
    const sql = new SqlParams();
    const first = `(SELECT U0."received_at" FROM "purchasing_purchasereceipt" U0 WHERE (U0."is_posted" AND U0."purchase_order_id" = (${P}."id")) ORDER BY U0."received_at" ASC LIMIT 1)`;
    const row = await this.one(
      `SELECT COALESCE(SUM(${P}."shipping_total"), 0.00) AS "total", COUNT(${P}."id") AS "orders"
         FROM ${P} WHERE (${P}."shipping_total" > 0.00
          AND ${first} >= ${sql.add(scope.range.start, 'timestamptz')}
          AND ${first} <= ${sql.add(scope.range.end, 'timestamptz')}` +
        (scope.branchId ? ` AND ${P}."branch_id" = ${sql.add(scope.branchId, 'uuid')}` : '') +
        ')',
      sql,
    );
    return { total: quantize(row.total as string), orders: int(row.orders) };
  }

  /** `_net_profit`: gross profit less the window's expenses and purchase shipping. */
  private async netProfit(scope: Scope, grossProfit: Dec) {
    const expenses = await this.expenseTotals(scope);
    const shipping = await this.purchaseShipping(scope);
    const expensesTotal = quantize(expenses.total);
    return {
      expenses: { ...expenses, total: expensesTotal },
      shipping,
      netProfit: quantize(grossProfit.minus(expensesTotal).minus(shipping.total)),
    };
  }

  private expenseRows(expenses: ExpenseTotals): Payload[] {
    return expenses.byCategory.map((row) => ({
      category_id: row.category_id,
      category: row.category,
      code: row.code,
      total: dcm(row.total),
      count: row.count,
      share: dcm(row.share),
    }));
  }

  private period(range: DateRange): Payload {
    return { start: momentJson(range.start), end: momentJson(range.end), label: range.label };
  }

  // --- The reports ------------------------------------------------------------------------------

  /** `dashboard`: the figures every staff member sees first; `financial` adds the profit block. */
  async dashboard(scope: Scope, financial: boolean): Promise<Payload> {
    const tz = this.env.DJANGO_TIME_ZONE;
    let sql = new SqlParams();
    const totals = await this.one(
      `SELECT COUNT(${O}."id") AS "order_count", COALESCE(SUM(${O}."grand_total"), 0.00) AS "revenue",
              COALESCE(SUM(${O}."discount_total"), 0.00) AS "discount",
              COALESCE(SUM(${O}."refunded_total"), 0.00) AS "refunded"
         FROM ${O} WHERE (${this.sold(sql, O, scope)})`,
      sql,
    );
    sql = new SqlParams();
    const items = await this.one(
      `SELECT COALESCE(SUM(${I}."quantity"), 0) AS "units", ${COGS} AS "cogs",
              ${netRevenue()} AS "net_sales", COALESCE(SUM(${I}."tax_amount"), 0.00) AS "tax"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)}`,
      sql,
    );
    const gross = await this.grossProfit(
      scope,
      new Dec(items.net_sales as string),
      new Dec(items.cogs as string),
    );

    sql = new SqlParams();
    const byChannel = await this.db.query<Raw>(
      `SELECT ${O}."channel", COUNT(${O}."id") AS "orders",
              COALESCE(SUM(${O}."grand_total"), 0.00) AS "revenue"
         FROM ${O} WHERE (${this.sold(sql, O, scope)}) GROUP BY ${O}."channel" ORDER BY 3 DESC`,
      sql.values,
    );

    sql = new SqlParams();
    const day = this.trunc(sql, 'date', `${O}."placed_at"`);
    const daily = await this.db.query<Raw>(
      `SELECT ${day} AS "day", COUNT(${O}."id") AS "orders",
              COALESCE(SUM(${O}."grand_total"), 0.00) AS "revenue",
              COALESCE(SUM(${O}."grand_total") FILTER (WHERE ${O}."channel" = 'POS'), 0.00) AS "pos",
              COALESCE(SUM(${O}."grand_total") FILTER (WHERE ${O}."channel" = 'ONLINE'), 0.00) AS "online"
         FROM ${O} WHERE (${this.sold(sql, O, scope)}) GROUP BY 1 ORDER BY 1 ASC`,
      sql.values,
    );

    sql = new SqlParams();
    const payments = await this.db.query<Raw>(
      `SELECT "orders_payment"."method", COALESCE(SUM("orders_payment"."amount"), 0.00) AS "amount",
              COUNT("orders_payment"."id") AS "count"
         FROM "orders_payment"
        WHERE ("orders_payment"."order_id" IN (SELECT U0."id" FROM ${O} U0 WHERE (${this.sold(sql, 'U0', scope)}))
          AND "orders_payment"."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED'))
        GROUP BY "orders_payment"."method" ORDER BY 2 DESC`,
      sql.values,
    );

    sql = new SqlParams();
    const topProducts = await this.db.query<Raw>(
      `SELECT ${I}."sku", ${I}."product_name", SUM(${I}."quantity") AS "units", ${netRevenue()} AS "revenue"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)}
        GROUP BY ${I}."sku", ${I}."product_name" ORDER BY 3 DESC LIMIT 10`,
      sql.values,
    );

    sql = new SqlParams();
    const categorySales = await this.db.query<Raw>(
      `SELECT "catalog_category"."name" AS "category", SUM(${I}."quantity") AS "units",
              ${netRevenue()} AS "revenue"
         ${ITEMS_FROM}
         INNER JOIN "catalog_productvariant" ON (${I}."variant_id" = "catalog_productvariant"."id")
         INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
         INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")
        WHERE ${this.soldLines(sql, scope)} GROUP BY 1 ORDER BY 3 DESC LIMIT 10`,
      sql.values,
    );

    const atBranch = (sql: SqlParams, extra = '') => {
      const conditions = [
        ...(scope.branchId ? [`${INV}."branch_id" = ${sql.add(scope.branchId, 'uuid')}`] : []),
        ...(extra ? [extra] : []),
      ];
      return conditions.length ? ` WHERE (${conditions.join(' AND ')})` : '';
    };
    sql = new SqlParams();
    const stock = await this.one(
      `SELECT COALESCE(SUM((${INV}."on_hand" * ${INV}."average_cost")), 0.00) AS "value",
              COALESCE(SUM(${INV}."on_hand"), 0) AS "units" FROM ${INV}${atBranch(sql)}`,
      sql,
    );

    sql = new SqlParams();
    const returns = await this.count(
      `FROM ${R}${scope.branchId ? ` INNER JOIN ${O} ON (${R}."order_id" = ${O}."id")` : ''}
        WHERE (${this.window(sql, `${R}."created_at"`, scope, `${O}."branch_id"`)})`,
      sql,
    );
    sql = new SqlParams();
    const pendingOnline = await this.count(
      `FROM ${O} WHERE (${O}."channel" = 'ONLINE'
         AND ${O}."status" IN ('PENDING', 'CONFIRMED', 'PROCESSING')` +
        (scope.branchId ? ` AND ${O}."branch_id" = ${sql.add(scope.branchId, 'uuid')}` : '') +
        ')',
      sql,
    );
    sql = new SqlParams();
    const lowStock = await this.count(
      `FROM ${INV}${atBranch(sql, `${INV}."on_hand" <= (${INV}."reorder_point")`)}`,
      sql,
    );

    const revenue = new Dec(totals.revenue as string);
    const orderCount = int(totals.order_count);
    const payload: Payload = {
      range: this.period(scope.range),
      kpis: {
        revenue: new Dcm(totals.revenue as string),
        orders: orderCount,
        units_sold: int(items.units),
        gross_profit: dcm(gross.grossProfit),
        margin_percent: dcm(percent(gross.grossProfit, gross.netRevenue)),
        discount_total: new Dcm(totals.discount as string),
        refunded_total: new Dcm(totals.refunded as string),
        average_order_value: dcm(
          quantize(orderCount ? revenue.div(new Dec(String(orderCount))) : ZERO),
        ),
        returns,
        pending_online_orders: pendingOnline,
        low_stock_products: lowStock,
        inventory_value: new Dcm(stock.value as string),
        inventory_units: int(stock.units),
      },
      sales_over_time: this.fillMissingDays(
        daily.map((row) => ({
          day: row.day as string,
          orders: int(row.orders),
          revenue: new Dcm(row.revenue as string),
          pos: new Dcm(row.pos as string),
          online: new Dcm(row.online as string),
        })),
        scope.range,
        tz,
      ),
      by_channel: byChannel.map((row) => ({
        channel: row.channel as string,
        orders: int(row.orders),
        revenue: new Dcm(row.revenue as string),
      })),
      payment_methods: payments.map((row) => ({
        method: row.method as string,
        amount: new Dcm(row.amount as string),
        count: int(row.count),
      })),
      top_products: topProducts.map((row) => ({
        sku: row.sku as string,
        product_name: row.product_name as string,
        units: int(row.units),
        revenue: new Dcm(row.revenue as string),
      })),
      category_sales: categorySales.map((row) => ({
        category: row.category as string,
        units: int(row.units),
        revenue: new Dcm(row.revenue as string),
      })),
    };

    if (financial) {
      const net = await this.netProfit(scope, gross.grossProfit);
      payload.profit = {
        gross_profit: dcm(gross.grossProfit),
        expenses: dcm(net.expenses.total),
        expense_count: net.expenses.count,
        top_expense_category: net.expenses.byCategory[0]?.category ?? '',
        purchase_shipping: dcm(net.shipping.total),
        purchase_shipping_orders: net.shipping.orders,
        net_profit: dcm(net.netProfit),
        net_margin_percent: dcm(percent(net.netProfit, gross.netRevenue)),
      };
    }
    return payload;
  }

  /**
   * `_fill_missing_days`: a zero row on every day of the window that saw no
   * sale, unless the window runs backwards or past `_MAX_FILLED_DAYS`.
   */
  private fillMissingDays(rows: Row[], range: DateRange, timeZone: string): Row[] {
    const first = localOrdinal(range.start, timeZone);
    const last = localOrdinal(range.end, timeZone);
    if (last < first || last - first + 1 > MAX_FILLED_DAYS) return rows;
    const traded = new Map(rows.map((row) => [row.day as string, row]));
    const filled: Row[] = [];
    for (let day = first; day <= last; day++) {
      const date = ordinalDate(day);
      filled.push(
        traded.get(date) ?? {
          day: date,
          orders: 0,
          revenue: new Dcm('0.00'),
          pos: new Dcm('0.00'),
          online: new Dcm('0.00'),
        },
      );
      // `day += timedelta(days=1)` after the last day a date can hold: an
      // `OverflowError` nothing catches (copied).
      if (day === MAX_ORDINAL) throw new Error('OverflowError: date value out of range');
    }
    return filled;
  }

  /** `sales_report`: the orders themselves, newest first. */
  async sales(scope: Scope, channel: string): Promise<Row[]> {
    const sql = new SqlParams();
    const join = (table: string, column: string) =>
      `INNER JOIN "${table}" ON (${O}."${column}" = "${table}"."id")`;
    // A filter on the branch names its join first, as Django's query holds them.
    const joins = scope.branchId
      ? `${join('accounts_branch', 'branch_id')} ${join('customers_customer', 'customer_id')}`
      : `${join('customers_customer', 'customer_id')} ${join('accounts_branch', 'branch_id')}`;
    const rows = await this.db.query<Raw>(
      `SELECT ${O}."number", ${O}."placed_at", ${O}."channel", ${O}."status", ${O}."payment_status",
              ${O}."subtotal", ${O}."discount_total", ${O}."tax_total", ${O}."shipping_total",
              ${O}."grand_total", "customers_customer"."name" AS "customer",
              "accounts_branch"."code" AS "branch_code"
         FROM ${O} ${joins} WHERE (${this.sold(sql, O, scope, channel)})
        ORDER BY ${O}."placed_at" DESC`,
      sql.values,
    );
    return rows.map((row) => ({
      number: row.number as string,
      placed_at: row.placed_at === null ? null : new Moment(row.placed_at as string),
      channel: row.channel as string,
      status: row.status as string,
      payment_status: row.payment_status as string,
      subtotal: new Dcm(row.subtotal as string),
      discount_total: new Dcm(row.discount_total as string),
      tax_total: new Dcm(row.tax_total as string),
      shipping_total: new Dcm(row.shipping_total as string),
      grand_total: new Dcm(row.grand_total as string),
      customer: row.customer as string,
      branch_code: row.branch_code as string,
    }));
  }

  /** `product_performance`: what each SKU sold, cost and came back, best revenue first. */
  async productPerformance(scope: Scope): Promise<Row[]> {
    const sql = new SqlParams();
    const rows = await this.db.query<Raw>(
      `SELECT ${I}."sku", ${I}."product_name", ${I}."variant_label", SUM(${I}."quantity") AS "units",
              ${netRevenue()} AS "revenue", ${COGS} AS "cost",
              COALESCE(SUM(${I}."returned_quantity"), 0) AS "returned"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)}
        GROUP BY ${I}."sku", ${I}."product_name", ${I}."variant_label" ORDER BY 5 DESC`,
      sql.values,
    );
    return rows.map((row) => {
      const revenue = new Dec(row.revenue as string);
      const grossProfit = quantize(revenue.minus(row.cost as string));
      return {
        sku: row.sku as string,
        product_name: row.product_name as string,
        variant_label: row.variant_label as string,
        units: int(row.units),
        revenue: new Dcm(row.revenue as string),
        cost: new Dcm(row.cost as string),
        returned: int(row.returned),
        gross_profit: dcm(grossProfit),
        margin_percent: dcm(percent(grossProfit, revenue)),
      };
    });
  }

  /** `inventory_report`: every stock row with what it is worth at cost and at retail. */
  async inventoryValuation(branchId: string | null): Promise<Row[]> {
    const sql = new SqlParams();
    const branch = `INNER JOIN "accounts_branch" ON (${INV}."branch_id" = "accounts_branch"."id")`;
    const variant = `INNER JOIN "catalog_productvariant" ON (${INV}."variant_id" = "catalog_productvariant"."id")
         INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
         INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")`;
    // The order ties on every product with more than one variant, so the
    // joins stand as Django's query holds them: the branch first when it filters.
    const rows = await this.db.arrays(
      `SELECT "catalog_productvariant"."sku", "catalog_product"."name", "catalog_category"."name",
              "accounts_branch"."code", ${INV}."on_hand", ${INV}."reserved", ${INV}."average_cost",
              ${INV}."reorder_point", (${INV}."on_hand" - ${INV}."reserved") AS "available_qty",
              (${INV}."on_hand" * ${INV}."average_cost") AS "stock_value",
              (${INV}."on_hand" * "catalog_productvariant"."price") AS "retail_value"
         FROM ${INV} ${branchId ? `${branch} ${variant}` : `${variant} ${branch}`}` +
        (branchId ? ` WHERE ${INV}."branch_id" = ${sql.add(branchId, 'uuid')}` : '') +
        ` ORDER BY "catalog_product"."name" ASC`,
      sql.values,
    );
    return rows.map((row) => ({
      variant__sku: row[0] as string,
      variant__product__name: row[1] as string,
      variant__product__category__name: row[2] as string,
      branch__code: row[3] as string,
      on_hand: int(row[4]),
      reserved: int(row[5]),
      average_cost: new Dcm(row[6] as string),
      reorder_point: int(row[7]),
      available_qty: int(row[8]),
      stock_value: new Dcm(row[9] as string),
      retail_value: new Dcm(row[10] as string),
    }));
  }

  /** `inventory_movement`: the ledger in the window, by movement type. */
  async inventoryMovement(scope: Scope): Promise<Row[]> {
    const sql = new SqlParams();
    const T = '"inventory_inventorytransaction"';
    const rows = await this.db.query<Raw>(
      `SELECT ${T}."transaction_type", SUM(${T}."quantity") AS "units", COUNT(${T}."id") AS "entries",
              COALESCE(SUM((${T}."quantity" * COALESCE(${T}."unit_cost", 0.00))), 0.00) AS "value"
         FROM ${T} WHERE (${this.window(sql, `${T}."created_at"`, scope, `${T}."branch_id"`)})
        GROUP BY ${T}."transaction_type" ORDER BY ${T}."transaction_type" ASC`,
      sql.values,
    );
    return rows.map((row) => ({
      transaction_type: row.transaction_type as string,
      units: int(row.units),
      entries: int(row.entries),
      value: new Dcm(row.value as string),
    }));
  }

  /** `purchase_report`: the purchase orders raised in the window, with what is still owed. */
  async purchases(scope: Scope): Promise<Row[]> {
    const sql = new SqlParams();
    const rows = await this.db.query<Raw>(
      `SELECT ${P}."number", ${P}."status", ${P}."payment_status", ${P}."created_at", ${P}."grand_total",
              ${P}."paid_total", ${P}."credited_total", "purchasing_supplier"."name" AS "supplier",
              ((${P}."grand_total" - ${P}."paid_total") - ${P}."credited_total") AS "outstanding"
         FROM ${P} INNER JOIN "purchasing_supplier" ON (${P}."supplier_id" = "purchasing_supplier"."id")
        WHERE (${this.window(sql, `${P}."created_at"`, scope, `${P}."branch_id"`)})
        ORDER BY ${P}."created_at" DESC`,
      sql.values,
    );
    return rows.map((row) => ({
      number: row.number as string,
      status: row.status as string,
      payment_status: row.payment_status as string,
      created_at: new Moment(row.created_at as string),
      grand_total: new Dcm(row.grand_total as string),
      paid_total: new Dcm(row.paid_total as string),
      credited_total: new Dcm(row.credited_total as string),
      supplier: row.supplier as string,
      outstanding: new Dcm(row.outstanding as string),
    }));
  }

  /** `returns_report`: the returns opened in the window, with the units each asks for. */
  async returns(scope: Scope): Promise<Row[]> {
    const sql = new SqlParams();
    const rows = await this.db.query<Raw>(
      `SELECT ${R}."number", ${R}."reason", ${R}."status", ${R}."refund_amount", ${R}."created_at",
              ${O}."number" AS "order_number", ${O}."channel" AS "channel",
              COALESCE(SUM(${RI}."quantity"), 0) AS "units"
         FROM ${R} INNER JOIN ${O} ON (${R}."order_id" = ${O}."id")
         LEFT OUTER JOIN ${RI} ON (${R}."id" = ${RI}."return_request_id")
        WHERE (${this.window(sql, `${R}."created_at"`, scope, `${O}."branch_id"`)})
        GROUP BY ${R}."number", ${R}."reason", ${R}."status", ${R}."refund_amount", ${R}."created_at", 6, 7
        ORDER BY ${R}."created_at" DESC`,
      sql.values,
    );
    return rows.map((row) => ({
      number: row.number as string,
      reason: row.reason as string,
      status: row.status as string,
      refund_amount: new Dcm(row.refund_amount as string),
      created_at: new Moment(row.created_at as string),
      order_number: row.order_number as string,
      channel: row.channel as string,
      units: int(row.units),
    }));
  }

  /** `profit_report`: revenue, cost and gross profit day by day, and their totals. */
  async profit(scope: Scope): Promise<Payload> {
    const sql = new SqlParams();
    const day = this.trunc(sql, 'date', `${O}."placed_at"`);
    const rows = await this.db.query<Raw>(
      `SELECT ${day} AS "day", ${netRevenue()} AS "revenue", ${COGS} AS "cost"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)} GROUP BY 1 ORDER BY 1 ASC`,
      sql.values,
    );
    let revenue = new Dec(ZERO);
    let cost = new Dec(ZERO);
    const daily: Row[] = rows.map((row) => {
      revenue = revenue.plus(row.revenue as string);
      cost = cost.plus(row.cost as string);
      return {
        day: row.day as string,
        revenue: new Dcm(row.revenue as string),
        cost: new Dcm(row.cost as string),
        gross_profit: dcm(quantize(new Dec(row.revenue as string).minus(row.cost as string))),
      };
    });
    revenue = quantize(revenue);
    cost = quantize(cost);
    const grossProfit = quantize(revenue.minus(cost));
    return {
      totals: {
        revenue: dcm(revenue),
        cost: dcm(cost),
        gross_profit: dcm(grossProfit),
        margin_percent: dcm(percent(grossProfit, revenue)),
      },
      daily,
    };
  }

  /** `expense_report`: spending in the window, by category. */
  async expenses(scope: Scope): Promise<Row[]> {
    const totals = await this.expenseTotals(scope);
    return totals.byCategory.map((row) => ({
      category: row.category,
      code: row.code,
      expenses: row.count,
      total: dcm(row.total),
      share_percent: dcm(row.share),
    }));
  }

  /** `business_summary`: revenue through to net profit. */
  async businessSummary(scope: Scope): Promise<Payload> {
    let sql = new SqlParams();
    const sales = await this.one(
      `SELECT ${netRevenue()} AS "revenue", COALESCE(SUM(${I}."tax_amount"), 0.00) AS "tax",
              ${COGS} AS "cogs", COALESCE(SUM(${I}."quantity"), 0) AS "units"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)}`,
      sql,
    );
    sql = new SqlParams();
    const orderTotals = await this.one(
      `SELECT COUNT(${O}."id") AS "count", COALESCE(SUM(${O}."shipping_total"), 0.00) AS "shipping",
              COALESCE(SUM(${O}."discount_total"), 0.00) AS "discounts"
         FROM ${O} WHERE (${this.sold(sql, O, scope)})`,
      sql,
    );
    const gross = await this.grossProfit(
      scope,
      new Dec(sales.revenue as string),
      new Dec(sales.cogs as string),
    );
    const net = await this.netProfit(scope, gross.grossProfit);
    sql = new SqlParams();
    const completed = await this.count(this.completedReturns(sql, scope), sql);
    const orders = int(orderTotals.count);
    return {
      period: this.period(scope.range),
      revenue: {
        goods: dcm(gross.revenue),
        refunds: dcm(gross.refunds),
        net: dcm(gross.netRevenue),
        shipping_charged: dcm(quantize(orderTotals.shipping as string)),
        discounts_given: dcm(quantize(orderTotals.discounts as string)),
        vat_collected: dcm(quantize(sales.tax as string)),
      },
      cost_of_goods: {
        sold: dcm(gross.cogs),
        recovered_from_returns: dcm(gross.cogsRecovered),
        net: dcm(gross.netCogs),
      },
      gross_profit: dcm(gross.grossProfit),
      gross_margin_percent: dcm(percent(gross.grossProfit, gross.netRevenue)),
      expenses: {
        total: dcm(net.expenses.total),
        count: net.expenses.count,
        by_category: this.expenseRows(net.expenses),
      },
      purchase_shipping: { total: dcm(net.shipping.total), orders: net.shipping.orders },
      net_profit: dcm(net.netProfit),
      net_margin_percent: dcm(percent(net.netProfit, gross.netRevenue)),
      volume: {
        orders,
        units: int(sales.units),
        returns: completed,
        average_order_value: dcm(
          orders ? quantize(gross.netRevenue.div(new Dec(String(orders)))) : ZERO,
        ),
      },
    };
  }

  /** `vat_report`: what was collected, what was credited back, what was paid. */
  async vat(scope: Scope): Promise<Payload> {
    let sql = new SqlParams();
    const output = await this.one(
      `SELECT COALESCE(SUM(${I}."tax_amount"), 0.00) AS "vat",
              ${netRevenue(`${O}."tax_rate" > 0`)} AS "taxable",
              ${netRevenue(`${O}."tax_rate" = 0`)} AS "zero_rated",
              COUNT(DISTINCT ${I}."order_id") AS "orders"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)}`,
      sql,
    );

    sql = new SqlParams();
    const credits = await this.one(
      `SELECT COALESCE(SUM(${RETURNED_LINE_VAT}), 0.00) AS "vat",
              COALESCE(SUM(${RETURNED_LINE_BASE}), 0.00) AS "taxable"
         FROM ${RI} INNER JOIN ${I} ON (${RI}."order_item_id" = ${I}."id")
         INNER JOIN ${O} ON (${I}."order_id" = ${O}."id")
        WHERE ${this.completedReturnLines(sql, scope)}`,
      sql,
    );

    sql = new SqlParams();
    const supplierVat = await this.one(
      `SELECT COALESCE(SUM(${P}."tax_total"), 0.00) AS "vat", COUNT(${P}."id") AS "orders"
         FROM ${P} WHERE (${this.purchased(sql, P, scope)})`,
      sql,
    );
    sql = new SqlParams();
    const supplierBase = await this.one(
      `SELECT COALESCE(SUM(${PI}."line_total") FILTER (WHERE ${PI}."tax_rate" > 0), 0.00) AS "taxable",
              COALESCE(SUM(${PI}."line_total") FILTER (WHERE ${PI}."tax_rate" = 0), 0.00) AS "zero_rated"
         FROM ${PI}
        WHERE ${PI}."purchase_order_id" IN (SELECT U0."id" FROM ${P} U0 WHERE (${this.purchased(sql, 'U0', scope)}))`,
      sql,
    );
    sql = new SqlParams();
    const reclaimed = await this.one(
      `SELECT COALESCE(SUM(${RETURNED_PURCHASE_VAT}), 0.00) AS "vat",
              COALESCE(SUM((${PRI}."unit_cost" * ${PRI}."quantity")), 0.00) AS "goods"
         FROM ${PRI} INNER JOIN ${PI} ON (${PRI}."purchase_order_item_id" = ${PI}."id")
        WHERE ${this.supplierReturnLines(sql, scope)}`,
      sql,
    );

    const outputVat = quantize(output.vat as string);
    const creditVat = quantize(credits.vat as string);
    const inputVat = quantize(new Dec(supplierVat.vat as string).minus(reclaimed.vat as string));

    sql = new SqlParams();
    const completedReturns = await this.count(this.completedReturns(sql, scope), sql);
    sql = new SqlParams();
    const supplierReturns = await this.count(
      `FROM ${PR}${scope.branchId ? ` INNER JOIN ${P} ON (${PR}."purchase_order_id" = ${P}."id")` : ''}
        WHERE (${this.window(sql, `${PR}."returned_at"`, scope, `${P}."branch_id"`)})`,
      sql,
    );

    return {
      period: this.period(scope.range),
      output: {
        taxable_sales: dcm(quantize(output.taxable as string)),
        zero_rated_sales: dcm(quantize(output.zero_rated as string)),
        vat: dcm(outputVat),
        orders: int(output.orders),
      },
      credits: {
        taxable_returns: dcm(quantize(credits.taxable as string)),
        vat: dcm(creditVat),
        returns: completedReturns,
      },
      input: {
        taxable_purchases: dcm(quantize(supplierBase.taxable as string)),
        zero_rated_purchases: dcm(quantize(supplierBase.zero_rated as string)),
        vat: dcm(inputVat),
        vat_on_purchases: dcm(quantize(supplierVat.vat as string)),
        purchases: int(supplierVat.orders),
        returned_to_suppliers: dcm(quantize(reclaimed.goods as string)),
        vat_given_back: dcm(quantize(reclaimed.vat as string)),
        returns: supplierReturns,
      },
      net_payable: dcm(quantize(outputVat.minus(creditVat).minus(inputVat))),
      by_rate: await this.vatByRate(scope),
      monthly: await this.vatByMonth(scope),
    };
  }

  /** `_vat_by_rate`: output VAT split by the rate, and the treatment, each order was priced at. */
  private async vatByRate(scope: Scope): Promise<Row[]> {
    const sql = new SqlParams();
    const rows = await this.db.query<Raw>(
      `SELECT ${O}."tax_rate", ${O}."tax_mode", ${netRevenue()} AS "taxable",
              COALESCE(SUM(${I}."tax_amount"), 0.00) AS "vat",
              COUNT(DISTINCT ${I}."order_id") AS "orders"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)}
        GROUP BY ${O}."tax_rate", ${O}."tax_mode" ORDER BY ${O}."tax_rate" DESC`,
      sql.values,
    );
    return rows.map((row) => ({
      rate: new Dcm(row.tax_rate as string),
      mode: row.tax_mode as string,
      taxable: dcm(quantize(row.taxable as string)),
      vat: dcm(quantize(row.vat as string)),
      orders: int(row.orders),
    }));
  }

  /** `_vat_by_month`: the same subtraction month by month, on the shop's calendar. */
  private async vatByMonth(scope: Scope): Promise<Row[]> {
    const buckets = new Map<string, { output: Dec; credit: Dec; input: Dec }>();
    const bucket = (month: unknown) => {
      // A `timestamp` at the month's first midnight: its date.
      const key = String(month).slice(0, 10);
      let found = buckets.get(key);
      if (!found) {
        found = { output: ZERO, credit: ZERO, input: ZERO };
        buckets.set(key, found);
      }
      return found;
    };

    let sql = new SqlParams();
    let month = this.trunc(sql, 'month', `${O}."placed_at"`);
    for (const row of await this.db.query<Raw>(
      `SELECT ${month} AS "month", COALESCE(SUM(${I}."tax_amount"), 0.00) AS "vat"
         ${ITEMS_FROM} WHERE ${this.soldLines(sql, scope)} GROUP BY 1`,
      sql.values,
    )) {
      bucket(row.month).output = quantize(row.vat as string);
    }

    sql = new SqlParams();
    month = this.trunc(sql, 'month', `${R}."completed_at"`);
    for (const row of await this.db.query<Raw>(
      `SELECT ${month} AS "month", COALESCE(SUM(${RETURNED_LINE_VAT}), 0.00) AS "vat"
         FROM ${RI} INNER JOIN ${R} ON (${RI}."return_request_id" = ${R}."id")
         INNER JOIN ${I} ON (${RI}."order_item_id" = ${I}."id")
        WHERE ${this.completedReturnLines(sql, scope)} GROUP BY 1`,
      sql.values,
    )) {
      bucket(row.month).credit = quantize(row.vat as string);
    }

    sql = new SqlParams();
    month = this.trunc(sql, 'month', `${P}."created_at"`);
    for (const row of await this.db.query<Raw>(
      `SELECT ${month} AS "month", COALESCE(SUM(${P}."tax_total"), 0.00) AS "vat"
         FROM ${P} WHERE (${this.purchased(sql, P, scope)}) GROUP BY 1`,
      sql.values,
    )) {
      bucket(row.month).input = quantize(row.vat as string);
    }

    sql = new SqlParams();
    month = this.trunc(sql, 'month', `${PR}."returned_at"`);
    for (const row of await this.db.query<Raw>(
      `SELECT ${month} AS "month", COALESCE(SUM(${RETURNED_PURCHASE_VAT}), 0.00) AS "vat"
         FROM ${PRI} INNER JOIN ${PR} ON (${PRI}."purchase_return_id" = ${PR}."id")
         INNER JOIN ${PI} ON (${PRI}."purchase_order_item_id" = ${PI}."id")
        WHERE ${this.supplierReturnLines(sql, scope)} GROUP BY 1`,
      sql.values,
    )) {
      const found = bucket(row.month);
      found.input = quantize(found.input.minus(quantize(row.vat as string)));
    }

    return [...buckets.keys()].sort().map((key) => {
      const found = buckets.get(key) as { output: Dec; credit: Dec; input: Dec };
      return {
        month: key,
        output_vat: dcm(found.output),
        credit_vat: dcm(found.credit),
        input_vat: dcm(found.input),
        net_payable: dcm(quantize(found.output.minus(found.credit).minus(found.input))),
      };
    });
  }
}
