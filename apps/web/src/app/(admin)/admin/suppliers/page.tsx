import Link from "next/link";
import { redirect } from "next/navigation";

import type { SupplierRow } from "@/components/admin/supplier-form";
import { PageHeader } from "@/components/admin/shell";
import { SupplierManager } from "@/components/admin/supplier-manager";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Suppliers" };

export default async function SuppliersPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/suppliers");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  let suppliers: SupplierRow[] = [];
  let error: string | null = null;
  try {
    const page = await apiServer<Paginated<SupplierRow>>("/suppliers/?page_size=100");
    suppliers = page.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load suppliers.";
  }

  return (
    <>
      <PageHeader
        title="Suppliers"
        description={
          error ? undefined : `${suppliers.length} supplier${suppliers.length === 1 ? "" : "s"}`
        }
      />

      <p className="mb-4 text-body-sm text-muted">
        <Link href="/admin/purchases" className="text-brand-600 hover:underline">
          ← Purchase orders
        </Link>
      </p>

      {error ? (
        <Card>
          <ErrorState title="Could not load suppliers" description={error} />
        </Card>
      ) : (
        <SupplierManager suppliers={suppliers} canManage={can("purchases.create")} />
      )}
    </>
  );
}
