import { PackagePlus } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ProductForm } from "@/components/admin/product-form";
import { ProductImages, type ColourOption, type ProductImageRow } from "@/components/admin/product-images";
import { ProductSuppliers, type SupplierOfferRow } from "@/components/admin/product-suppliers";
import { PageHeader } from "@/components/admin/shell";
import { Button, Card, ErrorState } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { apiServer, currentUser, type Paginated } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import type { ExistingVariant } from "@/lib/commerce/variant-matrix";
import { getProductFormData } from "@/lib/commerce/product-form-data";
import { purchaseOrderFor } from "@/lib/commerce/stock-adjust";
import type { ProductValues } from "@/lib/commerce/product-values";

interface AdminProductDetail {
  id: string;
  name: string;
  slug: string;
  category: string;
  category_name: string;
  brand: string | null;
  short_description: string;
  description: string;
  material: string;
  care_instructions: string;
  status: ProductValues["status"];
  published: boolean;
  featured: boolean;
  is_final_sale: boolean;
  seo_title: string;
  seo_description: string;
  /** Attribute-value ids stated as specifications — the flat set the form ticks. */
  spec_value_ids: string[];
  /** The size chart's id, or null for none. */
  size_chart: string | null;
  variants: ExistingVariant[];
  images: ProductImageRow[];
}

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  try {
    const product = await apiServer<{ name: string }>(`/products/${id}/`);
    return { title: product.name };
  } catch {
    return { title: "Product" };
  }
}

export default async function EditProductPage({ params }: { params: Params }) {
  const { id } = await params;

  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=/admin/products/${id}`);

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  let product: AdminProductDetail;
  let data: Awaited<ReturnType<typeof getProductFormData>>;
  try {
    [product, data] = await Promise.all([
      apiServer<AdminProductDetail>(`/products/${id}/`),
      getProductFormData(),
    ]);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    return (
      <>
        <PageHeader title="Product" />
        <Card>
          <ErrorState
            title="Could not load this product"
            description={caught instanceof Error ? caught.message : "Try again in a moment."}
          />
        </Card>
      </>
    );
  }

  // Allowed to fail on its own: a merchandiser without `purchases.view` still
  // gets the product, just without the supplier panel. One request covers every
  // variant, which is what `?product=` on the endpoint is for.
  let offers: SupplierOfferRow[] = [];
  if (can("purchases.view")) {
    try {
      const page = await apiServer<Paginated<SupplierOfferRow>>(
        `/supplier-products/?product=${product.id}&page_size=200`,
      );
      offers = page.results;
    } catch {
      offers = [];
    }
  }

  // What this branch has never received. A product defined here has no stock
  // until a purchase order brings it in (business-rules.md § 4.0a), so say so
  // and offer the order with these versions already on it.
  const unreceived = product.variants.filter(
    (variant) => variant.status !== "ARCHIVED" && variant.stock?.received === false,
  );
  const live = product.variants.filter((variant) => variant.status !== "ARCHIVED");

  const initial: ProductValues = {
    name: product.name,
    slug: product.slug,
    category: product.category,
    brand: product.brand ?? "",
    short_description: product.short_description,
    description: product.description,
    material: product.material,
    care_instructions: product.care_instructions,
    status: product.status,
    featured: product.featured,
    is_final_sale: product.is_final_sale,
    seo_title: product.seo_title,
    seo_description: product.seo_description,
  };

  return (
    <>
      <PageHeader
        title={product.name}
        description={`${product.variants.length} variant${product.variants.length === 1 ? "" : "s"} · ${product.category_name}`}
      />

      <p className="mb-4 flex flex-wrap gap-4 text-body-sm">
        <Link href="/admin/products" className="text-brand-700 hover:underline">
          ← All products
        </Link>
        {product.published && (
          <Link href={`/product/${product.slug}`} className="text-brand-700 hover:underline">
            View on storefront
          </Link>
        )}
      </p>

      {!can("products.update") && (
        <p className="mb-4 rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
          You can view this product but not change it. Editing needs the
          <code className="mx-1">products.update</code> permission — the API refuses the write
          regardless of what this screen shows.
        </p>
      )}

      {can("purchases.create") && unreceived.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4">
          <PackagePlus className="size-5 shrink-0 text-muted" aria-hidden />
          <p className="min-w-[16rem] flex-1 text-body-sm">
            {unreceived.length === live.length
              ? `Nothing has been received for this product at ${user.branch ? user.branch.name : "this branch"} yet, so there is no stock to sell.`
              : `${unreceived.length} of its ${live.length} versions have never been received at ${user.branch ? user.branch.name : "this branch"}.`}{" "}
            Stock comes in on a purchase order.
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link href={purchaseOrderFor(unreceived.map((variant) => variant.id))}>
              Raise a purchase order
            </Link>
          </Button>
        </div>
      )}

      <div className="space-y-6">
        <ProductForm
          mode="edit"
          productId={product.id}
          initial={initial}
          initialVariants={product.variants}
          initialSpecValues={product.spec_value_ids ?? []}
          initialSizeChart={product.size_chart ?? ""}
          sizeCharts={data.sizeCharts}
          categories={data.categories}
          brands={data.brands}
          attributes={data.attributes}
          published={product.published}
          branchLabel={user.branch ? user.branch.name : "Default branch"}
          canDelete={can("products.delete")}
        />

        {/* Images bind to a colour the product actually has a variant in, which
            is why this only exists once variants do (product-media.md B3). */}
        <ProductImages
          productId={product.id}
          images={product.images}
          colours={colourOptions(product.variants, data)}
        />

        {/* Who sells us this, and what each of them charges. Hidden entirely
            from someone who cannot see purchasing at all. */}
        {can("purchases.view") && (
          <ProductSuppliers offers={offers} canManage={can("purchases.create")} />
        )}
      </div>
    </>
  );
}

/** The colour values this product's variants use, with their AttributeValue ids. */
function colourOptions(
  variants: ExistingVariant[],
  data: Awaited<ReturnType<typeof getProductFormData>>,
): ColourOption[] {
  const colourCodes = new Set(
    data.attributes.filter((attribute) => attribute.kind === "COLOR").map((a) => a.code),
  );

  const options = new Map<string, ColourOption>();
  for (const variant of variants) {
    for (const attribute of variant.attributes) {
      if (!colourCodes.has(attribute.attribute_code)) continue;
      const valueId = data.valueIds[`${attribute.attribute_code}:${attribute.value}`];
      if (!valueId || options.has(valueId)) continue;
      options.set(valueId, {
        id: valueId,
        label: attribute.label || attribute.value,
        swatch: attribute.swatch,
      });
    }
  }
  return [...options.values()];
}
