import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiServer } from "./server";

// apiServer reads the access-token cookie; the tests care about timing, not auth.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

function jsonResponse(payload: unknown): Response {
  return {
    status: 200,
    ok: true,
    // A real Response always carries headers, and apiServer reads the
    // content-type so it can name the upstream when something other than the
    // API answers. The double has to have them.
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(payload),
  } as Response;
}

describe("apiServer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the payload of a cached read that answers in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ slug: "shoes" }])));

    await expect(apiServer("/shop/categories/", { auth: false, revalidate: 300 })).resolves.toEqual([
      { slug: "shoes" },
    ]);
  });

  it("gives up on a cached read that never settles", async () => {
    // Next leaves a failed data-cache entry pending, so the fetch it hands back
    // for the next reader never resolves or rejects. Without the deadline this
    // hangs the render — and every storefront page with it.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const request = apiServer("/shop/categories/", { auth: false, revalidate: 300 });
    const assertion = expect(request).rejects.toMatchObject({
      status: 504,
      code: "UPSTREAM_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("honours a caller-supplied deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const request = apiServer("/shop/categories/", {
      auth: false,
      revalidate: 300,
      timeoutMs: 1_000,
    });
    const assertion = expect(request).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("never races a mutation", async () => {
    // Aborting a payment mid-flight is worse than waiting for it, so uncached
    // requests wait however long the API takes.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(jsonResponse({ number: "ORD-1" })), 30_000);
          }),
      ),
    );

    const request = apiServer("/shop/checkout/", { method: "POST", body: {} });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(request).resolves.toEqual({ number: "ORD-1" });
  });
});
