/**
 * The supplier payment form's own logic, which is the part a round trip cannot
 * check for you.
 *
 * The server owns every rule here and refuses independently (see
 * business-rules.md §6b.1b and the backend guard tests); these cover the two
 * things that live only in the browser: refusing an overpayment before the
 * round trip, and — the subtle one — issuing a *fresh* idempotency key after
 * each success, so two genuine part-payments are not collapsed into one by a
 * key that outlived the submit it belonged to.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SupplierPaymentForm } from "./supplier-payment-form";
import type { Account } from "@/lib/api/types";

const apiClient = vi.fn();

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return { ...actual, apiClient: (...args: unknown[]) => apiClient(...args) };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const ACCOUNTS: Account[] = [
  {
    id: "acc-cash",
    branch: "b1",
    branch_code: "BR1",
    branch_name: "Main",
    name: "Front drawer",
    kind: "CASH",
    kind_display: "Cash",
    account_number: "",
    bank_name: "",
    balance: "5000.00",
    is_active: true,
  } as Account,
];

function renderForm(outstanding = "1000.00") {
  return render(
    <SupplierPaymentForm
      purchaseOrderId="po-1"
      supplierId="sup-1"
      outstanding={outstanding}
      accounts={ACCOUNTS}
    />,
  );
}

function typeAmount(value: string) {
  fireEvent.change(screen.getByLabelText(/amount/i), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
}

describe("SupplierPaymentForm", () => {
  beforeEach(() => {
    apiClient.mockReset();
    apiClient.mockResolvedValue({ id: "pay-1" });
  });

  it("refuses more than is outstanding without calling the API", async () => {
    renderForm("1000.00");

    typeAmount("1500.00");
    submit();

    // Twice over: once in the ErrorSummary and once under the field itself,
    // which is why this is findAll rather than find.
    const shown = await screen.findAllByText(/only .* is outstanding/i);
    expect(shown.length).toBeGreaterThan(0);
    expect(apiClient).not.toHaveBeenCalled();
  });

  it("refuses a zero amount", async () => {
    renderForm();

    typeAmount("0");
    submit();

    const shown = await screen.findAllByText(/greater than zero/i);
    expect(shown.length).toBeGreaterThan(0);
    expect(apiClient).not.toHaveBeenCalled();
  });

  it("sends the exact outstanding amount", async () => {
    renderForm("1000.00");

    typeAmount("1000.00");
    submit();

    await waitFor(() => expect(apiClient).toHaveBeenCalledTimes(1));
    const [, options] = apiClient.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body.amount).toBe("1000.00");
    expect(options.body.purchase_order).toBe("po-1");
    expect(options.body.supplier).toBe("sup-1");
  });

  it("issues a new idempotency key for the second payment", async () => {
    renderForm("1000.00");

    typeAmount("400.00");
    submit();
    await waitFor(() => expect(apiClient).toHaveBeenCalledTimes(1));

    typeAmount("300.00");
    submit();
    await waitFor(() => expect(apiClient).toHaveBeenCalledTimes(2));

    const keyOf = (index: number) =>
      (apiClient.mock.calls[index] as [string, { idempotencyKey: string }])[1].idempotencyKey;

    // Reusing the first key would make the server return the first payment and
    // the supplier would be short by the second instalment.
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  it("renders nothing once the order is fully paid", () => {
    // Plain matchers only: this project registers no jest-dom setup file.
    const { container } = renderForm("0.00");

    expect(container.innerHTML).toBe("");
  });
});
