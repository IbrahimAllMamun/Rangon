import { describe, expect, it } from "vitest";

import { memoShowsVat } from "./memo";

describe("memoShowsVat", () => {
  it("is false at the rate the platform ships with", () => {
    // default_tax_rate is 0.0000 until the owner settles it.
    expect(memoShowsVat({ tax_total: "0.00" })).toBe(false);
  });

  it("is true once the sale actually charged VAT", () => {
    expect(memoShowsVat({ tax_total: "150.00" })).toBe(true);
  });

  it("treats a missing total as no VAT rather than throwing", () => {
    expect(memoShowsVat({ tax_total: null })).toBe(false);
    expect(memoShowsVat({ tax_total: undefined })).toBe(false);
  });

  it("accepts a number as well as the API's string", () => {
    expect(memoShowsVat({ tax_total: 0 })).toBe(false);
    expect(memoShowsVat({ tax_total: 12.5 })).toBe(true);
  });
});
