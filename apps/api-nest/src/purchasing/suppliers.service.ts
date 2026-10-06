import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ProtectedError } from '../catalog/admin/deletion';
import { likeContains } from '../catalog/discovery.service';
import { localIso } from '../common/datetime';
import {
  charField,
  choiceField,
  emailField,
  errorMessages,
  type Fields,
  integerField,
  runSerializer,
  type UniqueCheck,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import { applyFilters, choiceFilter, orderingFrom, searchTerms } from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { normalizeIfMobile } from '../common/phone';
import { pySlice } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { columns, Params as SqlParams } from '../database/sql';

/**
 * `purchasing.api.views.SupplierViewSet`: a plain `ModelViewSet` over
 * `Supplier`, each row annotated with the purchase orders still on their way.
 * No audit entries and no signals; a supplier anything was ever ordered from
 * or paid is not deleted (`PROTECT`).
 */

const S = '"purchasing_supplier"';
const SUPPLIER_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'code',
  'contact_person',
  'phone',
  'email',
  'address',
  'tax_id',
  'payment_terms_days',
  'lead_time_days',
  'status',
  'notes',
] as const;
const SELECT = `${columns(S, SUPPLIER_COLUMNS)},
  COUNT("purchasing_purchaseorder"."id")
    FILTER (WHERE "purchasing_purchaseorder"."status" IN ('SENT', 'PARTIALLY_RECEIVED'))
    AS "outstanding_orders"`;
const FROM = `FROM ${S} LEFT OUTER JOIN "purchasing_purchaseorder"
  ON (${S}."id" = "purchasing_purchaseorder"."supplier_id")`;
const STATUSES = ['ACTIVE', 'INACTIVE'] as const;
const FILTERS = [choiceFilter('status', `${S}."status"`, STATUSES)];
const ORDERING = { name: `${S}."name"`, created_at: `${S}."created_at"` };
const SMALL_INT = { minValue: 0, maxValue: 32767 };

export interface SupplierRow {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  code: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  tax_id: string;
  payment_terms_days: number;
  lead_time_days: number;
  status: string;
  notes: string;
  /** Absent on a supplier just made: the annotation belongs to the queryset. */
  outstanding_orders?: string;
}

type SupplierData = Partial<{
  name: string;
  code: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  tax_id: string;
  payment_terms_days: number;
  lead_time_days: number;
  status: string;
  notes: string;
}>;

