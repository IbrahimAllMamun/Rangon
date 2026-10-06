import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ProtectedError } from '../catalog/admin/deletion';
import { Dec } from '../common/decimal';
import {
  booleanField,
  charField,
  decimalField,
  errorMessages,
  type Fields,
  integerField,
  Invalid,
  InvalidFields,
  jsonField,
  pkRelatedField,
  runSerializer,
  slugField,
  type UniqueCheck,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  booleanFilter,
  type FilterField,
  modelFilter,
  orderingPlan,
  type OrderingTerm,
} from '../common/filtering';
import { normalizeIfMobile } from '../common/phone';
import { pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { Database, Queryable } from '../database/database.service';
import { columns, Params as SqlParams } from '../database/sql';
import { parsePythonJson } from '../http/request-body';

/**
 * `ShippingZoneViewSet`, `ShippingMethodViewSet` and `CourierViewSet`: where
 * the shop delivers, what each way of getting there costs, and who carries
 * the parcel. Three plain `ModelViewSet`s, unpaginated; what a shopper is
 * offered at checkout is `checkout`'s reading of the same rows.
 */

const Z = '"shipping_shippingzone"';
const M = '"shipping_shippingmethod"';
const K = '"shipping_courier"';
const ZONE_COLUMNS = ['id', 'name', 'description', 'is_default', 'position', 'is_active'] as const;
const ZONE_SELECT = `${columns(Z, ZONE_COLUMNS)}, ${Z}."cities"::text AS "cities"`;
const METHOD_COLUMNS = [
  'id',
  'zone_id',
  'name',
  'code',
  'description',
  'price',
  'free_over',
  'min_days',
  'max_days',
  'is_pickup',
  'supports_cod',
  'is_active',
  'position',
] as const;
const METHOD_SELECT = `${columns(M, METHOD_COLUMNS)}, ${Z}."name" AS "zone_name"`;
const METHOD_FROM = `FROM ${M} INNER JOIN ${Z} ON (${M}."zone_id" = ${Z}."id")`;
const COURIER_COLUMNS = [
  'id',
  'name',
  'code',
  'phone',
  'tracking_url_template',
  'integration',
  'is_active',
] as const;
const INT = { minValue: 0, maxValue: 2147483647 };
const SMALL_INT = { minValue: 0, maxValue: 32767 };

/** The views name no `ordering_fields`: every serializer field the model holds, by its source. */
const ZONE_ORDERING: Readonly<Record<string, OrderingTerm>> = {
  ...Object.fromEntries(
    ['id', 'name', 'description', 'cities', 'is_default', 'position', 'is_active'].map((name) => [
      name,
      `${Z}."${name}"`,
    ]),
  ),
  // A zone's methods order it by theirs, one row per method.
  methods: {
    columns: [`${M}."position"`, `${M}."price"`],
    join: `LEFT OUTER JOIN ${M} ON (${Z}."id" = ${M}."zone_id")`,
  },
};
const METHOD_ORDERING: Readonly<Record<string, OrderingTerm>> = {
  ...Object.fromEntries(
    [
      'id',
      'name',
      'code',
      'description',
      'price',
      'free_over',
      'min_days',
      'max_days',
      'is_pickup',
      'supports_cod',
      'is_active',
      'position',
    ].map((name) => [name, `${M}."${name}"`]),
  ),
  zone: { columns: [`${Z}."position"`, `${Z}."name"`] },
  zone__name: `${Z}."name"`,
};
const COURIER_ORDERING = Object.fromEntries(
  COURIER_COLUMNS.map((name) => [name, `${K}."${name}"`]),
);
const METHOD_FILTERS: readonly FilterField[] = [
  modelFilter('zone', `${M}."zone_id"`, 'shipping_shippingzone'),
  booleanFilter('is_active', `${M}."is_active"`),
];

interface ZoneRow {
  id: string;
  name: string;
  description: string;
  /** The stored JSON's own text. */
  cities: string;
  is_default: boolean;
  position: number;
  is_active: boolean;
}

interface MethodRow {
  id: string;
  zone_id: string;
  name: string;
  code: string;
  description: string;
  price: string;
  free_over: string | null;
  min_days: number;
  max_days: number;
  is_pickup: boolean;
  supports_cod: boolean;
  is_active: boolean;
  position: number;
  zone_name: string;
}

interface CourierRow {
  id: string;
  name: string;
  code: string;
  phone: string;
  tracking_url_template: string;
  integration: string;
  is_active: boolean;
}

type ZoneData = Partial<Omit<ZoneRow, 'id' | 'cities'> & { cities: string[] }>;
type MethodData = Partial<{
  zone: string;
  name: string;
  code: string;
  description: string;
  price: string;
  free_over: string | null;
  min_days: number;
  max_days: number;
  is_pickup: boolean;
  supports_cod: boolean;
  is_active: boolean;
  position: number;
}>;
type CourierData = Partial<Omit<CourierRow, 'id'>>;

/**
 * `validate_cities`: a list of names, stored trimmed, lower-cased and once
 * each. A bare string would be matched a character at a time.
 */
export function cleanCities(value: unknown): string[] {
  if (!Array.isArray(value))
    throw Invalid.of('Provide a list of city names, e.g. ["dhaka", "gazipur"].');
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw Invalid.of('Every city must be a name.');
    const name = pyStrip(entry).toLowerCase();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** `ShippingMethod.eta_label`. */
export function etaLabel(method: { is_pickup: boolean; min_days: number; max_days: number }) {
  if (method.is_pickup) return 'Collect in store';
  if (method.min_days === method.max_days)
    return `${method.min_days} day${method.min_days !== 1 ? 's' : ''}`;
  return `${method.min_days}–${method.max_days} days`;
}

@Injectable()
export class ShippingSettingsService {
  constructor(private readonly db: Database) {}

  private invalid<T>(result: { ok: false; errors: Parameters<typeof errorMessages>[0] }): T {
    throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
  }

  private unique(
    table: string,
    column: string,
    model: string,
    exclude: string | null,
  ): UniqueCheck {
    return {
      message: `${model} with this ${column} already exists.`,
      exists: async (value) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM "${table}" WHERE ("${table}"."${column}" = $1${
            exclude ? ` AND NOT ("${table}"."id" = $2)` : ''
          }) LIMIT 1`,
          exclude ? [value, exclude] : [value],
        )) !== null,
    };
  }

  private id(pk: string): string {
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    return id;
  }

  // --- Methods ---------------------------------------------------------------------------------

  /** `ShippingMethodSerializer(method).data`. */
  private method(row: MethodRow) {
    return {
      id: row.id,
      zone: row.zone_id,
      zone_name: row.zone_name,
      name: row.name,
      code: row.code,
      description: row.description,
      price: row.price,
      free_over: row.free_over,
      min_days: row.min_days,
      max_days: row.max_days,
      eta_label: etaLabel(row),
      is_pickup: row.is_pickup,
      supports_cod: row.supports_cod,
      is_active: row.is_active,
      position: row.position,
    };
  }

  async methods(query: QueryDict) {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, METHOD_FILTERS, sql, where);
    const order = orderingPlan(query, METHOD_ORDERING)?.order ?? [
      `${M}."position" ASC`,
      `${M}."price" ASC`,
    ];
    const rows = await this.db.query<MethodRow>(
      `SELECT ${METHOD_SELECT} ${METHOD_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${order.join(', ')}`,
      sql.values,
    );
    return rows.map((row) => this.method(row));
  }

  private async findMethod(pk: string, query: QueryDict): Promise<MethodRow> {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, METHOD_FILTERS, sql, where);
    where.push(`${M}."id" = ${sql.add(this.id(pk), 'uuid')}`);
    const row = await this.db.one<MethodRow>(
      `SELECT ${METHOD_SELECT} ${METHOD_FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieveMethod(pk: string, query: QueryDict) {
    return this.method(await this.findMethod(pk, query));
  }

  private async methodById(id: string) {
    return this.method(
      (await this.db.one<MethodRow>(
        `SELECT ${METHOD_SELECT} ${METHOD_FROM} WHERE ${M}."id" = $1 LIMIT 21`,
        [id],
      )) as MethodRow,
    );
  }

  /** `ShippingMethodSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  private async validateMethod(data: unknown, instance: MethodRow | null, partial: boolean) {
    const fields: Fields = {
      zone: pkRelatedField(async (id) => {
        const zone = await this.db.one(`SELECT 1 AS "a" FROM ${Z} WHERE "id" = $1 LIMIT 21`, [id]);
        return zone !== null;
      }),
      name: charField({ maxLength: 120 }),
      code: slugField({ maxLength: 48 }),
      description: charField({ maxLength: 255, required: false, allowBlank: true }),
      price: decimalField(14, 2, { required: false }),
      free_over: decimalField(14, 2, { required: false, allowNull: true }),
      min_days: integerField({ required: false, ...SMALL_INT }),
      max_days: integerField({ required: false, ...SMALL_INT }),
      is_pickup: booleanField({ required: false }),
      supports_cod: booleanField({ required: false }),
      is_active: booleanField({ required: false }),
      position: integerField({ required: false, ...INT }),
    };
    const result = await runSerializer<MethodData>(fields, data, {
      partial,
      hooks: {
        price: (value: string | null) => {
          if (value !== null && new Dec(value).lt(0))
            throw Invalid.of('A shipping price cannot be negative.');
          return value;
        },
        // A negative threshold is always met: every order would ship free.
        free_over: (value: string | null) => {
          if (value !== null && new Dec(value).lt(0)) {
            throw Invalid.of(
              'A free-shipping threshold cannot be negative — that would make every order free.',
            );
          }
          return value;
        },
      },
      validate: async (attrs) => {
        // `UniqueTogetherValidator(fields=("zone", "code"))`, then `validate()`.
        const zone = attrs.zone ?? instance?.zone_id;
        const code = attrs.code ?? instance?.code;
        if (instance === null || zone !== instance.zone_id || code !== instance.code) {
          const clash = await this.db.one(
            `SELECT 1 AS "a" FROM ${M} WHERE (${M}."zone_id" = $1 AND ${M}."code" = $2${
              instance ? ` AND NOT (${M}."id" = $3)` : ''
            }) LIMIT 1`,
            instance ? [zone, code, instance.id] : [zone, code],
          );
          if (clash) throw Invalid.of('The fields zone, code must make a unique set.', 'unique');
        }
        const resulting = (field: 'min_days' | 'max_days') =>
          Object.hasOwn(attrs, field) ? attrs[field] : (instance?.[field] ?? null);
        const shortest = resulting('min_days');
        const longest = resulting('max_days');
        if (shortest != null && longest != null && longest < shortest) {
          throw new InvalidFields({
            max_days: [
              {
                message: 'The longest estimate cannot be shorter than the shortest.',
                code: 'invalid',
              },
            ],
          });
        }
        return attrs;
      },
    });
    return result.ok ? result.values : this.invalid<MethodData>(result);
  }

  async createMethod(data: unknown) {
    const values = await this.validateMethod(data, null, false);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO ${M} ("id", "created_at", "updated_at", "zone_id", "name", "code", "description",
         "price", "free_over", "min_days", "max_days", "is_pickup", "supports_cod", "is_active",
         "position")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13)`,
      [
        id,
        values.zone,
        values.name,
        values.code,
        values.description ?? '',
        values.price ?? '0.00',
        values.free_over ?? null,
        values.min_days ?? 1,
        values.max_days ?? 3,
        values.is_pickup ?? false,
        values.supports_cod ?? true,
        values.is_active ?? true,
        values.position ?? 0,
      ],
    );
    return this.asWritten(await this.methodById(id), values);
  }

  /**
   * A write answers with the money it validated, not the money stored: a
   * price of "-0" passes the check for a negative one, is answered as "-0.00"
   * and kept as 0.00.
   */
  private asWritten<T extends { price: string; free_over: string | null }>(
    answer: T,
    values: MethodData,
  ): T {
    return {
      ...answer,
      ...(values.price !== undefined ? { price: values.price } : {}),
      ...(Object.hasOwn(values, 'free_over') ? { free_over: values.free_over } : {}),
    };
  }

  async updateMethod(pk: string, query: QueryDict, data: () => unknown, partial: boolean) {
    const instance = await this.findMethod(pk, query);
    const values = await this.validateMethod(data(), instance, partial);
    await this.db.query(
      `UPDATE ${M} SET "updated_at" = clock_timestamp(), "zone_id" = $2, "name" = $3, "code" = $4,
         "description" = $5, "price" = $6, "free_over" = $7, "min_days" = $8, "max_days" = $9,
         "is_pickup" = $10, "supports_cod" = $11, "is_active" = $12, "position" = $13
       WHERE ${M}."id" = $1`,
      [
        instance.id,
        values.zone ?? instance.zone_id,
        values.name ?? instance.name,
        values.code ?? instance.code,
        values.description ?? instance.description,
        values.price ?? instance.price,
        Object.hasOwn(values, 'free_over') ? values.free_over : instance.free_over,
        values.min_days ?? instance.min_days,
        values.max_days ?? instance.max_days,
        values.is_pickup ?? instance.is_pickup,
        values.supports_cod ?? instance.supports_cod,
        values.is_active ?? instance.is_active,
        values.position ?? instance.position,
      ],
    );
    return this.asWritten(await this.methodById(instance.id), values);
  }

  /** `method.delete()`: the parcels and orders that used it are left without one (`SET_NULL`). */
  private async deleteMethods(tx: Queryable, ids: string[]): Promise<void> {
    if (!ids.length) return;
    for (const table of ['orders_order', 'shipping_shipment']) {
      await tx.query(
        `UPDATE "${table}" SET "shipping_method_id" = NULL
          WHERE "shipping_method_id" = ANY($1::uuid[])`,
        [ids],
      );
    }
    await tx.query(`DELETE FROM ${M} WHERE ${M}."id" = ANY($1::uuid[])`, [ids]);
  }

  async destroyMethod(pk: string, query: QueryDict): Promise<void> {
    const instance = await this.findMethod(pk, query);
    await this.db.transaction((tx) => this.deleteMethods(tx, [instance.id]));
  }

  // --- Zones -----------------------------------------------------------------------------------

  /** `ShippingZoneSerializer(zones, many=True).data`: each zone with its methods, cheapest first. */
  private async zonesOf(rows: ZoneRow[]) {
    const ids = [...new Set(rows.map((row) => row.id))];
    const sql = new SqlParams();
    const methods = ids.length
      ? await this.db.query<MethodRow>(
          `SELECT ${columns(M, METHOD_COLUMNS)} FROM ${M}
            WHERE ${M}."zone_id" IN ${sql.list(ids, 'uuid')}
            ORDER BY ${M}."position" ASC, ${M}."price" ASC`,
          sql.values,
        )
      : [];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      cities: parsePythonJson(row.cities),
      is_default: row.is_default,
      position: row.position,
      is_active: row.is_active,
      methods: methods
        .filter((method) => method.zone_id === row.id)
        .map((method) => this.method({ ...method, zone_name: row.name })),
    }));
  }

  async zones(query: QueryDict) {
    const plan = orderingPlan(query, ZONE_ORDERING);
    const order = plan?.order ?? [`${Z}."position" ASC`, `${Z}."name" ASC`];
    return this.zonesOf(
      await this.db.query<ZoneRow>(
        `SELECT ${ZONE_SELECT} FROM ${Z} ${(plan?.joins ?? []).join(' ')}
          ORDER BY ${order.join(', ')}`,
      ),
    );
  }

  private async findZone(pk: string): Promise<ZoneRow> {
    const row = await this.db.one<ZoneRow>(
      `SELECT ${ZONE_SELECT} FROM ${Z} WHERE ${Z}."id" = $1 LIMIT 21`,
      [this.id(pk)],
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieveZone(pk: string) {
    return (await this.zonesOf([await this.findZone(pk)]))[0];
  }

  private async validateZone(data: unknown, instance: ZoneRow | null, partial: boolean) {
    const result = await runSerializer<ZoneData>(
      {
        name: charField({
          maxLength: 120,
          unique: this.unique(
            'shipping_shippingzone',
            'name',
            'shipping zone',
            instance?.id ?? null,
          ),
        }),
        description: charField({ maxLength: 255, required: false, allowBlank: true }),
        cities: jsonField({ required: false }),
        is_default: booleanField({ required: false }),
        position: integerField({ required: false, ...INT }),
        is_active: booleanField({ required: false }),
      } as Fields,
      data,
      { partial, hooks: { cities: (value: unknown) => cleanCities(value) } },
    );
    return result.ok ? result.values : this.invalid<ZoneData>(result);
  }

  async createZone(data: unknown) {
    const values = await this.validateZone(data, null, false);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO ${Z} ("id", "created_at", "updated_at", "name", "description", "cities",
         "is_default", "position", "is_active")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        id,
        values.name,
        values.description ?? '',
        JSON.stringify(values.cities ?? []),
        values.is_default ?? false,
        values.position ?? 0,
        values.is_active ?? true,
      ],
    );
    return this.retrieveZone(id);
  }

  async updateZone(pk: string, data: () => unknown, partial: boolean) {
    const instance = await this.findZone(pk);
    const values = await this.validateZone(data(), instance, partial);
    await this.db.query(
      `UPDATE ${Z} SET "updated_at" = clock_timestamp(), "name" = $2, "description" = $3,
         "cities" = $4::jsonb, "is_default" = $5, "position" = $6, "is_active" = $7
       WHERE ${Z}."id" = $1`,
      [
        instance.id,
        values.name ?? instance.name,
        values.description ?? instance.description,
        values.cities ? JSON.stringify(values.cities) : instance.cities,
        values.is_default ?? instance.is_default,
        values.position ?? instance.position,
        values.is_active ?? instance.is_active,
      ],
    );
    return this.retrieveZone(instance.id);
  }

  /** `zone.delete()`: its methods go with it (`CASCADE`). */
  async destroyZone(pk: string): Promise<void> {
    const instance = await this.findZone(pk);
    await this.db.transaction(async (tx) => {
      const methods = await tx.query<{ id: string }>(
        `SELECT ${M}."id" FROM ${M} WHERE ${M}."zone_id" IN ($1)`,
        [instance.id],
      );
      await this.deleteMethods(
        tx,
        methods.map((method) => method.id),
      );
      await tx.query(`DELETE FROM ${Z} WHERE ${Z}."id" IN ($1)`, [instance.id]);
    });
  }

  // --- Couriers --------------------------------------------------------------------------------

  async couriers(query: QueryDict) {
    const order = orderingPlan(query, COURIER_ORDERING)?.order ?? [`${K}."name" ASC`];
    return this.db.query<CourierRow>(
      `SELECT ${columns(K, COURIER_COLUMNS)} FROM ${K} ORDER BY ${order.join(', ')}`,
    );
  }

  async findCourier(pk: string): Promise<CourierRow> {
    const row = await this.db.one<CourierRow>(
      `SELECT ${columns(K, COURIER_COLUMNS)} FROM ${K} WHERE ${K}."id" = $1 LIMIT 21`,
      [this.id(pk)],
    );
    if (!row) throw new NotFound();
    return row;
  }

  private async validateCourier(data: unknown, instance: CourierRow | null, partial: boolean) {
    const exclude = instance?.id ?? null;
    const result = await runSerializer<CourierData>(
      {
        name: charField({
          maxLength: 120,
          unique: this.unique('shipping_courier', 'name', 'courier', exclude),
        }),
        code: slugField({
          maxLength: 32,
          unique: this.unique('shipping_courier', 'code', 'courier', exclude),
        }),
        // `ContactPhoneField`: a hotline is kept as typed, a mobile stored canonically.
        phone: charField({
          maxLength: 32,
          required: false,
          allowBlank: true,
          convert: (value) => normalizeIfMobile(value),
        }),
        tracking_url_template: charField({ maxLength: 255, required: false, allowBlank: true }),
        integration: charField({ maxLength: 32, required: false }),
        is_active: booleanField({ required: false }),
      } as Fields,
      data,
      { partial },
    );
    return result.ok ? result.values : this.invalid<CourierData>(result);
  }

  async createCourier(data: unknown): Promise<CourierRow> {
    const values = await this.validateCourier(data, null, false);
    return (await this.db.one<CourierRow>(
      `INSERT INTO ${K} ("id", "created_at", "updated_at", "name", "code", "phone",
         "tracking_url_template", "integration", "is_active")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7)
       RETURNING ${columns(K, COURIER_COLUMNS)}`,
      [
        randomUUID(),
        values.name,
        values.code,
        values.phone ?? '',
        values.tracking_url_template ?? '',
        values.integration ?? 'manual',
        values.is_active ?? true,
      ],
    )) as CourierRow;
  }

  async updateCourier(pk: string, data: () => unknown, partial: boolean): Promise<CourierRow> {
    const instance = await this.findCourier(pk);
    const values = await this.validateCourier(data(), instance, partial);
    const row = { ...instance, ...values } as CourierRow;
    await this.db.query(
      `UPDATE ${K} SET "updated_at" = clock_timestamp(), "name" = $2, "code" = $3, "phone" = $4,
         "tracking_url_template" = $5, "integration" = $6, "is_active" = $7
       WHERE ${K}."id" = $1`,
      [
        row.id,
        row.name,
        row.code,
        row.phone,
        row.tracking_url_template,
        row.integration,
        row.is_active,
      ],
    );
    return row;
  }

  /** `courier.delete()`: refused while a parcel names it (`PROTECT`). */
  async destroyCourier(pk: string): Promise<void> {
    const instance = await this.findCourier(pk);
    await this.db.transaction(async (tx) => {
      const used = await tx.query(
        `SELECT 1 FROM "shipping_shipment" WHERE "shipping_shipment"."courier_id" IN ($1) LIMIT 1`,
        [instance.id],
      );
      if (used.length) throw new ProtectedError();
      await tx.query(`DELETE FROM ${K} WHERE ${K}."id" IN ($1)`, [instance.id]);
    });
  }
}
