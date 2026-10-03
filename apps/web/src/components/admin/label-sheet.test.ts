import { describe, expect, it } from "vitest";

import {
  DEFAULT_LABEL_SIZE,
  LABEL_SIZE_LIMITS,
  type LabelStatus,
  MAX_QUANTITY,
  type SheetVariant,
  clampQuantity,
  describeLabelStatus,
  mergeSheet,
  parseLabelDimension,
  rowsFromSheet,
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

function sheetVariant(overrides: Partial<SheetVariant> = {}): SheetVariant {
  return {
    ...variant(),
    product: "p1",
    status: "ACTIVE",
    stock: { on_hand: 12, reserved: 0, available: 12 },
    label_status: null,
    suggested_labels: 12,
    ...overrides,
  };
}

function printedStatus(overrides: Partial<LabelStatus> = {}): LabelStatus {
  return {
    printed: true,
    quantity: 12,
    on_hand: 12,
    marked_at: "2026-10-03T08:30:00Z",
    marked_by: "Rahim Uddin",
    received_since: 0,
    ...overrides,
  };
}

describe("the label count on each variant", () => {
  it("starts at what the server suggests: one per unit in stock", () => {
    const [row] = rowsFromSheet([sheetVariant({ suggested_labels: 12 })]);
    expect(row.quantity).toBe(12);
  });

  it("lists every variant, including the ones with nothing to print", () => {
    const rows = rowsFromSheet([
      sheetVariant({ id: "v1", suggested_labels: 3 }),
      sheetVariant({ id: "v2", suggested_labels: 0, stock: null }),
    ]);
    expect(rows.map((row) => [row.variant.id, row.quantity])).toEqual([
      ["v1", 3],
      ["v2", 0],
    ]);
  });

  it("is kept between 0 and the server's ceiling, in whole stickers", () => {
    expect(clampQuantity(-4)).toBe(0);
    expect(clampQuantity(2.7)).toBe(2);
    expect(clampQuantity(Number.NaN)).toBe(0);
    expect(clampQuantity(9999)).toBe(MAX_QUANTITY);
    expect(rowsFromSheet([sheetVariant({ suggested_labels: 9999 })])[0].quantity).toBe(
      MAX_QUANTITY,
    );
  });

  it("says why a barcode that is not an EAN-13 will not print", () => {
    const [row] = rowsFromSheet([sheetVariant({ barcode: "12345678" })]);
    expect(row.error).toMatch(/not a valid EAN-13/);
  });
});

describe("folding the server's answer back into the sheet", () => {
  it("resets the count only on the variants just marked", () => {
    const rows = rowsFromSheet([
      sheetVariant({ id: "v1", suggested_labels: 12 }),
      sheetVariant({ id: "v2", suggested_labels: 4 }),
    ]).map((row) => ({ ...row, quantity: 7 }));

    const merged = mergeSheet(
      rows,
      [
        sheetVariant({ id: "v1", suggested_labels: 0, label_status: printedStatus() }),
        sheetVariant({ id: "v2", suggested_labels: 4 }),
      ],
      new Set(["v1"]),
    );

    // v1 is done: nothing more to print. v2 keeps what the user typed.
    expect(merged.map((row) => row.quantity)).toEqual([0, 7]);
    expect(merged[0].variant.label_status?.printed).toBe(true);
  });

  it("always takes the stock and the ticks from the server", () => {
    const rows = rowsFromSheet([sheetVariant({ id: "v1" })]);

    const [row] = mergeSheet(
      rows,
      [sheetVariant({ id: "v1", stock: { on_hand: 30, reserved: 2, available: 28 } })],
      new Set(),
    );

    expect(row.variant.stock?.on_hand).toBe(30);
  });

  it("keeps a barcode assigned on screen", () => {
    const rows = rowsFromSheet([sheetVariant({ id: "v1", barcode: null })]).map((row) => ({
      ...row,
      barcode: "2000000000015",
    }));

    const [row] = mergeSheet(rows, [sheetVariant({ id: "v1", barcode: null })], new Set());

    expect(row.barcode).toBe("2000000000015");
  });

  it("adds a variant created since the product was put on the sheet", () => {
    const rows = rowsFromSheet([sheetVariant({ id: "v1" })]);

    const merged = mergeSheet(
      rows,
      [sheetVariant({ id: "v1" }), sheetVariant({ id: "v9", suggested_labels: 2 })],
      new Set(["v1"]),
    );

    expect(merged.map((row) => row.variant.id)).toEqual(["v1", "v9"]);
    expect(merged[1].quantity).toBe(2);
  });
});

describe("the line under a variant's tick", () => {
  it("is absent for a variant nobody has marked", () => {
    expect(describeLabelStatus(null)).toBeNull();
  });

  it("says how many were printed, when, and by whom", () => {
    const described = describeLabelStatus(printedStatus());
    expect(described?.summary).toMatch(/^12 printed .*2026.* by Rahim Uddin$/);
    expect(described?.reopened).toBeNull();
  });

  it("says in words when a delivery since needs labels", () => {
    // Words, not just an amber colour (WCAG 1.4.1).
    const described = describeLabelStatus(printedStatus({ received_since: 8 }));
    expect(described?.reopened).toBe("8 more received since — they need labels");
  });

  it("records an un-mark as such", () => {
    const described = describeLabelStatus(printedStatus({ printed: false, quantity: 0 }));
    expect(described?.summary).toMatch(/^Marked not printed /);
    expect(described?.reopened).toBeNull();
  });
});
