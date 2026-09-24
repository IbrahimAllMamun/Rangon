/**
 * Every staff role against every permission, for the table on /admin/staff.
 *
 * The screen used to show each role as a cloud of raw codes
 * (`sales.discount_override`) in six separate cards, which answers "what can a
 * manager do" and not the question people actually ask: "who may refund?"
 * This lays the same data out so a row answers that, by name.
 *
 * Kept free of React so the rules below are tested on their own:
 *
 * - **An owner holds everything**, whatever its role row lists — the API says
 *   so with `holds_every_permission`, because `User.permission_codes` answers
 *   `*` for an owner and a row can be edited in the Django admin.
 * - **Nothing a role holds is hidden.** A code the catalogue does not name
 *   still gets a row, named by its code, rather than silently disappearing.
 * - **The catalogue is optional.** If `/permissions/` fails, the rows are the
 *   codes the roles hold, grouped by their prefix — plainer, still complete.
 */

export interface MatrixRole {
  id: string;
  code: string;
  name: string;
  is_staff_role: boolean;
  holds_every_permission: boolean;
  /** Permission *codes* — `RoleSerializer` uses a SlugRelatedField. */
  permissions: string[];
}

export interface MatrixPermission {
  code: string;
  name: string;
  group: string;
}

export interface MatrixColumn {
  code: string;
  name: string;
  everything: boolean;
  /** How many of the listed permissions the role holds. */
  count: number;
}

export interface MatrixRow {
  code: string;
  name: string;
  /** One entry per column, in column order. */
  held: boolean[];
}

export interface MatrixGroup {
  group: string;
  label: string;
  rows: MatrixRow[];
}

export interface RoleMatrix {
  columns: MatrixColumn[];
  groups: MatrixGroup[];
  total: number;
}

const groupOf = (code: string) => code.split(".")[0] || code;
const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function buildRoleMatrix(
  roles: MatrixRole[],
  catalogue: MatrixPermission[] | null,
): RoleMatrix {
  const staff = roles.filter((role) => role.is_staff_role);

  // The catalogue's own order, then anything a role holds that it does not name.
  const permissions: MatrixPermission[] = [...(catalogue ?? [])];
  const named = new Set(permissions.map((permission) => permission.code));
  for (const role of staff) {
    for (const code of role.permissions) {
      if (named.has(code)) continue;
      named.add(code);
      permissions.push({ code, name: code, group: groupOf(code) });
    }
  }

  const holds = (role: MatrixRole, code: string) =>
    role.holds_every_permission || role.permissions.includes(code);

  // Most permissions first, so the columns read from widest to narrowest
  // without a hard-coded seniority list to keep in step with the roles.
  const ordered: { role: MatrixRole; column: MatrixColumn }[] = staff
    .map((role) => ({
      role,
      column: {
        code: role.code,
        name: role.name,
        everything: role.holds_every_permission,
        count: permissions.filter((permission) => holds(role, permission.code)).length,
      },
    }))
    .sort(
      (a, b) =>
        Number(b.column.everything) - Number(a.column.everything) ||
        b.column.count - a.column.count ||
        a.column.name.localeCompare(b.column.name),
    );

  const groups: MatrixGroup[] = [];
  const byGroup = new Map<string, MatrixGroup>();
  for (const permission of permissions) {
    let group = byGroup.get(permission.group);
    if (!group) {
      group = { group: permission.group, label: titleCase(permission.group), rows: [] };
      byGroup.set(permission.group, group);
      groups.push(group);
    }
    group.rows.push({
      code: permission.code,
      name: permission.name,
      held: ordered.map(({ role }) => holds(role, permission.code)),
    });
  }

  return {
    columns: ordered.map(({ column }) => column),
    groups,
    total: permissions.length,
  };
}
