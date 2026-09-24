import { ExternalLink, Plus, Upload } from "lucide-react";
import Link from "next/link";

import { Pagination } from "@/components/admin/pagination";
import { ROW_LINK_ABOVE, ROW_LINK_ROW, RowLink } from "@/components/admin/row-link";
import { PageHeader } from "@/components/admin/shell";
import { Badge, Button, Card, EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import { dateOnly, money } from "@/lib/format";
import { applyPaging, readPaging } from "@/lib/paging";

export const metadata = { title: "Products" };

/**
 * Where a product actually stands, which one boolean could not say.
 *
 * `status` and `published` are independent and the two surfaces read them
 * differently: the storefront needs `published=True AND status=ACTIVE`
 * (`catalog/search.py`), while the POS grid filters on `status=ACTIVE` alone
 * (`orders/api/pos_views.py`). So an active, unpublished product is not hidden
 * — it sells at the counter and not online, which is a real arrangement and
 * worth naming.
 *
 * The list used to render one badge, `published ? "Published" : "Hidden"`, so a
 * draft a buyer created from a purchase order looked identical to a live
 * product someone had deliberately taken offline.
 */
const FILTERS = [
  { key: "", label: "All", params: {} },
  { key: "draft", label: "Drafts", params: { status: "DRAFT" } },
  { key: "counter", label: "Counter only", params: { status: "ACTIVE", published: "false" } },
  { key: "published", label: "Published", params: { status: "ACTIVE", published: "true" } },
  { key: "archived", label: "Archived", params: { status: "ARCHIVED" } },
] as const;

/** Which tab the current query string corresponds to. */
function activeFilter(params: Record<string, string | undefined>): string {
  const status = params.status ?? "";
  const published = params.published ?? "";
  if (status === "DRAFT") return "draft";
  if (status === "ARCHIVED") return "archived";
  if (status === "ACTIVE" && published === "false") return "counter";
  if (status === "ACTIVE" && published === "true") return "published";
  return "";
}

/** The badge, from the pair rather than from `published` alone. */
function standing(product: { status: string; published: boolean }): {
  label: string;
  tone: "success" | "info" | "warning" | "neutral";
  title: string;
} {
  if (product.status === "DRAFT") {
    return {
      label: "Draft",
      tone: "warning",
      title: "Not on the storefront and not at the counter. Publish it to start selling.",
    };
  }
  if (product.status === "ARCHIVED") {
    return { label: "Archived", tone: "neutral", title: "Retired. Kept so history resolves." };
  }
  if (!product.published) {
    return {
      label: "Counter only",
      tone: "info",
      title: "Sells at the POS, hidden from the storefront.",
    };
  }
  return { label: "Published", tone: "success", title: "Live on the storefront and at the counter." };
}

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
  const paging = readPaging(params);
  const query = new URLSearchParams();
  for (const key of ["search", "status", "published", "category"]) {
    if (params[key]) query.set(key, params[key]!);
  }
  applyPaging(query, paging);

  const filtered = Boolean(
    params.search || params.status || params.published || params.category,
  );

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
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost">
              <Link href="/admin/products/import">
                <Upload className="size-4" aria-hidden />
                Import
              </Link>
            </Button>
            <Button asChild>
              <Link href="/admin/products/new">
                <Plus className="size-4" aria-hidden />
                New product
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const active = activeFilter(params) === filter.key;
          const search = new URLSearchParams();
          for (const [key, value] of Object.entries(filter.params)) search.set(key, value);
          // Keep the text search when switching tabs; dropping it silently
          // would look like the search had failed.
          if (params.search) search.set("search", params.search);
          return (
            <Link
              key={filter.key || "all"}
              href={`/admin/products${search.toString() ? `?${search}` : ""}`}
              aria-current={active ? "true" : undefined}
              className={`rounded-md px-3 py-1.5 text-body-sm font-medium ${
                active
                  ? "bg-neutral-900 text-white"
                  : "border border-border bg-surface hover:bg-neutral-100"
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        {error ? (
          <p role="alert" className="p-6 text-body-sm text-[var(--error)]">
            {error}
          </p>
        ) : !products || products.results.length === 0 ? (
          // An empty *filter* is not an empty catalogue. Offering "create the
          // first one" to someone who just clicked Drafts reads as though their
          // products had vanished.
          filtered ? (
            <EmptyState
              title="Nothing here"
              description="No product matches this filter."
              action={
                <Button asChild variant="ghost">
                  <Link href="/admin/products">Show all products</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No products yet"
              description="Create the first one, import a spreadsheet, or run the demo seed to populate the catalogue."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button asChild>
                    <Link href="/admin/products/new">
                      <Plus className="size-4" aria-hidden />
                      New product
                    </Link>
                  </Button>
                  <Button asChild variant="ghost">
                    <Link href="/admin/products/import">
                      <Upload className="size-4" aria-hidden />
                      Import a spreadsheet
                    </Link>
                  </Button>
                </div>
              }
            />
          )
        ) : (
          <>
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
                  <th scope="col" className="w-12 px-2 py-2.5">
                    <span className="sr-only">Storefront</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.results.map((product) => (
                  <tr key={product.id} className={ROW_LINK_ROW}>
                    <td className="px-4 py-2.5">
                      {/* The whole row opens the product for editing; the
                          storefront link sits above it in the last cell. */}
                      <RowLink
                        href={`/admin/products/${product.id}`}
                        className="font-medium group-hover/row:text-brand-600"
                      >
                        {product.name}
                      </RowLink>
                    </td>
                    <td className="px-4 py-2.5">{product.category_name}</td>
                    <td className="px-4 py-2.5 text-muted">{product.brand_name || "—"}</td>
                    <td className="tabular px-4 py-2.5 text-right">{product.variant_count}</td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {product.min_price ? money(product.min_price) : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {(() => {
                          const where = standing(product);
                          return (
                            <Badge tone={where.tone} title={where.title}>
                              {where.label}
                            </Badge>
                          );
                        })()}
                        {product.featured && <Badge tone="brand">Featured</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{dateOnly(product.created_at)}</td>
                    <td className="px-2 py-1.5 text-right">
                      {/* Only a live product has a storefront page; linking a
                          draft or counter-only product would open a 404. */}
                      {product.status === "ACTIVE" && product.published && (
                        <Link
                          href={`/product/${product.slug}`}
                          target="_blank"
                          rel="noopener"
                          title="View on storefront"
                          aria-label={`View ${product.name} on the storefront (opens in a new tab)`}
                          className={`${ROW_LINK_ABOVE} inline-flex size-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]`}
                        >
                          <ExternalLink className="size-4" aria-hidden />
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {/* Outside the scroll container, or the controls slide away with a
                wide table. */}
            <Pagination
              count={products.count}
              page={paging.page}
              pageSize={paging.pageSize}
              query={params}
              unit="products"
            />
          </>
        )}
      </Card>
    </>
  );
}
