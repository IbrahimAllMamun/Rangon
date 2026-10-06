import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ProtectedError } from '../catalog/admin/deletion';
import { localIso } from '../common/datetime';
import {
  booleanField,
  charField,
  choiceField,
  emailField,
  errorMessages,
  type Fields,
  integerField,
  runSerializer,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import { orderingFrom } from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { normalizeIfMobile } from '../common/phone';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns } from '../database/sql';

/**
 * `BranchViewSet`: the shop's branches. A plain `ModelViewSet` -- a new
 * branch joins the one organisation, and nothing else is decided here: which
 * branch a request acts on is `RolePermissions.resolveBranch`.
 */

const B = '"accounts_branch"';
export const BRANCH_FIELDS = [
  'id',
  'name',
  'code',
  'address',
  'phone',
  'email',
  'is_default',
  'fulfils_online_orders',
  'register_count',
  'status',
  'created_at',
] as const;
export const STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
/** The view names no `ordering_fields`: every serializer field, by its source. */
const ORDERING = Object.fromEntries(BRANCH_FIELDS.map((name) => [name, `${B}."${name}"`]));
/**
 * What refuses a branch's deletion (`PROTECT`), in the order Django's
 * collector meets them; and what goes with it or lets go of it.
 */
const PROTECTED: readonly [table: string, column: string][] = [
  ['accounts_user', 'branch_id'],
  ['inventory_inventory', 'branch_id'],
  ['inventory_inventorytransaction', 'branch_id'],
  ['inventory_stocktransfer', 'source_branch_id'],
  ['inventory_stocktransfer', 'target_branch_id'],
  ['inventory_stockcount', 'branch_id'],
  ['inventory_labelprint', 'branch_id'],
  ['purchasing_purchaseorder', 'branch_id'],
  ['finance_account', 'branch_id'],
  ['finance_expense', 'branch_id'],
  ['orders_cart', 'branch_id'],
  ['orders_order', 'branch_id'],
  ['orders_abandonedcheckout', 'branch_id'],
];

export interface BranchRow {
  id: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  is_default: boolean;
  fulfils_online_orders: boolean;
  register_count: number;
  status: string;
  created_at: string;
}

type BranchData = Partial<Omit<BranchRow, 'id' | 'created_at'>>;

@Injectable()
export class BranchesService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `BranchSerializer(branch).data`. */
  serialise(row: BranchRow) {
    return { ...row, created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE) };
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const order = orderingFrom(query, ORDERING) ?? [`${B}."name" ASC`];
    const count = Number(
      (await this.db.one<{ count: string }>(`SELECT COUNT(*) AS "count" FROM ${B}`))?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<BranchRow>(
      `SELECT ${columns(B, BRANCH_FIELDS)} FROM ${B} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
    );
    return paginated(
      page,
      rows.map((row) => this.serialise(row)),
      absoluteUrl,
    );
  }

  private async find(pk: string): Promise<BranchRow> {
    const id = parseUuid(pk);
    const row = id
      ? await this.db.one<BranchRow>(
          `SELECT ${columns(B, BRANCH_FIELDS)} FROM ${B} WHERE ${B}."id" = $1 LIMIT 21`,
          [id],
        )
      : null;
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(pk: string) {
    return this.serialise(await this.find(pk));
  }

  /**
   * `BranchSerializer(instance, data, partial)`. The code is unique within
   * the organisation, which the serializer does not hold a field for: DRF
   * builds no validator, and a code taken is the index's bare 409.
   */
  private async validate(data: unknown, partial: boolean): Promise<BranchData> {
    const result = await runSerializer<BranchData>(
      {
        name: charField({ maxLength: 120 }),
        code: charField({ maxLength: 16 }),
        address: charField({ required: false, allowBlank: true }),
        // `ContactPhoneField`: a hotline is kept as typed, a mobile stored canonically.
        phone: charField({
          maxLength: 32,
          required: false,
          allowBlank: true,
          convert: (value) => normalizeIfMobile(value),
        }),
        email: emailField({ maxLength: 254, required: false, allowBlank: true }),
        is_default: booleanField({ required: false }),
        fulfils_online_orders: booleanField({ required: false }),
        register_count: integerField({ required: false, minValue: 0, maxValue: 32767 }),
        status: choiceField(STATUSES, { required: false }),
      } as Fields,
      data,
      { partial },
    );
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `perform_create`: the branch joins `get_organization()`, the oldest active one. */
  async create(data: unknown) {
    const values = await this.validate(data, false);
    const organization = await this.db.one<{ id: string }>(
      `SELECT "id" FROM "accounts_organization" WHERE "accounts_organization"."status" = 'ACTIVE'
        ORDER BY "accounts_organization"."created_at" ASC LIMIT 1`,
    );
    const row = (await this.db.one<BranchRow>(
      `INSERT INTO ${B} ("id", "created_at", "updated_at", "organization_id", "name", "code",
         "address", "phone", "email", "is_default", "fulfils_online_orders", "register_count",
         "status")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${columns(B, BRANCH_FIELDS)}`,
      [
        randomUUID(),
        organization?.id ?? null,
        values.name,
        values.code,
        values.address ?? '',
        values.phone ?? '',
        values.email ?? '',
        values.is_default ?? false,
        values.fulfils_online_orders ?? true,
        values.register_count ?? 1,
        values.status ?? 'ACTIVE',
      ],
    )) as BranchRow;
    return this.serialise(row);
  }

  /** A plain save: every column written back as read. */
  async update(pk: string, data: () => unknown, partial: boolean) {
    const instance = await this.find(pk);
    const row = { ...instance, ...(await this.validate(data(), partial)) } as BranchRow;
    await this.db.query(
      `UPDATE ${B} SET "updated_at" = clock_timestamp(), "name" = $2, "code" = $3, "address" = $4,
         "phone" = $5, "email" = $6, "is_default" = $7, "fulfils_online_orders" = $8,
         "register_count" = $9, "status" = $10
       WHERE ${B}."id" = $1`,
      [
        row.id,
        row.name,
        row.code,
        row.address,
        row.phone,
        row.email,
        row.is_default,
        row.fulfils_online_orders,
        row.register_count,
        row.status,
      ],
    );
    return this.serialise(row);
  }

  /**
   * `branch.delete()`: refused while anything that must keep its branch names
   * it -- staff, stock, orders, money (`PROTECT`). A branch nothing names
   * goes with its counter holds and its notices, and the audit log lets go
   * of it (`SET_NULL`).
   */
  async destroy(pk: string): Promise<void> {
    const instance = await this.find(pk);
    await this.db.transaction(async (tx) => {
      for (const [table, column] of PROTECTED) {
        const used = await tx.query(
          `SELECT 1 FROM "${table}" WHERE "${table}"."${column}" IN ($1) LIMIT 1`,
          [instance.id],
        );
        if (used.length) throw new ProtectedError();
      }
      await tx.query(`DELETE FROM "orders_heldsale" WHERE "orders_heldsale"."branch_id" IN ($1)`, [
        instance.id,
      ]);
      await tx.query(
        `DELETE FROM "notifications_notification"
          WHERE "notifications_notification"."branch_id" IN ($1)`,
        [instance.id],
      );
      await tx.query(
        `UPDATE "core_auditlog" SET "branch_id" = NULL WHERE "core_auditlog"."branch_id" IN ($1)`,
        [instance.id],
      );
      await tx.query(`DELETE FROM ${B} WHERE ${B}."id" IN ($1)`, [instance.id]);
    });
  }
}
