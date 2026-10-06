import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { RolePermissions } from '../auth/permissions';
import { type AuditContext, recordAudit } from '../common/audit';
import { localIso, pyIsoformat, utcIso } from '../common/datetime';
import { Dec } from '../common/decimal';
import {
  booleanField,
  charField,
  choiceField,
  decimalField,
  emailField,
  errorMessages,
  type Fields,
  runSerializer,
  withDefault,
} from '../common/drf';
import { Conflict, NotFound, ValidationError } from '../common/errors';
import { normalizeIfMobile } from '../common/phone';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { columns } from '../database/sql';
import { Revalidation } from '../jobs/revalidation';
import { ManualResponse } from './auth.service';
import { BRANCH_FIELDS, type BranchRow, STATUSES } from './branches.service';
import { fullName } from './me.service';

/**
 * `OrganizationView` and `OrganizationTaxView`: the one organisation the
 * shop is, and its VAT treatment -- the one setting that changes how money
 * is calculated, which is why it has a route of its own that asks for
 * confirmation once orders exist and always writes an audit entry. Both
 * views check their permission by hand and answer a refusal by hand: an
 * envelope with no `request_id`.
 */

const O = '"accounts_organization"';
const B = '"accounts_branch"';
const ORGANIZATION_COLUMNS = [
  'id',
  'name',
  'slug',
  'legal_name',
  'status',
  'email',
  'phone',
  'address',
  'vat_registration',
  'currency',
  'logo',
  'receipt_footer',
  'tax_mode',
  'default_tax_rate',
  'tax_settled_at',
  'tax_settled_by_id',
  'counter_sells_reserved',
] as const;
const TAX_MODES = ['EXCLUSIVE', 'INCLUSIVE'] as const;

const NOT_ALLOWED = new ManualResponse(403, {
  error: { code: 'PERMISSION_DENIED', message: 'Not allowed.', details: {} },
});
const NO_ORGANIZATION = new ManualResponse(404, { detail: 'No organisation configured.' });

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  legal_name: string;
  status: string;
  email: string;
  phone: string;
  address: string;
  vat_registration: string;
  currency: string;
  logo: string | null;
  receipt_footer: string;
  tax_mode: string;
  default_tax_rate: string;
  tax_settled_at: string | null;
  tax_settled_by_id: string | null;
  counter_sells_reserved: boolean;
}

type OrganizationData = Partial<
  Pick<
    OrganizationRow,
    | 'name'
    | 'legal_name'
    | 'status'
    | 'email'
    | 'phone'
    | 'address'
    | 'vat_registration'
    | 'currency'
    | 'receipt_footer'
    | 'counter_sells_reserved'
  >
>;

