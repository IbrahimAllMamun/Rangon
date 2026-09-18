import { describe, expect, it } from "vitest";

import {
  EMPTY_OFFERS,
  type SupplierOffer,
  minimumOrderWarning,
  resolveCost,
} from "./supplier-prices";

function offer(partial: Partial<SupplierOffer> = {}): SupplierOffer {
  return {
    variant: "v1",
    last_cost: "250.00",
    supplier_sku: "",
    minimum_order_quantity: 1,
    is_preferred: false,
    last_purchased_at: null,
    ...partial,
  };
}

describe("resolveCost", () => {
  it("uses what this supplier last charged", () => {
    const offers = new Map([["v1", offer({ last_cost: "250.00" })]]);
    // 400 is the catalogue cost — the last price paid to somebody else.
    expect(resolveCost(offers, "v1", "400.00")).toMatchObject({
      cost: "250.00",
      source: "supplier",
    });
  });

  it("falls back to the catalogue cost, and says so", () => {
    // The whole bug in one assertion: without a per-supplier price the form can
    // only offer the last price paid to anyone, so it must be labelled.
    expect(resolveCost(EMPTY_OFFERS, "v1", "400.00")).toMatchObject({
      cost: "400.00",
      source: "catalogue",
      offer: null,
    });
  });

  it("does not leak one variant's price onto another", () => {
    const offers = new Map([["v1", offer({ last_cost: "250.00" })]]);
    expect(resolveCost(offers, "v2", "400.00").source).toBe("catalogue");
  });
});

describe("minimumOrderWarning", () => {
  it("warns below the supplier's minimum", () => {
    expect(minimumOrderWarning(offer({ minimum_order_quantity: 12 }), "5")).toBe(
      "This supplier's minimum is 12.",
    );
  });

  it("is silent at or above the minimum", () => {
    expect(minimumOrderWarning(offer({ minimum_order_quantity: 12 }), "12")).toBeNull();
    expect(minimumOrderWarning(offer({ minimum_order_quantity: 12 }), "50")).toBeNull();
  });

  it("is silent when there is no minimum, no offer, or no usable quantity", () => {
    expect(minimumOrderWarning(offer({ minimum_order_quantity: 1 }), "1")).toBeNull();
    expect(minimumOrderWarning(null, "1")).toBeNull();
    // Mid-typing an empty or nonsense box must not shout at the buyer.
    expect(minimumOrderWarning(offer({ minimum_order_quantity: 12 }), "")).toBeNull();
    expect(minimumOrderWarning(offer({ minimum_order_quantity: 12 }), "abc")).toBeNull();
  });
});
