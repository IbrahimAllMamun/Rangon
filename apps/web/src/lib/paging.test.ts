/**
 * `listHref` builds every filter tab and "Clear" link on the admin lists.
 *
 * What it must guarantee: a tab changes one thing and keeps the rest of what
 * the reader chose (a search survives a status tab), `page` never rides along
 * (DRF answers a page past the end of a narrower list with a 404), and a change
 * to nothing drops the key rather than leaving `status=` behind.
 */

import { describe, expect, it } from "vitest";

import { listHref } from "./paging";

describe("listHref", () => {
  it("keeps what the reader chose and changes one thing", () => {
    expect(listHref("/admin/products", { search: "kurt" }, { status: "DRAFT" })).toBe(
      "/admin/products?search=kurt&status=DRAFT",
    );
  });

  it("replaces a value rather than repeating the key", () => {
    expect(listHref("/admin/purchases", { status: "SENT" }, { status: "RECEIVED" })).toBe(
      "/admin/purchases?status=RECEIVED",
    );
  });

  it("starts again at page 1 but keeps the rows-per-page choice", () => {
    expect(
      listHref("/admin/orders", { page: "4", page_size: "50", channel: "POS" }, { status: "PAID" }),
    ).toBe("/admin/orders?page_size=50&channel=POS&status=PAID");
  });

  it("drops a key changed to nothing, or left empty", () => {
    const params = { search: "", date_from: "2026-09-01", date_to: "2026-09-30", status: "DRAFT" };

    expect(listHref("/admin/purchases", params, { date_from: undefined, date_to: "" })).toBe(
      "/admin/purchases?status=DRAFT",
    );
  });

  it("gives the bare path when nothing is left", () => {
    expect(listHref("/admin/customers", { page: "2" }, { customer_type: "" })).toBe(
      "/admin/customers",
    );
  });

  it("encodes what was typed", () => {
    expect(listHref("/admin/inventory", {}, { search: "Oxford & co" })).toBe(
      "/admin/inventory?search=Oxford+%26+co",
    );
  });
});
