import { describe, expect, it } from "vitest";

import type { MatrixAttribute } from "@/lib/commerce/variant-matrix";

import { axesInUse, declaredAxes, declaredSpecs, resolveVariantAxes } from "./category-attributes";
import type { CategoryAttributeRow } from "./category-attributes";

/**
 * Scoping the variant matrix to the category is a convenience — a merchant
 * editing shoes should not be shown Shade, Volume and Capacity. The two rules
 * below are what stop that convenience becoming a trap, because the variant
 * half of the form is the only control over rows that may hold stock and are
 * referenced by the ledger and by order history.
 */

function axis(code: string, values: string[] = ["one"]): MatrixAttribute {
  return {
    code,
    name: code,
    kind: "TEXT",
    values: values.map((value) => ({ value, label: value, swatch: "" })),
  };
}

function row(code: string, isVariantDefining: boolean): CategoryAttributeRow {
  return {
    id: `id-${code}`,
    code,
    name: code,
    kind: "TEXT",
    is_variant_defining: isVariantDefining,
    is_required: false,
    declared_by: "Shoes",
    values: [],
  };
}

const ALL = [axis("size"), axis("color"), axis("shade"), axis("volume")];

describe("resolveVariantAxes", () => {
  it("offers only what the category declares", () => {
    const offered = resolveVariantAxes(ALL, ["size", "color"], []);

    expect(offered.map((a) => a.code)).toEqual(["size", "color"]);
  });

  it("offers everything when the category declares nothing", () => {
    // Not a cosmetic fallback: the seed wires attributes to leaf categories, so
    // a product filed against "Men" — or any category somebody has just
    // created — would otherwise have no axis at all and could never be given a
    // single variant. That reads as a broken form, not as missing config.
    const offered = resolveVariantAxes(ALL, [], []);

    expect(offered.map((a) => a.code)).toEqual(["size", "color", "shade", "volume"]);
  });

  it("keeps an axis the product already uses even when the category does not declare it", () => {
    // The rule that matters most. Re-filing a product into a category that
    // does not declare Colour must not strand the colours it is already sold
    // in: `buildMatrix` appends those saved rows whatever is ticked, so hiding
    // the fieldset would leave them visible and un-editable.
    const offered = resolveVariantAxes(ALL, ["size"], ["color"]);

    expect(offered.map((a) => a.code)).toEqual(["size", "color"]);
  });

  it("does not duplicate an axis that is both declared and in use", () => {
    const offered = resolveVariantAxes(ALL, ["size", "color"], ["size"]);

    expect(offered.map((a) => a.code)).toEqual(["size", "color"]);
  });

  it("drops an attribute with no values, declared or not", () => {
    // An attribute nobody has given values to cannot generate a combination,
    // and an empty fieldset is a question with no answers.
    const offered = resolveVariantAxes([axis("size"), axis("empty", [])], ["size", "empty"], []);

    expect(offered.map((a) => a.code)).toEqual(["size"]);
  });

  it("never invents an axis the shop does not have", () => {
    // The category may name an attribute this form was not handed — one that
    // stopped being variant-defining, say. It must not appear.
    const offered = resolveVariantAxes([axis("size")], ["size", "ghost"], ["phantom"]);

    expect(offered.map((a) => a.code)).toEqual(["size"]);
  });
});

describe("axesInUse", () => {
  it("collects every attribute the saved variants are built on", () => {
    const variants = [
      { attributes: [{ attribute_code: "size" }, { attribute_code: "color" }] },
      { attributes: [{ attribute_code: "size" }] },
    ];

    expect(axesInUse(variants).sort()).toEqual(["color", "size"]);
  });

  it("is empty for a product with no variants yet", () => {
    expect(axesInUse([])).toEqual([]);
  });
});

describe("splitting the category's answer", () => {
  const rows = [row("size", true), row("material", false), row("color", true)];

  it("takes the variant-defining half as axes", () => {
    expect(declaredAxes(rows)).toEqual(["size", "color"]);
  });

  it("takes the rest as specifications", () => {
    expect(declaredSpecs(rows).map((r) => r.code)).toEqual(["material"]);
  });

  it("treats a missing answer as declaring nothing", () => {
    // `null` is "not loaded yet", which must fall through to the offer-
    // everything rule above rather than to an empty form.
    expect(declaredAxes(null)).toEqual([]);
    expect(declaredSpecs(null)).toEqual([]);
  });
});
