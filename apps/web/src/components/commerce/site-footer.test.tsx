/**
 * The storefront footer, drawn from `/shop/site/` (ADR-0012).
 *
 * What it must guarantee whatever the shop configures: the full address sits
 * under the logo, columns and social links come out in the shop's order, a
 * link off-site says it opens a new tab, and `{year}` is filled in.
 *
 * Plain matchers, no `toBeInTheDocument`: no vitest setup file registers
 * jest-dom (see receipt.test.tsx).
 */

import { render, screen, within } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import type { SitePayload } from "@/lib/api/types";
import { FALLBACK_SITE } from "@/lib/site/site";

import { SiteFooter } from "./site-footer";

// next/image has no loader outside Next; the logo is not what is under test.
vi.mock("@/components/brand/logo", () => ({
  LogoLink: () => <span>Rangon Fashion logo</span>,
}));
// `site.ts` is server-only (it imports next/headers via apiServer); only its
// fallback constant is used here.
vi.mock("@/lib/api/server", () => ({ apiServer: vi.fn() }));

function site(overrides: Partial<SitePayload> = {}): SitePayload {
  return {
    brand: {
      name: "Rangon Fashion",
      tagline: "Clothing, shoes, bags and cosmetics.",
      address: "Level 3, Bashundhara City\nPanthapath, Dhaka 1215",
      phone: "8801700000000",
      email: "hello@rangonfashion.com",
      opening_hours: [{ days: "Saturday–Thursday", hours: "10:00–20:00" }],
    },
    map: { embed_url: "", link_url: "https://maps.app.goo.gl/abc" },
    social: [
      { platform: "TIKTOK", label: "TikTok", url: "https://tiktok.com/@rangon" },
      { platform: "FACEBOOK", label: "Facebook", url: "https://facebook.com/rangon" },
    ],
    columns: [
      {
        id: "c1",
        label: "Shop",
        links: [
          { label: "Women", url: "/category/women", external: false },
          { label: "Lookbook", url: "https://lookbook.example", external: true },
        ],
      },
      {
        id: "c2",
        label: "Company",
        links: [{ label: "About us", url: "/about", external: false }],
      },
    ],
    bottom: { copyright: "© {year} Rangon Fashion.", note: "Cash on delivery." },
    whatsapp: null,
    ...overrides,
  };
}

describe("SiteFooter", () => {
  it("shows the full address, line by line, in an address element", () => {
    const { container } = render(<SiteFooter site={site()} />);

    const address = container.querySelector("address");
    expect(address).not.toBeNull();
    expect(Array.from(address!.querySelectorAll("span")).map((line) => line.textContent)).toEqual([
      "Level 3, Bashundhara City",
      "Panthapath, Dhaka 1215",
    ]);
  });

  it("puts the address after the logo in reading order", () => {
    const { container } = render(<SiteFooter site={site()} />);
    const text = container.textContent ?? "";
    expect(text.indexOf("Rangon Fashion logo")).toBeLessThan(text.indexOf("Level 3"));
  });

  it("links phone and email so they can be tapped", () => {
    render(<SiteFooter site={site()} />);
    expect(screen.getByRole("link", { name: /phone/i }).getAttribute("href")).toBe(
      "tel:+8801700000000",
    );
    expect(screen.getByRole("link", { name: /email/i }).getAttribute("href")).toBe(
      "mailto:hello@rangonfashion.com",
    );
  });

  it("names each social link and keeps the shop's order", () => {
    render(<SiteFooter site={site()} />);
    const list = screen.getByRole("list", { name: "Rangon Fashion on social media" });
    const names = within(list)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"));
    expect(names).toEqual([
      "Rangon Fashion on TikTok (opens in a new tab)",
      "Rangon Fashion on Facebook (opens in a new tab)",
    ]);
  });

  it("renders each column as labelled navigation, in order", () => {
    render(<SiteFooter site={site()} />);
    const navs = screen.getAllByRole("navigation");
    expect(navs.map((nav) => within(nav).getByRole("heading").textContent)).toEqual([
      "Shop",
      "Company",
    ]);
    expect(screen.getByRole("navigation", { name: "Shop" })).toBeTruthy();
  });

  it("opens an off-site link in a new tab and says so", () => {
    render(<SiteFooter site={site()} />);
    const external = screen.getByRole("link", { name: /Lookbook/ });
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
    expect(external.textContent).toContain("(opens in a new tab)");

    const internal = screen.getByRole("link", { name: "Women" });
    expect(internal.getAttribute("target")).toBeNull();
  });

  it("fills in the year", () => {
    render(<SiteFooter site={site()} />);
    expect(screen.getByText(`© ${new Date().getFullYear()} Rangon Fashion.`)).toBeTruthy();
  });

  it("leaves out what the shop has not set up", () => {
    const { container } = render(
      <SiteFooter
        site={site({
          brand: { ...site().brand, address: "", phone: "", email: "", opening_hours: [] },
          social: [],
          columns: [],
          bottom: { copyright: "© {year}", note: "" },
        })}
      />,
    );
    expect(container.querySelector("address")).toBeNull();
    expect(screen.queryByRole("list", { name: /social media/ })).toBeNull();
    expect(screen.queryAllByRole("navigation")).toEqual([]);
  });

  it("renders the static fallback when the API is unreachable", () => {
    render(<SiteFooter site={FALLBACK_SITE} />);
    expect(
      screen.getAllByRole("navigation").map((nav) => within(nav).getByRole("heading").textContent),
    ).toEqual(["Shop", "Help", "Company"]);
    expect(screen.getByRole("link", { name: "Privacy policy" }).getAttribute("href")).toBe(
      "/policies/privacy",
    );
  });
});
