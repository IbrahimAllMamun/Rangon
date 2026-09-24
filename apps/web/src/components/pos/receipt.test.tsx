/**
 * What the printed memo says about VAT.
 *
 * The rule the owner set: a memo that charged no VAT says nothing about VAT.
 * That is two elements, not one -- the tax line above the total, and the
 * shop's registration number in the header. The amount line was already
 * conditional; the registration number was not, so every memo the platform
 * printed at the shipped rate of 0% announced a VAT registration and then
 * showed no tax.
 *
 * Plain matchers, no `toBeInTheDocument`: no vitest setup file registers
 * jest-dom, the same reason `order-fulfilment.test.tsx` does without it.
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { Receipt } from "./receipt";
import type { Order, PosSession } from "@/lib/api/types";

const BIN = "0019283746-0101";

function session(): PosSession {
  return {
    branch: {
      id: "b-1",
      name: "Dhanmondi",
      code: "BR001",
      address: "Road 27, Dhaka",
      phone: "01700000000",
      register_count: 2,
    },
    cashier: { id: "u-1", name: "Cashier", email: "c@rangon.test", permissions: [] },
    organization: {
      name: "Rangon Fashion",
      currency: "BDT",
      receipt_footer: "Thank you.",
      vat_registration: BIN,
    },
    holds: [],
    accounts: [],
  };
}

/** A one-item sale; `taxTotal` is the only thing the tests vary. */
function order(taxTotal: string): Order {
  const grand = (1000 + Number(taxTotal)).toFixed(2);
  return {
    id: "o-1",
    number: "RGN-POS-000001",
    channel: "POS",
    status: "DELIVERED",
    payment_status: "PAID",
    branch: "branch-1",
    branch_code: "BR001",
    customer: "",
    customer_name: "Walk-in",
    customer_phone: "",
    item_count: 1,
    subtotal: "1000.00",
    discount_total: "0.00",
    tax_total: taxTotal,
    shipping_total: "0.00",
    grand_total: grand,
    paid_total: grand,
    refunded_total: "0.00",
    currency: "BDT",
    created_by_email: "c@rangon.test",
    placed_at: "2026-09-18T10:00:00Z",
    register: "1",
    items: [
      {
        id: "i-1",
        variant: "v-1",
        sku: "SKU-1",
        product_name: "Cotton kurta",
        variant_label: "M / Red",
        quantity: 1,
        unit_price: "1000.00",
        line_discount: "0.00",
        tax_amount: taxTotal,
        line_total: "1000.00",
        returned_quantity: 0,
        returnable_quantity: 1,
        image: "",
      },
    ],
    payments: [],
  };
}

describe("Receipt, VAT block", () => {
  it("says nothing about VAT when none was charged", () => {
    render(<Receipt order={order("0.00")} session={session()} onNewSale={() => {}} />);

    // Neither half of the block: no tax line, and no registration number.
    expect(screen.queryByText("VAT")).toBeNull();
    expect(screen.queryByText(`VAT: ${BIN}`)).toBeNull();
    // The rest of the memo is untouched.
    expect(screen.getByText("Subtotal")).toBeTruthy();
    expect(screen.getByText("TOTAL")).toBeTruthy();
  });

  it("prints both halves once VAT was charged", () => {
    render(<Receipt order={order("150.00")} session={session()} onNewSale={() => {}} />);

    expect(screen.getByText("VAT")).toBeTruthy();
    expect(screen.getByText(`VAT: ${BIN}`)).toBeTruthy();
  });

  it("omits the registration number on a zero-VAT memo even though the shop has one", () => {
    // The shop is registered; this sale simply charged no VAT. The memo must
    // not imply otherwise.
    const registered = session();
    expect(registered.organization.vat_registration).toBe(BIN);

    render(<Receipt order={order("0.00")} session={registered} onNewSale={() => {}} />);

    expect(screen.queryByText(new RegExp(BIN))).toBeNull();
  });
});
