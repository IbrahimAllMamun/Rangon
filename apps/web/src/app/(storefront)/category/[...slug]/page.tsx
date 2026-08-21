import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { FilterPanel } from "@/components/commerce/filter-panel";
import { ProductGrid } from "@/components/commerce/product-card";
import { PendingRegion } from "@/components/ui/pending-region";
import { EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { ShopCategory, ShopProduct } from "@/lib/api/types";
import { type Facets, ListingPagination, toQuery } from "@/components/commerce/listing";

type Params = Promise<{ slug: string[] }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Category listings live at a path, not a query parameter (navigation.md §5).
 *
 * The **last** segment resolves the category — `Category.slug` is globally
 * unique — and the rest is verified against its real ancestors. That means
 * `/category/kurti` and `/category/women/kurti` both work, but only the
 * canonical one is ever indexed: the other permanently redirects to it.
 */
async function getCategory(slug: string): Promise<ShopCategory | null> {
  try {
    return await apiServer<ShopCategory>(`/shop/categories/${slug}/`, {
      auth: false,
      revalidate: 300,
      tags: ["categories"],
    });
  } catch {
    return null;
  }
}

function canonicalFor(segments: string[]): string {
  return `/category/${segments.join("/")}`;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategory(slug[slug.length - 1]);
  if (!category) return { title: "Category not found" };

  return {
    title: category.seo_title || category.name,
    description:
      category.seo_description ||
      `Shop ${category.name.toLowerCase()} at Rangon Fashion.`,
    alternates: { canonical: canonicalFor(category.path.split("/")) },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);
  const category = await getCategory(slug[slug.length - 1]);
  if (!category) notFound();

  // One canonical path per category. `permanentRedirect` emits 308, which
  // crawlers treat exactly as 301 and which — unlike 301 — Next can issue from
  // a server component without a per-request middleware lookup.
  const canonicalSegments = category.path.split("/");
  if (canonicalSegments.join("/") !== slug.join("/")) {
    const query = toQuery(search);
    permanentRedirect(`${canonicalFor(canonicalSegments)}${query ? `?${query}` : ""}`);
  }

  const query = toQuery({ ...search, category: category.slug });
  const [productsResult, facetsResult] = await Promise.allSettled([
    apiServer<Paginated<ShopProduct>>(`/shop/products/?${query}`, { auth: false }),
    apiServer<Facets>(`/shop/facets/?category=${category.slug}`, { auth: false }),
  ]);

  const products = productsResult.status === "fulfilled" ? productsResult.value : null;
  const facets = facetsResult.status === "fulfilled" ? facetsResult.value : null;

  return (
    <div className="container-rangon py-8 sm:py-10">
      <nav aria-label="Breadcrumb" className="mb-4 text-caption text-muted">
        <ol className="flex flex-wrap items-center gap-2">
          <li>
            <Link href="/" className="hover:text-brand-600">
              Home
            </Link>
          </li>
          {category.breadcrumbs.map((crumb) => (
            <li key={crumb.slug} className="flex items-center gap-2">
              <span aria-hidden>/</span>
              <Link href={`/category/${crumb.path}`} className="hover:text-brand-600">
                {crumb.name}
              </Link>
            </li>
          ))}
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-neutral-900">
            {category.name}
          </li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-h1">{category.name}</h1>
        <p className="text-body-sm text-muted" aria-live="polite">
          {products ? `${products.count} product${products.count === 1 ? "" : "s"}` : ""}
        </p>
      </div>

      {category.description && (
        <p className="mt-3 max-w-2xl text-body text-neutral-700">{category.description}</p>
      )}

      {category.children.length > 0 && (
        <nav aria-label={`${category.name} subcategories`} className="mt-6">
          <ul className="flex flex-wrap gap-2">
            {category.children.map((child) => (
              <li key={child.slug}>
                <Link
                  href={`/category/${child.path}`}
                  className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-4 text-body-sm transition-colors duration-fast hover:border-brand-500 hover:text-brand-600"
                >
                  {child.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[240px_1fr]">
        <FilterPanel facets={facets} />

        <PendingRegion label="Updating products">
          {productsResult.status === "rejected" ? (
            <div
              role="alert"
              className="rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-6"
            >
              <h2 className="text-body font-semibold text-[var(--error)]">
                Products could not be loaded
              </h2>
              <p className="mt-1 text-body-sm">Please refresh the page or try again shortly.</p>
            </div>
          ) : products && products.results.length > 0 ? (
            <div key={JSON.stringify(search)} className="route-fade">
              <ProductGrid products={products.results} />
              <ListingPagination
                basePath={canonicalFor(canonicalSegments)}
                params={search}
                count={products.count}
                hasNext={Boolean(products.next)}
              />
            </div>
          ) : (
            <EmptyState
              title="Nothing matches those filters"
              description="Try removing a filter, or browse the whole category."
              action={
                <Link
                  href={canonicalFor(canonicalSegments)}
                  className="text-body-sm font-medium text-brand-600 hover:underline"
                >
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
