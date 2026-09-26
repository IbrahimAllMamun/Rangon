/**
 * The footer's and the site pages' data source.
 *
 * SERVER ONLY — it reaches the API through `apiServer`.
 *
 * Like the navbar (lib/navigation/navigation.ts), the footer must never take
 * the storefront down: if `/shop/site/` is unreachable the layout renders
 * `FALLBACK_SITE`, which is the footer as it was before it became data —
 * links a shopper can always follow, and no contact details, because stale
 * ones are worse than none.
 *
 * No cookie is read here (`auth: false`). A cookie read in the storefront
 * layout switches every storefront page to dynamic rendering, and the nonce
 * CSP then broke sign-in and checkout (D74).
 */
import { ApiError } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { SitePage, SitePayload } from "@/lib/api/types";

/** Revalidated by tag whenever the footer, a social link or a page is saved. */
export const SITE_TAG = "site";

/** Footer content changes rarely; five minutes plus tag revalidation. */
const SITE_REVALIDATE = 300;

export const FALLBACK_SITE: SitePayload = {
  brand: {
    name: "Rangon Fashion",
    tagline: "Clothing, shoes, bags and cosmetics — online and at our Dhaka store.",
    address: "",
    phone: "",
    email: "",
    opening_hours: [],
  },
  map: { embed_url: "", link_url: "" },
  social: [],
  columns: [
    {
      id: "fallback-shop",
      label: "Shop",
      links: [
        { label: "New arrivals", url: "/shop?sort=newest", external: false },
        { label: "All brands", url: "/brand", external: false },
        { label: "Shop all", url: "/shop", external: false },
      ],
    },
    {
      id: "fallback-help",
      label: "Help",
      links: [
        { label: "Track your order", url: "/track", external: false },
        { label: "Shipping", url: "/policies/shipping", external: false },
        { label: "Returns & exchanges", url: "/policies/returns", external: false },
        { label: "Contact us", url: "/contact", external: false },
      ],
    },
    {
      id: "fallback-company",
      label: "Company",
      links: [
        { label: "About us", url: "/about", external: false },
        { label: "Privacy policy", url: "/policies/privacy", external: false },
        { label: "Terms of sale", url: "/policies/terms", external: false },
      ],
    },
  ],
  bottom: {
    copyright: "© {year} Rangon Fashion. All rights reserved.",
    note: "Cash on delivery available across Bangladesh.",
  },
  whatsapp: null,
};

export async function getSite(): Promise<SitePayload> {
  try {
    return await apiServer<SitePayload>("/shop/site/", {
      auth: false,
      revalidate: SITE_REVALIDATE,
      // A category rename changes a "Top categories" column.
      tags: [SITE_TAG, "navigation", "categories"],
    });
  } catch (error) {
    console.error("Footer content unavailable, using the static fallback:", error);
    return FALLBACK_SITE;
  }
}

/**
 * One published page, or `null` when there is no such page (the caller 404s).
 *
 * Any other failure is thrown, not swallowed into a fallback: showing a
 * privacy policy or terms from a copy baked into the build — possibly older
 * than the one the shop has since published — is worse than an error page.
 */
export async function getSitePage(slug: string): Promise<SitePage | null> {
  try {
    return await apiServer<SitePage>(`/shop/pages/${encodeURIComponent(slug)}/`, {
      auth: false,
      revalidate: SITE_REVALIDATE,
      tags: ["pages", `page:${slug}`],
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Published pages, for the sitemap and static params. Empty if the API is down. */
export async function listSitePages(): Promise<{ slug: string; path: string; updated_at: string }[]> {
  try {
    return await apiServer("/shop/pages/", {
      auth: false,
      revalidate: SITE_REVALIDATE,
      tags: ["pages"],
    });
  } catch {
    return [];
  }
}
