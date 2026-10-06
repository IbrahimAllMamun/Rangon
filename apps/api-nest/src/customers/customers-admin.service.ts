import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { likeContains } from '../catalog/discovery.service';
import { type AuditContext, recordAudit } from '../common/audit';
import { localIso } from '../common/datetime';
import {
  bangladeshiPhoneField,
  booleanField,
  charField,
  choiceField,
  dateField,
  emailField,
  errorMessages,
  type Fields,
  InvalidFields,
  jsonField,
  runSerializer,
  type UniqueCheck,
} from '../common/drf';
import { invalidUuid, NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  booleanFilter,
  choiceFilter,
  type FilterField,
  orderingFrom,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { searchDigits } from '../common/phone';
import { pySlice, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns, Params as SqlParams } from '../database/sql';
import { parsePythonJson } from '../http/request-body';
import { StaffOrders } from '../orders/staff-order.service';
import { type AddressRow, AddressesService, serialiseAddress } from './addresses.service';

/**
 * `customers.api.views.CustomerViewSet`: the back office's customers. A
 * plain `ModelViewSet` whose delete deactivates -- a customer's orders must
 * stay intact -- with the counter's phone lookup, the customer's orders, and
 * the addresses and notes kept under each.
 */

const C = '"customers_customer"';
const CUSTOMER_COLUMNS = [
  'id',
  'created_at',
  'user_id',
  'name',
  'phone',
  'email',
  'customer_type',
  'is_walk_in',
  'is_active',
  'date_of_birth',
  'notes',
  'total_orders',
  'total_spent',
  'loyalty_points',
  'last_order_at',
  'created_by_id',
] as const;
const SELECT = `${columns(C, CUSTOMER_COLUMNS)}, ${C}."tags"::text AS "tags"`;
const TYPES = ['WALK_IN', 'REGISTERED', 'GUEST', 'WHOLESALE'] as const;
const FILTERS: readonly FilterField[] = [
  choiceFilter('customer_type', `${C}."customer_type"`, TYPES),
  booleanFilter('is_active', `${C}."is_active"`),
];
const ORDERING = {
  name: `${C}."name"`,
  created_at: `${C}."created_at"`,
  total_spent: `${C}."total_spent"`,
  last_order_at: `${C}."last_order_at"`,
};
/** How many digits must be typed before the counter's lookup will search. */
const LOOKUP_MIN_LENGTH = 3;

const A = '"customers_customeraddress"';
const ADDRESS_SELECT = `${A}."id", ${A}."customer_id", ${A}."label", ${A}."address_type",
  ${A}."recipient_name", ${A}."phone", ${A}."line1", ${A}."line2", ${A}."area", ${A}."city",
  ${A}."district", ${A}."postal_code", ${A}."country", ${A}."is_default", ${A}."notes"`;
const N = '"customers_customernote"';

export interface CustomerRow {
  id: string;
  created_at: string;
  user_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  customer_type: string;
  is_walk_in: boolean;
  is_active: boolean;
  date_of_birth: string | null;
  notes: string;
  /** The stored JSON's own text, so a float stays one. */
  tags: string;
  total_orders: number;
  total_spent: string;
  loyalty_points: number;
  last_order_at: string | null;
  created_by_id: string | null;
}

type CustomerData = Partial<{
  name: string;
  phone: string | null;
  email: string | null;
  customer_type: string;
  is_active: boolean;
  date_of_birth: string | null;
  notes: string;
  tags: unknown;
}>;

interface NoteRow {
  id: string;
  created_at: string;
  customer_id: string;
  body: string;
  is_pinned: boolean;
  created_by_email: string | null;
}

@Injectable()
export class CustomersAdminService {
  constructor(
    private readonly db: Database,
    private readonly addresses: AddressesService,
    private readonly orders: StaffOrders,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  /** `CustomerSerializer(customer).data`. */
  private serialise(row: CustomerRow, addresses: AddressRow[]) {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      customer_type: row.customer_type,
      is_walk_in: row.is_walk_in,
      is_active: row.is_active,
      date_of_birth: row.date_of_birth,
      notes: row.notes,
      tags: parsePythonJson(row.tags),
      total_orders: row.total_orders,
      total_spent: row.total_spent,
      loyalty_points: row.loyalty_points,
      last_order_at: this.iso(row.last_order_at),
      has_account: row.user_id !== null,
      addresses: addresses
        .filter((address) => address.customer_id === row.id)
        .map(serialiseAddress),
      created_at: this.iso(row.created_at),
    };
  }

  /** `prefetch_related("addresses")`: the default first, then the newest. */
  private async addressesOf(ids: string[]): Promise<AddressRow[]> {
    if (!ids.length) return [];
    const sql = new SqlParams();
    return this.db.query<AddressRow>(
      `SELECT ${ADDRESS_SELECT} FROM ${A} WHERE ${A}."customer_id" IN ${sql.list(ids, 'uuid')}
        ORDER BY ${A}."is_default" DESC, ${A}."created_at" DESC`,
      sql.values,
    );
  }

  /**
   * `get_queryset` and the filter backend: `search` over the name and the
   * email, and over the phone by the digits that identify a subscriber -- a
   * country code or a trunk `0` alone adds no clause -- then the filters.
   */
  private async conditions(query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    const search = query.get('search');
    if (search) {
      const like = sql.add(likeContains(search));
      const matches = [
        `UPPER(${C}."name"::text) LIKE UPPER(${like})`,
        `UPPER(${C}."email"::text) LIKE UPPER(${like})`,
      ];
      const digits = searchDigits(search);
      if (digits) matches.push(`${C}."phone"::text LIKE ${sql.add(likeContains(digits))}`);
      where.push(`(${matches.join(' OR ')})`);
    }
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [`${C}."created_at" DESC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${C} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<CustomerRow>(
      `SELECT ${SELECT} FROM ${C} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    const addresses = await this.addressesOf(rows.map((row) => row.id));
    return paginated(
      page,
      rows.map((row) => this.serialise(row, addresses)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the searched, filtered queryset, then the key. */
  async find(pk: string, query: QueryDict): Promise<CustomerRow> {
    const sql = new SqlParams();
    const where = await this.conditions(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${C}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<CustomerRow>(
      `SELECT ${SELECT} FROM ${C} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  private async answer(id: string) {
    const row = (await this.db.one<CustomerRow>(
      `SELECT ${SELECT} FROM ${C} WHERE ${C}."id" = $1 LIMIT 21`,
      [id],
    )) as CustomerRow;
    return this.serialise(row, await this.addressesOf([id]));
  }

  async retrieve(pk: string, query: QueryDict) {
    const row = await this.find(pk, query);
    return this.serialise(row, await this.addressesOf([row.id]));
  }

  private unique(column: 'phone' | 'email', message: string, exclude: string | null): UniqueCheck {
    return {
      message,
      exists: async (value) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM ${C} WHERE (${C}."${column}" = $1${
            exclude ? ` AND NOT (${C}."id" = $2)` : ''
          }) LIMIT 1`,
          exclude ? [value, exclude] : [value],
        )) !== null,
    };
  }

  /** `CustomerSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  private async validate(data: unknown, instance: CustomerRow | null, partial: boolean) {
    const exclude = instance?.id ?? null;
    const fields: Fields = {
      name: charField({ maxLength: 160 }),
      // Canonical before the uniqueness check, so two spellings of one number collide.
      phone: bangladeshiPhoneField({
        maxLength: 32,
        required: false,
        allowBlank: true,
        allowNull: true,
        unique: this.unique(
          'phone',
          'Another customer is already filed under this number.',
          exclude,
        ),
      }),
      email: emailField({
        maxLength: 254,
        required: false,
        allowBlank: true,
        allowNull: true,
        unique: this.unique('email', 'customer with this email already exists.', exclude),
      }),
      customer_type: choiceField(TYPES, { required: false }),
      is_active: booleanField({ required: false }),
      date_of_birth: dateField({ required: false, allowNull: true }),
      notes: charField({ required: false, allowBlank: true }),
      tags: jsonField({ required: false }),
    };
    const result = await runSerializer<CustomerData>(fields, data, {
      partial,
      // Phone-first identity: a customer with neither contact detail cannot be
      // found again. Checked against the record as it would be left.
      validate: (attrs) => {
        const phone = Object.hasOwn(attrs, 'phone') ? attrs.phone : (instance?.phone ?? null);
        const email = Object.hasOwn(attrs, 'email') ? attrs.email : (instance?.email ?? null);
        if (!phone && !email) {
          throw new InvalidFields({
            phone: [{ message: 'Provide a phone number or an email address.', code: 'invalid' }],
          });
        }
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `Customer.save()`: no contact detail is NULL, and an email is lower-cased and trimmed. */
  private contact(phone: string | null | undefined, email: string | null | undefined) {
    return { phone: phone || null, email: email ? pyStrip(email.toLowerCase()) : null };
  }

  /** `create`: `serializer.save(created_by=request.user)`. */
  async create(user: RequestUser, data: unknown) {
    const values = await this.validate(data, null, false);
    const { phone, email } = this.contact(values.phone, values.email);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO ${C} ("id", "created_at", "updated_at", "user_id", "name", "phone", "email",
         "customer_type", "is_walk_in", "is_active", "date_of_birth", "notes", "tags",
         "total_orders", "total_spent", "loyalty_points", "last_order_at", "created_by_id")
       VALUES ($1, clock_timestamp(), clock_timestamp(), NULL, $2, $3, $4, $5, false, $6, $7::date,
               $8, $9::jsonb, 0, 0.00, 0, NULL, $10)`,
      [
        id,
        values.name,
        phone,
        email,
        values.customer_type ?? 'GUEST',
        values.is_active ?? true,
        values.date_of_birth ?? null,
        values.notes ?? '',
        JSON.stringify(values.tags === undefined ? [] : values.tags),
        user.id,
      ],
    );
    return this.answer(id);
  }

  /** `update`: the customer found first, then the body; every column written back as read. */
  async update(pk: string, query: QueryDict, data: () => unknown, partial: boolean) {
    const instance = await this.find(pk, query);
    const values = await this.validate(data(), instance, partial);
    const has = (key: keyof CustomerData) => Object.hasOwn(values, key);
    const { phone, email } = this.contact(
      has('phone') ? values.phone : instance.phone,
      has('email') ? values.email : instance.email,
    );
    await this.db.query(
      `UPDATE ${C} SET "updated_at" = clock_timestamp(), "user_id" = $2, "name" = $3, "phone" = $4,
         "email" = $5, "customer_type" = $6, "is_walk_in" = $7, "is_active" = $8,
         "date_of_birth" = $9::date, "notes" = $10, "tags" = $11::jsonb, "total_orders" = $12,
         "total_spent" = $13, "loyalty_points" = $14, "last_order_at" = $15::timestamptz,
         "created_by_id" = $16
       WHERE ${C}."id" = $1`,
      [
        instance.id,
        instance.user_id,
        values.name ?? instance.name,
        phone,
        email,
        values.customer_type ?? instance.customer_type,
        instance.is_walk_in,
        values.is_active ?? instance.is_active,
        has('date_of_birth') ? values.date_of_birth : instance.date_of_birth,
        values.notes ?? instance.notes,
        has('tags') ? JSON.stringify(values.tags) : instance.tags,
        instance.total_orders,
        instance.total_spent,
        instance.loyalty_points,
        instance.last_order_at,
        instance.created_by_id,
      ],
    );
    return this.answer(instance.id);
  }

  /** `perform_destroy`: a customer is deactivated, never deleted. */
  async destroy(pk: string, query: QueryDict): Promise<void> {
    const instance = await this.find(pk, query);
    await this.db.query(
      `UPDATE ${C} SET "updated_at" = clock_timestamp(), "is_active" = false WHERE ${C}."id" = $1`,
      [instance.id],
    );
  }

  /**
   * `lookup`: the counter's phone search. Not the list's queryset: active
   * customers who are not a branch's walk-in record, ten at most, with no
   * more than the counter needs to tell two people apart.
   */
  async lookup(query: QueryDict) {
    const digits = searchDigits(query.get('phone') ?? '');
    if (digits.length < LOOKUP_MIN_LENGTH) return { results: [], min_length: LOOKUP_MIN_LENGTH };
    const rows = await this.db.query<CustomerRow>(
      `SELECT ${C}."id", ${C}."name", ${C}."phone", ${C}."email", ${C}."customer_type",
              ${C}."total_orders", ${C}."last_order_at"
         FROM ${C}
        WHERE (${C}."is_active" AND ${C}."phone"::text LIKE $1 AND NOT (${C}."is_walk_in"))
        ORDER BY ${C}."name" ASC, ${C}."id" ASC LIMIT 10`,
      [likeContains(digits)],
    );
    return {
      results: rows.map((row) => ({
        id: row.id,
        name: row.name,
        phone: row.phone,
        email: row.email,
        customer_type: row.customer_type,
        total_orders: row.total_orders,
        last_order_at: this.iso(row.last_order_at),
      })),
    };
  }

  /** `orders`: the customer's last hundred, newest placed first. */
  async ordersOf(pk: string, query: QueryDict) {
    return this.orders.ofCustomer(await this.find(pk, query));
  }

  // --- Addresses -------------------------------------------------------------------------------

  async addressList(pk: string, query: QueryDict) {
    return this.addresses.list((await this.find(pk, query)).id);
  }

  async addAddress(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const customer = await this.find(pk, query);
    const values = await this.addresses.validate(data(), false);
    const row = await this.addresses.add(
      customer.id,
      values,
      { id: user.id, email: user.email },
      context,
    );
    return serialiseAddress(row);
  }

  /** A key in the URL, as `get_object_or_404(Model, pk=key, ...)` reads one. */
  private key(value: string): string {
    const id = parseUuid(value);
    if (!id) throw invalidUuid(value);
    return id;
  }

  async editAddress(
    user: RequestUser,
    pk: string,
    addressId: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const customer = await this.find(pk, query);
    const address = await this.addresses.find(this.key(addressId), customer.id);
    const values = await this.addresses.validate(data(), true);
    const row = await this.addresses.update(
      address,
      values,
      { id: user.id, email: user.email },
      context,
    );
    return serialiseAddress(row);
  }

  async removeAddress(
    user: RequestUser,
    pk: string,
    addressId: string,
    query: QueryDict,
    context: AuditContext,
  ): Promise<void> {
    const customer = await this.find(pk, query);
    const address = await this.addresses.find(this.key(addressId), customer.id);
    await this.addresses.remove(address, { id: user.id, email: user.email }, context);
  }

  // --- Notes -----------------------------------------------------------------------------------

  private note(row: NoteRow) {
    return {
      id: row.id,
      customer: row.customer_id,
      body: row.body,
      is_pinned: row.is_pinned,
      created_by_email: row.created_by_email ?? '',
      created_at: this.iso(row.created_at),
    };
  }

  /** `customer.customer_notes.all()`: the pinned first, then the newest. */
  async noteList(pk: string, query: QueryDict) {
    const customer = await this.find(pk, query);
    const rows = await this.db.query<NoteRow>(
      `SELECT ${N}."id", ${N}."created_at", ${N}."customer_id", ${N}."body", ${N}."is_pinned",
              (SELECT u."email" FROM "accounts_user" u WHERE u."id" = ${N}."created_by_id")
                AS "created_by_email"
         FROM ${N} WHERE ${N}."customer_id" = $1
        ORDER BY ${N}."is_pinned" DESC, ${N}."created_at" DESC`,
      [customer.id],
    );
    return rows.map((row) => this.note(row));
  }

  /** `notes` (POST) and `add_note`. */
  async addNote(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const customer = await this.find(pk, query);
    const validated = await runSerializer<{ body: string; is_pinned?: boolean }>(
      { body: charField(), is_pinned: booleanField({ required: false }) } as Fields,
      data(),
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const body = pyStrip(validated.values.body);
    if (!body) throw new ValidationError('A note cannot be empty.');
    const pinned = validated.values.is_pinned ?? false;
    const id = randomUUID();
    const row = await this.db.transaction(async (tx) => {
      const made = (await tx.one<NoteRow>(
        `INSERT INTO ${N} ("id", "created_at", "updated_at", "customer_id", "body", "is_pinned",
                           "created_by_id")
         VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5)
         RETURNING "id", "created_at", "customer_id", "body", "is_pinned"`,
        [id, customer.id, body, pinned, user.id],
      )) as NoteRow;
      await recordAudit(tx, context, {
        action: 'CREATE',
        entity: { type: 'CustomerNote', id, label: pySlice(body, 60) },
        actor: { id: user.id, email: user.email },
        newValues: { body, is_pinned: pinned },
        reason: 'Customer note added',
      });
      return made;
    });
    return this.note({ ...row, created_by_email: user.email });
  }

  /** `note_detail` and `delete_note`: staff commentary, not a financial record. */
  async removeNote(
    user: RequestUser,
    pk: string,
    noteId: string,
    query: QueryDict,
    context: AuditContext,
  ): Promise<void> {
    const customer = await this.find(pk, query);
    const note = await this.db.one<{ id: string; body: string; is_pinned: boolean }>(
      `SELECT ${N}."id", ${N}."body", ${N}."is_pinned" FROM ${N}
        WHERE (${N}."customer_id" = $1 AND ${N}."id" = $2) LIMIT 21`,
      [customer.id, this.key(noteId)],
    );
    if (!note) throw new NotFound();
    await this.db.transaction(async (tx) => {
      await recordAudit(tx, context, {
        action: 'DELETE',
        entity: { type: 'CustomerNote', id: note.id, label: pySlice(note.body, 60) },
        actor: { id: user.id, email: user.email },
        oldValues: { body: note.body, is_pinned: note.is_pinned },
        reason: 'Customer note deleted',
      });
      await tx.query(`DELETE FROM ${N} WHERE ${N}."id" IN ($1)`, [note.id]);
    });
  }
}
