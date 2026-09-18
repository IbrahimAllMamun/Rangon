import { describe, expect, it } from "vitest";

import { vatNote, vatRatePercent } from "./vat";

describe("vatRatePercent", () => {
  it("turns the stored fraction into a percentage", () => {
    expect(vatRatePercent("0.1500")).toBe(15);
    expect(vatRatePercent("0.0750")).toBe(7.5);
  });

  it("is zero for no rate, a bad rate, or a negative one", () => {
    expect(vatRatePercent("0.0000")).toBe(0);
    expect(vatRatePercent(null)).toBe(0);
    expect(vatRatePercent("nonsense")).toBe(0);
    expect(vatRatePercent("-0.15")).toBe(0);
  });
});

describe("vatNote", () => {
  it("says the tax is still to come when it is added at checkout", () => {
    expect(vatNote({ mode: "EXCLUSIVE", rate: "0.1500" })).toBe("+ 15% VAT");
  });

  it("says the price is the price when the tax is already inside it", () => {
    expect(vatNote({ mode: "INCLUSIVE", rate: "0.1500" })).toBe("incl. 15% VAT");
  });

  it("says nothing at the rate the platform ships with", () => {
    // default_tax_rate is 0.0000 until the owner settles it, and a note
    // reading "+ 0% VAT" would be noise on every price in the shop.
    expect(vatNote({ mode: "EXCLUSIVE", rate: "0.0000" })).toBeNull();
    expect(vatNote({ mode: "INCLUSIVE", rate: "0.0000" })).toBeNull();
  });

  it("says nothing when the payload predates the field", () => {
    expect(vatNote(undefined)).toBeNull();
    expect(vatNote(null)).toBeNull();
  });

  it("does not render a whole rate with decimals", () => {
    expect(vatNote({ mode: "EXCLUSIVE", rate: "0.1500" })).not.toContain("15.0");
  });
});
