import { describe, expect, it } from "vitest";

import type { Account, Payment } from "@/lib/api/types";

import {
  METHOD_KIND,
  REFUND_METHODS,
  accountsFor,
  defaultRefundMethod,
  suggestedAccount,
} from "./money-accounts";

function account(overrides: Partial<Account>): Account {
  return {
    id: "acct",
    branch: "alpha",
    branch_code: "ALPHA",
    branch_name: "Alpha",
    name: "Drawer",
    kind: "CASH",
    kind_display: "Cash drawer",
    account_number: "",
    bank_name: "",
    balance: "0.00",
    is_active: true,
    is_default: true,
    allow_overdraft: false,
    notes: "",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function payment(overrides: Partial<Payment>): Payment {
  return {
    id: "pay",
    method: "CASH",
    status: "CAPTURED",
    amount: "100.00",
    tendered_amount: null,
    change_amount: "0.00",
    reference: "",
    captured_at: null,
    created_at: "",
    account: null,
    account_name: "",
    ...overrides,
  };
}

describe("accountsFor", () => {
  const accounts = [
    account({ id: "drawer-a" }),
    account({ id: "bank-a", kind: "BANK" }),
    account({ id: "drawer-b", branch: "bravo" }),
    account({ id: "closed-a", is_active: false }),
  ];

  it("offers only the branch's own open accounts of the method's kind", () => {
    expect(accountsFor(accounts, "CASH", "alpha").map((row) => row.id)).toEqual(["drawer-a"]);
    expect(accountsFor(accounts, "CARD", "alpha").map((row) => row.id)).toEqual(["bank-a"]);
    expect(accountsFor(accounts, "CHEQUE", "alpha").map((row) => row.id)).toEqual(["bank-a"]);
  });

  it("offers every branch's when the money names none", () => {
    expect(accountsFor(accounts, "CASH").map((row) => row.id)).toEqual(["drawer-a", "drawer-b"]);
  });

  it("offers nothing for a method it does not know", () => {
    expect(accountsFor(accounts, "BITCOIN", "alpha")).toEqual([]);
  });
});

describe("defaultRefundMethod", () => {
  it("goes back the way the largest captured payment came in", () => {
    const payments = [
      payment({ method: "CASH", amount: "200.00" }),
      payment({ method: "CARD", amount: "800.00" }),
      payment({ method: "MOBILE_MFS", amount: "900.00", status: "FAILED" }),
    ];
    expect(defaultRefundMethod(payments)).toBe("CARD");
  });

  it("refunds cash on delivery in cash", () => {
    expect(defaultRefundMethod([payment({ method: "COD" })])).toBe("CASH");
  });

  it("falls back to cash for a method no refund offers, or no payment at all", () => {
    expect(defaultRefundMethod([payment({ method: "STORE_CREDIT" })])).toBe("CASH");
    expect(defaultRefundMethod([])).toBe("CASH");
    expect(defaultRefundMethod(undefined)).toBe("CASH");
  });
});

describe("suggestedAccount", () => {
  const drawers = [
    account({ id: "second", name: "Second drawer", is_default: false }),
    account({ id: "main", name: "Main drawer" }),
  ];

  it("goes back into the account the payment came into", () => {
    expect(suggestedAccount(drawers, "second")).toBe("second");
  });

  it("uses the branch's default when that account is not on offer", () => {
    // A card payment's bank account, for a refund made in cash.
    expect(suggestedAccount(drawers, "bank-a")).toBe("main");
    expect(suggestedAccount(drawers, null)).toBe("main");
  });

  it("uses the only one there is, or none", () => {
    expect(suggestedAccount([drawers[0]], null)).toBe("second");
    expect(suggestedAccount([], "main")).toBe("");
  });
});

describe("the maps", () => {
  it("know every method a refund offers", () => {
    for (const row of REFUND_METHODS) expect(METHOD_KIND[row.value]).toBeDefined();
  });

  it("agree with the server's METHOD_TO_KIND", () => {
    // finance/models.py — copied here so a change there is a change here too.
    expect(METHOD_KIND).toEqual({
      CASH: "CASH",
      CARD: "BANK",
      BANK: "BANK",
      MOBILE_MFS: "MFS",
      ONLINE_GATEWAY: "BANK",
      COD: "CASH",
      CHEQUE: "BANK",
      STORE_CREDIT: "OTHER",
      OTHER: "OTHER",
    });
  });
});
