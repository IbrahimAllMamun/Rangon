import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ProductForm } from "@/components/admin/product-form";
import { ProductImages, type ColourOption, type ProductImageRow } from "@/components/admin/product-images";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import type { ExistingVariant } from "@/lib/commerce/variant-matrix";
import { getProductFormData } from "@/lib/commerce/product-form-data";
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
        <Link href="/admin/products" className="text-brand-600 hover:underline">
          ← All products
        </Link>
        {product.published && (
          <Link href={`/product/${product.slug}`} className="text-brand-600 hover:underline">
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

      <div className="space-y-6">
        <ProductForm
          mode="edit"
          productId={product.id}
          initial={initial}
          initialVariants={product.variants}
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
