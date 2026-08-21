import { describe, expect, it } from "vitest";

import {
  type DraftLine,
  type OrderItem,
  defaultReceipt,
  lineTotals,
  orderTotals,
  quantize,
  receiptValue,
  toCreatePayload,
  toReceivePayload,
  validateLines,
  validateReceipt,
} from "./purchase-order";

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    key: "k1",
    variantId: "v1",
    sku: "RGN-SHIRT-BLK-M",
    productName: "Oxford Shirt",
    variantLabel: "Black / M",
    quantity: "10",
    unitCost: "450.00",
    discount: "0",
    ...over,
  };
}

function item(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "i1",
    variant: "v1",
    sku: "RGN-SHIRT-BLK-M",
    product_name: "Oxford Shirt",
    variant_label: "Black / M",
    quantity_ordered: 10,
    quantity_received: 0,
    quantity_outstanding: 10,
    unit_cost: "450.00",
    discount: "0.00",
    line_total: "4500.00",
    ...over,
  };
}

describe("quantize", () => {
  it("rounds to two places", () => {
    expect(quantize(1.005)).toBe(1.01);
    expect(quantize(4499.999)).toBe(4500);
  });

  it("treats a non-finite value as zero rather than propagating NaN", () => {
    expect(quantize(Number.NaN)).toBe(0);
    expect(quantize(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("lineTotals", () => {
  it("computes gross, discount and net", () => {
    expect(lineTotals(line())).toEqual({ gross: 4500, discount: 0, net: 4500 });
  });

  it("subtracts the discount from the gross", () => {
    expect(lineTotals(line({ discount: "500" }))).toEqual({
      gross: 4500,
      discount: 500,
      net: 4000,
    });
  });

  it("treats blank fields as zero rather than NaN", () => {
    expect(lineTotals(line({ quantity: "", unitCost: "", discount: "" }))).toEqual({
      gross: 0,
      discount: 0,
      net: 0,
    });
  });
});

describe("orderTotals", () => {
  it("sums lines and adds shipping", () => {
    const totals = orderTotals([line(), line({ key: "k2", variantId: "v2", quantity: "5" })], "120");
    expect(totals.subtotal).toBe(6750);
    expect(totals.shipping).toBe(120);
    expect(totals.grandTotal).toBe(6870);
    expect(totals.lineCount).toBe(2);
    expect(totals.unitCount).toBe(15);
  });

  it("subtracts discounts before shipping", () => {
    const totals = orderTotals([line({ discount: "500" })], "100");
    expect(totals.discountTotal).toBe(500);
    expect(totals.grandTotal).toBe(4100);
  });

  it("quantises per line, as the server does", () => {
    // 0.005 * 3 = 0.015. Rounding per line gives 0.01 each -> 0.03; rounding a
    // single sum would give 0.02. The server rounds per line, so this must too.
    const odd = [
      line({ key: "a", variantId: "va", quantity: "1", unitCost: "0.005" }),
      line({ key: "b", variantId: "vb", quantity: "1", unitCost: "0.005" }),
      line({ key: "c", variantId: "vc", quantity: "1", unitCost: "0.005" }),
    ];
    expect(orderTotals(odd, "0").subtotal).toBe(0.03);
  });

  it("is zero for an empty order", () => {
    expect(orderTotals([], "")).toMatchObject({ subtotal: 0, grandTotal: 0, lineCount: 0 });
  });
});

describe("validateLines", () => {
  it("accepts a well-formed line", () => {
    expect(validateLines([line()])).toEqual([]);
  });

  it("rejects a zero or fractional quantity", () => {
    expect(validateLines([line({ quantity: "0" })])).toHaveLength(1);
    expect(validateLines([line({ quantity: "1.5" })])).toHaveLength(1);
  });

  it("rejects a negative unit cost", () => {
    expect(validateLines([line({ unitCost: "-1" })])[0].message).toMatch(/negative/i);
  });

  it("rejects a discount larger than the line", () => {
    expect(validateLines([line({ discount: "99999" })])[0].message).toMatch(/exceed/i);
  });

  it("catches a duplicated variant before the database constraint does", () => {
    const problems = validateLines([line(), line({ key: "k2" })]);
    expect(problems).toHaveLength(1);
    expect(problems[0].key).toBe("k2");
    expect(problems[0].message).toMatch(/already on the order/i);
  });

  it("allows the same SKU text on different variants", () => {
    expect(validateLines([line(), line({ key: "k2", variantId: "v2" })])).toEqual([]);
  });
});

describe("toCreatePayload", () => {
  it("maps to the API's line shape", () => {
    expect(toCreatePayload([line()])).toEqual([
      { variant: "v1", quantity: 10, unit_cost: "450.00", discount: "0" },
    ]);
  });

  it("sends zero rather than an empty string", () => {
    expect(toCreatePayload([line({ unitCost: "", discount: "" })])[0]).toMatchObject({
      unit_cost: "0",
      discount: "0",
    });
  });
});

describe("defaultReceipt", () => {
  it("offers everything outstanding at the ordered cost", () => {
    expect(defaultReceipt([item()])).toEqual([
      { itemId: "i1", quantity: "10", unitCost: "450.00" },
    ]);
  });

  it("offers only what is left on a part-received line", () => {
    const partial = item({ quantity_received: 4, quantity_outstanding: 6 });
    expect(defaultReceipt([partial])[0].quantity).toBe("6");
  });

  it("drops a fully received line", () => {
    const done = item({ quantity_received: 10, quantity_outstanding: 0 });
    expect(defaultReceipt([done])).toEqual([]);
  });
});

describe("validateReceipt", () => {
  it("accepts receiving exactly what is outstanding", () => {
    expect(validateReceipt(defaultReceipt([item()]), [item()])).toEqual([]);
  });

  it("refuses more than outstanding, which the DB constraint would reject", () => {
    const problems = validateReceipt(
      [{ itemId: "i1", quantity: "11", unitCost: "450.00" }],
      [item()],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/only 10 outstanding/i);
  });

  it("allows a line to receive nothing", () => {
    expect(validateReceipt([{ itemId: "i1", quantity: "0", unitCost: "450" }], [item()])).toEqual(
      [],
    );
  });

  it("refuses a negative unit cost", () => {
    const problems = validateReceipt(
      [{ itemId: "i1", quantity: "5", unitCost: "-3" }],
      [item()],
    );
    expect(problems.some((p) => /negative/i.test(p.message))).toBe(true);
  });
});

describe("toReceivePayload", () => {
  it("drops lines receiving nothing", () => {
    const payload = toReceivePayload(
      [
        { itemId: "i1", quantity: "0", unitCost: "450.00" },
        { itemId: "i2", quantity: "3", unitCost: "450.00" },
      ],
      [item(), item({ id: "i2" })],
    );
    expect(payload).toHaveLength(1);
    expect(payload[0].item).toBe("i2");
  });

  it("omits unit_cost when it matches what was ordered", () => {
    const payload = toReceivePayload([{ itemId: "i1", quantity: "10", unitCost: "450.00" }], [item()]);
    expect(payload[0]).not.toHaveProperty("unit_cost");
  });

  it("treats an equal value written differently as unchanged", () => {
    // "450" and "450.00" are the same money; resending it would be noise.
    const payload = toReceivePayload([{ itemId: "i1", quantity: "10", unitCost: "450" }], [item()]);
    expect(payload[0]).not.toHaveProperty("unit_cost");
  });

  it("sends unit_cost when the delivered cost actually differs", () => {
    const payload = toReceivePayload([{ itemId: "i1", quantity: "10", unitCost: "480.00" }], [item()]);
    expect(payload[0]).toMatchObject({ item: "i1", quantity: 10, unit_cost: "480.00" });
  });
});

describe("receiptValue", () => {
  it("values the receipt about to hit the ledger", () => {
    expect(receiptValue([{ itemId: "i1", quantity: "10", unitCost: "450.00" }])).toBe(4500);
  });

  it("is zero when nothing is being received", () => {
    expect(receiptValue([{ itemId: "i1", quantity: "0", unitCost: "450.00" }])).toBe(0);
  });
});
