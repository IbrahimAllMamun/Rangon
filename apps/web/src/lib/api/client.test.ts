import { describe, expect, it } from "vitest";

import { ApiError, parseApiResponse } from "./client";

/**
 * `fieldErrors()` exists to drive `ErrorSummary` and the inline messages under
 * each input. Only a VALIDATION_ERROR carries per-field messages; every other
 * `BusinessError` puts diagnostic context in `details`.
 *
 * Before this was enforced, an `INSUFFICIENT_FUNDS` from a transfer rendered
 * its context as four field errors — the admin saw a list reading
 * "e6622e4d-…", "Counter Cash Drawer", "65450.00", "100000.00" instead of the
 * sentence the service wrote, each linked to a form field that does not exist.
 */
describe("ApiError.fieldErrors", () => {
  it("flattens a VALIDATION_ERROR into per-field messages", () => {
    const error = new ApiError(400, "VALIDATION_ERROR", "Invalid input.", {
      name: ["This field is required."],
      amount: ["Enter a number."],
    });

    expect(error.fieldErrors()).toEqual([
      { field: "name", message: "This field is required." },
      { field: "amount", message: "Enter a number." },
    ]);
  });

  it("accepts a bare string as well as DRF's array form", () => {
    const error = new ApiError(400, "VALIDATION_ERROR", "Invalid input.", {
      name: "This field is required.",
    });

    expect(error.fieldErrors()).toEqual([
      { field: "name", message: "This field is required." },
    ]);
  });

  it("returns nothing for a business error, so callers fall back to the message", () => {
    const error = new ApiError(
      409,
      "INSUFFICIENT_FUNDS",
      "Counter Cash Drawer holds ৳ 65,450.00, which is less than the ৳ 100,000.00 this would take out.",
      {
        account_id: "e6622e4d-525a-44f4-8f4d-3205e44604cd",
        account: "Counter Cash Drawer",
        balance: "65450.00",
        requested: "100000.00",
      },
    );

    expect(error.fieldErrors()).toEqual([]);
    expect(error.message).toContain("Counter Cash Drawer holds");
  });

  it("returns nothing for INSUFFICIENT_STOCK, whose details are also context", () => {
    const error = new ApiError(409, "INSUFFICIENT_STOCK", "Only 3 in stock.", {
      sku: "RGN-CLA-L-NAV",
      available: 3,
      requested: 6,
    });

    expect(error.fieldErrors()).toEqual([]);
  });

  it("handles a missing or non-object details payload", () => {
    expect(new ApiError(400, "VALIDATION_ERROR", "Invalid.").fieldErrors()).toEqual([]);
    expect(new ApiError(400, "VALIDATION_ERROR", "Invalid.", "nope").fieldErrors()).toEqual([]);
  });
});

/**
 * Regression: a stale production API answered `/shop/navigation/` with
 * Django's own 404 HTML page. Parsing before checking the status turned that
 * into `SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON`
 * thrown from a bundled chunk — an error that names neither the status, the
 * URL, nor which upstream answered.
 */
describe("parseApiResponse", () => {
  // Django's own 404 page, byte for byte — this is what the stale production
  // API returned for /shop/navigation/.
  const HTML_404 = [
    "",
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    "  <title>Not Found</title>",
    "</head>",
    "<body>",
    "  <h1>Not Found</h1><p>The requested resource was not found on this server.</p>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  it("parses a JSON success body", () => {
    expect(
      parseApiResponse<{ ok: boolean }>(200, true, '{"ok":true}', "application/json", "/x/"),
    ).toEqual({ ok: true });
  });

  it("treats an empty body as null rather than a parse failure", () => {
    expect(parseApiResponse(200, true, "", null, "/x/")).toBeNull();
  });

  it("raises the status, not a SyntaxError, when an error body is HTML", () => {
    let thrown: unknown;
    try {
      parseApiResponse(404, false, HTML_404, "text/html; charset=utf-8", "/shop/navigation/");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(404);
    expect((thrown as ApiError).message).toContain("/shop/navigation/");
    expect(String(thrown)).not.toContain("Unexpected token");
  });

  it("still uses the documented envelope when the error body is JSON", () => {
    let thrown: unknown;
    try {
      parseApiResponse(
        409,
        false,
        JSON.stringify({ error: { code: "INSUFFICIENT_FUNDS", message: "No.", details: {} } }),
        "application/json",
        "/accounts/",
      );
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ApiError).code).toBe("INSUFFICIENT_FUNDS");
    expect((thrown as ApiError).message).toBe("No.");
  });

  it("names the upstream when a 2xx body is not JSON at all", () => {
    let thrown: unknown;
    try {
      parseApiResponse(200, true, HTML_404, "text/html", "/shop/navigation/");
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ApiError).code).toBe("UPSTREAM_NOT_JSON");
    expect((thrown as ApiError).message).toContain("text/html");
    expect((thrown as ApiError).message).toContain("/shop/navigation/");
  });
});
