import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refuseCrossOrigin, siteOrigins } from "./same-origin";

const SITE = "https://shop.example";

function request(method: string, headers: Record<string, string>, url = `${SITE}/api/proxy/x`) {
  return new Request(url, { method, headers });
}

describe("refuseCrossOrigin", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = saved;
  });

  it("refuses a write from another origin on the same site", async () => {
    // What SameSite=Lax lets through: a subdomain is the same site.
    const refused = refuseCrossOrigin(
      request("PATCH", { origin: "https://blog.shop.example", host: "shop.example" }),
    );

    expect(refused?.status).toBe(403);
    expect((await refused?.json()).error.code).toBe("CROSS_ORIGIN_REFUSED");
  });

  it("refuses every state-changing method, and an opaque origin", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(refuseCrossOrigin(request(method, { origin: "https://evil.example" }))?.status).toBe(
        403,
      );
    }
    // Sandboxed frames and some redirects send `Origin: null`.
    expect(refuseCrossOrigin(request("POST", { origin: "null" }))?.status).toBe(403);
  });

  it("lets the site's own pages write", () => {
    expect(refuseCrossOrigin(request("POST", { origin: SITE, host: "shop.example" }))).toBeNull();
  });

  it("lets a request through Nginx write, where Host has lost the port", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:4100";
    const proxied = request(
      "POST",
      { origin: "http://localhost:4100", host: "localhost", "x-forwarded-proto": "http" },
      "http://localhost/api/proxy/x",
    );

    expect(refuseCrossOrigin(proxied)).toBeNull();
  });

  it("lets direct access write, where Host carries the port", () => {
    const direct = request(
      "POST",
      { origin: "http://127.0.0.1:4000", host: "127.0.0.1:4000" },
      "http://127.0.0.1:4000/api/proxy/x",
    );

    expect(refuseCrossOrigin(direct)).toBeNull();
  });

  it("does not judge reads, or requests no browser sent", () => {
    expect(refuseCrossOrigin(request("GET", { origin: "https://evil.example" }))).toBeNull();
    expect(refuseCrossOrigin(request("POST", {}))).toBeNull();
  });

  it("is not fooled by an origin that merely starts like the site's", () => {
    expect(
      refuseCrossOrigin(request("POST", { origin: "https://shop.example.evil.com" }))?.status,
    ).toBe(403);
  });
});

describe("siteOrigins", () => {
  it("honours the first protocol a proxy chain forwarded", () => {
    const origins = siteOrigins(
      new Request("http://shop.example/x", {
        headers: { host: "shop.example", "x-forwarded-proto": "https, http" },
      }),
    );

    expect(origins.has("https://shop.example")).toBe(true);
  });
});
