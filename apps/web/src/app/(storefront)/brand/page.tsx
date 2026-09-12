import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { EmptyState } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";

interface ShopBrandSummary {
  name: string;
  slug: string;
  description: string;
  logo: string;
  is_featured: boolean;
  product_count: number;
}

export const metadata: Metadata = {
  title: "Brands",
  description: "Every brand stocked at Rangon Fashion.",
  alternates: { canonical: "/brand" },
};

export default async function BrandIndexPage() {
  let brands: ShopBrandSummary[] = [];
  try {
    brands = await apiServer<ShopBrandSummary[]>("/shop/brands/", {
      auth: false,
      revalidate: 300,
      tags: ["brands"],
    });
  } catch {
    brands = [];
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
          <li aria-current="page" className="text-neutral-900">
            Brands
          </li>
        </ol>
      </nav>

      <h1 className="font-display text-h1">Brands</h1>
      <p className="mt-1 text-body-sm text-muted">
        Everything we stock, by the people who make it.
      </p>

      {brands.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="No brands to show yet"
            description="Brands appear here once they have something in stock."
          />
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {brands.map((brand) => (
            <li key={brand.slug}>
              <Link
                href={`/brand/${brand.slug}`}
                className="flex h-full items-center gap-4 rounded-xl border border-border bg-surface p-5 transition-colors duration-fast hover:border-brand-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]"
              >
                {brand.logo ? (
                  <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-white p-2">
                    <Image
                      src={brand.logo}
                      alt=""
                      width={48}
                      height={48}
                      className="h-full w-auto object-contain"
                    />
                  </span>
                ) : (
                  // Never a broken frame: a brand with no logo gets its initial.
                  <span
                    aria-hidden
                    className="grid size-14 shrink-0 place-items-center rounded-lg bg-neutral-100 font-display text-h4 text-neutral-500"
                  >
                    {brand.name.charAt(0)}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block font-medium">{brand.name}</span>
                  <span className="block text-caption text-muted">
                    {brand.product_count} product{brand.product_count === 1 ? "" : "s"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
