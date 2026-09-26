import type { Metadata } from "next";
import Link from "next/link";

import { SitePageView, loadSitePage, sitePageMetadata } from "@/components/commerce/site-page-view";

/** Copy is edited in Admin → Footer & pages → Pages → About (ADR-0012). */
export function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("about", "About");
}

export default async function AboutPage() {
  const page = await loadSitePage("about");

  return (
    <SitePageView page={page} lead>
      {page !== "unavailable" && (
        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/shop"
            className="rounded-md bg-brand-500 px-5 py-2.5 text-body-sm font-semibold text-white hover:bg-brand-600"
          >
            Browse the shop
          </Link>
          <Link
            href="/contact"
            className="rounded-md border border-neutral-300 px-5 py-2.5 text-body-sm font-semibold hover:bg-neutral-100"
          >
            Contact us
          </Link>
        </div>
      )}
    </SitePageView>
  );
}
