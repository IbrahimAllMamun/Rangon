import { describe, expect, it } from "vitest";

import {
  type NewProductDraft,
  axesFor,
  blankDraft,
  toProductPayload,
  toVariantsPayload,
  validateDraft,
} from "./new-product";
import { MAX_MATRIX_ROWS, type MatrixAttribute } from "./variant-matrix";

function draft(partial: Partial<NewProductDraft> = {}): NewProductDraft {
  return {
    ...blankDraft("Linen Shirt"),
    categoryId: "cat-1",
    selections: { size: ["S", "M"] },
    cost: "400.00",
    ...partial,
  };
}

function attribute(code: string, values: string[]): MatrixAttribute {
  return {
    code,
    name: code,
    kind: "TEXT",
    values: values.map((value) => ({ value, label: value, swatch: "" })),
  };
}

describe("validateDraft", () => {
  it("accepts a complete draft with no retail price", () => {
    // The point of the whole design: a buyer knows the cost, not the price.
    expect(validateDraft(draft({ price: "" }))).toEqual([]);
  });

  it("requires a name, a category and a cost", () => {
    const problems = validateDraft(
      draft({ name: "  ", categoryId: "", cost: "", selections: { size: ["S"] } }),
    );
    expect(problems.map((p) => p.field).sort()).toEqual(["category", "cost", "name"]);
  });

  it("requires at least one ticked value", () => {
    const problems = validateDraft(draft({ selections: {} }));
    expect(problems.map((p) => p.field)).toContain("selections");
  });

  it("refuses a selection that would generate thousands of SKUs", () => {
    const many = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const problems = validateDraft(
      draft({ selections: { size: many, color: many } }), // 900 rows
    );
    const message = problems.find((p) => p.field === "selections")?.message ?? "";
    expect(message).toContain(String(MAX_MATRIX_ROWS));
  });

  it("rejects a negative or nonsense cost, and a nonsense price", () => {
    expect(validateDraft(draft({ cost: "-5" })).map((p) => p.field)).toContain("cost");
    expect(validateDraft(draft({ cost: "abc" })).map((p) => p.field)).toContain("cost");
    expect(validateDraft(draft({ price: "-1" })).map((p) => p.field)).toContain("price");
    // Blank is the documented "not decided yet", not an error.
    expect(validateDraft(draft({ price: "" })).map((p) => p.field)).not.toContain("price");
  });
});

describe("toProductPayload", () => {
  it("creates a draft, never a published product", () => {
    // Goods on order are not sellable, and nothing here has a photo or a price.
    expect(toProductPayload(draft())).toMatchObject({ status: "DRAFT" });
  });

  it("trims the name and sends no brand rather than an empty string", () => {
    expect(toProductPayload(draft({ name: "  Linen Shirt  ", brandId: "" }))).toMatchObject({
      name: "Linen Shirt",
      brand: null,
    });
  });
});

describe("toVariantsPayload", () => {
  it("sends a blank price as zero, which the draft state makes safe", () => {
    expect(toVariantsPayload(draft({ price: "" }))).toMatchObject({ price: "0.00" });
  });

  it("passes a stated price through untouched", () => {
    expect(toVariantsPayload(draft({ price: "1290.00" }))).toMatchObject({ price: "1290.00" });
  });

  it("drops axes with nothing ticked", () => {
    // An empty list would make `generate_variants` raise "No matching values".
    const payload = toVariantsPayload(draft({ selections: { size: ["S"], color: [] } }));
    expect(payload.selections).toEqual({ size: ["S"] });
  });
});

describe("axesFor", () => {
  const all = [attribute("size", ["S", "M"]), attribute("color", ["Black"]), attribute("empty", [])];

  it("offers only what the category declares", () => {
    expect(axesFor(all, ["size"]).map((a) => a.code)).toEqual(["size"]);
  });

  it("offers every usable axis when the category declares none", () => {
    // Narrowing is a convenience; a buyer who cannot build a variant has a
    // worse problem than a long list.
    expect(axesFor(all, []).map((a) => a.code)).toEqual(["size", "color"]);
  });

  it("never offers an axis with no values to tick", () => {
    expect(axesFor(all, ["empty"]).map((a) => a.code)).toEqual([]);
  });
});
