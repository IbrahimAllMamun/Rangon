import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Nothing transactional or internal should ever be indexed.
        disallow: ["/admin", "/pos", "/checkout", "/cart", "/account", "/order/", "/api/"],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
