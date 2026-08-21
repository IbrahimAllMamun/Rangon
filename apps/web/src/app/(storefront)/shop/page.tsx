import type { Metadata } from "next";
import Link from "next/link";
import { permanentRedirect } from "next/navigation";

import { FilterPanel } from "@/components/commerce/filter-panel";
import {
  type Facets,
  type ListingParams,
  ListingPagination,
  toQuery,
} from "@/components/commerce/listing";
import { ProductGrid } from "@/components/commerce/product-card";
import { PendingRegion } from "@/components/ui/pending-region";
import { EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { ShopCategory, ShopProduct } from "@/lib/api/types";

type SearchParams = Promise<ListingParams>;

/**
 * `/shop` browses everything and runs search. Category browsing moved to
 * `/category/[...slug]` (navigation.md §5); `?category=` still arrives from
 * old links and anything already indexed, and is permanently redirected.
 */
async function redirectTargetFor(params: ListingParams): Promise<string | null> {
  const slug = typeof params.category === "string" ? params.category : "";
  if (!slug) return null;

  let path = slug;
  try {
    const category = await apiServer<ShopCategory>(`/shop/categories/${slug}/`, {
      auth: false,
      revalidate: 300,
      tags: ["categories"],
    });
    path = category.path;
  } catch {
    // Unknown slug: still leave the query string behind. `/category/<slug>`
    // renders the 404 rather than a listing that silently ignores the filter.
  }

  const rest = toQuery({ ...params, category: undefined });
  return `/category/${path}${rest ? `?${rest}` : ""}`;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";

  return {
    title: query ? `Search: ${query}` : "Shop",
    description: query
      ? `Search results for “${query}” at Rangon Fashion.`
      : "Browse everything at Rangon Fashion.",
    // Filtered permutations must not compete with the canonical listing.
    robots:
      query || Object.keys(params).some((key) => key.startsWith("attr_"))
        ? { index: false, follow: true }
        : undefined,
    alternates: { canonical: "/shop" },
  };
}

export default async function ShopPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const redirectTarget = await redirectTargetFor(params);
  if (redirectTarget) permanentRedirect(redirectTarget);

  const query = toQuery(params);

  const [productsResult, facetsResult] = await Promise.allSettled([
    apiServer<Paginated<ShopProduct>>(`/shop/products/?${query}`, { auth: false }),
    apiServer<Facets>(`/shop/facets/?${toQuery({ q: params.q })}`, { auth: false }),
  ]);

  const products = productsResult.status === "fulfilled" ? productsResult.value : null;
  const facets = facetsResult.status === "fulfilled" ? facetsResult.value : null;

  const heading =
    typeof params.q === "string" && params.q ? `Results for “${params.q}”` : "All products";

  return (
    <div className="container-rangon py-8 sm:py-10">
      <nav aria-label="Breadcrumb" className="mb-4 text-caption text-muted">
        <ol className="flex items-center gap-2">
          <li>
            <Link href="/" className="hover:text-brand-600">
              Home
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-neutral-900">
            {heading}
          </li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-h1">{heading}</h1>
        <p className="text-body-sm text-muted" aria-live="polite">
          {products ? `${products.count} product${products.count === 1 ? "" : "s"}` : ""}
        </p>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[240px_1fr]">
        <FilterPanel facets={facets} />

        {/* Filtering, sorting and paging all rewrite the query string, which
            re-renders this same segment — no loading.tsx, no Suspense, no
            visible change until the server answers. PendingRegion holds the
            results in place and dims them so the wait is legible. */}
        <PendingRegion label="Updating products">
          {productsResult.status === "rejected" ? (
            <div role="alert" className="rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-6">
              <h2 className="text-body font-semibold text-[var(--error)]">
                Products could not be loaded
              </h2>
              <p className="mt-1 text-body-sm">Please refresh the page or try again shortly.</p>
            </div>
          ) : products && products.results.length > 0 ? (
            // Keyed on the query so a filter change remounts the grid and the
            // fade replays: the results dim, the loader confirms the work, then
            // the new set arrives visibly rather than swapping in silently.
            <div key={JSON.stringify(params)} className="route-fade">
              <ProductGrid products={products.results} />
              <ListingPagination
                basePath="/shop"
                params={params}
                count={products.count}
                hasNext={Boolean(products.next)}
              />
            </div>
          ) : (
            <EmptyState
              title="Nothing matches those filters"
              description="Try removing a filter, or search for something else."
              action={
                <Link href="/shop" className="text-body-sm font-medium text-brand-600 hover:underline">
                  Clear all filters
                </Link>
              }
            />
          )}
        </PendingRegion>
      </div>
    </div>
  );
}
