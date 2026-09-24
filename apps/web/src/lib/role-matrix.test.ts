import { describe, expect, it } from "vitest";

import { type MatrixPermission, type MatrixRole, buildRoleMatrix } from "./role-matrix";

const role = (code: string, permissions: string[], extra: Partial<MatrixRole> = {}): MatrixRole => ({
  id: code,
  code,
  name: code.charAt(0) + code.slice(1).toLowerCase(),
  is_staff_role: true,
  holds_every_permission: false,
  permissions,
  ...extra,
});

const CATALOGUE: MatrixPermission[] = [
  { code: "sales.view", name: "View sales", group: "sales" },
  { code: "sales.refund", name: "Refund a sale", group: "sales" },
  { code: "finance.view", name: "View accounts and the cash book", group: "finance" },
];

describe("buildRoleMatrix", () => {
  it("answers 'who may refund' along one row", () => {
    const matrix = buildRoleMatrix(
      [role("MANAGER", ["sales.view", "sales.refund"]), role("CASHIER", ["sales.view"])],
      CATALOGUE,
    );

    const refund = matrix.groups[0].rows.find((row) => row.code === "sales.refund");
    expect(matrix.columns.map((column) => column.code)).toEqual(["MANAGER", "CASHIER"]);
    expect(refund?.held).toEqual([true, false]);
  });

  it("gives the owner every permission, whatever its row lists", () => {
    // The row can be edited in the Django admin; the API's flag is the rule.
    const matrix = buildRoleMatrix(
      [role("OWNER", [], { holds_every_permission: true }), role("CASHIER", ["sales.view"])],
      CATALOGUE,
    );

    const owner = matrix.columns[0];
    expect(owner).toMatchObject({ code: "OWNER", everything: true, count: 3 });
    for (const group of matrix.groups) {
      for (const row of group.rows) expect(row.held[0]).toBe(true);
    }
  });

  it("orders columns widest first, the owner ahead of a tie", () => {
    const matrix = buildRoleMatrix(
      [
        role("CASHIER", ["sales.view"]),
        role("ADMIN", ["sales.view", "sales.refund", "finance.view"]),
        role("OWNER", [], { holds_every_permission: true }),
        role("MANAGER", ["sales.view", "sales.refund"]),
      ],
      CATALOGUE,
    );

    expect(matrix.columns.map((column) => column.code)).toEqual([
      "OWNER",
      "ADMIN",
      "MANAGER",
      "CASHIER",
    ]);
  });

  it("leaves out roles that are not staff", () => {
    const matrix = buildRoleMatrix(
      [role("MANAGER", ["sales.view"]), role("CUSTOMER", [], { is_staff_role: false })],
      CATALOGUE,
    );

    expect(matrix.columns.map((column) => column.code)).toEqual(["MANAGER"]);
  });

  it("groups rows by area, in the catalogue's order, with a readable label", () => {
    const matrix = buildRoleMatrix([role("MANAGER", [])], CATALOGUE);

    expect(matrix.groups.map((group) => [group.group, group.label])).toEqual([
      ["sales", "Sales"],
      ["finance", "Finance"],
    ]);
    expect(matrix.groups[0].rows.map((row) => row.name)).toEqual(["View sales", "Refund a sale"]);
    expect(matrix.total).toBe(3);
  });

  it("never hides a code the catalogue does not name", () => {
    const matrix = buildRoleMatrix([role("MANAGER", ["sales.view", "reports.secret"])], CATALOGUE);

    const extra = matrix.groups.find((group) => group.group === "reports");
    expect(extra?.rows).toEqual([{ code: "reports.secret", name: "reports.secret", held: [true] }]);
    expect(matrix.total).toBe(4);
  });

  it("still lists everything a role holds when the catalogue failed to load", () => {
    const matrix = buildRoleMatrix(
      [role("MANAGER", ["sales.view", "finance.view"]), role("CASHIER", ["sales.view"])],
      null,
    );

    expect(matrix.groups.map((group) => group.label)).toEqual(["Sales", "Finance"]);
    expect(matrix.groups[0].rows[0]).toEqual({
      code: "sales.view",
      name: "sales.view",
      held: [true, true],
    });
  });
});
