import Link from "next/link";
import { redirect } from "next/navigation";

import { Pagination } from "@/components/admin/pagination";
import type { SupplierRow } from "@/components/admin/supplier-form";
import { PageHeader } from "@/components/admin/shell";
import { SupplierManager } from "@/components/admin/supplier-manager";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { applyPaging, readPaging } from "@/lib/paging";

export const metadata = { title: "Suppliers" };

type Search = Promise<Record<string, string | undefined>>;

export default async function SuppliersPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const paging = readPaging(params);
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/suppliers");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  let suppliers: SupplierRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    // Was a flat `page_size=100`, which silently stopped at the hundredth
    // supplier with nothing on screen to say so.
    const query = applyPaging(new URLSearchParams(), paging);
    const page = await apiServer<Paginated<SupplierRow>>(`/suppliers/?${query.toString()}`);
    suppliers = page.results;
    total = page.count;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load suppliers.";
  }

  return (
    <>
      <PageHeader
        title="Suppliers"
        description={error ? undefined : `${total} supplier${total === 1 ? "" : "s"}`}
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
        <>
          <SupplierManager suppliers={suppliers} canManage={can("purchases.create")} />
          <Card className="mt-4 overflow-hidden">
            <Pagination
              count={total}
              page={paging.page}
              pageSize={paging.pageSize}
              query={params}
              unit="suppliers"
              className="border-t-0"
            />
          </Card>
        </>
      )}
    </>
  );
}
