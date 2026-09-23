/**
 * The matrix is a lookup across two axes, so what matters is that a screen
 * reader can make the same lookup a sighted reader makes: headers on both
 * axes, and a cell that says yes or no in words rather than by its mark.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildRoleMatrix } from "@/lib/role-matrix";

import { RoleMatrix } from "./role-matrix";

const matrix = buildRoleMatrix(
  [
    {
      id: "o",
      code: "OWNER",
      name: "Owner",
      is_staff_role: true,
      holds_every_permission: true,
      permissions: [],
    },
    {
      id: "c",
      code: "CASHIER",
      name: "Cashier",
      is_staff_role: true,
      holds_every_permission: false,
      permissions: ["sales.view"],
    },
  ],
  [
    { code: "sales.view", name: "View sales", group: "sales" },
    { code: "sales.refund", name: "Refund a sale", group: "sales" },
  ],
);

describe("RoleMatrix", () => {
  it("is a table with a header for every role and every permission", () => {
    render(<RoleMatrix matrix={matrix} />);

    const table = screen.getByRole("table");
    const columns = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(columns[0]).toBe("Permission");
    expect(columns[1]).toContain("Owner");
    expect(columns[2]).toContain("Cashier");
    expect(within(table).getByRole("rowheader", { name: /Refund a sale/ })).toBeTruthy();
  });

  it("names the area each block of rows belongs to", () => {
    render(<RoleMatrix matrix={matrix} />);

    const group = screen.getByRole("rowheader", { name: "Sales" });
    expect(group.getAttribute("scope")).toBe("rowgroup");
  });

  it("says yes or no in words, not only with a mark", () => {
    render(<RoleMatrix matrix={matrix} />);

    const refund = screen.getByRole("rowheader", { name: /Refund a sale/ }).closest("tr");
    const cells = within(refund as HTMLElement).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["Yes", "No"]);
    // The marks themselves are decoration; the words carry the meaning.
    for (const icon of refund?.querySelectorAll("svg") ?? []) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("says the owner holds everything rather than counting", () => {
    render(<RoleMatrix matrix={matrix} />);

    expect(screen.getByRole("columnheader", { name: /Owner/ }).textContent).toContain(
      "Everything, always",
    );
    expect(screen.getByRole("columnheader", { name: /Cashier/ }).textContent).toContain("1 of 2");
  });
});
