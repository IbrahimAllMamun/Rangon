import { applyDecorators, Controller, Injectable, SetMetadata } from '@nestjs/common';

import { invalidUuid, PermissionDenied } from '../common/errors';
import { pyStr } from '../common/python';
import { uuidFromValue } from '../common/uuid';
import { Database, Queryable } from '../database/database.service';
import type { RequestUser } from './authentication';

/**
 * `accounts.permissions.RolePermission` and the branch rules of
 * `accounts.services` (`resolve_branch`, `branch_queryset`): what every staff
 * endpoint checks before it does anything.
 *
 * A viewset declares its requirement the way Django's does:
 *
 *     @StaffView('brands', { list: ['products.view'], create: ['products.create'] })
 *
 * a dict keyed by action (`list`, `retrieve`, `create`, `update`,
 * `partial_update`, `destroy`, or an `@action`'s name), a flat list for every
 * action, or -- for an action serving a read and a write -- a dict keyed by
 * HTTP method. Each handler names its action with `@Action('list')`; a
 * handler without one is a plain `APIView` method, whose action is the
 * method's name in lower case, as `RolePermission` reads it.
 */

export type Codes = readonly string[];
export type PerMethod = Readonly<
  Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', Codes>>
>;
export type RequiredPermissions = Codes | Readonly<Record<string, Codes | PerMethod>>;

const VIEW = 'rangon:staff-view';
const ACTION = 'rangon:action';

export interface StaffViewMeta {
  required: RequiredPermissions;
}

/** Route prefix (`/api/v1/brands/`) to its view's requirement, for requests no handler took. */
const VIEWS = new Map<string, StaffViewMeta>();

/**
 * `permission_classes = [IsAuthenticated, RolePermission]` on a view served
 * under `/api/v1/<base>/`. The controller's paths are written in full
 * (`brands/:pk/`), as the shop controllers write theirs.
 */
export function StaffView(base: string, required: RequiredPermissions): ClassDecorator {
  const meta: StaffViewMeta = { required };
  VIEWS.set(`/api/v1/${base}/`, meta);
  return applyDecorators(Controller('api/v1'), SetMetadata(VIEW, meta));
}

/** The viewset action a handler serves: `self.action` in the Django view. */
export const Action = (name: string) => SetMetadata(ACTION, name);

export const STAFF_VIEW_METADATA = VIEW;
export const ACTION_METADATA = ACTION;

