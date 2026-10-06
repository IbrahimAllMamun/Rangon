import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { RolePermissions } from '../auth/permissions';
import { auditDiff, type AuditContext, recordAudit } from '../common/audit';
import { localIso, zoneOffsetSeconds } from '../common/datetime';
import {
  charField,
  choiceField,
  dateField,
  emailField,
  EMPTY,
  errorMessages,
  type Field,
  type Fields,
  Invalid,
  InvalidFields,
  InvalidNested,
  pkRelatedField,
  runSerializer,
} from '../common/drf';
import { Conflict, NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { normalizeIfMobile } from '../common/phone';
import { compareCodePoints, pyStr, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { dataGet, pyTruthy } from '../http/request-body';
import { STATUSES } from './branches.service';
import { fullName } from './me.service';
import { makePassword, validatePassword } from './passwords';
import { TokensService } from './tokens.service';

/**
 * `UserViewSet`, `UserWriteSerializer` and the staff side of
 * `accounts.services`: the people who work in the shop. An account is made
 * and edited through services that carry two guards -- nobody removes their
 * own access, and the last owner keeps theirs -- and write the audit entry;
 * staff are deactivated, never deleted. The profile, the most personal data
 * the system holds, is shown only to `users.manage`, and the audit log
 * records which of its fields changed, never what they say.
 */

const U = '"accounts_user"';
const R = '"accounts_role"';
const B = '"accounts_branch"';
const S = '"accounts_staffprofile"';
/** `PROFILE_FIELDS`, in the serializer's order. */
export const PROFILE_FIELDS = [
  'designation',
  'joined_on',
  'date_of_birth',
  'national_id',
  'blood_group',
  'present_address',
  'permanent_address',
  'emergency_contact_name',
  'emergency_contact_relation',
  'emergency_contact_phone',
  'notes',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type Profile = Record<ProfileField, string | null>;
export const BLANK_PROFILE: Profile = {
  designation: '',
  joined_on: null,
  date_of_birth: null,
  national_id: '',
  blood_group: '',
  present_address: '',
  permanent_address: '',
  emergency_contact_name: '',
  emergency_contact_relation: '',
  emergency_contact_phone: '',
  notes: '',
};
const BLOOD_GROUPS = ['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG'];
/** `RoleCode.choices`: a role made in the Django admin is not one. */
const ROLE_CODES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'CASHIER',
  'INVENTORY_MANAGER',
  'ACCOUNTANT',
  'CUSTOMER',
] as const;
const USER_COLUMNS = [
  'id',
  'password',
  'last_login',
  'is_superuser',
  'email',
  'first_name',
  'last_name',
  'phone',
  'organization_id',
  'branch_id',
  'role_id',
  'status',
  'is_staff',
  'is_active',
  'date_joined',
  'last_login_ip',
] as const;
const SELECT = `${USER_COLUMNS.map((name) => `${U}."${name}"`).join(', ')},
  ${R}."code" AS "role_code", ${R}."name" AS "role_name",
  ${B}."name" AS "branch_name", ${B}."code" AS "branch_code",
  ${S}."id" AS "profile_id", ${PROFILE_FIELDS.map((name) => `${S}."${name}"::text AS "profile_${name}"`).join(', ')}`;
const JOIN_ROLE = `LEFT OUTER JOIN ${R} ON (${U}."role_id" = ${R}."id")`;
const FROM = `FROM ${U} ${JOIN_ROLE}
  LEFT OUTER JOIN ${B} ON (${U}."branch_id" = ${B}."id")
  LEFT OUTER JOIN ${S} ON (${U}."id" = ${S}."user_id")`;
/** `.exclude(role__code=RoleCode.CUSTOMER)`: an account with no role is staff too. */
const STAFF = `NOT (${R}."code" = 'CUSTOMER' AND ${R}."code" IS NOT NULL)`;
const FILTERS: readonly FilterField[] = [
  choiceFilter('status', `${U}."status"`, STATUSES),
  modelFilter('branch', `${U}."branch_id"`, 'accounts_branch'),
  modelFilter('role', `${U}."role_id"`, 'accounts_role'),
];
const ORDERING = { email: `${U}."email"`, date_joined: `${U}."date_joined"` };

interface UserRow {
  id: string;
  password: string;
  last_login: string | null;
  is_superuser: boolean;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  organization_id: string | null;
  branch_id: string | null;
  role_id: string | null;
  status: string;
  is_staff: boolean;
  is_active: boolean;
  date_joined: string;
  last_login_ip: string | null;
  role_code: string | null;
  role_name: string | null;
  branch_name: string | null;
  branch_code: string | null;
  profile_id: string | null;
}

type UserData = Partial<{
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  status: string;
  branch: string | null;
  password: string;
  role_code: string;
  profile: Partial<Profile>;
}>;

interface Actor {
  id: string;
  email: string;
}

function localToday(timeZone: string): string {
  const seconds = Math.floor(Date.now() / 1000);
  return new Date((seconds + zoneOffsetSeconds(seconds, timeZone)) * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * What `save_staff_profile` finds changed: the fields sent whose values differ
 * from the stored ones, sorted -- the names the audit entry carries, never
 * the values.
 */
export function changedProfileFields(stored: Profile, values: Partial<Profile>): ProfileField[] {
  return (Object.keys(values) as ProfileField[])
    .filter((field) => stored[field] !== values[field])
    .sort(compareCodePoints);
}

/** A nested serializer: a JSON object validated by `fields`, its errors a dict of their own. */
function nestedField<V extends Record<string, unknown>>(
  fields: Fields,
  options: Parameters<typeof runSerializer<V>>[2] & { required?: boolean },
): Field<V | null> {
  return {
    async run(data, partial) {
      if (data === EMPTY || data === undefined) {
        if (partial || !(options.required ?? true)) return undefined as unknown as V;
        throw Invalid.of('This field is required.', 'required');
      }
      if (data === null) throw Invalid.of('This field may not be null.', 'null');
      const result = await runSerializer<V>(fields, data, { ...options, partial });
      if (!result.ok) throw new InvalidNested(result.errors);
      return result.values;
    },
  };
}

/** `check_can_lose_access`'s two refusals. */
function cannot(what: string, whom: 'own' | 'last'): ValidationError {
  return whom === 'own'
    ? new ValidationError(`You cannot ${what} your own account.`, {
        details: { user: `Ask another owner to ${what} it.` },
      })
    : new ValidationError(`You cannot ${what} the last owner.`, {
        details: { user: 'Give another account the owner role first.' },
      });
}

@Injectable()
export class StaffUsersService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly tokens: TokensService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  /** `StaffProfileSerializer(profile).data`, or the same shape blank for nobody's. */
  private profile(row: UserRow): Profile {
    if (!row.profile_id) return { ...BLANK_PROFILE };
    const source = row as unknown as Record<string, string | null>;
    return Object.fromEntries(
      PROFILE_FIELDS.map((name) => [name, source[`profile_${name}`] ?? BLANK_PROFILE[name]]),
    ) as Profile;
  }

  /**
   * `UserSerializer(user).data`. `role_code` and `role_name` read through a
   * role that may not be there, and DRF leaves out a read-only field whose
   * source is missing; `branch_name` has a default and stays. The profile is
   * there only for someone who may manage staff -- absent, not null.
   */
  private serialise(row: UserRow, withProfile: boolean) {
    return {
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      full_name: fullName(row),
      phone: row.phone,
      status: row.status,
      role: row.role_id,
      ...(row.role_id ? { role_code: row.role_code, role_name: row.role_name } : {}),
      branch: row.branch_id,
      branch_name: row.branch_id ? (row.branch_name ?? '') : '',
      date_joined: this.iso(row.date_joined),
      last_login: this.iso(row.last_login),
      ...(withProfile ? { profile: this.profile(row) } : {}),
    };
  }

  /** `can_see_staff_profiles`. */
  private seesProfiles(user: RequestUser): Promise<boolean> {
    return this.permissions.has(user, 'users.manage');
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = [STAFF];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const order = orderingFrom(query, ORDERING) ?? [`${U}."email" ASC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${U} ${JOIN_ROLE} WHERE ${where.join(' AND ')}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<UserRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    const withProfile = await this.seesProfiles(user);
    return paginated(
      page,
      rows.map((row) => this.serialise(row, withProfile)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the staff queryset, filtered, then the key. */
  private async find(pk: string, query: QueryDict, q: Queryable = this.db): Promise<UserRow> {
    const sql = new SqlParams();
    const where = [STAFF];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${U}."id" = ${sql.add(id, 'uuid')}`);
    const row = await q.one<UserRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  private async byId(id: string, q: Queryable = this.db): Promise<UserRow> {
    return (await q.one<UserRow>(`SELECT ${SELECT} ${FROM} WHERE ${U}."id" = $1 LIMIT 21`, [
      id,
    ])) as UserRow;
  }

  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    return this.serialise(await this.find(pk, query), await this.seesProfiles(user));
  }

  /** `StaffProfileSerializer`, nested: every field optional. */
  private profileField(): Field<Partial<Profile> | null> {
    const text = (maxLength?: number) =>
      charField({ required: false, allowBlank: true, ...(maxLength ? { maxLength } : {}) });
    return nestedField<Partial<Profile>>(
      {
        designation: text(80),
        joined_on: dateField({ required: false, allowNull: true }),
        date_of_birth: dateField({ required: false, allowNull: true }),
        // The model's conditional unique constraint, as a `UniqueValidator` on a
        // nested serializer that never has an instance: it cannot exclude the
        // profile being edited, so an ID number resent with an edit is "taken".
        national_id: charField({
          maxLength: 32,
          required: false,
          allowBlank: true,
          unique: {
            message: 'staff profile with this national id already exists.',
            exists: async (value) =>
              (await this.db.one(
                `SELECT 1 AS "a" FROM ${S}
                  WHERE (NOT (${S}."national_id" = '') AND ${S}."national_id" = $1) LIMIT 1`,
                [value],
              )) !== null,
          },
        }),
        blood_group: choiceField(BLOOD_GROUPS, { required: false, allowBlank: true }),
        present_address: text(),
        permanent_address: text(),
        emergency_contact_name: text(120),
        emergency_contact_relation: text(60),
        emergency_contact_phone: charField({
          maxLength: 32,
          required: false,
          allowBlank: true,
          convert: (value) => normalizeIfMobile(value),
        }),
        notes: text(),
      } as Fields,
      {
        required: false,
        hooks: {
          date_of_birth: (value: string | null) => {
            if (value && value > localToday(this.env.DJANGO_TIME_ZONE))
              throw Invalid.of('A date of birth cannot be in the future.');
            return value;
          },
          national_id: (value: string) => {
            if (!/^[A-Za-z0-9 -]*$/.test(value))
              throw Invalid.of('Use only letters, digits, spaces and hyphens.');
            return value;
          },
        },
        validate: (attrs) => {
          const born = attrs.date_of_birth;
          const joined = attrs.joined_on;
          if (born && joined && joined < born) {
            throw new InvalidFields({
              joined_on: [
                { message: 'The joining date is before the date of birth.', code: 'invalid' },
              ],
            });
          }
          return attrs;
        },
      },
    );
  }

  /** `UserWriteSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  private async validate(data: unknown, instance: UserRow | null, partial: boolean) {
    const exists = (table: string) => async (id: string) =>
      (await this.db.one(`SELECT 1 AS "a" FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
    const result = await runSerializer<UserData>(
      {
        // Compared as typed; the account is stored in lower case.
        email: emailField({
          maxLength: 254,
          unique: {
            message: 'user with this email already exists.',
            exists: async (value) =>
              (await this.db.one(
                `SELECT 1 AS "a" FROM ${U} WHERE (${U}."email" = $1${
                  instance ? ` AND NOT (${U}."id" = $2)` : ''
                }) LIMIT 1`,
                instance ? [value, instance.id] : [value],
              )) !== null,
          },
        }),
        first_name: charField({ maxLength: 80, required: false, allowBlank: true }),
        last_name: charField({ maxLength: 80, required: false, allowBlank: true }),
        phone: charField({
          maxLength: 32,
          required: false,
          allowBlank: true,
          convert: (value) => normalizeIfMobile(value),
        }),
        status: choiceField(STATUSES, { required: false }),
        branch: pkRelatedField(exists('accounts_branch'), { required: false, allowNull: true }),
        password: charField({ required: false, minLength: 10 }),
        role_code: choiceField(ROLE_CODES, { required: false }),
        profile: this.profileField(),
      } as Fields,
      data,
      {
        partial,
        hooks: {
          password: (value: string) => {
            const errors = validatePassword(value, null);
            if (errors.length) throw new Invalid(errors);
            return value;
          },
        },
      },
    );
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /**
   * `save_staff_profile`: the fields that differ from what is stored are
   * written, under the profile's row lock, and named for the audit entry. A
   * payload that changes nothing writes nothing -- not even an empty row.
   */
  private async saveProfile(
    tx: Queryable,
    userId: string,
    values: Partial<Profile>,
    actor: Actor,
  ): Promise<string[]> {
    const stored = await tx.one<Record<string, string | null>>(
      `SELECT ${S}."id", ${PROFILE_FIELDS.map((name) => `${S}."${name}"::text AS "${name}"`).join(', ')}
         FROM ${S} WHERE ${S}."user_id" = $1 ORDER BY ${S}."id" ASC LIMIT 1 FOR UPDATE`,
      [userId],
    );
    const profile: Profile = stored
      ? (Object.fromEntries(PROFILE_FIELDS.map((name) => [name, stored[name]])) as Profile)
      : { ...BLANK_PROFILE };
    const changed = changedProfileFields(profile, values);
    if (!changed.length) return [];
    for (const field of changed) profile[field] = values[field] as string | null;

    const nationalId = pyStrip(profile.national_id ?? '');
    const taken = () =>
      new ValidationError('Another member of staff already has this ID number.', {
        details: {
          profile: { national_id: ['Another member of staff already has this ID number.'] },
        },
      });
    if (nationalId) {
      const other = await tx.one(
        `SELECT 1 AS "a" FROM ${S} WHERE (${S}."national_id" = $1 AND NOT (${S}."user_id" = $2))
          LIMIT 1`,
        [nationalId, userId],
      );
      if (other) throw taken();
    }
    // `StaffProfile.save()`: the ID trimmed, the phone made canonical when it is a mobile.
    const row = [
      profile.designation,
      profile.joined_on,
      profile.date_of_birth,
      nationalId,
      profile.blood_group,
      profile.present_address,
      profile.permanent_address,
      profile.emergency_contact_name,
      profile.emergency_contact_relation,
      normalizeIfMobile(profile.emergency_contact_phone),
      profile.notes,
    ];
    await tx.query('SAVEPOINT staff_profile');
    try {
      if (stored) {
        await tx.query(
          `UPDATE ${S} SET "updated_at" = clock_timestamp(), "designation" = $2,
             "joined_on" = $3::date, "date_of_birth" = $4::date, "national_id" = $5,
             "blood_group" = $6, "present_address" = $7, "permanent_address" = $8,
             "emergency_contact_name" = $9, "emergency_contact_relation" = $10,
             "emergency_contact_phone" = $11, "notes" = $12
           WHERE ${S}."id" = $1`,
          [stored.id, ...row],
        );
      } else {
        await tx.query(
          `INSERT INTO ${S} ("id", "created_at", "updated_at", "user_id", "designation",
             "joined_on", "date_of_birth", "national_id", "blood_group", "present_address",
             "permanent_address", "emergency_contact_name", "emergency_contact_relation",
             "emergency_contact_phone", "notes", "created_by_id")
           VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4::date, $5::date, $6, $7, $8,
                   $9, $10, $11, $12, $13, $14)`,
          [randomUUID(), userId, ...row, actor.id],
        );
      }
      await tx.query('RELEASE SAVEPOINT staff_profile');
    } catch (error) {
      const failure = error as { code?: string; constraint?: string; message?: string };
      if (!String(failure.code).startsWith('23')) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT staff_profile');
      if (`${failure.constraint ?? ''} ${failure.message ?? ''}`.includes('national_id'))
        throw taken();
      // Two first saves of one profile at once: the other one won.
      throw new Conflict('This profile was saved by someone else just now. Reload and try again.');
    }
    return changed;
  }

  private async role(tx: Queryable, code: string): Promise<string> {
    const role = await tx.one<{ id: string }>(
      `SELECT ${R}."id" FROM ${R} WHERE ${R}."code" = $1 LIMIT 21`,
      [code],
    );
    // `Role.objects.get(code=...)`: a role the code names and the table lacks is a 500.
    if (!role) throw new Error(`Role matching query does not exist: ${code}`);
    return role.id;
  }

  /** `str(branch)`, as the audit entry names it. */
  private async branchLabel(tx: Queryable, id: string | null): Promise<string | null> {
    if (!id) return null;
    const branch = await tx.one<{ name: string; code: string }>(
      `SELECT ${B}."name", ${B}."code" FROM ${B} WHERE ${B}."id" = $1 LIMIT 21`,
      [id],
    );
    return branch ? `${branch.name} (${branch.code})` : null;
  }

  /**
   * `create` and `create_staff_user`: a cashier unless a role is named,
   * always ACTIVE whatever status was sent, in the one organisation. The
   * password is asked for only once everything else has passed.
   */
  async create(user: RequestUser, data: unknown, context: AuditContext) {
    const values = await this.validate(data, null, false);
    const roleCode = values.role_code ?? 'CASHIER';
    if (!values.password) {
      throw new ValidationError('Invalid input.', {
        details: { password: ['A password is required.'] },
      });
    }
    const password = values.password;
    const actor = { id: user.id, email: user.email };
    // `normalize_email(email).lower()`, then `save()`'s own `.lower().strip()`.
    const email = pyStrip((values.email as string).toLowerCase());

    const id = await this.db.transaction(async (tx) => {
      const roleId = await this.role(tx, roleCode);
      const organization = await tx.one<{ id: string }>(
        `SELECT "id" FROM "accounts_organization" WHERE "accounts_organization"."status" = 'ACTIVE'
          ORDER BY "accounts_organization"."created_at" ASC LIMIT 1`,
      );
      const userId = randomUUID();
      await tx.query(
        `INSERT INTO ${U} ("id", "password", "last_login", "is_superuser", "created_at",
           "updated_at", "email", "first_name", "last_name", "phone", "organization_id",
           "branch_id", "role_id", "status", "is_staff", "is_active", "date_joined",
           "last_login_ip")
         VALUES ($1, $2, NULL, false, clock_timestamp(), clock_timestamp(), $3, $4, $5, $6, $7, $8,
                 $9, 'ACTIVE', false, true, clock_timestamp(), NULL)`,
        [
          userId,
          await makePassword(password),
          email,
          values.first_name ?? '',
          values.last_name ?? '',
          normalizeIfMobile(values.phone ?? ''),
          organization?.id ?? null,
          values.branch ?? null,
          roleId,
        ],
      );
      const newValues: Record<string, unknown> = {
        email: values.email,
        role: roleCode,
        branch: await this.branchLabel(tx, values.branch ?? null),
      };
      if (values.profile && Object.keys(values.profile).length) {
        const recorded = await this.saveProfile(tx, userId, values.profile, actor);
        if (recorded.length) newValues.profile_recorded = recorded;
      }
      await recordAudit(tx, context, {
        action: 'USER_CHANGED',
        entity: { type: 'User', id: userId, label: email },
        actor,
        newValues,
        reason: 'User created',
      });
      return userId;
    });
    return this.serialise(await this.byId(id), await this.seesProfiles(user));
  }

  private async activeOwnersBeside(tx: Queryable, userId: string): Promise<number> {
    const row = await tx.one<{ count: string }>(
      `SELECT COUNT(*) AS "count" FROM ${U} INNER JOIN ${R} ON (${U}."role_id" = ${R}."id")
        WHERE (${R}."code" = 'OWNER' AND ${U}."status" = 'ACTIVE' AND NOT (${U}."id" = $1))`,
      [userId],
    );
    return Number(row?.count ?? 0);
  }

  /** `check_can_lose_access`: not yourself, and not the last owner. */
  private async checkCanLoseAccess(tx: Queryable, user: UserRow, actor: Actor, what: string) {
    if (actor.id === user.id) throw cannot(what, 'own');
    if (user.role_code === 'OWNER' && (await this.activeOwnersBeside(tx, user.id)) === 0)
      throw cannot(what, 'last');
  }

  /**
   * `update` and `update_staff_user`: the two guards, the account saved whole
   * -- every column written back as read -- a new password ending every
   * session, the profile, and one audit entry naming what changed.
   */
  async update(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    partial: boolean,
    context: AuditContext,
  ) {
    const instance = await this.find(pk, query);
    const values = await this.validate(data(), instance, partial);
    const actor = { id: user.id, email: user.email };

    await this.db.transaction(async (tx) => {
      const before = {
        role: instance.role_code,
        status: instance.status,
        email: instance.email,
        branch: instance.branch_id ? `${instance.branch_name} (${instance.branch_code})` : null,
      };
      const status = values.status ?? instance.status;
      if (values.status !== undefined && status !== instance.status && status !== 'ACTIVE')
        await this.checkCanLoseAccess(tx, instance, actor, 'deactivate');

      let roleId = instance.role_id;
      let roleCode = instance.role_code;
      if (values.role_code && values.role_code !== instance.role_code) {
        if (instance.role_code === 'OWNER')
          await this.checkCanLoseAccess(tx, instance, actor, 'demote');
        roleId = await this.role(tx, values.role_code);
        roleCode = values.role_code;
      }

      const has = (key: keyof UserData) => Object.hasOwn(values, key);
      const branchId = has('branch') ? (values.branch ?? null) : instance.branch_id;
      // `User.save()`: the email lower-cased and trimmed, a mobile made canonical.
      const email = pyStrip((values.email ?? instance.email).toLowerCase());
      await tx.query(
        `UPDATE ${U} SET "password" = $2, "last_login" = $3::timestamptz, "is_superuser" = $4,
           "updated_at" = clock_timestamp(), "email" = $5, "first_name" = $6, "last_name" = $7,
           "phone" = $8, "organization_id" = $9, "branch_id" = $10, "role_id" = $11,
           "status" = $12, "is_staff" = $13, "is_active" = $14, "date_joined" = $15::timestamptz,
           "last_login_ip" = $16::inet
         WHERE ${U}."id" = $1`,
        [
          instance.id,
          values.password ? await makePassword(values.password) : instance.password,
          instance.last_login,
          instance.is_superuser,
          email,
          values.first_name ?? instance.first_name,
          values.last_name ?? instance.last_name,
          normalizeIfMobile(values.phone ?? instance.phone),
          instance.organization_id,
          branchId,
          roleId,
          status,
          instance.is_staff,
          status === 'ACTIVE',
          instance.date_joined,
          instance.last_login_ip,
        ],
      );
      // A reset signs the account out everywhere, not only at the next sign-in.
      const sessionsEnded = values.password ? await this.tokens.endSessions(instance.id, tx) : 0;
      const profileChanged =
        values.profile && Object.keys(values.profile).length
          ? await this.saveProfile(tx, instance.id, values.profile, actor)
          : [];

      const after = {
        role: roleCode,
        status,
        email,
        branch: await this.branchLabel(tx, branchId),
      };
      const [oldValues, newValues] = auditDiff(before, after);
      if (values.password) {
        // The value never goes near the log -- only the fact of the reset.
        newValues.password_reset = true;
        newValues.sessions_ended = sessionsEnded;
      }
      if (profileChanged.length) newValues.profile_updated = profileChanged;
      if (Object.keys(oldValues).length || Object.keys(newValues).length) {
        await recordAudit(tx, context, {
          action: 'USER_CHANGED',
          entity: { type: 'User', id: instance.id, label: email },
          actor,
          oldValues,
          newValues,
          reason: 'Staff account updated',
        });
      }
    });
    return this.serialise(await this.byId(instance.id), await this.seesProfiles(user));
  }

  /** `set_user_status`: the status, `is_active` with it, and the audit entry. */
  private async setStatus(
    target: UserRow,
    status: 'ACTIVE' | 'INACTIVE',
    actor: Actor,
    reason: unknown,
    context: AuditContext,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE ${U} SET "status" = $2, "is_active" = $3, "updated_at" = clock_timestamp()
          WHERE ${U}."id" = $1`,
        [target.id, status, status === 'ACTIVE'],
      );
      await recordAudit(tx, context, {
        action: 'USER_CHANGED',
        entity: { type: 'User', id: target.id, label: target.email },
        actor,
        oldValues: { status: target.status },
        newValues: { status },
        // `reason or f"Status changed to {status}"`, whatever the body's reason is.
        reason: pyTruthy(reason) ? pyStr(reason) : `Status changed to ${status}`,
      });
    });
    // `UserSerializer(user).data`, with no request in its context: no profile, for anyone.
    return this.serialise({ ...target, status, is_active: status === 'ACTIVE' }, false);
  }

  /**
   * `deactivate`, and `destroy`, which is the same thing: staff are never
   * deleted, as their audit trail must survive. The account is found, then
   * the guards, then the body's `reason` is read.
   */
  async deactivate(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const target = await this.find(pk, query);
    const actor = { id: user.id, email: user.email };
    await this.checkCanLoseAccess(this.db, target, actor, 'deactivate');
    const given = dataGet(data(), 'reason');
    return this.setStatus(target, 'INACTIVE', actor, given === undefined ? '' : given, context);
  }

  /** `activate`: no guard, and no reason but the default. */
  async activate(user: RequestUser, pk: string, query: QueryDict, context: AuditContext) {
    const target = await this.find(pk, query);
    return this.setStatus(target, 'ACTIVE', { id: user.id, email: user.email }, '', context);
  }
}
