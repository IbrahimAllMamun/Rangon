import { describe, expect, it } from "vitest";

import { ORDER_NUMBER, canReturn, defaultDecision, returnLines } from "./returns";

const lines = [
  { id: "a", returnable_quantity: 2 },
  { id: "b", returnable_quantity: 1 },
  { id: "c", returnable_quantity: 0 },
];

describe("the lines a return asks for", () => {
  it("sends only lines with something chosen", () => {
    expect(
      returnLines(lines, { a: { quantity: 1, decision: "RESTOCK" }, b: { quantity: 0, decision: "DAMAGED" } }),
    ).toEqual([{ order_item: "a", quantity: 1, restock_decision: "RESTOCK" }]);
  });

  it("never asks for more than can still come back", () => {
    expect(returnLines(lines, { a: { quantity: 5, decision: "DAMAGED" } })).toEqual([
      { order_item: "a", quantity: 2, restock_decision: "DAMAGED" },
    ]);
    expect(returnLines(lines, { c: { quantity: 1, decision: "RESTOCK" } })).toEqual([]);
  });

  it("drops a quantity that is not a whole number above nothing", () => {
    expect(
      returnLines(lines, {
        a: { quantity: Number.NaN, decision: "RESTOCK" },
        b: { quantity: 0.5, decision: "RESTOCK" },
      }),
    ).toEqual([]);
  });
});

describe("what a return starts from", () => {
  it("suggests the supplier for the shop's faults and the shelf otherwise", () => {
    expect(defaultDecision("DEFECTIVE")).toBe("DAMAGED");
    expect(defaultDecision("DAMAGED")).toBe("DAMAGED");
    expect(defaultDecision("WRONG_SIZE")).toBe("RESTOCK");
    expect(defaultDecision("CUSTOMER_CHANGED_MIND")).toBe("RESTOCK");
  });

  it("allows a return once the goods have left, and while any can come back", () => {
    expect(canReturn({ status: "DELIVERED", items: lines })).toBe(true);
    expect(canReturn({ status: "PACKED", items: lines })).toBe(false);
    expect(canReturn({ status: "DELIVERED", items: [lines[2]!] })).toBe(false);
  });

  it("recognises a receipt's order number", () => {
    expect(ORDER_NUMBER.test("RGN-POS-000123")).toBe(true);
    expect(ORDER_NUMBER.test("rgn-web-17")).toBe(true);
    expect(ORDER_NUMBER.test("RGN-CHI-L-9")).toBe(false);
  });
});
