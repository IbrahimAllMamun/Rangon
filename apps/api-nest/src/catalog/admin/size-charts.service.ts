import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AuditActor, AuditContext, recordAudit } from '../../common/audit';
import {
  charField,
  errorMessages,
  Fields,
  integerField,
  listField,
  nestedListField,
  pkRelatedField,
  runSerializer,
  uuidField,
} from '../../common/drf';
import { Conflict, NotFound, ValidationError } from '../../common/errors';
import { applyFilters, modelFilter, orderingPlan, type OrderingTerm } from '../../common/filtering';
import { PyFloat, pyLen, pySlice, pyStr, pyStrip } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { parsePythonJson } from '../../http/request-body';
import { Revalidation } from '../../jobs/revalidation';
import { kindLabel, single } from './attributes.service';

/**
 * `SizeChartViewSet` over `catalog.services.save_size_chart` and
 * `delete_size_chart` (docs/business-rules.md §5b): a chart describes one
 * Size attribute, its rows are that attribute's own values, each row holds
 * one figure per column, and the finished chart -- not the request -- is what
 * is validated. Every save and delete is audited, and a save asks the
 * storefront to drop its cached product pages once it has committed.
 */

const MAX_CHART_COLUMNS = 12;
const MAX_COLUMN_LABEL = 40;
const MAX_CELL_LENGTH = 32;
const MAX_CHART_NOTES = 2000;

export interface ChartRow {
  id: string;
  attribute_id: string;
  name: string;
  system: string;
  columns: string;
  notes: string;
  position: number;
  created_by_id: string | null;
  product_count: number;
  attribute_name: string;
  attribute_code: string;
  attribute_kind: string;
}

interface ChartLine {
  chart_id: string;
  attribute_value_id: string;
  cells: string;
  value: string;
  label: string;
}

const SELECT = `"catalog_sizechart"."id", "catalog_sizechart"."attribute_id", "catalog_sizechart"."name",
  "catalog_sizechart"."system", "catalog_sizechart"."columns"::text AS "columns",
  "catalog_sizechart"."notes", "catalog_sizechart"."position", "catalog_sizechart"."created_by_id",
  COUNT("catalog_product"."id")::int AS "product_count", "catalog_attribute"."name" AS "attribute_name",
  "catalog_attribute"."code" AS "attribute_code", "catalog_attribute"."kind" AS "attribute_kind"`;

const FILTERS = [
  modelFilter('attribute', '"catalog_sizechart"."attribute_id"', 'catalog_attribute'),
];
const ORDERING: Record<string, OrderingTerm> = {
  id: '"catalog_sizechart"."id"',
  attribute: { columns: ['"catalog_attribute"."position"', '"catalog_attribute"."name"'] },
  attribute__code: '"catalog_attribute"."code"',
  attribute__name: '"catalog_attribute"."name"',
  name: '"catalog_sizechart"."name"',
  system: '"catalog_sizechart"."system"',
  columns: '"catalog_sizechart"."columns"',
  notes: '"catalog_sizechart"."notes"',
  position: '"catalog_sizechart"."position"',
  // A reverse relation, ordered as the rows are: one result per row.
  rows: {
    columns: ['"catalog_attributevalue"."position"', '"catalog_attributevalue"."value"'],
    join: `LEFT OUTER JOIN "catalog_sizechartrow" ON ("catalog_sizechart"."id" = "catalog_sizechartrow"."chart_id")
      LEFT OUTER JOIN "catalog_attributevalue" ON ("catalog_sizechartrow"."attribute_value_id" = "catalog_attributevalue"."id")`,
    groupBy: ['"catalog_attributevalue"."position"', '"catalog_attributevalue"."value"'],
  },
};
const DEFAULT_ORDER = [
  '"catalog_attribute"."position" ASC',
  '"catalog_attribute"."name" ASC',
  '"catalog_sizechart"."position" ASC',
  '"catalog_sizechart"."name" ASC',
];

/** A service refusal keyed by field, so the editor puts it beside that field. */
function chartError(field: string, message: string): ValidationError {
  return new ValidationError(message, { details: { [field]: [message] } });
}

