import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RichText } from "@/components/commerce/rich-text";
import { ErrorState } from "@/components/ui/primitives";
import type { SitePage } from "@/lib/api/types";
import { dateOnly } from "@/lib/format";
import { getSitePage } from "@/lib/site/site";

/**
 * About, the policies and the shop's own pages, as written in
 * Admin → Footer & pages → Pages.
 *
 * Three outcomes, kept distinct on purpose:
 *   - the page exists and is published   -> render it
 *   - it does not, or is unpublished     -> 404
 *   - the API could not be reached       -> say so, and nothing else
 * The third deliberately renders no fallback copy: a privacy policy or terms
 * of sale baked into the build could be older than what the shop published.
 */
export async function loadSitePage(slug: string): Promise<SitePage | "unavailable"> {
  let page: SitePage | null;
  try {
    page = await getSitePage(slug);
  } catch (error) {
    console.error(`Site page "${slug}" unavailable:`, error);
    return "unavailable";
  }
  if (!page) notFound();
  return page;
}

export async function sitePageMetadata(slug: string, fallbackTitle: string): Promise<Metadata> {
  const page = await getSitePage(slug).catch(() => null);
  if (!page) return { title: fallbackTitle };
  // "About Rangon Fashion | Rangon Fashion" says the name twice.
  const title = page.title.includes("Rangon Fashion") ? { absolute: page.title } : page.title;
  return { title, description: page.meta_description || undefined };
}

export function SitePageView({
  page,
  lead = false,
  showUpdated = false,
  children,
}: {
  page: SitePage | "unavailable";
  lead?: boolean;
  /** Policies say when they last changed; marketing pages do not need to. */
  showUpdated?: boolean;
  children?: React.ReactNode;
}) {
  if (page === "unavailable") {
    return (
      <div className="container-rangon max-w-3xl py-12">
        <h1 className="sr-only">Page unavailable</h1>
        <ErrorState
          title="This page is not available right now"
          description="Please try again in a moment."
        />
      </div>
    );
  }

  return (
    <article className="container-rangon max-w-3xl py-12">
      <h1 className="font-display text-h1">{page.title}</h1>
      {showUpdated && page.updated_at && (
        <p className="mt-2 text-body-sm text-muted">
          Last updated <time dateTime={page.updated_at}>{dateOnly(page.updated_at)}</time>
        </p>
      )}
      {page.body && <RichText html={page.body} lead={lead} className="mt-6" />}
      {children}
    </article>
  );
}
