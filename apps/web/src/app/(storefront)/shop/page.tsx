import type { Metadata } from "next";
import Link from "next/link";

import { FilterPanel } from "@/components/commerce/filter-panel";
import { ProductGrid } from "@/components/commerce/product-card";
import { PendingRegion } from "@/components/ui/pending-region";
import { EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { ShopProduct } from "@/lib/api/types";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const category = typeof params.category === "string" ? params.category : "";

  const title = query ? `Search: ${query}` : category ? titleise(category) : "Shop";
  return {
    title,
    description: `Browse ${title.toLowerCase()} at Rangon Fashion.`,
    // Filtered permutations must not compete with the canonical listing.
    robots: query || Object.keys(params).some((key) => key.startsWith("attr_"))
      ? { index: false, follow: true }
      : undefined,
    alternates: { canonical: category ? `/shop?category=${category}` : "/shop" },
  };
}

interface Facets {
  brands: { slug: string; name: string; count: number }[];
  attributes: {
    code: string;
    name: string;
    kind: string;
    values: { value: string; label: string; swatch: string; count: number }[];
  }[];
  price: { min: string; max: string };
}

function toQuery(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) search.append(key, entry);
  }
  return search.toString();
}

export default async function ShopPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = toQuery(params);

  const [productsResult, facetsResult] = await Promise.allSettled([
    apiServer<Paginated<ShopProduct>>(`/shop/products/?${query}`, { auth: false }),
    apiServer<Facets>(
      `/shop/facets/?${toQuery({ q: params.q, category: params.category })}`,
      { auth: false },
    ),
  ]);

  const products = productsResult.status === "fulfilled" ? productsResult.value : null;
  const facets = facetsResult.status === "fulfilled" ? facetsResult.value : null;

  const heading =
    typeof params.q === "string" && params.q
      ? `Results for “${params.q}”`
      : typeof params.category === "string" && params.category
        ? titleise(params.category)
        : "All products";

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
              <Pagination params={params} count={products.count} hasNext={Boolean(products.next)} />
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

function Pagination({
  params,
  count,
  hasNext,
}: {
  params: Record<string, string | string[] | undefined>;
  count: number;
  hasNext: boolean;
}) {
  const page = Number(params.page ?? 1);
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  if (totalPages <= 1) return null;

  const build = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "page" || value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) search.append(key, entry);
    }
    search.set("page", String(target));
    return `/shop?${search.toString()}`;
  };

  return (
    <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-2">
      {page > 1 && (
        <Link
          href={build(page - 1)}
          className="rounded-md border border-neutral-300 px-4 py-2 text-body-sm hover:bg-neutral-100"
        >
          Previous
        </Link>
      )}
      <span className="px-3 text-body-sm text-muted">
        Page {page} of {totalPages}
      </span>
      {hasNext && (
        <Link
          href={build(page + 1)}
          className="rounded-md border border-neutral-300 px-4 py-2 text-body-sm hover:bg-neutral-100"
        >
          Next
        </Link>
      )}
    </nav>
  );
}

function titleise(slug: string) {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
