import type { MetadataRoute } from "next";

import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE}/shop`, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE}/about`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${SITE}/contact`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${SITE}/policies/shipping`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE}/policies/returns`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE}/policies/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE}/policies/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];

  try {
    const [products, categories] = await Promise.all([
      apiServer<Paginated<{ slug: string }>>("/shop/products/?page_size=100", {
        auth: false,
        revalidate: 3600,
      }),
      apiServer<{ slug: string; children: { slug: string }[] }[]>("/shop/categories/", {
        auth: false,
        revalidate: 3600,
      }),
    ]);

    const categoryUrls = categories.flatMap((category) => [
      { url: `${SITE}/shop?category=${category.slug}`, changeFrequency: "weekly" as const, priority: 0.7 },
      ...category.children.map((child) => ({
        url: `${SITE}/shop?category=${child.slug}`,
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
