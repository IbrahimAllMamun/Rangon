/**
 * The navbar's data source.
 *
 * SERVER ONLY — it reaches the API through `apiServer`.
 *
 * Three layers of degradation (docs/architecture/navigation.md §6). Navigation
 * must never take the storefront down:
 *
 *   1. `NavigationItem` overrides            (resolved server-side)
 *   2. the category tree                     (resolved server-side)
 *   3. this file's static fallback           (API unreachable)
 */
import { apiServer } from "@/lib/api/server";
import type { NavigationNode, NavigationPayload } from "@/lib/api/types";

/** Cache tag revalidated when a category, menu item or banner is saved. */
export const NAVIGATION_TAG = "navigation";

/** Navigation changes rarely; five minutes plus tag revalidation is plenty. */
const NAVIGATION_REVALIDATE = 300;

function link(id: string, label: string, url: string): NavigationNode {
  return {
    id,
    label,
    url,
    type: "LINK",
    badge: null,
    layout: "AUTO",
    description: "",
    image: null,
    children: [],
  };
}

/**
 * Last resort. Deliberately four links a shopper can always act on rather than
 * a guess at the real catalogue, which would 404 if the guess were wrong.
 */
export const FALLBACK_NAVIGATION: NavigationPayload = {
  announcement: null,
  items: [
    link("fallback-home", "Home", "/"),
    link("fallback-shop", "Shop", "/shop"),
    link("fallback-new", "New Arrivals", "/shop?sort=newest"),
    link("fallback-sale", "Sale", "/shop?sort=price_asc"),
  ],
  footer: [],
};

export async function getNavigation(): Promise<NavigationPayload> {
  try {
    const payload = await apiServer<NavigationPayload>("/shop/navigation/", {
      auth: false,
      revalidate: NAVIGATION_REVALIDATE,
      tags: [NAVIGATION_TAG, "categories"],
    });
    // An API that answers with an empty menu is still a working API, but a
    // navbar with nothing in it is not a usable storefront — that happens on a
    // fresh install with no catalogue yet.
    if (!payload?.items?.length) {
      return {
        announcement: payload?.announcement ?? null,
        items: FALLBACK_NAVIGATION.items,
        footer: payload?.footer ?? [],
      };
    }
    return payload;
  } catch (error) {
    console.error("Navigation unavailable, using the static fallback:", error);
    return FALLBACK_NAVIGATION;
  }
}
