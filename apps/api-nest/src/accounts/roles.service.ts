import { Injectable } from '@nestjs/common';

import { NotFound } from '../common/errors';
import { orderingPlan, type OrderingTerm } from '../common/filtering';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { Database } from '../database/database.service';
import { columns, Params as SqlParams } from '../database/sql';

/**
 * `RoleViewSet` and `PermissionViewSet`: what each role may do, and every
 * permission there is. Read-only and unpaginated; roles are edited in the
 * Django admin and permissions are synced from the code.
 */

const R = '"accounts_role"';
const P = '"accounts_permission"';
const ROLE_COLUMNS = ['id', 'code', 'name', 'description', 'is_staff_role', 'is_system'] as const;
const PERMISSION_COLUMNS = ['id', 'code', 'name', 'group', 'description'] as const;
/**
 * The views name no `ordering_fields`: every serializer field the model
 * holds, by its source. `holds_every_permission` is a property and is not one.
 */
const ROLE_ORDERING: Readonly<Record<string, OrderingTerm>> = {
  ...Object.fromEntries(ROLE_COLUMNS.map((name) => [name, `${R}."${name}"`])),
  // A role's permissions order it by theirs, one row per permission.
  permissions: {
    columns: [`${P}."group"`, `${P}."code"`],
    join: `LEFT OUTER JOIN "accounts_role_permissions"
      ON (${R}."id" = "accounts_role_permissions"."role_id")
      LEFT OUTER JOIN ${P} ON ("accounts_role_permissions"."permission_id" = ${P}."id")`,
  },
};
const PERMISSION_ORDERING = Object.fromEntries(
  PERMISSION_COLUMNS.map((name) => [name, `${P}."${name}"`]),
);

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string;
  is_staff_role: boolean;
  is_system: boolean;
}

@Injectable()
export class RolesService {
  constructor(private readonly db: Database) {}

  /** `RoleSerializer(roles, many=True).data`: each role's codes by group, then code. */
  private async serialise(rows: RoleRow[]) {
    const sql = new SqlParams();
    const held = rows.length
      ? await this.db.query<{ role_id: string; code: string }>(
          `SELECT "accounts_role_permissions"."role_id", "accounts_permission"."code"
             FROM "accounts_permission" INNER JOIN "accounts_role_permissions"
               ON ("accounts_permission"."id" = "accounts_role_permissions"."permission_id")
            WHERE "accounts_role_permissions"."role_id" IN ${sql.list(
              rows.map((row) => row.id),
              'uuid',
            )}
            ORDER BY "accounts_permission"."group" ASC, "accounts_permission"."code" ASC`,
          sql.values,
        )
      : [];
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      is_staff_role: row.is_staff_role,
      is_system: row.is_system,
      // An owner holds every permission whatever its row lists.
      holds_every_permission: row.code === 'OWNER',
      permissions: held.filter((entry) => entry.role_id === row.id).map((entry) => entry.code),
    }));
  }

  async list(query: QueryDict) {
    const plan = orderingPlan(query, ROLE_ORDERING);
    const order = plan?.order ?? [`${R}."name" ASC`];
    return this.serialise(
      await this.db.query<RoleRow>(
        `SELECT ${columns(R, ROLE_COLUMNS)} FROM ${R} ${(plan?.joins ?? []).join(' ')}
          ORDER BY ${order.join(', ')}`,
      ),
    );
  }

  async retrieve(pk: string) {
    const id = parseUuid(pk);
    const row = id
      ? await this.db.one<RoleRow>(
          `SELECT ${columns(R, ROLE_COLUMNS)} FROM ${R} WHERE ${R}."id" = $1 LIMIT 21`,
          [id],
        )
      : null;
    if (!row) throw new NotFound();
    return (await this.serialise([row]))[0];
  }

  /** `PermissionSerializer(permissions, many=True).data`. */
  permissions(query: QueryDict) {
    const order = orderingPlan(query, PERMISSION_ORDERING)?.order ?? [
      `${P}."group" ASC`,
      `${P}."code" ASC`,
    ];
    return this.db.query(
      `SELECT ${columns(P, PERMISSION_COLUMNS)} FROM ${P} ORDER BY ${order.join(', ')}`,
    );
  }
}
