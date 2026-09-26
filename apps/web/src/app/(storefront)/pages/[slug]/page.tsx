import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SitePageView, loadSitePage, sitePageMetadata } from "@/components/commerce/site-page-view";

/**
 * Pages the shop adds itself — a size guide, an FAQ — in
 * Admin → Footer & pages → Pages (ADR-0012).
 *
 * The standard pages keep the addresses they always had (`/about`,
 * `/contact`, `/policies/*`), so they are not served here as well: one page,
 * one URL.
 */

type Params = Promise<{ slug: string }>;

const STANDARD_SLUGS = new Set(["about", "contact", "shipping", "returns", "privacy", "terms"]);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  if (STANDARD_SLUGS.has(slug)) return {};
  return sitePageMetadata(slug, "Page");
}

export default async function CustomPage({ params }: { params: Params }) {
  const { slug } = await params;
  if (STANDARD_SLUGS.has(slug)) notFound();

  return <SitePageView page={await loadSitePage(slug)} showUpdated />;
}
