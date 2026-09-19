import { describe, expect, it } from "vitest";

import {
  MOVEMENT_FAMILIES,
  documentHref,
  movesReserved,
  resolveFamily,
  signedQuantity,
} from "./stock-movements";

const everything = () => true;
const nothing = () => false;

describe("resolveFamily", () => {
  it("groups the two write-off types under one filter", () => {
    expect(resolveFamily("written-off").types).toEqual(["DAMAGE", "LOSS"]);
  });

  it("falls back to everything for a value it does not know", () => {
    expect(resolveFamily("bananas")).toBe(MOVEMENT_FAMILIES[0]);
    expect(resolveFamily(undefined).types).toEqual([]);
  });

  it("names every ledger type exactly once", () => {
    const named = MOVEMENT_FAMILIES.flatMap((family) => family.types);
    expect(new Set(named).size).toBe(named.length);
    expect(named).toHaveLength(11);
  });
});

describe("signedQuantity", () => {
  it("spells the sign out rather than leaving it to colour", () => {
    expect(signedQuantity(3)).toBe("+3");
    expect(signedQuantity(-2)).toBe("−2");
    expect(signedQuantity(0)).toBe("0");
  });
});

describe("movesReserved", () => {
  it("is true only for the reservation pair", () => {
    expect(movesReserved("RESERVATION")).toBe(true);
    expect(movesReserved("RESERVATION_RELEASE")).toBe(true);
    expect(movesReserved("SALE")).toBe(false);
  });
});

describe("documentHref", () => {
  it("opens a receipt on its purchase order", () => {
    expect(
      documentHref({ kind: "purchase_order", id: "po-1", label: "PO-000001 · GRN-000001" }, everything),
    ).toBe("/admin/purchases/po-1");
  });

  it("does not link what the reader's role cannot open", () => {
    expect(documentHref({ kind: "order", id: "o-1", label: "RGN-1" }, nothing)).toBeNull();
  });

  it("names a transfer without linking it — it has no screen of its own", () => {
    expect(
      documentHref({ kind: "stock_transfer", id: "t-1", label: "TR-000001" }, everything),
    ).toBeNull();
  });

  it("has nothing to open for a manual movement", () => {
    expect(documentHref(null, everything)).toBeNull();
  });
});
