import { describe, expect, it } from "vitest";

import { changedFields, entityHref, entityName } from "./audit-trail";

describe("entityName", () => {
  it("turns a model's class name into words", () => {
    expect(entityName("PurchaseOrder")).toBe("Purchase order");
    expect(entityName("Order")).toBe("Order");
    expect(entityName("")).toBe("—");
  });
});

describe("entityHref", () => {
  const can = (permission: string) => permission === "orders.view";

  it("links a record that has a screen the reader may open", () => {
    expect(entityHref({ entity_type: "Order", entity_id: "o-1" }, can)).toBe("/admin/orders/o-1");
  });

  it("does not link one the reader's role cannot open", () => {
    expect(entityHref({ entity_type: "PurchaseOrder", entity_id: "po-1" }, can)).toBeNull();
  });

  it("does not guess a screen for a record that has none", () => {
    expect(entityHref({ entity_type: "Payment", entity_id: "p-1" }, () => true)).toBeNull();
  });

  it("does not link an entry with no id, such as a failed sign-in", () => {
    expect(entityHref({ entity_type: "Order", entity_id: "" }, () => true)).toBeNull();
  });
});

describe("changedFields", () => {
  it("pairs each field's before and after, in the order they were written", () => {
    expect(changedFields({ status: "DRAFT" }, { status: "SENT", ordered_at: "2026-09-19" })).toEqual([
      { field: "status", before: "DRAFT", after: "SENT" },
      { field: "ordered_at", before: null, after: "2026-09-19" },
    ]);
  });

  it("shows nested values as JSON and absent ones as nothing", () => {
    expect(changedFields(null, { lines: [{ sku: "A", qty: 2 }], active: false })).toEqual([
      { field: "lines", before: null, after: '[{"sku":"A","qty":2}]' },
      { field: "active", before: null, after: "false" },
    ]);
  });

  it("keeps the redaction marker rather than hiding the field", () => {
    expect(changedFields({}, { password: "***" })).toEqual([
      { field: "password", before: null, after: "***" },
    ]);
  });
});
