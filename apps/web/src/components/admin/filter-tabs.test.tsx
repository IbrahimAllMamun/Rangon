/**
 * The one filter look every admin list shares.
 *
 * What it must guarantee: the set is a named group, the chosen tab is exposed
 * as current (to assistive tech, not only by colour), exactly one is chosen,
 * and each tab is a real link to its own URL -- so it opens in a new tab and
 * works before hydration.
 *
 * Plain matchers, no `toBeInTheDocument`: no vitest setup file registers
 * jest-dom (see receipt.test.tsx).
 */

import { render, screen, within } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { FilterTabs } from "./filter-tabs";

const TABS = [
  { label: "All", href: "/admin/reviews", active: false },
  { label: "Pending", href: "/admin/reviews?status=PENDING", active: true },
  { label: "Approved", href: "/admin/reviews?status=APPROVED", active: false },
];

describe("FilterTabs", () => {
  it("is a group named for what it filters", () => {
    render(<FilterTabs label="Review status" tabs={TABS} />);

    const group = screen.getByRole("group", { name: "Review status" });
    expect(within(group).getAllByRole("link")).toHaveLength(3);
  });

  it("links each tab to its own list", () => {
    render(<FilterTabs label="Review status" tabs={TABS} />);

    expect(screen.getByRole("link", { name: "Approved" }).getAttribute("href")).toBe(
      "/admin/reviews?status=APPROVED",
    );
  });

  it("marks the chosen tab as current, and only that one", () => {
    render(<FilterTabs label="Review status" tabs={TABS} />);

    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "true");
    expect(current.map((link) => link.textContent)).toEqual(["Pending"]);
  });

  it("sets the chosen tab apart by weight as well as colour", () => {
    render(<FilterTabs label="Review status" tabs={TABS} />);

    expect(screen.getByRole("link", { name: "Pending" }).className).toContain("font-semibold");
    expect(screen.getByRole("link", { name: "All" }).className).not.toContain("font-semibold");
  });

  it("marks current the same way in the segmented shape", () => {
    render(
      <FilterTabs
        label="Date range"
        variant="segmented"
        tabs={[
          { label: "Today", href: "/admin?range=today", active: false },
          { label: "7 days", href: "/admin?range=7d", active: true },
        ]}
      />,
    );

    const chosen = screen.getByRole("link", { name: "7 days" });
    expect(chosen.getAttribute("aria-current")).toBe("true");
    expect(chosen.className).toContain("font-semibold");
    expect(screen.getByRole("link", { name: "Today" }).getAttribute("aria-current")).toBeNull();
  });
});
