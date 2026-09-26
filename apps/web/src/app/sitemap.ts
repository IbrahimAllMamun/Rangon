import type { MetadataRoute } from "next";

import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import { listSitePages } from "@/lib/site/site";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const revalidate = 3600;

/** Used only if `/shop/pages/` cannot be reached: the pages every install has. */
const STANDARD_PAGES = [
  "/about",
  "/contact",
  "/policies/shipping",
  "/policies/returns",
  "/policies/privacy",
  "/policies/terms",
].map((path) => ({ path, updated_at: undefined as string | undefined }));

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Published pages only: an unpublished one 404s, and a sitemap must never
  // advertise a URL that does not resolve.
  const listed = await listSitePages();
  const pages = listed.length ? listed : STANDARD_PAGES;

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE}/shop`, changeFrequency: "daily", priority: 0.9 },
    ...pages.map((page) => ({
      url: `${SITE}${page.path}`,
      lastModified: page.updated_at,
      changeFrequency: page.path.startsWith("/policies/") ? ("yearly" as const) : ("monthly" as const),
      priority: page.path.startsWith("/policies/") ? 0.3 : 0.4,
    })),
  ];

  try {
    const [products, categories] = await Promise.all([
      apiServer<Paginated<{ slug: string }>>("/shop/products/?page_size=100", {
        auth: false,
        revalidate: 3600,
      }),
      apiServer<{ path: string; slug: string; children: { path: string; slug: string }[] }[]>(
        "/shop/categories/",
        { auth: false, revalidate: 3600 },
      ),
    ]);

    // Only the canonical path form is listed: `/shop?category=` permanently
    // redirects here, and a sitemap must never advertise a redirect.
    const categoryUrls = categories.flatMap((category) => [
      {
        url: `${SITE}/category/${category.path ?? category.slug}`,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      },
      ...category.children.map((child) => ({
        url: `${SITE}/category/${child.path ?? child.slug}`,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      })),
    ]);

    const productUrls = products.results.map((product) => ({
      url: `${SITE}/product/${product.slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }));

    return [...staticRoutes, ...categoryUrls, ...productUrls];
  } catch {
    // A sitemap missing its products is better than a 500 for a crawler.
    return staticRoutes;
  }
}
