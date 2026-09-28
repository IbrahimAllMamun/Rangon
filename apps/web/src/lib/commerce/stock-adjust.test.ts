import { describe, expect, it } from "vitest";

import { purchaseOrderFor, upwardRefusal } from "./stock-adjust";

describe("upwardRefusal", () => {
  it("refuses raising stock that was never received", () => {
    expect(upwardRefusal(false, 5)).toMatch(/purchase order/);
  });

  it("allows lowering it — legacy stock must stay countable to zero", () => {
    expect(upwardRefusal(false, -3)).toBeNull();
    expect(upwardRefusal(false, 0)).toBeNull();
  });

  it("allows raising stock that has been received", () => {
    expect(upwardRefusal(true, 5)).toBeNull();
  });

  it("leaves the decision to the API when it did not say", () => {
    expect(upwardRefusal(undefined, 5)).toBeNull();
  });
});

describe("purchaseOrderFor", () => {
  it("prefills the order with the variants", () => {
    expect(purchaseOrderFor(["a", "b"])).toBe("/admin/purchases/new?variants=a,b");
  });

  it("is a plain new order when there is nothing to prefill", () => {
    expect(purchaseOrderFor([])).toBe("/admin/purchases/new");
    expect(purchaseOrderFor([""])).toBe("/admin/purchases/new");
  });
});
