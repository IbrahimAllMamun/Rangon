/**
 * The A4 invoice is the other memo the VAT rule covers.
 *
 * Same rule as the POS receipt (`pos/receipt.test.tsx`): a memo that charged
 * no VAT says nothing about VAT, registration number included. The condition
 * here is three-way rather than two — a packing slip carries no prices at all,
 * so it never showed the number in the first place.
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { PrintDocument } from "./print-document";
import type { Order } from "@/lib/api/types";

const BIN = "0019283746-0101";

const ORGANIZATION = {
  name: "Rangon Fashion",
  address: "Road 27, Dhaka",
  phone: "01700000000",
  vat_registration: BIN,
  receipt_footer: "Thank you.",
};

function order(taxTotal: string): Order {
  const grand = (1000 + Number(taxTotal)).toFixed(2);
  return {
    id: "o-1",
    number: "RGN-WEB-000001",
    channel: "ONLINE",
    status: "DELIVERED",
    payment_status: "PAID",
    branch: "branch-1",
    branch_code: "BR001",
    customer: "",
    customer_name: "Walk-in",
    customer_phone: "01700000001",
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
  };
}

describe("PrintDocument, VAT block", () => {
  it("prints neither half on an invoice that charged no VAT", () => {
    render(
      <PrintDocument order={order("0.00")} organization={ORGANIZATION} documentType="INVOICE" />,
    );

    expect(screen.queryByText("VAT")).toBeNull();
    expect(screen.queryByText(`VAT: ${BIN}`)).toBeNull();
    expect(screen.getByText("Subtotal")).toBeTruthy();
  });

  it("prints both halves once VAT was charged", () => {
    render(
      <PrintDocument order={order("150.00")} organization={ORGANIZATION} documentType="INVOICE" />,
    );

    expect(screen.getByText("VAT")).toBeTruthy();
    expect(screen.getByText(`VAT: ${BIN}`)).toBeTruthy();
  });

  it("still keeps the number off a packing slip, VAT or not", () => {
    render(
      <PrintDocument
        order={order("150.00")}
        organization={ORGANIZATION}
        documentType="PACKING_SLIP"
      />,
    );

    expect(screen.queryByText(new RegExp(BIN))).toBeNull();
  });
});
