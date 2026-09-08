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
  it("every layout is wide enough for the symbol once its padding is taken out", () => {
    // An EAN-13 with its quiet zones is 113 modules. A label narrower than the
    // symbol does not fail loudly — it clips the quiet zone, and the label
    // simply stops scanning. The padding is real width the symbol cannot use,
    // so it counts against the budget: widening it is exactly how a previously
    // fine layout would start clipping.
    for (const layout of LAYOUTS) {
      const symbolMm = 113 * layout.moduleMm;
      const usableMm = layout.widthMm - layout.paddingXMm * 2;
      expect(
        symbolMm,
        `${layout.id}: symbol is ${symbolMm.toFixed(1)}mm in ${usableMm.toFixed(1)}mm of usable width`,
      ).toBeLessThanOrEqual(usableMm);
    }
  });

  it("every layout leaves room for the bars and the text under them", () => {
    for (const layout of LAYOUTS) {
      // Bars, plus the rows the reference layout stacks: the shop heading, the
      // number, and three detail lines. Points to millimetres is 25.4/72;
      // line-height is folded in generously.
      //
      // Three, not four, even though the brand is now a detail line too: on the
      // 21.2mm stock a fourth line does not fit, which is why every field is
      // toggled independently and the label clips rather than reflowing.
      const pt = 25.4 / 72;
      const text = (layout.headingPt + layout.numberPt + layout.detailPt * 3) * pt * 1.3;
      const needed = layout.barHeightMm + text + layout.paddingYMm * 2;
      expect(
        needed,
        `${layout.id}: needs ${needed.toFixed(1)}mm on a ${layout.heightMm}mm label`,
      ).toBeLessThanOrEqual(layout.heightMm);
    }
  });

  it("puts a visible gutter between two neighbouring symbols", () => {
    // Labels butt up against each other, so the white space a reader sees
    // between one barcode and the next is two lots of padding. Below about 3mm
    // a row of labels reads as one continuous block of bars — the complaint
    // this padding exists to answer.
    for (const layout of LAYOUTS.filter((entry) => entry.columns > 1)) {
      const gutterMm = layout.paddingXMm * 2;
      expect(gutterMm, `${layout.id}: only ${gutterMm}mm between symbols`).toBeGreaterThanOrEqual(3);
    }
  });

  it("has a unique id per layout, since the id selects the preset", () => {
    expect(new Set(LAYOUTS.map((entry) => entry.id)).size).toBe(LAYOUTS.length);
  });
});
