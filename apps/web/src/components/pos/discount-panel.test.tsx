/**
 * The discount dialog's own logic: what reaches the sale, and when.
 *
 * The server prices and refuses everything (tests/test_pos_discounts.py). What
 * lives only here is the order of events -- a coupon or a discount is tried
 * first and committed to the sale only once the server has said yes -- and
 * what the manager's approval carries: the percentage they were shown, and
 * never their password beyond the one request that checks it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiscountPanel } from "./discount-panel";
import type { PosQuote, PosQuoteIssue, PosSession } from "@/lib/api/types";
import { usePos } from "@/lib/store/pos";

const apiClient = vi.fn();

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return { ...actual, apiClient: (...args: unknown[]) => apiClient(...args) };
});

function session(permissions = ["sales.create", "sales.discount"]): PosSession {
  return {
    branch: { id: "b1", name: "Main", code: "BR1", address: "", phone: "", register_count: 1 },
    cashier: { id: "u1", name: "Cashier", email: "cashier@rangon.test", permissions },
    organization: { name: "Rangon", currency: "BDT", receipt_footer: "", vat_registration: "" },
    holds: [],
    accounts: [],
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

const NEEDS_APPROVAL: PosQuoteIssue = {
  code: "PERMISSION_DENIED",
  field: "discount",
  message: "A discount above 20% needs manager approval.",
  details: {
    requires: "sales.discount_override",
    discount: "600.00",
    discount_percent: "30.00",
    threshold: "20",
  },
};

function renderPanel(preview: ReturnType<typeof vi.fn>, permissions?: string[]) {
  return render(
    <DiscountPanel
      session={session(permissions)}
      quote={null}
      preview={preview}
      onClose={() => {}}
      onAttachCustomer={() => {}}
    />,
  );
}

beforeEach(() => {
  apiClient.mockReset();
  usePos.getState().clear();
  usePos.getState().addVariant({
    id: "v1",
    sku: "RGN-TEE-M",
    barcode: "",
    name: "Cotton Tee",
    label: "M",
    price: "1000.00",
    available: 5,
    image: "",
    category: "",
  });
});

describe("DiscountPanel, coupons", () => {
  it("puts a coupon on the sale once the server has priced it", async () => {
    const preview = vi.fn().mockResolvedValue(
      quote({
        coupon: { code: "STORE100", description: "" },
        coupon_discount: "100.00",
        grand_total: "1900.00",
      }),
    );
    renderPanel(preview);

    fireEvent.change(screen.getByLabelText("Coupon code"), { target: { value: "store100" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[0]);

    await screen.findByText(/STORE100 applied/);
    expect(preview).toHaveBeenCalledWith({ couponCode: "STORE100" });
    expect(usePos.getState().couponCode).toBe("STORE100");
  });

  it("keeps a refused coupon off the sale and says why", async () => {
    const preview = vi.fn().mockResolvedValue(
      quote({
        issues: [
          {
            code: "COUPON_INVALID",
            field: "coupon",
            message: "This coupon has expired.",
            details: { code: "OLD10" },
          },
        ],
      }),
    );
    renderPanel(preview);

    fireEvent.change(screen.getByLabelText("Coupon code"), { target: { value: "OLD10" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[0]);

    await screen.findByText("This coupon has expired.");
    expect(usePos.getState().couponCode).toBe("");
    // The message is the field's, not a floating banner.
    expect(screen.getByLabelText("Coupon code").getAttribute("aria-describedby")).toBe(
      "pos-coupon-error",
    );
  });

  it("offers to attach the customer when the coupon is one-per-customer", async () => {
    const onAttachCustomer = vi.fn();
    const preview = vi.fn().mockResolvedValue(
      quote({
        issues: [
          {
            code: "COUPON_INVALID",
            field: "coupon",
            message: "RANGON10 can be used once per customer, so it needs the customer on the sale.",
            details: { code: "RANGON10", needs_customer: true },
          },
        ],
      }),
    );
    render(
      <DiscountPanel
        session={session()}
        quote={null}
        preview={preview}
        onClose={() => {}}
        onAttachCustomer={onAttachCustomer}
      />,
    );

    fireEvent.change(screen.getByLabelText("Coupon code"), { target: { value: "RANGON10" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: /attach the customer/i }));

    // Kept on the sale, so attaching the customer is all it takes.
    expect(usePos.getState().couponCode).toBe("RANGON10");
    expect(onAttachCustomer).toHaveBeenCalledOnce();
  });
});

describe("DiscountPanel, the cashier's discount", () => {
  it("sends a percentage as a percentage", async () => {
    const preview = vi.fn().mockResolvedValue(quote({ manual_discount: "200.00" }));
    renderPanel(preview);

    fireEvent.click(screen.getByRole("button", { name: "% Percent" }));
    fireEvent.change(screen.getByLabelText("Percentage off"), { target: { value: "10" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[1]);

    await screen.findByText(/200\.00 off the sale/);
    expect(preview).toHaveBeenCalledWith({ orderDiscount: 10, orderDiscountMode: "PERCENT" });
    expect(usePos.getState()).toMatchObject({ orderDiscount: 10, orderDiscountMode: "PERCENT" });
  });

  it("refuses a percentage over 100 without asking the server", async () => {
    const preview = vi.fn();
    renderPanel(preview);

    fireEvent.click(screen.getByRole("button", { name: "% Percent" }));
    fireEvent.change(screen.getByLabelText("Percentage off"), { target: { value: "120" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[1]);

    await screen.findByText("A percentage cannot be more than 100.");
    expect(preview).not.toHaveBeenCalled();
  });

  it("waits for a manager, and carries the percentage they approved", async () => {
    const preview = vi
      .fn()
      // The discount as asked for: over the threshold.
      .mockResolvedValueOnce(quote({ manual_discount: "600.00", issues: [NEEDS_APPROVAL] }))
      // Priced again with the approval: through.
      .mockResolvedValueOnce(quote({ manual_discount: "600.00" }));
    apiClient.mockResolvedValue({
      approved: true,
      approved_by: "Mina Manager",
      approved_by_id: "m1",
      permission: "sales.discount_override",
      approval_token: "signed-token",
      expires_in: 300,
    });
    renderPanel(preview);

    fireEvent.click(screen.getByRole("button", { name: "% Percent" }));
    fireEvent.change(screen.getByLabelText("Percentage off"), { target: { value: "30" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[1]);

    await screen.findByText("Manager approval needed");
    // In the server's figures, saying what the percentage is of.
    expect(
      screen.getByText(
        "৳ 600.00 off is 30.00% of the sale at full price. A cashier can give up to 20% without a manager.",
      ),
    ).toBeTruthy();
    // Not on the sale until a manager says so.
    expect(usePos.getState().orderDiscount).toBe(0);

    fireEvent.change(screen.getByLabelText("Manager's email"), {
      target: { value: "manager@rangon.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: /approve 30\.00%/i }));

    await screen.findByText(/Approved by Mina Manager/);
    expect(apiClient).toHaveBeenCalledWith("/pos/elevate/", {
      method: "POST",
      body: {
        email: "manager@rangon.test",
        password: "secret",
        permission: "sales.discount_override",
        discount_percent: "30.00",
      },
    });
    const state = usePos.getState();
    expect(state).toMatchObject({ orderDiscount: 30, orderDiscountMode: "PERCENT" });
    // The sale carries the approval, never the password.
    expect(state.approval).toEqual({
      token: "signed-token",
      approvedBy: "Mina Manager",
      percent: "30.00",
    });
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("clears the password when the manager's credentials are refused", async () => {
    const { ApiError } = await import("@/lib/api/client");
    const preview = vi
      .fn()
      .mockResolvedValue(quote({ manual_discount: "600.00", issues: [NEEDS_APPROVAL] }));
    apiClient.mockRejectedValue(
      new ApiError(403, "PERMISSION_DENIED", "Those manager credentials were not accepted."),
    );
    renderPanel(preview);

    fireEvent.click(screen.getByRole("button", { name: "% Percent" }));
    fireEvent.change(screen.getByLabelText("Percentage off"), { target: { value: "30" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[1]);
    await screen.findByText("Manager approval needed");

    fireEvent.change(screen.getByLabelText("Manager's email"), {
      target: { value: "manager@rangon.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /approve 30\.00%/i }));

    await screen.findByText("Those manager credentials were not accepted.");
    await waitFor(() =>
      expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(""),
    );
    expect(usePos.getState().approval).toBeNull();
  });

  it("offers no discount to a role that cannot give one, but still takes a coupon", () => {
    renderPanel(vi.fn(), ["sales.create"]);

    expect(screen.getByText(/cannot give a discount/)).toBeTruthy();
    expect(screen.queryByLabelText(/amount off|percentage off/i)).toBeNull();
    expect(screen.getByLabelText("Coupon code")).toBeTruthy();
  });
});
