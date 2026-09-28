import { beforeEach, describe, expect, it } from "vitest";

import { usePos } from "./pos";

const LINE = {
  variantId: "v1",
  sku: "RGN-TEE-M",
  barcode: "2000000000001",
  name: "Cotton Tee",
  label: "M",
  unitPrice: 1000,
  quantity: 1,
  available: 5,
  discount: 0,
};

describe("the register's discount state", () => {
  beforeEach(() => usePos.getState().clear());

  it("resumes a hold parked before discounts had a mode as an amount", () => {
    usePos.getState().restore({ lines: [LINE], orderDiscount: 150 });

    const state = usePos.getState();
    expect(state.orderDiscount).toBe(150);
    expect(state.orderDiscountMode).toBe("AMOUNT");
    expect(state.couponCode).toBe("");
  });

  it("resumes the coupon and the percentage, but never an approval", () => {
    usePos.getState().restore({
      lines: [LINE],
      orderDiscount: 10,
      orderDiscountMode: "PERCENT",
      couponCode: "STORE100",
      // Would only be here if something parked it; it must not come back.
      approval: { token: "signed", approvedBy: "Manager", percent: "30.00" },
    });

    const state = usePos.getState();
    expect(state.orderDiscountMode).toBe("PERCENT");
    expect(state.couponCode).toBe("STORE100");
    expect(state.approval).toBeNull();
  });

  it("keeps a percentage within 0 to 100, and an amount above 0", () => {
    usePos.getState().setOrderDiscount(140, "PERCENT");
    expect(usePos.getState().orderDiscount).toBe(100);

    usePos.getState().setOrderDiscount(-5, "AMOUNT");
    expect(usePos.getState().orderDiscount).toBe(0);
  });

  it("stores a coupon code the way the server spells it", () => {
    usePos.getState().setCoupon("  store100 ");

    expect(usePos.getState().couponCode).toBe("STORE100");
  });

  it("forgets the coupon, the discount and the approval with the sale", () => {
    const pos = usePos.getState();
    pos.setCoupon("STORE100");
    pos.setOrderDiscount(30, "PERCENT");
    pos.setApproval({ token: "signed", approvedBy: "Manager", percent: "30.00" });

    usePos.getState().clear();

    const state = usePos.getState();
    expect(state.couponCode).toBe("");
    expect(state.orderDiscount).toBe(0);
    expect(state.orderDiscountMode).toBe("AMOUNT");
    expect(state.approval).toBeNull();
  });
});
