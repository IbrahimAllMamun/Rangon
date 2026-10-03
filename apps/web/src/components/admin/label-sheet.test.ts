import { describe, expect, it } from "vitest";

import {
  DEFAULT_LABEL_SIZE,
  LABEL_SIZE_LIMITS,
  parseLabelDimension,
  thermalLayout,
  variantLines,
} from "./label-sheet";
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

/** The default roll, both limits, and sizes in between, including lopsided ones. */
const SIZES: Array<[number, number]> = [
  [DEFAULT_LABEL_SIZE.widthMm, DEFAULT_LABEL_SIZE.heightMm],
  [LABEL_SIZE_LIMITS.widthMm.min, LABEL_SIZE_LIMITS.heightMm.min],
  [LABEL_SIZE_LIMITS.widthMm.max, LABEL_SIZE_LIMITS.heightMm.max],
  [LABEL_SIZE_LIMITS.widthMm.min, LABEL_SIZE_LIMITS.heightMm.max],
  [LABEL_SIZE_LIMITS.widthMm.max, LABEL_SIZE_LIMITS.heightMm.min],
  [50, 25],
  [40, 30],
  [38.1, 21.2],
];

describe("the thermal sticker layout", () => {
  it("defaults to the 38 x 25 mm roll", () => {
    expect(DEFAULT_LABEL_SIZE).toEqual({ widthMm: 38, heightMm: 25 });
    const layout = thermalLayout(38, 25);
    expect(layout.widthMm).toBe(38);
    expect(layout.heightMm).toBe(25);
  });

  it("is wide enough for the symbol once its padding is taken out, at every size", () => {
    // An EAN-13 with its quiet zones is 113 modules. A label narrower than the
    // symbol does not fail loudly — it clips the quiet zone, and the label
    // simply stops scanning. The padding is real width the symbol cannot use,
    // so it counts against the budget.
    for (const [width, height] of SIZES) {
      const layout = thermalLayout(width, height);
      const symbolMm = 113 * layout.moduleMm;
      const usableMm = layout.widthMm - layout.paddingXMm * 2;
      expect(
        symbolMm,
        `${width}x${height}: symbol is ${symbolMm.toFixed(1)}mm in ${usableMm.toFixed(1)}mm of usable width`,
      ).toBeLessThanOrEqual(usableMm);
    }
  });

  it("never shrinks the bars below a scannable module", () => {
    // 0.264 mm is 80% of nominal; below it scanners start to miss. The width
    // floor on the size field exists so this never has to give.
    for (const [width, height] of SIZES) {
      const { moduleMm } = thermalLayout(width, height);
      expect(moduleMm, `${width}x${height}`).toBeGreaterThanOrEqual(0.264);
      expect(moduleMm, `${width}x${height}`).toBeLessThanOrEqual(0.33);
    }
  });

  it("leaves room for the bars and the text under them, at every size", () => {
    for (const [width, height] of SIZES) {
      const layout = thermalLayout(width, height);
      // Bars, plus the rows the reference layout stacks: the shop heading, the
      // number, and three detail lines. Points to millimetres is 25.4/72;
      // line-height is folded in generously.
      // The two gaps either side of the bars count against the same height.
      const pt = 25.4 / 72;
      const text = (layout.headingPt + layout.numberPt + layout.detailPt * 3) * pt * 1.3;
      const needed = layout.barHeightMm + text + layout.gapMm * 2 + layout.paddingYMm * 2;
      expect(
        needed,
        `${width}x${height}: needs ${needed.toFixed(1)}mm on a ${height}mm sticker`,
      ).toBeLessThanOrEqual(layout.heightMm);
    }
  });

  it("separates the bars from the shop name above and the number below", () => {
    for (const [width, height] of SIZES) {
      expect(thermalLayout(width, height).gapMm, `${width}x${height}`).toBeGreaterThan(0);
    }
  });

  it("makes a lone price larger than the barcode number", () => {
    // With no details beside it the price is the one thing a customer reads.
    for (const [width, height] of SIZES) {
      const layout = thermalLayout(width, height);
      expect(layout.soloPricePt, `${width}x${height}`).toBeGreaterThan(layout.numberPt);
      expect(layout.soloPricePt, `${width}x${height}`).toBeGreaterThan(layout.pricePt);
    }
  });

  it("fits the lone price, its height and its width, at every size", () => {
    for (const [width, height] of SIZES) {
      const layout = thermalLayout(width, height);
      const pt = 25.4 / 72;
      const text = (layout.headingPt + layout.numberPt + layout.soloPricePt) * pt * 1.3;
      const needed = layout.barHeightMm + text + layout.gapMm * 3 + layout.paddingYMm * 2;
      expect(
        needed,
        `${width}x${height}: needs ${needed.toFixed(1)}mm on a ${height}mm sticker`,
      ).toBeLessThanOrEqual(layout.heightMm);

      // "৳ 999,999.00" — twelve characters at about 0.62em each in bold
      // figures. A wider price would clip at the sticker's edge.
      const priceMm = 12 * 0.62 * layout.soloPricePt * pt;
      const usableMm = layout.widthMm - layout.paddingXMm * 2;
      expect(
        priceMm,
        `${width}x${height}: price is ${priceMm.toFixed(1)}mm in ${usableMm.toFixed(1)}mm`,
      ).toBeLessThanOrEqual(usableMm);
    }
  });
});

describe("the sticker size fields", () => {
  const limits = LABEL_SIZE_LIMITS.widthMm;

  it("accepts millimetres inside the limits, decimals included", () => {
    expect(parseLabelDimension("38", limits)).toEqual({ value: 38, error: null });
    expect(parseLabelDimension(" 38.5 ", limits)).toEqual({ value: 38.5, error: null });
    expect(parseLabelDimension(String(limits.min), limits).value).toBe(limits.min);
    expect(parseLabelDimension(String(limits.max), limits).value).toBe(limits.max);
  });

  it("refuses an empty or non-numeric field", () => {
    expect(parseLabelDimension("", limits).value).toBeNull();
    expect(parseLabelDimension("abc", limits).value).toBeNull();
  });

  it("refuses a size outside the limits, saying what they are", () => {
    const narrow = parseLabelDimension("30", limits);
    expect(narrow.value).toBeNull();
    expect(narrow.error).toBe(`Between ${limits.min} and ${limits.max} mm.`);
    expect(parseLabelDimension("101", limits).value).toBeNull();
  });
});