@Injectable()
export class OrganizationAdminService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `content.signals._site_changed`: the organisation's name, address and
   * phone are in the storefront's footer, so every save of it -- a VAT
   * settlement too -- asks the storefront to drop what it cached as `site`,
   * once the save has committed.
   */
  private siteChanged(): Promise<void> {
    return this.revalidation.request('site');
  }

  /** `get_organization()`: the oldest active one. */
  private current(q: Queryable = this.db): Promise<OrganizationRow | null> {
    return q.one<OrganizationRow>(
      `SELECT ${columns(O, ORGANIZATION_COLUMNS)} FROM ${O} WHERE ${O}."status" = 'ACTIVE'
        ORDER BY ${O}."created_at" ASC LIMIT 1`,
    );
  }

  private async settledBy(id: string | null): Promise<string | null> {
    if (!id) return null;
    const user = await this.db.one<{ first_name: string; last_name: string; email: string }>(
      `SELECT "first_name", "last_name", "email" FROM "accounts_user" WHERE "id" = $1 LIMIT 21`,
      [id],
    );
    return user ? fullName(user) : null;
  }

  /**
   * `OrganizationSerializer(organization).data`. A partial serializer -- the
   * one the PATCH answers with -- leaves `tax_settled_by_name` out when
   * nobody has settled the VAT: the field has a default, and DRF skips a
   * defaulted field whose source is missing then.
   */
  private async serialise(row: OrganizationRow, partial = false) {
    const branches = await this.db.query<BranchRow>(
      `SELECT ${columns(B, BRANCH_FIELDS)} FROM ${B} WHERE ${B}."organization_id" = $1
        ORDER BY ${B}."name" ASC`,
      [row.id],
    );
    const settledBy = await this.settledBy(row.tax_settled_by_id);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      legal_name: row.legal_name,
      status: row.status,
      email: row.email,
      phone: row.phone,
      address: row.address,
      vat_registration: row.vat_registration,
      currency: row.currency,
      receipt_footer: row.receipt_footer,
      tax_mode: row.tax_mode,
      default_tax_rate: row.default_tax_rate,
      tax_settled_at: localIso(row.tax_settled_at, this.env.DJANGO_TIME_ZONE),
      ...(settledBy === null && partial ? {} : { tax_settled_by_name: settledBy ?? '' }),
      counter_sells_reserved: row.counter_sells_reserved,
      branches: branches.map((branch) => ({
        ...branch,
        created_at: localIso(branch.created_at, this.env.DJANGO_TIME_ZONE),
      })),
    };
  }

  /** `GET /organization/`: anyone signed in, a customer too. */
  async retrieve() {
    const organization = await this.current();
    return organization ? this.serialise(organization) : NO_ORGANIZATION;
  }

  /**
   * `PATCH /organization/`. Whether the counter may sell stock reserved for
   * online orders is the owner's to decide. The save writes every column
   * back as read. With no active organisation -- one switched off through
   * this very route -- there is no instance: the serializer creates one
   * (copied).
   */
  async update(user: RequestUser, data: () => unknown, context: AuditContext) {
    if (!(await this.permissions.has(user, 'settings.manage'))) return NOT_ALLOWED;
    const organization = await this.current();
    const result = await runSerializer<OrganizationData>(
      {
        name: charField({ maxLength: 200 }),
        legal_name: charField({ maxLength: 200, required: false, allowBlank: true }),
        status: choiceField(STATUSES, { required: false }),
        email: emailField({ maxLength: 254, required: false, allowBlank: true }),
        phone: charField({
          maxLength: 32,
          required: false,
          allowBlank: true,
          convert: (value) => normalizeIfMobile(value),
        }),
        address: charField({ required: false, allowBlank: true }),
        vat_registration: charField({ maxLength: 64, required: false, allowBlank: true }),
        currency: charField({ maxLength: 8, required: false }),
        receipt_footer: charField({ required: false, allowBlank: true }),
        counter_sells_reserved: booleanField({ required: false }),
      } as Fields,
      data(),
      { partial: true },
    );
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    const values = result.values;
    const actor = { id: user.id, email: user.email };

    if (!organization) return this.createFrom(values, actor, context);

    const wanted = values.counter_sells_reserved;
    if (
      wanted !== undefined &&
      wanted !== null &&
      wanted !== organization.counter_sells_reserved &&
      !(user.roleCode === 'OWNER' || user.isSuperuser)
    ) {
      return new ManualResponse(403, {
        error: {
          code: 'PERMISSION_DENIED',
          message:
            'Only the owner can decide whether the counter sells stock reserved for online orders.',
          details: {},
        },
      });
    }
    const before = await this.serialise(organization);
    const row: OrganizationRow = { ...organization, ...values };
    await this.db.query(
      `UPDATE ${O} SET "updated_at" = clock_timestamp(), "name" = $2, "slug" = $3,
         "legal_name" = $4, "status" = $5, "email" = $6, "phone" = $7, "address" = $8,
         "vat_registration" = $9, "currency" = $10, "logo" = $11, "receipt_footer" = $12,
         "tax_mode" = $13, "default_tax_rate" = $14, "tax_settled_at" = $15::timestamptz,
         "tax_settled_by_id" = $16, "counter_sells_reserved" = $17
       WHERE ${O}."id" = $1`,
      [
        row.id,
        row.name,
        row.slug,
        row.legal_name,
        row.status,
        row.email,
        row.phone,
        row.address,
        row.vat_registration,
        row.currency,
        row.logo,
        row.receipt_footer,
        row.tax_mode,
        row.default_tax_rate,
        row.tax_settled_at,
        row.tax_settled_by_id,
        row.counter_sells_reserved,
      ],
    );
    await this.siteChanged();
    const after = await this.serialise(row, true);
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      entity: { type: 'Organization', id: row.id, label: row.name },
      actor,
      oldValues: before,
      newValues: after,
    });
    return after;
  }

  /**
   * The PATCH with no organisation to edit: `serializer.save()` on a
   * serializer with no instance creates one from what was sent, the audit
   * entry names no entity, and its "before" is the serializer's blank form.
   */
  private async createFrom(
    values: OrganizationData,
    actor: { id: string; email: string },
    context: AuditContext,
  ) {
    const row = (await this.db.one<OrganizationRow>(
      `INSERT INTO ${O} ("id", "created_at", "updated_at", "name", "slug", "legal_name", "status",
         "email", "phone", "address", "vat_registration", "currency", "logo", "receipt_footer",
         "tax_mode", "default_tax_rate", "tax_settled_at", "tax_settled_by_id",
         "counter_sells_reserved")
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, '', $3, $4, $5, $6, $7, $8, $9, '',
               $10, 'EXCLUSIVE', 0, NULL, NULL, $11)
       RETURNING ${columns(O, ORGANIZATION_COLUMNS)}`,
      [
        randomUUID(),
        values.name ?? '',
        values.legal_name ?? '',
        values.status ?? 'ACTIVE',
        values.email ?? '',
        values.phone ?? '',
        values.address ?? '',
        values.vat_registration ?? '',
        values.currency ?? 'BDT',
        values.receipt_footer ?? '',
        values.counter_sells_reserved ?? false,
      ],
    )) as OrganizationRow;
    await this.siteChanged();
    const after = await this.serialise(row, true);
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      actor,
      // `OrganizationSerializer(None).data`: each writable field's initial value.
      oldValues: {
        name: '',
        legal_name: '',
        status: null,
        email: '',
        phone: '',
        address: '',
        vat_registration: '',
        currency: '',
        receipt_footer: '',
        counter_sells_reserved: false,
      },
      newValues: after,
    });
    return after;
  }

  private async orderCount(q: Queryable = this.db): Promise<number> {
    return Number(
      (await q.one<{ count: string }>(`SELECT COUNT(*) AS "count" FROM "orders_order"`))?.count ??
        0,
    );
  }

  /** What both tax routes answer with: a hand-built dict, its time as DRF's encoder writes one. */
  private async taxAnswer(row: OrganizationRow, rate: string, settledBy: string | null) {
    return {
      tax_mode: row.tax_mode,
      default_tax_rate: rate,
      tax_settled_at: utcIso(row.tax_settled_at),
      tax_settled_by_name: settledBy ?? '',
      is_settled: row.tax_settled_at !== null,
      priced_order_count: await this.orderCount(),
    };
  }

  /** `GET /organization/tax/`. */
  async tax(user: RequestUser) {
    if (!(await this.permissions.has(user, 'settings.view'))) return NOT_ALLOWED;
    const organization = await this.current();
    if (!organization) return NO_ORGANIZATION;
    return this.taxAnswer(
      organization,
      organization.default_tax_rate,
      await this.settledBy(organization.tax_settled_by_id),
    );
  }

  /**
   * `PATCH /organization/tax/` and `update_tax_settings`: a change once
   * orders exist has to be confirmed; settling -- changed or not -- stamps
   * who and when and is always audited; a change asks the storefront to drop
   * its priced pages.
   */
  async settleTax(user: RequestUser, data: () => unknown, context: AuditContext) {
    if (!(await this.permissions.has(user, 'settings.manage'))) return NOT_ALLOWED;
    const result = await runSerializer<{
      tax_mode: string;
      default_tax_rate: string;
      confirm: boolean;
      reason?: string;
    }>(
      {
        tax_mode: choiceField(TAX_MODES),
        default_tax_rate: decimalField(6, 4, { minValue: '0', maxValue: '1' }),
        confirm: withDefault(booleanField({ required: false }), () => false),
        reason: charField({ required: false, allowBlank: true, maxLength: 500 }),
      } as Fields,
      data(),
    );
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    const asked = result.values;
    const actor = { id: user.id, email: user.email };

    const { row, changing } = await this.db.transaction(async (tx) => {
      const organization = await this.current(tx);
      if (!organization) throw new NotFound('No organisation is configured.');
      const changes =
        asked.tax_mode !== organization.tax_mode ||
        !new Dec(asked.default_tax_rate).eq(organization.default_tax_rate);
      if (changes && !asked.confirm) {
        const existing = await this.orderCount(tx);
        if (existing) {
          throw new Conflict('Changing VAT after orders exist needs confirmation.', {
            code: 'TAX_CHANGE_NEEDS_CONFIRMATION',
            details: {
              order_count: existing,
              message:
                `${existing} order(s) were priced under the current VAT treatment. ` +
                'They keep the totals they were given; reports spanning the change ' +
                'will mix both. Re-submit with confirm=true to proceed.',
            },
          });
        }
      }
      const saved = (await tx.one<{ tax_settled_at: string }>(
        `UPDATE ${O} SET "tax_mode" = $2, "default_tax_rate" = $3,
                "tax_settled_at" = clock_timestamp(), "tax_settled_by_id" = $4,
                "updated_at" = clock_timestamp()
          WHERE ${O}."id" = $1 RETURNING "tax_settled_at"`,
        [organization.id, asked.tax_mode, asked.default_tax_rate, actor.id],
      )) as { tax_settled_at: string };
      await recordAudit(tx, context, {
        action: 'SETTINGS_CHANGED',
        entity: { type: 'Organization', id: organization.id, label: organization.name },
        actor,
        oldValues: {
          tax_mode: organization.tax_mode,
          default_tax_rate: organization.default_tax_rate,
          tax_settled_at: pyIsoformat(organization.tax_settled_at),
        },
        newValues: {
          tax_mode: asked.tax_mode,
          default_tax_rate: asked.default_tax_rate,
          tax_settled_at: pyIsoformat(saved.tax_settled_at),
        },
        reason: asked.reason || 'VAT treatment settled',
      });
      return {
        row: {
          ...organization,
          tax_mode: asked.tax_mode,
          tax_settled_at: saved.tax_settled_at,
          tax_settled_by_id: actor.id,
        },
        changing: changes,
      };
    });
    // Every storefront price carries a note of the treatment it was quoted under.
    if (changing) await this.revalidation.request('products', 'home', 'categories');
    await this.siteChanged();
    return this.taxAnswer(row, asked.default_tax_rate, await this.settledBy(actor.id));
  }
}
