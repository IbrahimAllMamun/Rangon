import { describe, expect, it } from "vitest";

import {
  type ChartDraft,
  type SizeChartData,
  type SizeChartOption,
  MAX_COLUMNS,
  addColumn,
  chartPayload,
  chartTitle,
  chartsForProduct,
  draftFromChart,
  groupByAttribute,
  moveColumn,
  removeColumn,
  renameColumn,
  setCell,
  setIncluded,
  validateChartDraft,
} from "./size-chart";

/**
 * The grid's one real danger is alignment: every row holds one figure per
 * column, matched by position. A column added, removed or moved without the
 * same change to every row slides each figure after it under the wrong
 * heading — a chart that still looks right and now answers wrongly.
 */

const SIZES = [
  { id: "s", label: "S" },
  { id: "m", label: "M" },
  { id: "l", label: "L" },
];

function stored(overrides: Partial<SizeChartData> = {}): SizeChartData {
  return {
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
      { attribute_value: "m", value: "M", label: "M", cells: ["97", "38"] },
      { attribute_value: "s", value: "S", label: "S", cells: ["92", "36"] },
    ],
    product_count: 0,
    ...overrides,
  };
}

function cellsOf(draft: ChartDraft) {
  return Object.fromEntries(draft.rows.map((row) => [row.valueId, row.cells]));
}

describe("draftFromChart", () => {
  it("gives every size a row, in the attribute's order, ticking only the stored ones", () => {
    const draft = draftFromChart(stored(), SIZES);

    expect(draft.rows.map((row) => row.valueId)).toEqual(["s", "m", "l"]);
    expect(draft.rows.map((row) => row.included)).toEqual([true, true, false]);
    expect(cellsOf(draft)).toEqual({ s: ["92", "36"], m: ["97", "38"], l: ["", ""] });
  });

  it("starts a new chart with every size ticked and one empty heading", () => {
    const draft = draftFromChart(null, SIZES);

    expect(draft.columns).toEqual([""]);
    expect(draft.rows.every((row) => row.included)).toBe(true);
    expect(draft.rows.every((row) => row.cells.length === 1)).toBe(true);
  });
});

describe("column edits keep every row aligned", () => {
  const draft = draftFromChart(stored(), SIZES);

  it("adds an empty cell to every row", () => {
    const next = addColumn(draft);
    expect(next.columns).toEqual(["Chest (cm)", "UK", ""]);
    expect(cellsOf(next).s).toEqual(["92", "36", ""]);
    expect(next.rows.every((row) => row.cells.length === 3)).toBe(true);
  });

  it("stops at the API's limit", () => {
    let wide = draft;
    for (let i = 0; i < MAX_COLUMNS + 3; i++) wide = addColumn(wide);
    expect(wide.columns).toHaveLength(MAX_COLUMNS);
  });

  it("removes the same cell from every row", () => {
    const next = removeColumn(draft, 0);
    expect(next.columns).toEqual(["UK"]);
    expect(cellsOf(next)).toEqual({ s: ["36"], m: ["38"], l: [""] });
  });

  it("never removes the last column", () => {
    const one = removeColumn(draft, 0);
    expect(removeColumn(one, 0)).toBe(one);
  });

  it("moves each row's figure with its heading", () => {
    const next = moveColumn(draft, 1, "left");
    expect(next.columns).toEqual(["UK", "Chest (cm)"]);
    expect(cellsOf(next).m).toEqual(["38", "97"]);
  });

  it("ignores a move off either end", () => {
    expect(moveColumn(draft, 0, "left")).toBe(draft);
    expect(moveColumn(draft, 1, "right")).toBe(draft);
  });

  it("renames a heading and sets one cell without touching the others", () => {
    const next = setCell(renameColumn(draft, 1, "EU"), "s", 1, "46");
    expect(next.columns).toEqual(["Chest (cm)", "EU"]);
    expect(cellsOf(next)).toEqual({ s: ["92", "46"], m: ["97", "38"], l: ["", ""] });
  });
});

describe("validateChartDraft", () => {
  const valid = draftFromChart(stored(), SIZES);

  it("accepts a complete chart", () => {
    expect(validateChartDraft(valid)).toEqual([]);
  });

  it("needs a name", () => {
    expect(validateChartDraft({ ...valid, name: "  " })[0].field).toBe("chart-name");
  });

  it("needs every heading, and each one different ignoring case", () => {
    const problems = validateChartDraft(renameColumn(addColumn(valid), 2, "uk"));
    expect(problems.map((problem) => problem.field)).toEqual(["chart-column-2"]);
    expect(problems[0].message).toContain("twice");

    const blank = validateChartDraft(renameColumn(valid, 0, " "));
    expect(blank[0].field).toBe("chart-column-0");
  });

  it("needs at least one size", () => {
    let none = valid;
    for (const size of SIZES) none = setIncluded(none, size.id, false);
    expect(validateChartDraft(none).map((problem) => problem.message)).toContain(
      "Include at least one size.",
    );
  });

  it("refuses a ticked size with no figures, and ignores an unticked one", () => {
    const ticked = setIncluded(valid, "l", true);
    const problems = validateChartDraft(ticked);
    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe("chart-cell-l-0");

    // L is unticked in `valid` and empty: nothing to say about it.
    expect(validateChartDraft(valid)).toEqual([]);
  });
});

describe("chartPayload", () => {
  it("sends only ticked sizes, in the attribute's order, trimmed", () => {
    const draft = setCell(draftFromChart(stored({ name: " Men's shirts " }), SIZES), "s", 0, " 92 ");
    expect(chartPayload(draft)).toEqual({
      name: "Men's shirts",
      system: "UK",
      notes: "",
      columns: ["Chest (cm)", "UK"],
      rows: [
        { attribute_value: "s", cells: ["92", "36"] },
        { attribute_value: "m", cells: ["97", "38"] },
      ],
    });
  });
});

describe("chartsForProduct", () => {
  const option = (id: string, code: string, name = code): SizeChartOption => ({
    id,
    name: id,
    system: "",
    attribute_code: code,
    attribute_name: name,
  });
  const CHARTS = [option("shirts", "size", "Size"), option("shoes", "shoe-size", "Shoe size")];

  it("offers only the category's sizes, so a shirt is never offered a shoe chart", () => {
    expect(chartsForProduct(CHARTS, ["size", "color"], [], "").map((c) => c.id)).toEqual([
      "shirts",
    ]);
  });

  it("offers every chart when the category declares nothing", () => {
    expect(chartsForProduct(CHARTS, [], [], "")).toHaveLength(2);
  });

  it("offers an axis the saved variants use, declared or not", () => {
    expect(chartsForProduct(CHARTS, ["color"], ["shoe-size"], "").map((c) => c.id)).toEqual([
      "shoes",
    ]);
  });

  it("keeps the chart the product already has, even when it no longer fits", () => {
    expect(chartsForProduct(CHARTS, ["color"], [], "shoes").map((c) => c.id)).toEqual(["shoes"]);
  });

  it("groups by attribute, and titles a chart with its system when it has one", () => {
    expect(groupByAttribute(CHARTS).map((group) => group.name)).toEqual(["Size", "Shoe size"]);
    expect(chartTitle({ name: "Men's shirts", system: "UK" })).toBe("Men's shirts · UK");
    expect(chartTitle({ name: "Kids", system: "" })).toBe("Kids");
  });
});
