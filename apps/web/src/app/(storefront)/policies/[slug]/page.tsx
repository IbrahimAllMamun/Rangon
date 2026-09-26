import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SitePageView, loadSitePage, sitePageMetadata } from "@/components/commerce/site-page-view";

/**
 * Policy pages: shipping, returns, privacy, terms.
 *
 * The copy is edited in Admin → Footer & pages → Pages (ADR-0012) and stored
 * sanitised by the API. It started as the defaults the software enforces
 * (docs/business-rules.md); the owner must still review and sign these off
 * before launch — see docs/operations/go-live-checklist.md.
 */

type Params = Promise<{ slug: string }>;

/** Only these live under /policies/; the shop's own pages are under /pages/. */
const POLICY_SLUGS = new Set(["shipping", "returns", "privacy", "terms"]);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  if (!POLICY_SLUGS.has(slug)) return { title: "Policy" };
  return sitePageMetadata(slug, "Policy");
}

export default async function PolicyPage({ params }: { params: Params }) {
  const { slug } = await params;
  if (!POLICY_SLUGS.has(slug)) notFound();

  return <SitePageView page={await loadSitePage(slug)} showUpdated />;
}