/** The part of `unique_supplier_code` that needs no database: the name as a code. */
export function supplierCodeBase(name: string): string {
  return (
    pySlice(
      name
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toUpperCase(),
      24,
    ) || 'SUPPLIER'
  );
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `SupplierSerializer(supplier).data`: `outstanding_orders` only where the row was annotated. */
  serialise(row: SupplierRow): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      contact_person: row.contact_person,
      phone: row.phone,
      email: row.email,
      address: row.address,
      tax_id: row.tax_id,
      payment_terms_days: row.payment_terms_days,
      lead_time_days: row.lead_time_days,
      status: row.status,
      notes: row.notes,
      ...(row.outstanding_orders === undefined
        ? {}
        : { outstanding_orders: Number(row.outstanding_orders) }),
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
    };
  }

  /** `filter_queryset`: django-filter on the status, then `SearchFilter`. */
  private async conditions(query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    for (const term of searchTerms(query)) {
      const like = sql.add(likeContains(term));
      where.push(
        `(UPPER(${S}."name"::text) LIKE UPPER(${like}) OR UPPER(${S}."code"::text) LIKE UPPER(${like})
          OR UPPER(${S}."phone"::text) LIKE UPPER(${like}))`,
      );
    }
    return where;
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [`${S}."name" ASC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${S} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<SupplierRow>(
      `SELECT ${SELECT} ${FROM} ${whereSql} GROUP BY ${S}."id" ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.serialise(row)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the filtered queryset, then the key. `get()` drops the ordering. */
  async find(pk: string, query: QueryDict): Promise<SupplierRow> {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${S}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<SupplierRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} GROUP BY ${S}."id" LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  private codeTaken(q: Queryable, code: string, exclude: string | null): Promise<boolean> {
    return q
      .one(
        `SELECT 1 AS "a" FROM ${S} WHERE (${S}."code" = $1${
          exclude ? ` AND NOT (${S}."id" = $2)` : ''
        }) LIMIT 1`,
        exclude ? [code, exclude] : [code],
      )
      .then((row) => row !== null);
  }

  /** `unique_supplier_code`: the name as a code, numbered until no supplier has it. */
  private async uniqueCode(name: string): Promise<string> {
    const base = supplierCodeBase(name);
    let candidate = base;
    let counter = 1;
    while (await this.codeTaken(this.db, candidate, null)) {
      counter += 1;
      const suffix = `-${counter}`;
      candidate = `${pySlice(base, 32 - suffix.length)}${suffix}`;
    }
    return candidate;
  }

  /** `SupplierSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validate(
    data: unknown,
    instance: SupplierRow | null,
    partial: boolean,
  ): Promise<SupplierData> {
    const exclude = instance?.id ?? null;
    const unique: UniqueCheck = {
      message: 'supplier with this code already exists.',
      exists: (value) => this.codeTaken(this.db, value, exclude),
    };
    const optional = { required: false, allowBlank: true };
    const fields: Fields = {
      name: charField({ maxLength: 200 }),
      code: charField({ maxLength: 32, required: false, unique }),
      contact_person: charField({ maxLength: 120, ...optional }),
      // `ContactPhoneField`: a mobile is stored canonically, anything else as typed.
      phone: charField({
        maxLength: 32,
        ...optional,
        convert: (value) => normalizeIfMobile(value),
      }),
      email: emailField({ maxLength: 254, ...optional }),
      address: charField(optional),
      tax_id: charField({ maxLength: 64, ...optional }),
      payment_terms_days: integerField({ required: false, ...SMALL_INT }),
      lead_time_days: integerField({ required: false, ...SMALL_INT }),
      status: choiceField(STATUSES, { required: false }),
      notes: charField(optional),
    };
    const result = await runSerializer<SupplierData>(fields, data, {
      partial,
      validate: async (attrs) => {
        // The code is derived from the name on create only, as a slug is.
        if (!attrs.code && instance === null) attrs.code = await this.uniqueCode(attrs.name ?? '');
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  async create(data: SupplierData): Promise<SupplierRow> {
    const id = randomUUID();
    const row = await this.db.one<SupplierRow>(
      `INSERT INTO ${S} ("id", "created_at", "updated_at", "name", "code", "contact_person", "phone",
         "email", "address", "tax_id", "payment_terms_days", "lead_time_days", "status", "notes")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${columns(S, SUPPLIER_COLUMNS)}`,
      [
        id,
        data.name,
        data.code,
        data.contact_person ?? '',
        data.phone ?? '',
        data.email ?? '',
        data.address ?? '',
        data.tax_id ?? '',
        data.payment_terms_days ?? 0,
        data.lead_time_days ?? 7,
        data.status ?? 'ACTIVE',
        data.notes ?? '',
      ],
    );
    return row as SupplierRow;
  }

  /** `serializer.save()` on an instance: every column written back from the row as read. */
  async update(instance: SupplierRow, data: SupplierData): Promise<SupplierRow> {
    const row = { ...instance, ...data } as SupplierRow;
    await this.db.query(
      `UPDATE ${S} SET "updated_at" = clock_timestamp(), "name" = $2, "code" = $3,
         "contact_person" = $4, "phone" = $5, "email" = $6, "address" = $7, "tax_id" = $8,
         "payment_terms_days" = $9, "lead_time_days" = $10, "status" = $11, "notes" = $12
       WHERE ${S}."id" = $1`,
      [
        row.id,
        row.name,
        row.code,
        row.contact_person,
        row.phone,
        row.email,
        row.address,
        row.tax_id,
        row.payment_terms_days,
        row.lead_time_days,
        row.status,
        row.notes,
      ],
    );
    return row;
  }

  /** `supplier.delete()`: refused once ordered from or paid; its price list goes with it. */
  async destroy(instance: SupplierRow): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      for (const table of ['purchasing_purchaseorder', 'purchasing_supplierpayment']) {
        const used = await tx.query(
          `SELECT 1 FROM "${table}" WHERE "${table}"."supplier_id" IN ($1) LIMIT 1`,
          [instance.id],
        );
        if (used.length) throw new ProtectedError();
      }
      await tx.query(
        `DELETE FROM "purchasing_supplierproduct"
          WHERE "purchasing_supplierproduct"."supplier_id" IN ($1)`,
        [instance.id],
      );
      await tx.query(`DELETE FROM ${S} WHERE ${S}."id" IN ($1)`, [instance.id]);
    });
  }
}
