import { describe, expect, it } from "vitest";

import { LAYOUTS, variantLines } from "./label-sheet";
import type { PickableVariant } from "@/components/admin/variant-picker";

function variant(overrides: Partial<PickableVariant> = {}): PickableVariant {
  return {
    id: "v1",
    sku: "TSH-M-BLK",
    barcode: "2000000000015",
    product_name: "T-shirt SS 2022",
    label: "M / Black",
    price: "1099.00",
    cost: "400.00",
    ...overrides,
  };
}

describe("the variant lines on a label", () => {
  it("gives each attribute its own line, named", () => {
    // "Size M" and "Colour Black", not "M / Black": whoever is holding the
    // garment has to know which value is which.
    expect(
      variantLines(
        variant({
          attributes: [
            { attribute_name: "Size", label: "M" },
            { attribute_name: "Colour", label: "Black" },
          ],
        }),
      ),
    ).toEqual(["Size M", "Colour Black"]);
  });

  it("falls back to the joined label when attributes did not come down", () => {
    expect(variantLines(variant({ attributes: undefined }))).toEqual(["M / Black"]);
    expect(variantLines(variant({ attributes: [] }))).toEqual(["M / Black"]);
  });

  it("prints nothing rather than an empty line for a variant with neither", () => {
    expect(variantLines(variant({ attributes: [], label: "" }))).toEqual([]);
  });

  it("does not split a value that itself contains a slash", () => {
    // The reason the joined label cannot simply be split on "/". A colour
    // called "Black/White" is one attribute, not two.
    expect(
      variantLines(variant({ attributes: [{ attribute_name: "Colour", label: "Black/White" }] })),
    ).toEqual(["Colour Black/White"]);
  });
});

describe("the label stock presets", () => {
  it("every layout is wide enough for the symbol it will draw", () => {
    // An EAN-13 with its quiet zones is 113 modules. A label narrower than the
    // symbol does not fail loudly — it clips the quiet zone, and the label
    // simply stops scanning.
    for (const layout of LAYOUTS) {
      const symbolMm = 113 * layout.moduleMm;
      expect(
        symbolMm,
        `${layout.id}: symbol is ${symbolMm.toFixed(1)}mm on a ${layout.widthMm}mm label`,
      ).toBeLessThanOrEqual(layout.widthMm);
    }
  });

  it("every layout leaves room for the bars and the text under them", () => {
    for (const layout of LAYOUTS) {
      // Bars, plus the four text rows the reference layout stacks: brand,
      // number, and at least two detail lines. Points to millimetres is
      // 25.4/72; line-height and padding are folded in generously.
      const pt = 25.4 / 72;
      const text =
        (layout.brandPt + layout.numberPt + layout.detailPt * 3) * pt * 1.3 + 1.6;
      const needed = layout.barHeightMm + text;
      expect(
        needed,
        `${layout.id}: needs ${needed.toFixed(1)}mm on a ${layout.heightMm}mm label`,
      ).toBeLessThanOrEqual(layout.heightMm);
    }
  });

  it("has a unique id per layout, since the id selects the preset", () => {
    expect(new Set(LAYOUTS.map((entry) => entry.id)).size).toBe(LAYOUTS.length);
  });
});
