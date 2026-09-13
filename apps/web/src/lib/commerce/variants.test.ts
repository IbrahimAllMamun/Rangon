import { describe, expect, it } from "vitest";

import type { ShopVariant } from "@/lib/api/types";

import { resolveVariant } from "./variants";

/**
 * The distinction this file exists for: "sold out" and "not in that
 * combination" are different facts, and only one of them is worth a shopper
 * waiting for. `resolveVariant` reports which, so the buy panel can say so.
 */

function variant(
  sku: string,
  colour: string,
  size: string,
  inStock: boolean,
): ShopVariant {
  return {
    id: sku,
    sku,
    label: `${colour} / ${size}`,
    price: "1000.00",
    compare_at_price: null,
    available: inStock ? 5 : 0,
    in_stock: inStock,
    attributes: {
      color: { value: colour, label: colour, swatch: "" },
      size: { value: size, label: size, swatch: "" },
    },
  } as ShopVariant;
}

// Navy comes in S and M; Olive only in S. Nothing is made in L at all.
const NAVY_S = variant("NAVY-S", "Navy", "S", true);
const NAVY_M = variant("NAVY-M", "Navy", "M", false); // exists, sold out
const OLIVE_S = variant("OLIVE-S", "Olive", "S", true);
const VARIANTS = [NAVY_S, NAVY_M, OLIVE_S];

describe("resolveVariant", () => {
  it("keeps the other axes when the combination exists", () => {
    const match = resolveVariant(VARIANTS, NAVY_S, "size", "M");

    expect(match.exact).toBe(true);
    expect(match.variant).toBe(NAVY_M);
  });

  it("reports a combination that exists but has no stock as exact", () => {
    // Exact plus out of stock is `soldOut`: worth telling the shopper, because
    // it may come back. The panel must not confuse it with the case below.
    const match = resolveVariant(VARIANTS, NAVY_S, "size", "M");

    expect(match.exact).toBe(true);
    expect(match.variant?.in_stock).toBe(false);
  });

  it("flags a fallback when the value exists only in another combination", () => {
    // Olive has no M. Choosing M from Olive has to move the colour, and the
    // shopper deserves to be told that rather than shown a dead control.
    const match = resolveVariant(VARIANTS, OLIVE_S, "size", "M");

    expect(match.exact).toBe(false);
    expect(match.variant).toBe(NAVY_M);
  });

  it("prefers an in-stock fallback over the first row that matches", () => {
    // Olive has no L, so choosing L from Olive must fall back. Navy/L comes
    // first in the list and is sold out; Rust/L is buyable. Landing on the
    // buyable one is the whole point of the fallback.
    const navyL = variant("NAVY-L", "Navy", "L", false);
    const rustL = variant("RUST-L", "Rust", "L", true);

    const match = resolveVariant([...VARIANTS, navyL, rustL], OLIVE_S, "size", "L");

    expect(match.exact).toBe(false);
    expect(match.variant).toBe(rustL);
  });

  it("returns nothing when no variant carries the value at all", () => {
    const match = resolveVariant(VARIANTS, NAVY_S, "size", "XXL");

    expect(match.variant).toBeUndefined();
    // `dead` is the only state the panel disables, so this is the one case
    // that must not be confused with a repairable one.
    expect(match.exact).toBe(false);
  });

  it("treats every value as exact before anything is chosen", () => {
    const match = resolveVariant(VARIANTS, null, "size", "M");

    expect(match.exact).toBe(true);
    expect(match.variant).toBe(NAVY_M);
  });
});
