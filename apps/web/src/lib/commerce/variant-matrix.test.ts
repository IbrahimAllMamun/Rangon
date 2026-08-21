import { describe, expect, it } from "vitest";

import {
  type ExistingVariant,
  type MatrixAttribute,
  MAX_MATRIX_ROWS,
  buildMatrix,
  combinationKey,
  matrixSize,
  pendingSelections,
  selectionsFromVariants,
} from "./variant-matrix";

const ATTRIBUTES: MatrixAttribute[] = [
  {
    code: "color",
    name: "Colour",
    kind: "COLOR",
    values: [
      { value: "Black", label: "Black", swatch: "#111111" },
      { value: "White", label: "White", swatch: "#FFFFFF" },
    ],
  },
  {
    code: "size",
    name: "Size",
    kind: "SIZE",
    values: [
      { value: "S", label: "Small", swatch: "" },
      { value: "M", label: "Medium", swatch: "" },
    ],
  },
];

function variant(id: string, pairs: Record<string, string>, extra: Partial<ExistingVariant> = {}) {
  return {
    id,
    sku: `SKU-${id}`,
    barcode: null,
    name: Object.values(pairs).join(" / "),
    price: "1000.00",
    compare_at_price: null,
    cost: "600.00",
    status: "ACTIVE",
    attributes: Object.entries(pairs).map(([code, value]) => ({
      attribute_code: code,
      attribute_name: code,
      value,
      label: value,
      swatch: "",
    })),
    stock: null,
    ...extra,
  } satisfies ExistingVariant;
}

describe("combinationKey", () => {
  it("is independent of the order the attributes were added in", () => {
    expect(combinationKey({ color: "Black", size: "S" })).toBe(
      combinationKey({ size: "S", color: "Black" }),
    );
  });
});

describe("matrixSize", () => {
  it("multiplies the ticked values", () => {
    expect(matrixSize({ color: ["Black", "White"], size: ["S", "M", "L"] })).toBe(6);
  });

  it("ignores attributes with nothing ticked", () => {
    expect(matrixSize({ color: ["Black"], size: [] })).toBe(1);
  });

  it("is zero when nothing is ticked at all", () => {
    expect(matrixSize({})).toBe(0);
    expect(matrixSize({ color: [] })).toBe(0);
  });
});

describe("buildMatrix", () => {
  it("produces the cartesian product of the ticked values", () => {
    const rows = buildMatrix(
      { color: ["Black", "White"], size: ["S", "M"] },
      ATTRIBUTES,
      [],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.state === "new")).toBe(true);
    // First attribute varies slowest, so the table reads Black, Black, White, White.
    expect(rows.map((row) => row.combination.color)).toEqual([
      "Black",
      "Black",
      "White",
      "White",
    ]);
  });

  it("resolves labels from the attribute definition", () => {
    const [row] = buildMatrix({ size: ["S"] }, ATTRIBUTES, []);
    expect(row.labels.size).toBe("Small");
  });

  it("matches a saved variant to its combination", () => {
    const saved = variant("v1", { color: "Black", size: "S" });
    const rows = buildMatrix({ color: ["Black"], size: ["S", "M"] }, ATTRIBUTES, [saved]);

    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("existing");
    expect(rows[0].existing?.id).toBe("v1");
    expect(rows[1].state).toBe("new");
    expect(rows[1].existing).toBeNull();
  });

  it("keeps a saved variant whose value was un-ticked, flagged rather than dropped", () => {
    const black = variant("v1", { color: "Black", size: "S" });
    const white = variant("v2", { color: "White", size: "S" });

    // White is un-ticked. Its row must survive: it may hold stock or sales.
    const rows = buildMatrix({ color: ["Black"], size: ["S"] }, ATTRIBUTES, [black, white]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: "existing", existing: { id: "v1" } });
    expect(rows[1]).toMatchObject({ state: "unselected", existing: { id: "v2" } });
  });

  it("never collapses two saved variants onto one row when an axis is dropped", () => {
    // Size is un-ticked entirely. Both saved rows carry a size, so both are
    // 'unselected' — neither may vanish from the table.
    const small = variant("v1", { color: "Black", size: "S" });
    const medium = variant("v2", { color: "Black", size: "M" });

    const rows = buildMatrix({ color: ["Black"] }, ATTRIBUTES, [small, medium]);

    const ids = rows.map((row) => row.existing?.id ?? null);
    expect(ids).toContain("v1");
    expect(ids).toContain("v2");
    expect(rows.filter((row) => row.state === "unselected")).toHaveLength(2);
    // Plus the new colour-only combination the ticks now describe.
    expect(rows.filter((row) => row.state === "new")).toHaveLength(1);
  });

  it("lists every saved variant when nothing is ticked", () => {
    const saved = variant("v1", { color: "Black", size: "S" });
    const rows = buildMatrix({}, ATTRIBUTES, [saved]);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("unselected");
  });

  it("caps a runaway product instead of generating thousands of rows", () => {
    const many = Array.from({ length: 40 }, (_, index) => `v${index}`);
    const rows = buildMatrix(
      { color: many, size: many },
      [
        { code: "color", name: "Colour", kind: "TEXT", values: [] },
        { code: "size", name: "Size", kind: "TEXT", values: [] },
      ],
      [],
    );
    expect(matrixSize({ color: many, size: many })).toBe(1600);
    expect(rows.length).toBeLessThanOrEqual(MAX_MATRIX_ROWS);
  });

  it("gives every row a distinct key", () => {
    const rows = buildMatrix(
      { color: ["Black", "White"], size: ["S", "M"] },
      ATTRIBUTES,
      [variant("v9", { color: "Red", size: "XL" })],
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("pendingSelections", () => {
  it("asks for only the values the unsaved rows need", () => {
    const saved = variant("v1", { color: "Black", size: "S" });
    const rows = buildMatrix({ color: ["Black"], size: ["S", "M"] }, ATTRIBUTES, [saved]);

    expect(pendingSelections(rows)).toEqual({ color: ["Black"], size: ["M"] });
  });

  it("is empty when every ticked combination already exists", () => {
    const saved = variant("v1", { color: "Black", size: "S" });
    const rows = buildMatrix({ color: ["Black"], size: ["S"] }, ATTRIBUTES, [saved]);

    expect(pendingSelections(rows)).toEqual({});
  });

  it("never asks for a combination outside the ticked set", () => {
    // Black/S and White/M exist; Black/M and White/S do not. The union sent to
    // the API is the full 2x2, but every cell of it was ticked, and the service
    // skips the two that already exist.
    const rows = buildMatrix({ color: ["Black", "White"], size: ["S", "M"] }, ATTRIBUTES, [
      variant("v1", { color: "Black", size: "S" }),
      variant("v2", { color: "White", size: "M" }),
    ]);
    const asked = pendingSelections(rows);

    for (const [code, values] of Object.entries(asked)) {
      const ticked = code === "color" ? ["Black", "White"] : ["S", "M"];
      expect(values.every((value) => ticked.includes(value))).toBe(true);
    }
  });
});

describe("selectionsFromVariants", () => {
  it("ticks every value the saved variants already use", () => {
    const selections = selectionsFromVariants([
      variant("v1", { color: "Black", size: "S" }),
      variant("v2", { color: "White", size: "S" }),
    ]);
    expect(selections).toEqual({ color: ["Black", "White"], size: ["S"] });
  });

  it("is empty for a product with no variants", () => {
    expect(selectionsFromVariants([])).toEqual({});
  });
});