/** The staff view a route pattern belongs to, if any: the longest registered prefix. */
export function staffViewFor(pattern: string): StaffViewMeta | null {
  const path = pattern.endsWith('/') ? pattern : `${pattern}/`;
  let found: StaffViewMeta | null = null;
  let length = 0;
  for (const [prefix, meta] of VIEWS) {
    if (path.startsWith(prefix) && prefix.length > length) {
      found = meta;
      length = prefix.length;
    }
  }
  return found;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isPerMethod(value: Codes | PerMethod): value is PerMethod {
  return !Array.isArray(value);
}

/**
 * The codes an action needs, or null when the view declares none for it --
 * which refuses, because a missing entry must fail closed.
 */
export function requiredCodes(
  required: RequiredPermissions,
  action: string | null,
  method: string,
): Codes | null {
  if (Array.isArray(required)) return required as Codes;
  const table = required as Readonly<Record<string, Codes | PerMethod>>;
  const key = action ?? method.toLowerCase();
  let codes: Codes | PerMethod | undefined = Object.hasOwn(table, key) ? table[key] : undefined;
  if (codes === undefined && SAFE_METHODS.has(method)) {
    // `required.get("list") or required.get("retrieve")`: an empty list is falsy.
    const list = table['list'];
    codes =
      list !== undefined && !(Array.isArray(list) && list.length === 0) ? list : table['retrieve'];
  }
  if (codes === undefined) return null;
  if (isPerMethod(codes)) {
    // DRF routes HEAD to the GET handler and OPTIONS to the metadata probe.
    const verb = (method === 'HEAD' || method === 'OPTIONS' ? 'GET' : method) as keyof PerMethod;
    return codes[verb] ?? null;
  }
  return codes;
}

/** `user.can_cross_branch`: owners and administrators act on any branch. */
export function canCrossBranch(user: RequestUser): boolean {
  return user.roleCode === 'OWNER' || user.roleCode === 'ADMIN';
}

export interface BranchRow {
  id: string;
  code: string;
  name: string;
  status: string;
  is_default: boolean;
  fulfils_online_orders: boolean;
}

const BRANCH_COLUMNS = `"accounts_branch"."id", "accounts_branch"."code", "accounts_branch"."name",
  "accounts_branch"."status", "accounts_branch"."is_default", "accounts_branch"."fulfils_online_orders"`;

@Injectable()
export class RolePermissions {
  constructor(private readonly db: Database) {}

  /** `user.permission_codes()`: every code the role holds, `*` for an owner or superuser. */
  async codes(user: RequestUser): Promise<Set<string>> {
    if (user.roleCode === 'OWNER' || user.isSuperuser) return new Set(['*']);
    if (!user.roleId) return new Set();
    const rows = await this.db.query<{ code: string }>(
      `SELECT "accounts_permission"."code" FROM "accounts_permission"
         INNER JOIN "accounts_role_permissions"
           ON ("accounts_permission"."id" = "accounts_role_permissions"."permission_id")
        WHERE "accounts_role_permissions"."role_id" = $1
        ORDER BY "accounts_permission"."group" ASC, "accounts_permission"."code" ASC`,
      [user.roleId],
    );
    return new Set(rows.map((row) => row.code));
  }

  /** `user.has_perm_code(code)`. */
  async has(user: RequestUser, code: string): Promise<boolean> {
    const codes = await this.codes(user);
    return codes.has('*') || codes.has(code);
  }

  /** `RolePermission.has_permission` for a signed-in user. */
  async allows(
    user: RequestUser,
    required: RequiredPermissions,
    action: string | null,
    method: string,
  ): Promise<boolean> {
    if (user.roleCode === 'OWNER' || user.isSuperuser) return true;
    const codes = requiredCodes(required, action, method);
    if (codes === null) return false;
    if (codes.length === 0) return true;
    const held = await this.codes(user);
    return codes.every((code) => held.has('*') || held.has(code));
  }

  /**
   * `resolve_branch(user, branch_id)`: which branch a staff request acts on.
   * Their own, unless they may cross branches and asked for another active
   * one -- and a branch they may not act on is refused, not swapped.
   */
  async resolveBranch(
    user: RequestUser,
    branchId: unknown,
    q: Queryable = this.db,
  ): Promise<BranchRow> {
    if (truthy(branchId)) {
      const lookup = uuidFromValue(branchId);
      if ('invalid' in lookup) throw invalidUuid(pyStr(branchId));
      const branch = lookup.id
        ? await q.one<BranchRow>(
            `SELECT ${BRANCH_COLUMNS} FROM "accounts_branch"
              WHERE ("accounts_branch"."id" = $1 AND "accounts_branch"."status" = 'ACTIVE')
              ORDER BY "accounts_branch"."name" ASC LIMIT 1`,
            [lookup.id],
          )
        : null;
      if (!branch) throw new PermissionDenied('That branch is not available.');
      if (!canCrossBranch(user) && user.branchId && user.branchId !== branch.id) {
        throw new PermissionDenied('You may only act on your own branch.');
      }
      return branch;
    }
    if (user.branchId) {
      const own = await q.one<BranchRow>(
        `SELECT ${BRANCH_COLUMNS} FROM "accounts_branch" WHERE "accounts_branch"."id" = $1 LIMIT 21`,
        [user.branchId],
      );
      if (own) return own;
    }
    const fallback = await q.one<BranchRow>(
      `SELECT ${BRANCH_COLUMNS} FROM "accounts_branch" WHERE "accounts_branch"."status" = 'ACTIVE'
        ORDER BY "accounts_branch"."is_default" DESC, "accounts_branch"."created_at" ASC LIMIT 1`,
    );
    if (!fallback) throw new PermissionDenied('No active branch is configured.');
    return fallback;
  }
}

/** Python truthiness of a branch id as a view passes it: `if branch_id:`. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === '' || value === 0 || value === 0n) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * `branch_queryset(user, queryset, field)`: the rows a user may see, as a SQL
 * condition over the given branch columns -- or null when they see them all
 * (a superuser, an owner or administrator, or staff with no home branch).
 * Placeholders are numbered from `next`.
 */
export function branchCondition(
  user: RequestUser,
  columns: readonly string[],
  next: number,
): { sql: string; values: unknown[] } | null {
  if (user.isSuperuser || canCrossBranch(user) || !user.branchId) return null;
  const parts = columns.map((column) => `${column} = $${next}`);
  return {
    sql: parts.length === 1 ? (parts[0] as string) : `(${parts.join(' OR ')})`,
    values: [user.branchId],
  };
}
