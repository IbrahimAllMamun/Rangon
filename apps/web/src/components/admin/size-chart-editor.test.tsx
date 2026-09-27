/**
 * The size-chart editor's own behaviour. The API owns the rules and
 * tests/api/test_size_charts.py proves them; these cover what lives only here:
 * the grid staying aligned as the columns change, a refusal shown before the
 * round trip, and the API's refusal put beside the control it is about.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SizeChartData } from "@/lib/commerce/size-chart";

import { SizeChartEditor } from "./size-chart-editor";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace, push: () => {} }),
}));

const ATTRIBUTE = { id: "attr-size", name: "Size" };
const SIZES = [
  { id: "s", label: "S" },
  { id: "m", label: "M" },
];

const CHART: SizeChartData = {
  id: "chart-1",
  attribute: "attr-size",
  attribute_code: "size",
  attribute_name: "Size",
  name: "Men's shirts",
  system: "UK",
  columns: ["Chest (cm)", "UK"],
  notes: "",
  position: 0,
  rows: [
    { attribute_value: "s", value: "S", label: "S", cells: ["92", "36"] },
    { attribute_value: "m", value: "M", label: "M", cells: ["97", "38"] },
  ],
  product_count: 0,
};

const field = (id: string) => document.getElementById(id) as HTMLInputElement;

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

describe("SizeChartEditor", () => {
  it("moves every row's figure with its heading", () => {
    render(<SizeChartEditor attribute={ATTRIBUTE} sizes={SIZES} chart={CHART} canManage canDelete />);

    fireEvent.click(screen.getByRole("button", { name: "Move UK left" }));

    expect(field("chart-column-0").value).toBe("UK");
    expect(field("chart-cell-s-0").value).toBe("36");
    expect(field("chart-cell-m-1").value).toBe("97");
  });

  it("refuses a blank heading without asking the server", () => {
    const fetchMock = answer(200, {});
    render(<SizeChartEditor attribute={ATTRIBUTE} sizes={SIZES} chart={CHART} canManage canDelete />);

    fireEvent.click(screen.getByRole("button", { name: /add column/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save chart" }));

    expect(screen.getAllByText("Column 3 needs a heading.").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a chart for its attribute, sending only the ticked sizes", async () => {
    const fetchMock = answer(201, { id: "new-chart" });
    render(<SizeChartEditor attribute={ATTRIBUTE} sizes={SIZES} chart={null} canManage canDelete={false} />);

    fireEvent.change(field("chart-name"), { target: { value: "Kids" } });
    fireEvent.change(field("chart-column-0"), { target: { value: "Height (cm)" } });
    fireEvent.change(field("chart-cell-s-0"), { target: { value: "110–116" } });
    fireEvent.click(field("chart-include-m"));
    fireEvent.click(screen.getByRole("button", { name: "Create chart" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0];
    // Through the same-origin proxy, which owns the trailing slash.
    expect(String(url)).toBe("/api/proxy/size-charts");
    expect(JSON.parse(init.body)).toEqual({
      attribute: "attr-size",
      name: "Kids",
      system: "",
      notes: "",
      columns: ["Height (cm)"],
      rows: [{ attribute_value: "s", cells: ["110–116"] }],
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin/taxonomy/size-charts/new-chart"));
  });

  it("puts the server's refusal beside the field it is about", async () => {
    answer(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Size already has a chart called “Men's shirts”.",
        details: { name: ["Size already has a chart called “Men's shirts”."] },
      },
    });
    render(<SizeChartEditor attribute={ATTRIBUTE} sizes={SIZES} chart={CHART} canManage canDelete />);

    fireEvent.click(screen.getByRole("button", { name: "Save chart" }));

    await waitFor(() =>
      expect(field("chart-name").getAttribute("aria-invalid")).toBe("true"),
    );
  });

  it("will not offer to delete a chart products still use", () => {
    render(
      <SizeChartEditor
        attribute={ATTRIBUTE}
        sizes={SIZES}
        chart={{ ...CHART, product_count: 3 }}
        canManage
        canDelete
      />,
    );

    const button = screen.getByRole("button", { name: /delete chart/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/used by 3 products/i)).toBeTruthy();
  });
});
