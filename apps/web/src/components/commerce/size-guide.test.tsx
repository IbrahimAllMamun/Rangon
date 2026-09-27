/**
 * The storefront size guide: a dialog opened from beside the size options.
 * Radix owns the focus trap; these check what the page itself promises — the
 * chart as the API sent it, the shopper's pick marked in words as well as
 * colour, and the notes when there are any.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import type { ShopSizeChart } from "@/lib/api/types";

import { SizeGuide } from "./size-guide";

const CHART: ShopSizeChart = {
  name: "Men's tops",
  system: "International",
  attribute_code: "size",
  attribute_name: "Size",
  columns: ["Chest (cm)", "UK / US"],
  rows: [
    { value: "S", label: "S", cells: ["92–96", "36"] },
    { value: "M", label: "Medium", cells: ["97–101", ""] },
  ],
  notes: "Measure under the arms.",
};

function open(selectedValue?: string, chart: ShopSizeChart = CHART) {
  render(<SizeGuide chart={chart} selectedValue={selectedValue} productName="Oxford shirt" />);
  fireEvent.click(screen.getByRole("button", { name: /size guide/i }));
  return screen.getByRole("dialog");
}

describe("SizeGuide", () => {
  it("opens a dialog titled with the chart and its sizing system", () => {
    const dialog = open();
    expect(within(dialog).getByRole("heading", { name: "Size guide" })).toBeTruthy();
    expect(within(dialog).getByText("Men's tops · International sizing")).toBeTruthy();
  });

  it("renders every size as a labelled row, in the order sent", () => {
    const dialog = open();
    const headers = within(dialog).getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["S", "Medium"]);
    const columns = within(dialog).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(columns).toEqual(["Size", "Chest (cm)", "UK / US"]);
  });

  it("marks the picked size in words, not only in colour", () => {
    const dialog = open("M");
    const row = within(dialog).getByRole("rowheader", { name: /Medium/ });
    expect(row.textContent).toContain("Selected");
    expect(within(dialog).getAllByText("Selected")).toHaveLength(1);
  });

  it("shows a dash for a blank figure rather than an empty cell", () => {
    const dialog = open();
    expect(within(dialog).getByText("—")).toBeTruthy();
  });

  it("shows the notes only when there are some", () => {
    expect(within(open()).getByText("Measure under the arms.")).toBeTruthy();
  });

  it("leaves the notes heading out when the chart has none", () => {
    const dialog = open(undefined, { ...CHART, notes: "" });
    expect(within(dialog).queryByText("How to measure")).toBeNull();
  });
});
