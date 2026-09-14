import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  type ListingParams,
  ListingPagination,
  toQuery,
} from "@/components/commerce/listing";
import { ProductGrid } from "@/components/commerce/product-card";
import { PendingRegion } from "@/components/ui/pending-region";
import { EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { ShopProduct } from "@/lib/api/types";

interface ShopBrand {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo: string;
  product_count: number;
}

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<ListingParams>;

async function loadBrand(slug: string): Promise<ShopBrand | null> {
  try {
    return await apiServer<ShopBrand>(`/shop/brands/${slug}/`, {
      auth: false,
      revalidate: 300,
      tags: ["brands"],
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const brand = await loadBrand((await params).slug);
  if (!brand) return { title: "Brand not found" };

  return {
    title: brand.name,
    description:
      brand.description || `Shop ${brand.name} at Rangon Fashion — ${brand.product_count} products.`,
    alternates: { canonical: `/brand/${brand.slug}` },
  };
}

export default async function BrandPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const listing = await searchParams;

  const brand = await loadBrand(slug);
  if (!brand) notFound();

  // The brand is the filter, so it is forced here rather than taken from the
  // query string — otherwise `/brand/aurelia?brand=carry` would show one
  // brand's products under another's name and logo.
  const query = toQuery({ ...listing, brand: brand.slug });

  let products: Paginated<ShopProduct> | null = null;
  try {
    products = await apiServer<Paginated<ShopProduct>>(`/shop/products/?${query}`, {
      auth: false,
    });
  } catch {
    products = null;
  }

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
          <li>
            <Link href="/brand" className="hover:text-brand-600">
              Brands
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-neutral-900">
            {brand.name}
          </li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-center gap-5">
        {brand.logo && (
          <span className="grid size-20 shrink-0 place-items-center rounded-xl border border-border bg-white p-3">
            <Image
              src={brand.logo}
              alt=""
              width={64}
              height={64}
              className="h-full w-auto object-contain"
            />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="font-display text-h1">{brand.name}</h1>
          {brand.description && (
            <p className="mt-1 max-w-2xl text-body-sm text-muted">{brand.description}</p>
          )}
          <p className="mt-1 text-body-sm text-muted" aria-live="polite">
            {products
              ? `${products.count} product${products.count === 1 ? "" : "s"}`
              : `${brand.product_count} products`}
          </p>
        </div>
      </header>

      <div className="mt-8">
        <PendingRegion label="Updating products">
          {products && products.results.length > 0 ? (
            <div key={JSON.stringify(listing)} className="route-fade">
              <ProductGrid products={products.results} />
              <ListingPagination
                basePath={`/brand/${brand.slug}`}
                params={listing}
                count={products.count}
                hasNext={Boolean(products.next)}
              />
            </div>
          ) : (
            <EmptyState
              title={`Nothing from ${brand.name} right now`}
              description="It may be out of stock or between seasons. Browse everything else in the meantime."
              action={
                <Link
                  href="/shop"
                  className="rounded-md bg-brand-500 px-4 py-2 text-body-sm font-semibold text-white hover:bg-brand-600"
                >
                  Shop everything
                </Link>
              }
            />
          )}
        </PendingRegion>
      </div>
    </div>
  );
}
