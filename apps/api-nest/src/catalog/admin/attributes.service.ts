import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  booleanField,
  charField,
  choiceField,
  errorMessages,
  Fields,
  integerField,
  Invalid,
  pkRelatedField,
  runSerializer,
  slugField,
  UniqueCheck,
} from '../../common/drf';
import { Conflict, NotFound, ValidationError } from '../../common/errors';
import { applyFilters, modelFilter, orderingPlan, type OrderingTerm } from '../../common/filtering';
import { pyStr, pyStrip } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { dataGet } from '../../http/request-body';

/**
 * `AttributeViewSet` and `AttributeValueViewSet` (`catalog/api/views.py`):
 * the properties variants are built on (Size, Colour) and the values each
 * can take. Unpaginated, no audit entries.
 *
 * Neither view names `ordering_fields`, so `OrderingFilter` allows every
 * field its serializer reads from the model -- a relation among them, which
 * Django orders by the related model's own ordering through a join, one row
 * per related row.
 */

export const ATTRIBUTE_KINDS = ['TEXT', 'COLOR', 'NUMBER', 'SIZE'] as const;
const KIND_LABELS: Record<string, string> = {
  TEXT: 'Text',
  COLOR: 'Colour',
  NUMBER: 'Number',
  SIZE: 'Size',
};

export interface AttributeRow {
  id: string;
  name: string;
  code: string;
  kind: string;
  is_variant_defining: boolean;
  is_filterable: boolean;
  position: number;
  /** The view's annotation; absent on a row read without it. */
  variant_usage_count?: number;
}

export interface ValueRow {
  id: string;
  attribute_id: string;
  value: string;
  label: string;
  swatch: string;
  position: number;
  attribute_code: string;
}

/** `get_kind_display()`. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

const ATTRIBUTE_COLUMNS = `"catalog_attribute"."id", "catalog_attribute"."name", "catalog_attribute"."code",
  "catalog_attribute"."kind", "catalog_attribute"."is_variant_defining",
  "catalog_attribute"."is_filterable", "catalog_attribute"."position"`;
const VARIANT_USAGE = `COALESCE((SELECT COUNT(U0."id") AS "total" FROM "catalog_variantattributevalue" U0
  WHERE U0."attribute_id" = ("catalog_attribute"."id") GROUP BY U0."attribute_id" LIMIT 1), 0)::int`;

const ATTRIBUTE_ORDERING: Record<string, OrderingTerm> = {
  id: '"catalog_attribute"."id"',
  name: '"catalog_attribute"."name"',
  code: '"catalog_attribute"."code"',
  kind: '"catalog_attribute"."kind"',
  is_variant_defining: '"catalog_attribute"."is_variant_defining"',
  is_filterable: '"catalog_attribute"."is_filterable"',
  position: '"catalog_attribute"."position"',
  // A reverse relation: one row per value, ordered as the values are.
  values: {
    columns: [
      'T3."position"',
      'T3."name"',
      '"catalog_attributevalue"."position"',
      '"catalog_attributevalue"."value"',
    ],
    join: `LEFT OUTER JOIN "catalog_attributevalue" ON ("catalog_attribute"."id" = "catalog_attributevalue"."attribute_id")
      LEFT OUTER JOIN "catalog_attribute" T3 ON ("catalog_attributevalue"."attribute_id" = T3."id")`,
  },
};

const VALUE_COLUMNS = `"catalog_attributevalue"."id", "catalog_attributevalue"."attribute_id",
  "catalog_attributevalue"."value", "catalog_attributevalue"."label",
  "catalog_attributevalue"."swatch", "catalog_attributevalue"."position",
  "catalog_attribute"."code" AS "attribute_code"`;
const VALUE_FILTERS = [
  modelFilter('attribute', '"catalog_attributevalue"."attribute_id"', 'catalog_attribute'),
];
const VALUE_ORDERING: Record<string, OrderingTerm> = {
  id: '"catalog_attributevalue"."id"',
  attribute: { columns: ['"catalog_attribute"."position"', '"catalog_attribute"."name"'] },
  attribute__code: '"catalog_attribute"."code"',
  value: '"catalog_attributevalue"."value"',
  label: '"catalog_attributevalue"."label"',
  swatch: '"catalog_attributevalue"."swatch"',
  position: '"catalog_attributevalue"."position"',
};
const VALUE_DEFAULT_ORDER = [
  '"catalog_attribute"."position" ASC',
  '"catalog_attribute"."name" ASC',
  '"catalog_attributevalue"."position" ASC',
  '"catalog_attributevalue"."value" ASC',
];

/** `#rgb`, `#rrggbb` or `#rrggbbaa`. */
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** `'' if n == 1 else 's'`. */
function plural(count: number): string {
  return count === 1 ? '' : 's';
}

