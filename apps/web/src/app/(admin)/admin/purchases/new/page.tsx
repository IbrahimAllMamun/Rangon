import Link from "next/link";
import { redirect } from "next/navigation";

import { PurchaseOrderForm } from "@/components/admin/purchase-order-form";
import type { SupplierRow } from "@/components/admin/supplier-form";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "New purchase order" };

export default async function NewPurchaseOrderPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/purchases/new");

  const allowed = user.permissions.includes("*") || user.permissions.includes("purchases.create");
  if (!allowed) {
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
  let error: string | null = null;
  try {
    const page = await apiServer<Paginated<SupplierRow>>("/suppliers/?page_size=100");
    suppliers = page.results;
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
        description="Raising an order does not move stock — that happens when the goods are received."
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
      />
    </>
  );
}
