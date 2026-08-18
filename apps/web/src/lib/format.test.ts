import { describe, expect, it } from "vitest";

import { dateOnly, humanise, money, moneyCompact, percent } from "./format";

describe("money", () => {
  it("formats the taka symbol and thousands separators", () => {
    expect(money("1290")).toBe("৳ 1,290.00");
    expect(money(1290.5)).toBe("৳ 1,290.50");
  });

  it("takes the string the API sends without losing precision", () => {
    // Money crosses the wire as a string precisely so this cannot drift.
    expect(money("1234567.89")).toBe("৳ 1,234,567.89");
  });

  it("can omit the symbol for table columns", () => {
    expect(money("1290", false)).toBe("1,290.00");
  });

  it("survives null, undefined and nonsense", () => {
    expect(money(null)).toBe("৳ 0.00");
    expect(money(undefined)).toBe("৳ 0.00");
    expect(money("")).toBe("৳ 0.00");
    expect(money("not-a-number")).toBe("৳ 0.00");
  });

  it("always shows two decimal places", () => {
    expect(money("5")).toBe("৳ 5.00");
    expect(money("0")).toBe("৳ 0.00");
  });
});

describe("moneyCompact", () => {
  it("uses lakh, the way Bangladesh reads large numbers", () => {
    expect(moneyCompact(250000)).toBe("৳ 2.50L");
  });

  it("uses k for thousands", () => {
    expect(moneyCompact(12500)).toBe("৳ 12.5k");
  });

  it("leaves small amounts alone", () => {
    expect(moneyCompact(750)).toBe("৳ 750");
  });
});

describe("humanise", () => {
  it("turns an enum value into a sentence", () => {
    expect(humanise("RETURN_REQUESTED")).toBe("Return requested");
    expect(humanise("PAID")).toBe("Paid");
  });

  it("renders an em dash for nothing", () => {
    expect(humanise(null)).toBe("—");
    expect(humanise("")).toBe("—");
  });
});

describe("percent", () => {
  it("formats to one decimal by default", () => {
    expect(percent("42.567")).toBe("42.6%");
    expect(percent(null)).toBe("0%");
  });
});

describe("dateOnly", () => {
  it("formats as a Bangladeshi reader expects", () => {
    expect(dateOnly("2026-08-17T10:30:00Z")).toBe("17 Aug 2026");
  });

  it("renders an em dash for nothing", () => {
    expect(dateOnly(null)).toBe("—");
  });
});
