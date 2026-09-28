import { describe, expect, it } from "vitest";

import type { PosQuote, PosQuoteIssue } from "@/lib/api/types";
import type { PosLine } from "@/lib/store/pos";

import {
  type BasketState,
  approvalIssue,
  basketKey,
  basketRequest,
  discountLabel,
  issueFor,
  saleRequest,
  shownTotals,
} from "./pos-sale";

function line(over: Partial<PosLine> = {}): PosLine {
  return {
    variantId: "v1",
    sku: "RGN-TEE-M",
    barcode: "2000000000001",
    name: "Cotton Tee",
    label: "M",
    unitPrice: 1000,
    quantity: 2,
    available: 10,
    discount: 0,
    ...over,
  };
}

function basket(over: Partial<BasketState> = {}): BasketState {
  return {
    lines: [line()],
    customerId: null,
    orderDiscount: 0,
    orderDiscountMode: "AMOUNT",
    couponCode: "",
    approval: null,
    ...over,
  };
}

function quote(over: Partial<PosQuote> = {}): PosQuote {
  return {
    lines: [],
    subtotal: "2000.00",
    coupon: null,
    coupon_discount: "0.00",
    manual_discount: "0.00",
    discount_total: "0.00",
    tax_mode: "EXCLUSIVE",
    tax_rate: "0.0000",
    tax_total: "0.00",
    grand_total: "2000.00",
    item_count: 2,
    issues: [],
    ...over,
  };
}

const APPROVAL_ISSUE: PosQuoteIssue = {
  code: "PERMISSION_DENIED",
  field: "discount",
  message: "A discount above 20% needs manager approval.",
  details: { requires: "sales.discount_override", discount_percent: "30.00", threshold: "20" },
};

describe("basketRequest", () => {
  it("has nothing to price for an empty sale", () => {
    expect(basketRequest(basket({ lines: [] }))).toBeNull();
    expect(basketKey(null)).toBe("");
  });

  it("sends an amount as money and no percentage", () => {
    const request = basketRequest(basket({ orderDiscount: 150 }));

    expect(request?.manual_discount).toBe("150.00");
    expect(request?.manual_discount_percent).toBeNull();
  });

  it("sends a percentage as a percentage, never as money it worked out itself", () => {
    const request = basketRequest(basket({ orderDiscount: 12.5, orderDiscountMode: "PERCENT" }));

    // The server turns it into money, after the coupon; the browser does not.
    expect(request?.manual_discount).toBe("0.00");
    expect(request?.manual_discount_percent).toBe("12.50");
  });

  it("sends no percentage at all for 0%", () => {
    const request = basketRequest(basket({ orderDiscount: 0, orderDiscountMode: "PERCENT" }));

    expect(request?.manual_discount_percent).toBeNull();
  });

  it("sends the coupon as a code, trimmed, and the approval as its token", () => {
    const request = basketRequest(
      basket({
        couponCode: "  STORE100 ",
        approval: { token: "signed", approvedBy: "Manager", percent: "30.00" },
      }),
    );

    expect(request?.coupon_code).toBe("STORE100");
    expect(request?.approval_token).toBe("signed");
  });

  it("files equal baskets under one key and different ones apart", () => {
    const a = basketKey(basketRequest(basket({ couponCode: "A" })));

    expect(basketKey(basketRequest(basket({ couponCode: "A" })))).toBe(a);
    expect(basketKey(basketRequest(basket({ couponCode: "B" })))).not.toBe(a);
    expect(basketKey(basketRequest(basket({ customerId: "c1", couponCode: "A" })))).not.toBe(a);
  });
});

describe("saleRequest", () => {
  it("is the quoted basket plus the payments and the total that was shown", () => {
    const priced = basketRequest(basket({ couponCode: "STORE100" }))!;

    const body = saleRequest(priced, {
      payments: [{ method: "CASH", amount: "1900.00", reference: "", account: null }],
      register: "REG-02",
      note: "",
      expectedTotal: "1900.00",
    });

    expect(body).toMatchObject({
      coupon_code: "STORE100",
      register: "REG-02",
      expected_total: "1900.00",
      lines: priced.lines,
    });
    expect(body.payments).toHaveLength(1);
  });
});

describe("shownTotals", () => {
  it("shows the server's answer when it is for this basket", () => {
    const shown = shownTotals(
      basket({ couponCode: "STORE100" }),
      quote({
        coupon: { code: "STORE100", description: "" },
        coupon_discount: "100.00",
        grand_total: "1900.00",
      }),
      true,
    );

    expect(shown).toMatchObject({ couponCode: "STORE100", couponOff: 100, total: 1900 });
    expect(shown.settled).toBe(true);
  });

  it("shows shelf price at once for a plain basket, before the answer lands", () => {
    const shown = shownTotals(basket({ lines: [line({ quantity: 3 })] }), quote(), false);

    expect(shown.total).toBe(3000);
    expect(shown.settled).toBe(false);
  });

  it("keeps the last answer while a discounted basket is re-priced", () => {
    // Shelf price would ignore the coupon, and jump up and back down.
    const shown = shownTotals(
      basket({ lines: [line({ quantity: 3 })], couponCode: "STORE100" }),
      quote({ coupon_discount: "100.00", grand_total: "1900.00" }),
      false,
    );

    expect(shown.total).toBe(1900);
    expect(shown.settled).toBe(false);
  });

  it("keeps the last answer while VAT is being charged", () => {
    const shown = shownTotals(
      basket({ lines: [line({ quantity: 3 })] }),
      quote({ tax_total: "300.00", grand_total: "2300.00" }),
      false,
    );

    expect(shown.total).toBe(2300);
  });
});

describe("issues", () => {
  it("finds a discount a manager could approve, and nothing else", () => {
    const couponIssue: PosQuoteIssue = {
      code: "COUPON_INVALID",
      field: "coupon",
      message: "This coupon has expired.",
      details: { code: "OLD" },
    };

    expect(approvalIssue(quote({ issues: [couponIssue] }))).toBeUndefined();
    expect(approvalIssue(quote({ issues: [couponIssue, APPROVAL_ISSUE] }))).toBe(APPROVAL_ISSUE);
    expect(issueFor(quote({ issues: [couponIssue] }), "coupon")).toBe(couponIssue);
    expect(issueFor(null, "coupon")).toBeUndefined();
  });

  it("does not offer approval for a discount the cashier may not give at all", () => {
    const forbidden: PosQuoteIssue = {
      code: "PERMISSION_DENIED",
      field: "discount",
      message: "You do not have permission to apply discounts.",
      details: {},
    };

    expect(approvalIssue(quote({ issues: [forbidden] }))).toBeUndefined();
  });
});

describe("discountLabel", () => {
  it("names the percentage the cashier gave", () => {
    expect(discountLabel("PERCENT", 10)).toBe("Discount (10%)");
    expect(discountLabel("PERCENT", 12.5)).toBe("Discount (12.5%)");
    expect(discountLabel("AMOUNT", 150)).toBe("Discount");
  });
});