/** Python `==` over parsed JSON: `1 == 1.0`, dicts by key, lists in order. */
function pyEqual(a: unknown, b: unknown): boolean {
  const number = (value: unknown) =>
    value instanceof PyFloat ? value.value : typeof value === 'number' ? value : null;
  if (number(a) !== null && number(b) !== null) return number(a) === number(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => pyEqual(item, b[index]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = Object.keys(a);
    const right = Object.keys(b);
    return (
      left.length === right.length &&
      left.every(
        (key) =>
          Object.hasOwn(b, key) &&
          pyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return a === b;
}

type ChartData = Partial<{
  attribute: string;
  name: string;
  system: string;
  columns: string[];
  notes: string;
  position: number;
  rows: Record<string, unknown>[];
}>;

@Injectable()
export class SizeChartsService {
  constructor(
    private readonly db: Database,
    private readonly revalidation: Revalidation,
  ) {}

  /**
   * The queryset's SQL: filtered when given the request's query, and ordered
   * by it only for a list -- `QuerySet.get()` clears the ordering, so a
   * relation term's join never repeats the row a lookup fetches.
   */
  private async select(
    query: QueryDict | null,
    sql: SqlParams,
    extra: (sql: SqlParams) => string[],
    ordered = true,
  ): Promise<string> {
    const where: string[] = [];
    if (query) await applyFilters(this.db, query, FILTERS, sql, where);
    where.push(...extra(sql));
    const plan = query && ordered ? orderingPlan(query, ORDERING) : null;
    return `SELECT ${SELECT} FROM "catalog_sizechart"
        LEFT OUTER JOIN "catalog_product" ON ("catalog_sizechart"."id" = "catalog_product"."size_chart_id")
        INNER JOIN "catalog_attribute" ON ("catalog_sizechart"."attribute_id" = "catalog_attribute"."id")
        ${plan?.joins.join(' ') ?? ''}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY ${['"catalog_sizechart"."id"', '"catalog_attribute"."id"', ...(plan?.groupBy ?? [])].join(', ')}
        ORDER BY ${(plan?.order ?? DEFAULT_ORDER).join(', ')}`;
  }

  /** `SizeChartSerializer(charts, many=True).data`, the rows fetched in one query. */
  private async serialise(charts: ChartRow[]): Promise<Record<string, unknown>[]> {
    const lines = charts.length
      ? await this.db.query<ChartLine>(
          `SELECT r."chart_id", r."attribute_value_id", r."cells"::text AS "cells", v."value", v."label"
             FROM "catalog_sizechartrow" r
             INNER JOIN "catalog_attributevalue" v ON (r."attribute_value_id" = v."id")
            WHERE r."chart_id" = ANY($1::uuid[])
            ORDER BY v."position" ASC, v."value" ASC`,
          [[...new Set(charts.map((chart) => chart.id))]],
        )
      : [];
    return charts.map((chart) => ({
      id: chart.id,
      attribute: chart.attribute_id,
      attribute_code: chart.attribute_code,
      attribute_name: chart.attribute_name,
      name: chart.name,
      system: chart.system,
      columns: strings(parsePythonJson(chart.columns)),
      notes: chart.notes,
      position: chart.position,
      rows: lines
        .filter((line) => line.chart_id === chart.id)
        .map((line) => ({
          attribute_value: line.attribute_value_id,
          value: line.value,
          label: line.label || line.value,
          cells: strings(parsePythonJson(line.cells)),
        })),
      product_count: chart.product_count,
    }));
  }

  async serialiseOne(chart: ChartRow): Promise<Record<string, unknown>> {
    return (await this.serialise([chart]))[0] as Record<string, unknown>;
  }

  async list(query: QueryDict): Promise<Record<string, unknown>[]> {
    const sql = new SqlParams();
    const charts = await this.db.query<ChartRow>(
      await this.select(query, sql, () => []),
      sql.values,
    );
    return this.serialise(charts);
  }

  /** `get_object()`: filtered, ordered, then looked up by key. */
  async find(pk: string, query: QueryDict): Promise<ChartRow> {
    const sql = new SqlParams();
    const text = await this.select(
      query,
      sql,
      (params) => {
        const id = parseUuid(pk);
        if (!id) throw new NotFound();
        return [`"catalog_sizechart"."id" = ${params.add(id, 'uuid')}`];
      },
      false,
    );
    return single(await this.db.query<ChartRow>(`${text} LIMIT 21`, sql.values));
  }

  /** `self.get_queryset().get(pk=chart.pk)`: the saved chart, re-read for the answer. */
  async payload(id: string): Promise<Record<string, unknown>> {
    const sql = new SqlParams();
    const text = await this.select(null, sql, (params) => [
      `"catalog_sizechart"."id" = ${params.add(id, 'uuid')}`,
    ]);
    const chart = single(await this.db.query<ChartRow>(`${text} LIMIT 21`, sql.values));
    return (await this.serialise([chart]))[0] as Record<string, unknown>;
  }

  /** `SizeChartSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validate(data: unknown, partial: boolean): Promise<ChartData> {
    const attributeExists = async (id: string) =>
      (await this.db.one(`SELECT 1 FROM "catalog_attribute" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
    const cell = () => charField({ allowBlank: true, trimWhitespace: false });
    const fields: Fields = {
      attribute: pkRelatedField(attributeExists),
      name: charField({ maxLength: 120 }),
      system: charField({ allowBlank: true, maxLength: 40, required: false }),
      columns: listField(cell(), { required: false }),
      notes: charField({ allowBlank: true, required: false }),
      position: integerField({ maxValue: 2147483647, minValue: 0, required: false }),
      rows: nestedListField(
        { attribute_value: uuidField(), cells: listField(cell()) },
        { required: false },
      ),
    };
    const result = await runSerializer<ChartData>(fields, data, { partial });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  private async snapshot(
    q: Queryable,
    chart: { id: string; name: string; system: string; columns: unknown[]; notes: string },
  ): Promise<Record<string, unknown>> {
    const rows = await q.query<{ label: string; value: string; cells: string }>(
      `SELECT v."label", v."value", r."cells"::text AS "cells" FROM "catalog_sizechartrow" r
         INNER JOIN "catalog_attributevalue" v ON (r."attribute_value_id" = v."id")
        WHERE r."chart_id" = $1 ORDER BY v."position" ASC, v."value" ASC`,
      [chart.id],
    );
    const byLabel: Record<string, unknown> = {};
    for (const row of rows) byLabel[row.label || row.value] = parsePythonJson(row.cells);
    return {
      name: chart.name,
      system: chart.system,
      columns: chart.columns,
      rows: byLabel,
      notes: chart.notes,
    };
  }

  /**
   * `save_size_chart`: create a chart, or update one, and validate the
   * finished chart as a whole. On an update a missing key keeps what is
   * stored; the rows are replaced, never merged.
   */
  async save(
    chart: ChartRow | null,
    data: ChartData,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<string> {
    // `_service_data`: a nested row without a value is a KeyError in Django (a 500).
    const rows = data.rows?.map((row) => {
      if (!Object.hasOwn(row, 'attribute_value')) throw new Error("KeyError: 'attribute_value_id'");
      return {
        attribute_value: row.attribute_value as string,
        cells: (row.cells as string[]) ?? [],
      };
    });

    const id = await this.db.transaction(async (tx: Queryable) => {
      let attributeId: string;
      if (chart === null) {
        if (data.attribute === undefined)
          throw chartError('attribute', 'Choose the size attribute this chart describes.');
        attributeId = data.attribute;
      } else if (data.attribute !== undefined && data.attribute !== chart.attribute_id) {
        throw chartError(
          'attribute',
          'A chart cannot move to another attribute; its sizes belong to this one. Create a new chart instead.',
        );
      } else {
        attributeId = chart.attribute_id;
      }
      const attribute = (await tx.one<{ name: string; kind: string }>(
        `SELECT "name", "kind" FROM "catalog_attribute" WHERE "id" = $1`,
        [attributeId],
      )) as { name: string; kind: string };
      if (attribute.kind !== 'SIZE') {
        throw chartError(
          'attribute',
          `${attribute.name} is a ${kindLabel(attribute.kind).toLowerCase()} attribute. ` +
            'Only a Size attribute can carry a size chart.',
        );
      }

      const name = pyStrip(data.name ?? chart?.name ?? '');
      if (!name) throw chartError('name', "Give the chart a name, such as “Men's shirts”.");
      if (pyLen(name) > 120) throw chartError('name', 'Keep the name under 120 characters.');
      const clash = await tx.one(
        `SELECT 1 AS "a" FROM "catalog_sizechart"
          WHERE ("catalog_sizechart"."attribute_id" = $1 AND UPPER("catalog_sizechart"."name"::text) = UPPER($2)${
            chart ? ` AND NOT ("catalog_sizechart"."id" = $3)` : ''
          }) LIMIT 1`,
        chart ? [attributeId, name, chart.id] : [attributeId, name],
      );
      if (clash)
        throw chartError('name', `${attribute.name} already has a chart called “${name}”.`);

      const system = pyStrip(data.system ?? chart?.system ?? '');
      if (pyLen(system) > 40)
        throw chartError('system', 'Keep the sizing system under 40 characters.');
      const notes = pyStrip(data.notes ?? chart?.notes ?? '');
      if (pyLen(notes) > MAX_CHART_NOTES)
        throw chartError('notes', `Keep the notes under ${MAX_CHART_NOTES} characters.`);
      const position = data.position ?? chart?.position ?? 0;

      const storedColumns = chart ? (parsePythonJson(chart.columns) as unknown[]) : [];
      const columns = cleanColumns(data.columns !== undefined ? data.columns : storedColumns);

      let rawRows: { attribute_value: unknown; cells: unknown }[];
      if (rows !== undefined) rawRows = rows;
      else if (chart !== null) {
        rawRows = (
          await tx.query<{ attribute_value_id: string; cells: string }>(
            `SELECT r."attribute_value_id", r."cells"::text AS "cells" FROM "catalog_sizechartrow" r
               INNER JOIN "catalog_attributevalue" v ON (r."attribute_value_id" = v."id")
              WHERE r."chart_id" = $1 ORDER BY v."position" ASC, v."value" ASC`,
            [chart.id],
          )
        ).map((row) => ({
          attribute_value: row.attribute_value_id,
          cells: parsePythonJson(row.cells),
        }));
      } else rawRows = [];
      const cleanedRows = await cleanRows(tx, rawRows, attributeId, attribute.name, columns.length);

      const before = chart
        ? await this.snapshot(tx, {
            id: chart.id,
            name: chart.name,
            system: chart.system,
            columns: parsePythonJson(chart.columns) as unknown[],
            notes: chart.notes,
          })
        : null;
      const chartId = chart?.id ?? randomUUID();
      if (chart === null) {
        await tx.query(
          `INSERT INTO "catalog_sizechart" ("id", "created_at", "updated_at", "attribute_id", "name",
             "system", "columns", "notes", "position", "created_by_id")
           VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [
            chartId,
            attributeId,
            name,
            system,
            JSON.stringify(columns),
            notes,
            position || 0,
            actor.id,
          ],
        );
      } else {
        await tx.query(
          `UPDATE "catalog_sizechart" SET "updated_at" = clock_timestamp(), "attribute_id" = $2,
             "name" = $3, "system" = $4, "columns" = $5::jsonb, "notes" = $6, "position" = $7,
             "created_by_id" = $8
           WHERE "catalog_sizechart"."id" = $1`,
          [
            chartId,
            attributeId,
            name,
            system,
            JSON.stringify(columns),
            notes,
            position || 0,
            chart.created_by_id,
          ],
        );
      }
      await tx.query(`DELETE FROM "catalog_sizechartrow" WHERE "chart_id" IN ($1)`, [chartId]);
      for (const row of cleanedRows) {
        await tx.query(
          `INSERT INTO "catalog_sizechartrow" ("id", "created_at", "updated_at", "chart_id",
             "attribute_value_id", "cells")
           VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4::jsonb)`,
          [randomUUID(), chartId, row.value, JSON.stringify(row.cells)],
        );
      }

      const after = await this.snapshot(tx, { id: chartId, name, system, columns, notes });
      const entity = { type: 'SizeChart', id: chartId, label: `${attribute.name}: ${name}` };
      if (before === null) {
        await recordAudit(tx, context, {
          action: 'CREATE',
          entity,
          actor,
          newValues: { attribute: attribute.name, ...after },
          reason: 'Size chart created',
        });
      } else {
        const changed = Object.keys(after).filter((key) => !pyEqual(before[key], after[key]));
        if (changed.length) {
          await recordAudit(tx, context, {
            action: 'UPDATE',
            entity,
            actor,
            oldValues: Object.fromEntries(changed.map((key) => [key, before[key]])),
            newValues: Object.fromEntries(changed.map((key) => [key, after[key]])),
            reason: 'Size chart changed',
          });
        }
      }
      return chartId;
    });
    // `transaction.on_commit`: the product pages are dropped once the chart is there to read.
    await this.revalidation.request('products');
    return id;
  }

  /** `delete_size_chart`: refused in words while any product uses the chart. */
  async destroy(chart: ChartRow, actor: AuditActor, context: AuditContext): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      const used = Number(
        (
          await tx.one<{ count: number }>(
            `SELECT COUNT(*)::int AS "count" FROM "catalog_product" WHERE "size_chart_id" = $1`,
            [chart.id],
          )
        )?.count ?? 0,
      );
      if (used) {
        throw new Conflict(
          `“${chart.name}” is the size chart for ${used} product${used === 1 ? '' : 's'} and ` +
            'cannot be deleted. Pick another chart for them first.',
          { details: { product_count: used } },
        );
      }
      await recordAudit(tx, context, {
        action: 'DELETE',
        entity: {
          type: 'SizeChart',
          id: chart.id,
          label: `${chart.attribute_name}: ${chart.name}`,
        },
        actor,
        oldValues: await this.snapshot(tx, {
          id: chart.id,
          name: chart.name,
          system: chart.system,
          columns: parsePythonJson(chart.columns) as unknown[],
          notes: chart.notes,
        }),
        reason: 'Size chart deleted',
      });
      await tx.query(`DELETE FROM "catalog_sizechartrow" WHERE "chart_id" IN ($1)`, [chart.id]);
      await tx.query(`DELETE FROM "catalog_sizechart" WHERE "id" IN ($1)`, [chart.id]);
    });
  }
}

/** A `ListField(child=CharField())` read back: each item as `str()`. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => pyStr(item)) : [];
}

/** Python's `str.casefold()` as an equality key: case folded both ways. */
function folded(text: string): string {
  return text.toUpperCase().toLowerCase();
}

/** `_clean_columns`: at least one, at most twelve, each named, short and distinct. */
function cleanColumns(columns: unknown): string[] {
  if (!Array.isArray(columns) || columns.length === 0)
    throw chartError('columns', 'Add at least one column, such as Chest (cm) or UK.');
  if (columns.length > MAX_CHART_COLUMNS)
    throw chartError('columns', `A chart can have at most ${MAX_CHART_COLUMNS} columns.`);
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const label of columns) {
    const text = pyStrip(pyStr(truthy(label) ? label : ''));
    if (!text) throw chartError('columns', 'Every column needs a heading.');
    if (pyLen(text) > MAX_COLUMN_LABEL) {
      throw chartError(
        'columns',
        `“${pySlice(text, 20)}…” is too long for a heading (${MAX_COLUMN_LABEL} max).`,
      );
    }
    if (seen.has(folded(text)))
      throw chartError('columns', `“${text}” is there twice. Each heading must differ.`);
    seen.add(folded(text));
    cleaned.push(text);
  }
  return cleaned;
}

/** Python truthiness of a parsed JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '' || value === 0)
    return false;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * `_clean_rows`: every size one of the attribute's own values and there
 * once, with one figure per column, some figure filled in, none too long.
 */
async function cleanRows(
  q: Queryable,
  rows: { attribute_value: unknown; cells: unknown }[],
  attributeId: string,
  attributeName: string,
  width: number,
): Promise<{ value: string; cells: string[] }[]> {
  if (!Array.isArray(rows) || rows.length === 0)
    throw chartError('rows', 'Include at least one size.');
  const values = new Map(
    (
      await q.query<{ id: string; value: string; label: string }>(
        `SELECT "id", "value", "label" FROM "catalog_attributevalue" WHERE "attribute_id" = $1`,
        [attributeId],
      )
    ).map((row) => [row.id, row]),
  );
  const cleaned: { value: string; cells: string[] }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const valueId = truthy(row.attribute_value) ? pyStr(row.attribute_value) : '';
    const value = values.get(valueId);
    if (!value) {
      throw chartError(
        'rows',
        `One of those sizes is not a ${attributeName} value. Reload and try again.`,
      );
    }
    const display = value.label || value.value;
    if (seen.has(valueId)) throw chartError('rows', `${display} is in the chart twice.`);
    seen.add(valueId);
    const cells = row.cells;
    if (!Array.isArray(cells) || cells.length !== width) {
      throw chartError(
        'rows',
        `${display} has ${Array.isArray(cells) ? cells.length : 0} figure(s) for ${width} column(s). ` +
          'Every size needs one per column.',
      );
    }
    const texts = cells.map((item: unknown) => pyStrip(item === null ? '' : pyStr(item)));
    if (!texts.some((text) => text !== ''))
      throw chartError('rows', `${display} has no figures. Fill it in, or leave that size out.`);
    const long = texts.find((text) => pyLen(text) > MAX_CELL_LENGTH);
    if (long !== undefined) {
      throw chartError(
        'rows',
        `“${pySlice(long, 20)}…” under ${display} is too long (${MAX_CELL_LENGTH} max).`,
      );
    }
    cleaned.push({ value: valueId, cells: texts });
  }
  return cleaned;
}