type AttributeData = Partial<{
  name: string;
  code: string;
  kind: string;
  is_variant_defining: boolean;
  is_filterable: boolean;
  position: number;
}>;

type ValueData = Partial<{
  attribute: string;
  value: string;
  label: string;
  swatch: string;
  position: number;
}>;

@Injectable()
export class AttributesService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async count(sql: string, id: string): Promise<number> {
    const row = await this.db.one<{ count: number }>(sql, [id]);
    return Number(row?.count ?? 0);
  }

  // --- Attributes ------------------------------------------------------------------

  /** The values nested under each attribute: its own, in its order. */
  private async valuesOf(ids: string[]): Promise<Map<string, ValueRow[]>> {
    const byAttribute = new Map<string, ValueRow[]>();
    if (!ids.length) return byAttribute;
    const rows = await this.db.query<ValueRow>(
      `SELECT ${VALUE_COLUMNS} FROM "catalog_attributevalue"
         INNER JOIN "catalog_attribute" ON ("catalog_attributevalue"."attribute_id" = "catalog_attribute"."id")
        WHERE "catalog_attributevalue"."attribute_id" = ANY($1::uuid[])
        ORDER BY ${VALUE_DEFAULT_ORDER.join(', ')}`,
      [[...new Set(ids)]],
    );
    for (const row of rows) {
      const list = byAttribute.get(row.attribute_id) ?? [];
      list.push(row);
      byAttribute.set(row.attribute_id, list);
    }
    return byAttribute;
  }

  /** `AttributeSerializer(attribute).data`. */
  private async serialiseAttribute(
    row: AttributeRow,
    values: ValueRow[],
  ): Promise<Record<string, unknown>> {
    const usage =
      row.variant_usage_count ??
      (await this.count(
        `SELECT COUNT(*)::int AS "count" FROM "catalog_variantattributevalue" WHERE "attribute_id" = $1`,
        row.id,
      ));
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      kind: row.kind,
      is_variant_defining: row.is_variant_defining,
      is_filterable: row.is_filterable,
      position: row.position,
      values: values.map((value) => serialiseValue(value)),
      variant_usage: usage,
    };
  }

  async serialiseAttributes(rows: AttributeRow[]): Promise<Record<string, unknown>[]> {
    const values = await this.valuesOf(rows.map((row) => row.id));
    const out: Record<string, unknown>[] = [];
    for (const row of rows) out.push(await this.serialiseAttribute(row, values.get(row.id) ?? []));
    return out;
  }

  async serialiseOneAttribute(row: AttributeRow): Promise<Record<string, unknown>> {
    return (await this.serialiseAttributes([row]))[0] as Record<string, unknown>;
  }

  /**
   * The queryset's SQL. A lookup passes no query: `QuerySet.get()` clears the
   * ordering, so a relation term's join never repeats the row being fetched.
   */
  private attributeQuery(query: QueryDict | null, where: string[], limit = ''): string {
    const plan = query ? orderingPlan(query, ATTRIBUTE_ORDERING) : null;
    const order = plan?.order ?? [
      '"catalog_attribute"."position" ASC',
      '"catalog_attribute"."name" ASC',
    ];
    return `SELECT ${ATTRIBUTE_COLUMNS}, ${VARIANT_USAGE} AS "variant_usage_count"
      FROM "catalog_attribute" ${plan?.joins.join(' ') ?? ''}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order.join(', ')}${limit}`;
  }

  async listAttributes(query: QueryDict): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<AttributeRow>(this.attributeQuery(query, []));
    return this.serialiseAttributes(rows);
  }

  async findAttribute(pk: string, _query: QueryDict): Promise<AttributeRow> {
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    return single(
      await this.db.query<AttributeRow>(
        this.attributeQuery(null, ['"catalog_attribute"."id" = $1'], ' LIMIT 21'),
        [id],
      ),
    );
  }

  private unique(
    table: string,
    column: string,
    label: string,
    exclude: string | null,
  ): UniqueCheck {
    return {
      message: `${label} with this ${column} already exists.`,
      exists: async (value) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM "${table}" WHERE ("${table}"."${column}" = $1${
            exclude ? ` AND NOT ("${table}"."id" = $2)` : ''
          }) LIMIT 1`,
          exclude ? [value, exclude] : [value],
        )) !== null,
    };
  }

  /** `AttributeSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validateAttribute(
    data: unknown,
    instance: AttributeRow | null,
    partial: boolean,
  ): Promise<AttributeData> {
    const exclude = instance?.id ?? null;
    const fields: Fields = {
      name: charField({
        maxLength: 64,
        unique: this.unique('catalog_attribute', 'name', 'attribute', exclude),
      }),
      code: slugField({
        maxLength: 64,
        unique: this.unique('catalog_attribute', 'code', 'attribute', exclude),
      }),
      kind: choiceField(ATTRIBUTE_KINDS, { required: false }),
      is_variant_defining: booleanField({ required: false }),
      is_filterable: booleanField({ required: false }),
      position: integerField({ maxValue: 2147483647, minValue: 0, required: false }),
    };
    const result = await runSerializer<AttributeData>(fields, data, {
      partial,
      hooks: {
        kind: async (value: string) => {
          // A Size attribute with size charts stays a Size attribute.
          if (instance && instance.kind === 'SIZE' && value !== 'SIZE') {
            const charts = await this.count(
              `SELECT COUNT(*)::int AS "count" FROM "catalog_sizechart" WHERE "attribute_id" = $1`,
              instance.id,
            );
            if (charts) {
              throw Invalid.of(
                `${charts} size chart${plural(charts)} describe ${charts === 1 ? 'this attribute' : 'it'}, ` +
                  'so it must stay a Size attribute. Delete the charts first.',
              );
            }
          }
          return value;
        },
        is_variant_defining: async (value: boolean) => {
          if (instance === null || instance.is_variant_defining === value) return value;
          if (value) {
            const stated = await this.count(
              `SELECT COUNT(*)::int AS "count" FROM "catalog_productattributevalue" p
                 INNER JOIN "catalog_attributevalue" v ON (p."attribute_value_id" = v."id")
                WHERE v."attribute_id" = $1`,
              instance.id,
            );
            if (stated) {
              throw Invalid.of(
                `${stated} product${plural(stated)} state this attribute as a specification, so it ` +
                  'cannot start defining variants. Clear it from those products first, or add a ' +
                  'separate attribute.',
              );
            }
            return value;
          }
          const used = await this.count(
            `SELECT COUNT(*)::int AS "count" FROM "catalog_variantattributevalue" WHERE "attribute_id" = $1`,
            instance.id,
          );
          if (used) {
            throw Invalid.of(
              `${used} variant${plural(used)} are defined by this attribute, so it cannot stop ` +
                'being variant-defining. Those SKUs exist because of it.',
            );
          }
          return value;
        },
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  async createAttribute(data: AttributeData): Promise<AttributeRow> {
    const row: AttributeRow = {
      id: randomUUID(),
      name: data.name as string,
      code: data.code as string,
      kind: data.kind ?? 'TEXT',
      is_variant_defining: data.is_variant_defining ?? true,
      is_filterable: data.is_filterable ?? true,
      position: data.position ?? 0,
    };
    await this.db.query(
      `INSERT INTO "catalog_attribute" ("id", "created_at", "updated_at", "name", "code", "kind",
         "is_variant_defining", "is_filterable", "position")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.name,
        row.code,
        row.kind,
        row.is_variant_defining,
        row.is_filterable,
        row.position,
      ],
    );
    return row;
  }

  async updateAttribute(instance: AttributeRow, data: AttributeData): Promise<AttributeRow> {
    const row: AttributeRow = { ...instance, ...data };
    await this.db.query(
      `UPDATE "catalog_attribute" SET "updated_at" = clock_timestamp(), "name" = $2, "code" = $3,
         "kind" = $4, "is_variant_defining" = $5, "is_filterable" = $6, "position" = $7
       WHERE "catalog_attribute"."id" = $1`,
      [
        row.id,
        row.name,
        row.code,
        row.kind,
        row.is_variant_defining,
        row.is_filterable,
        row.position,
      ],
    );
    return row;
  }

  /**
   * `perform_destroy`: refused in words while variants are built on it,
   * products state it, or size charts describe it; otherwise its values,
   * category links and image colours go with it.
   */
  async destroyAttribute(instance: AttributeRow): Promise<void> {
    const used = await this.count(
      `SELECT COUNT(*)::int AS "count" FROM "catalog_variantattributevalue" WHERE "attribute_id" = $1`,
      instance.id,
    );
    if (used) {
      throw new Conflict(
        `“${instance.name}” defines ${used} variant${plural(used)} and cannot be deleted. ` +
          'Those SKUs would lose the axis they were generated on.',
        { details: { variant_usage: used } },
      );
    }
    const stated = await this.count(
      `SELECT COUNT(*)::int AS "count" FROM "catalog_productattributevalue" p
         INNER JOIN "catalog_attributevalue" v ON (p."attribute_value_id" = v."id")
        WHERE v."attribute_id" = $1`,
      instance.id,
    );
    if (stated) {
      throw new Conflict(
        `“${instance.name}” is stated as a specification on ${stated} product${plural(stated)} ` +
          'and cannot be deleted. Clear it from those products first.',
        { details: { spec_usage: stated } },
      );
    }
    const charts = await this.count(
      `SELECT COUNT(*)::int AS "count" FROM "catalog_sizechart" WHERE "attribute_id" = $1`,
      instance.id,
    );
    if (charts) {
      throw new Conflict(
        `“${instance.name}” has ${charts} size chart${plural(charts)} and cannot be deleted. ` +
          'Delete the charts first.',
        { details: { size_chart_usage: charts } },
      );
    }
    await this.db.transaction(async (tx: Queryable) => {
      const values = (
        await tx.query<{ id: string }>(
          `SELECT "id" FROM "catalog_attributevalue" WHERE "attribute_id" = $1`,
          [instance.id],
        )
      ).map((row) => row.id);
      await this.removeValues(tx, values);
      await tx.query(`DELETE FROM "catalog_categoryattribute" WHERE "attribute_id" = $1`, [
        instance.id,
      ]);
      await tx.query(`DELETE FROM "catalog_attribute" WHERE "id" = $1`, [instance.id]);
    });
  }

  /** Delete values, clearing the colour of any image that carried one (`SET_NULL`). */
  private async removeValues(tx: Queryable, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await tx.query(
      `UPDATE "catalog_productimage" SET "attribute_value_id" = NULL
        WHERE "attribute_value_id" = ANY($1::uuid[])`,
      [ids],
    );
    await tx.query(`DELETE FROM "catalog_attributevalue" WHERE "id" = ANY($1::uuid[])`, [ids]);
  }

  // --- Attribute values ------------------------------------------------------------

  /** `filter_queryset(get_queryset())`, with any extra conditions after the filters'. */
  private async valueQuery(query: QueryDict, sql: SqlParams, extra: (sql: SqlParams) => string[]) {
    const where: string[] = [];
    await applyFilters(this.db, query, VALUE_FILTERS, sql, where);
    where.push(...extra(sql));
    const order = orderingPlan(query, VALUE_ORDERING)?.order ?? VALUE_DEFAULT_ORDER;
    return `SELECT ${VALUE_COLUMNS} FROM "catalog_attributevalue"
        INNER JOIN "catalog_attribute" ON ("catalog_attributevalue"."attribute_id" = "catalog_attribute"."id")
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${order.join(', ')}`;
  }

  async listValues(query: QueryDict): Promise<Record<string, unknown>[]> {
    const sql = new SqlParams();
    const rows = await this.db.query<ValueRow>(
      await this.valueQuery(query, sql, () => []),
      sql.values,
    );
    return rows.map((row) => serialiseValue(row));
  }

  async findValue(pk: string, query: QueryDict): Promise<ValueRow> {
    const sql = new SqlParams();
    // The filters are validated before the key is even read.
    const text = await this.valueQuery(query, sql, (params) => {
      const id = parseUuid(pk);
      if (!id) throw new NotFound();
      return [`"catalog_attributevalue"."id" = ${params.add(id, 'uuid')}`];
    });
    return single(await this.db.query<ValueRow>(`${text} LIMIT 21`, sql.values));
  }

  /** `AttributeValueSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validateValue(
    data: unknown,
    instance: ValueRow | null,
    partial: boolean,
  ): Promise<ValueData> {
    const attributeExists = async (id: string) =>
      (await this.db.one(`SELECT 1 FROM "catalog_attribute" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
    const fields: Fields = {
      attribute: pkRelatedField(attributeExists),
      value: charField({ maxLength: 64 }),
      label: charField({ allowBlank: true, maxLength: 64, required: false }),
      swatch: charField({ allowBlank: true, maxLength: 32, required: false }),
      position: integerField({ maxValue: 2147483647, minValue: 0, required: false }),
    };
    const result = await runSerializer<ValueData>(fields, data, {
      partial,
      hooks: {
        // A swatch is a colour or it is nothing: it is painted straight into a style.
        swatch: (value: string) => {
          const cleaned = pyStrip(value ?? '');
          if (!cleaned) return '';
          if (!HEX_COLOUR.test(cleaned)) {
            throw Invalid.of(
              'Use a hex colour such as #1E3A8A. A colour name or an rgb() string is stored ' +
                'happily and then renders as nothing.',
            );
          }
          return cleaned.toLowerCase();
        },
      },
      // `UniqueTogetherValidator(fields=("attribute", "value"))`, then no `validate()`.
      validate: async (attrs) => {
        if (instance !== null) {
          attrs.attribute ??= instance.attribute_id;
          attrs.value ??= instance.value;
        }
        const changed =
          instance === null
            ? [attrs.attribute, attrs.value]
            : [
                attrs.attribute !== instance.attribute_id ? attrs.attribute : undefined,
                attrs.value !== instance.value ? attrs.value : undefined,
              ].filter((item) => item !== undefined);
        if (changed.length) {
          const clash = await this.db.one(
            `SELECT 1 AS "a" FROM "catalog_attributevalue"
              WHERE ("catalog_attributevalue"."attribute_id" = $1 AND "catalog_attributevalue"."value" = $2${
                instance ? ` AND NOT ("catalog_attributevalue"."id" = $3)` : ''
              }) LIMIT 1`,
            instance ? [attrs.attribute, attrs.value, instance.id] : [attrs.attribute, attrs.value],
          );
          if (clash)
            throw Invalid.of('The fields attribute, value must make a unique set.', 'unique');
        }
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  private async attributeCode(id: string): Promise<string> {
    const row = await this.db.one<{ code: string }>(
      `SELECT "code" FROM "catalog_attribute" WHERE "id" = $1`,
      [id],
    );
    return row?.code ?? '';
  }

  async createValue(data: ValueData): Promise<ValueRow> {
    const row: ValueRow = {
      id: randomUUID(),
      attribute_id: data.attribute as string,
      value: data.value as string,
      label: data.label ?? '',
      swatch: data.swatch ?? '',
      position: data.position ?? 0,
      attribute_code: '',
    };
    await this.db.query(
      `INSERT INTO "catalog_attributevalue" ("id", "created_at", "updated_at", "attribute_id",
         "value", "label", "swatch", "position")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6)`,
      [row.id, row.attribute_id, row.value, row.label, row.swatch, row.position],
    );
    row.attribute_code = await this.attributeCode(row.attribute_id);
    return row;
  }

  async updateValue(instance: ValueRow, data: ValueData): Promise<ValueRow> {
    const { attribute, ...rest } = data;
    const row: ValueRow = { ...instance, ...rest };
    if (attribute !== undefined && attribute !== instance.attribute_id) {
      row.attribute_id = attribute;
      row.attribute_code = await this.attributeCode(attribute);
    }
    await this.db.query(
      `UPDATE "catalog_attributevalue" SET "updated_at" = clock_timestamp(), "attribute_id" = $2,
         "value" = $3, "label" = $4, "swatch" = $5, "position" = $6
       WHERE "catalog_attributevalue"."id" = $1`,
      [row.id, row.attribute_id, row.value, row.label, row.swatch, row.position],
    );
    return row;
  }

  /** `perform_destroy`: refused in words while variants, products or size charts use it. */
  async destroyValue(instance: ValueRow): Promise<void> {
    const display = instance.label || instance.value;
    const used = await this.count(
      `SELECT COUNT(*)::int AS "count" FROM "catalog_variantattributevalue" WHERE "attribute_value_id" = $1`,
      instance.id,
    );
    if (used) {
      throw new Conflict(
        `“${display}” is carried by ${used} variant${plural(used)} and cannot be deleted. ` +
          'Rename it instead — orders froze their own label at sale time, so history does not move.',
        { details: { variant_usage: used } },
      );
    }
    const stated = await this.count(
      `SELECT COUNT(*)::int AS "count" FROM "catalog_productattributevalue" WHERE "attribute_value_id" = $1`,
      instance.id,
    );
    if (stated) {
      throw new Conflict(
        `“${display}” is stated as a specification on ${stated} product${plural(stated)} and ` +
          'cannot be deleted. Rename it instead, or clear it from those products first.',
        { details: { spec_usage: stated } },
      );
    }
    const charted = await this.count(
      `SELECT COUNT(*)::int AS "count" FROM "catalog_sizechartrow" WHERE "attribute_value_id" = $1`,
      instance.id,
    );
    if (charted) {
      throw new Conflict(
        `“${display}” is in ${charted} size chart${plural(charted)} and cannot be deleted. ` +
          'Rename it instead, or take it out of those charts first.',
        { details: { size_chart_usage: charted } },
      );
    }
    await this.db.transaction((tx: Queryable) => this.removeValues(tx, [instance.id]));
  }

  /** `move`'s direction, read before the value is looked up: `str(...).lower()`. */
  direction(data: unknown): 'up' | 'down' {
    const raw = dataGet(data, 'direction');
    const direction = (raw === undefined ? '' : pyStr(raw)).toLowerCase();
    if (direction !== 'up' && direction !== 'down')
      throw new ValidationError("Direction must be 'up' or 'down'.");
    return direction;
  }

  /**
   * `move`: swap `position` with the neighbour, under a lock on every value
   * of the attribute (`ORDER BY position, value ... FOR UPDATE`). Where the
   * two share a position -- the seed leaves them all at 0 -- the whole run is
   * renumbered instead. The moved value's own position is the one read
   * before the lock, as Django reads it (D118).
   */
  async move(value: ValueRow, direction: 'up' | 'down'): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      const ordered = await tx.query<{ id: string; position: number }>(
        `SELECT "catalog_attributevalue"."id", "catalog_attributevalue"."position"
           FROM "catalog_attributevalue"
          WHERE "catalog_attributevalue"."attribute_id" = $1
          ORDER BY "catalog_attributevalue"."position" ASC, "catalog_attributevalue"."value" ASC
          FOR UPDATE`,
        [value.attribute_id],
      );
      const index = ordered.findIndex((row) => row.id === value.id);
      if (index === -1) throw new Error('StopIteration');
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= ordered.length) return;
      const neighbour = ordered[target] as { id: string; position: number };
      const moved = neighbour.position;
      const displaced = value.position;
      if (moved === displaced) {
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]] as [
          { id: string; position: number },
          { id: string; position: number },
        ];
        await bulkPositions(
          tx,
          ordered.map((row, offset) => ({ id: row.id, position: offset })),
        );
      } else {
        await bulkPositions(tx, [
          { id: value.id, position: moved },
          { id: neighbour.id, position: displaced },
        ]);
      }
    });
  }
}

/**
 * `bulk_update(rows, ["position"])`: one UPDATE, a CASE over the ids, in the
 * rows' order. `updated_at` is not touched -- `bulk_update` writes only the
 * fields it is given.
 */
async function bulkPositions(
  tx: Queryable,
  rows: { id: string; position: number }[],
): Promise<void> {
  if (!rows.length) return;
  const values: unknown[] = [];
  const cases = rows
    .map((row) => {
      values.push(row.id, row.position);
      return `WHEN ("catalog_attributevalue"."id" = $${values.length - 1}::uuid) THEN $${values.length}::integer`;
    })
    .join(' ');
  values.push(rows.map((row) => row.id));
  await tx.query(
    `UPDATE "catalog_attributevalue" SET "position" = CASE ${cases} ELSE NULL END
      WHERE "catalog_attributevalue"."id" = ANY($${values.length}::uuid[])`,
    values,
  );
}

/**
 * `queryset.get(pk=...)` inside `get_object_or_404`: none is a 404, and more
 * than one -- an ordering through a relation repeats the row -- is Django's
 * `MultipleObjectsReturned`, which nothing catches: a 500.
 */
export function single<T>(rows: T[]): T {
  if (!rows.length) throw new NotFound();
  if (rows.length > 1) throw new Error(`MultipleObjectsReturned: get() returned ${rows.length}`);
  return rows[0] as T;
}

/** `AttributeValueSerializer(value).data`. */
export function serialiseValue(row: ValueRow): Record<string, unknown> {
  return {
    id: row.id,
    attribute: row.attribute_id,
    attribute_code: row.attribute_code,
    value: row.value,
    label: row.label,
    display: row.label || row.value,
    swatch: row.swatch,
    position: row.position,
  };
}
