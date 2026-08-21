import Link from "next/link";
import { redirect } from "next/navigation";

import { ProductForm } from "@/components/admin/product-form";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { getProductFormData } from "@/lib/commerce/product-form-data";
import { blankProduct } from "@/lib/commerce/product-values";

export const metadata = { title: "New product" };

export default async function NewProductPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/products/new");

  const allowed = user.permissions.includes("*") || user.permissions.includes("products.create");
  if (!allowed) {
    return (
      <>
        <PageHeader title="New product" />
        <Card>
          <ErrorState
            title="You cannot create products"
            description="Creating a product needs the products.create permission. Ask an owner or admin."
          />
        </Card>
      </>
    );
  }

  let data;
  try {
    data = await getProductFormData();
  } catch (caught) {
    return (
      <>
        <PageHeader title="New product" />
        <Card>
          <ErrorState
            title="Could not load categories and attributes"
            description={caught instanceof Error ? caught.message : "Try again in a moment."}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New product"
        description="Details first, then tick the values it comes in to build its variants."
      />

      <p className="mb-4 text-body-sm text-muted">
        <Link href="/admin/products" className="text-brand-600 hover:underline">
          ← All products
        </Link>
      </p>

      <ProductForm
        mode="create"
        initial={blankProduct()}
        initialVariants={[]}
        categories={data.categories}
        brands={data.brands}
        attributes={data.attributes}
        published={false}
        branchLabel={user.branch ? user.branch.name : "Default branch"}
        canDelete={false}
      />
    </>
  );
}
