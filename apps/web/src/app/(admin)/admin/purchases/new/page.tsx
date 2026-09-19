import Link from "next/link";
import { redirect } from "next/navigation";

import { type ProductReference, PurchaseOrderForm } from "@/components/admin/purchase-order-form";
import type { SupplierRow } from "@/components/admin/supplier-form";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { getProductFormData } from "@/lib/commerce/product-form-data";

export const metadata = { title: "New purchase order" };

export default async function NewPurchaseOrderPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/purchases/new");

  const can = (code: string) => user.permissions.includes("*") || user.permissions.includes(code);
  if (!can("purchases.create")) {
    return (
      <>
        <PageHeader title="New purchase order" />
        <Card>
          <ErrorState
            title="You cannot raise purchase orders"
            description="This needs the purchases.create permission. Ask an owner or admin."
          />
        </Card>
      </>
    );
  }

  let suppliers: SupplierRow[] = [];
  let productReference: ProductReference | null = null;
  let error: string | null = null;
  try {
    // The new-product panel's lists are only fetched for someone who may use
    // it; the API refuses `products/quick-create/` without the permission anyway.
    const [page, reference] = await Promise.all([
      apiServer<Paginated<SupplierRow>>("/suppliers/?page_size=100"),
      can("products.create") ? getProductFormData() : Promise.resolve(null),
    ]);
    suppliers = page.results;
    productReference = reference
      ? {
          categories: reference.categories,
          brands: reference.brands,
          attributes: reference.attributes,
        }
      : null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load suppliers.";
  }

  if (error) {
    return (
      <>
        <PageHeader title="New purchase order" />
        <Card>
          <ErrorState title="Could not load suppliers" description={error} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New purchase order"
        description="Stock moves only when goods are received — straight away if they have already arrived, or later from the order."
      />

      <p className="mb-4 flex flex-wrap gap-4 text-body-sm">
        <Link href="/admin/purchases" className="text-brand-600 hover:underline">
          ← Purchase orders
        </Link>
        <Link href="/admin/suppliers" className="text-brand-600 hover:underline">
          Manage suppliers
        </Link>
      </p>

      <PurchaseOrderForm
        suppliers={suppliers}
        defaultBranchLabel={user.branch ? `${user.branch.name} (${user.branch.code})` : "Default branch"}
        productReference={productReference}
        canReceive={can("purchases.receive")}
      />
    </>
  );
}
