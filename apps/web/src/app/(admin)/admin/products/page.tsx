import Link from "next/link";

import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import { dateOnly, money } from "@/lib/format";

export const metadata = { title: "Products" };

interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  category_name: string;
  brand_name: string;
  status: string;
  published: boolean;
  featured: boolean;
  variant_count: number;
  min_price: string | null;
  max_price: string | null;
  primary_image: { url: string; alt: string } | null;
  created_at: string;
}

type Search = Promise<Record<string, string | undefined>>;

export default async function ProductsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["search", "status", "category", "page"]) {
    if (params[key]) query.set(key, params[key]!);
  }

  let products: Paginated<AdminProduct> | null = null;
  let error: string | null = null;
  try {
    products = await apiServer<Paginated<AdminProduct>>(`/products/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load products.";
  }

  return (
    <>
      <PageHeader
        title="Products"
        description={
          products ? `${products.count} product${products.count === 1 ? "" : "s"}` : undefined
        }
      />

      <Card className="overflow-hidden">
        {error ? (
          <p role="alert" className="p-6 text-body-sm text-[var(--error)]">
            {error}
          </p>
        ) : !products || products.results.length === 0 ? (
          <EmptyState
            title="No products yet"
            description="Products appear here once they are created, or after running the demo seed."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Products</caption>
              <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Product</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Category</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Brand</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Variants</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Price</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.results.map((product) => (
                  <tr key={product.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-2.5">
                      <span className="block font-medium">{product.name}</span>
                      <Link
                        href={`/product/${product.slug}`}
                        className="text-caption text-brand-600 hover:underline"
                      >
                        View on storefront
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">{product.category_name}</td>
                    <td className="px-4 py-2.5 text-muted">{product.brand_name || "—"}</td>
                    <td className="tabular px-4 py-2.5 text-right">{product.variant_count}</td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {product.min_price ? money(product.min_price) : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={product.published ? "success" : "neutral"}>
                          {product.published ? "Published" : "Hidden"}
                        </Badge>
                        {product.featured && <Badge tone="brand">Featured</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{dateOnly(product.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
