import Link from "next/link";
import { redirect } from "next/navigation";

import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { PageHeader } from "@/components/admin/shell";
import { StartStockCount } from "@/components/admin/stock-count-actions";
import { Badge, Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser, StockCount, StockCountStatus } from "@/lib/api/types";
import { dateTime } from "@/lib/format";

export const metadata = { title: "Stock counts" };

const TONE: Record<StockCountStatus, "warning" | "success" | "neutral"> = {
  DRAFT: "neutral",
  COUNTING: "warning",
  APPLIED: "success",
  CANCELLED: "neutral",
};

export default async function StockCountsPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/inventory/counts");

  const canCount =
    user.permissions.includes("*") || user.permissions.includes("inventory.count");

  let counts: StockCount[] = [];
  let error: string | null = null;
  try {
    const page = await apiServer<Paginated<StockCount>>("/stock-counts/?page_size=50");
    counts = page.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load stock counts.";
  }

  const columns: Column<StockCount>[] = [
    {
      header: "Count",
      cell: (row) => (
        <Link
          href={`/admin/inventory/counts/${row.id}`}
          className="font-mono font-medium text-brand-600 hover:underline"
        >
          {row.number}
        </Link>
      ),
    },
    { header: "Branch", cell: (row) => row.branch_code },
    { header: "Opened", cell: (row) => dateTime(row.created_at) },
    { header: "Lines", numeric: true, cell: (row) => row.items.length },
    {
      header: "Counted",
      numeric: true,
      cell: (row) => row.items.filter((item) => item.counted_quantity !== null).length,
    },
    {
      header: "Status",
      cell: (row) => <Badge tone={TONE[row.status] ?? "neutral"}>{row.status}</Badge>,
    },
    { header: "Applied", cell: (row) => (row.applied_at ? dateTime(row.applied_at) : "—") },
  ];

  return (
    <>
      <PageHeader
        title="Stock counts"
        description="A count sheet snapshots what the ledger believes, so the difference against what is on the shelf is measurable. Applying one writes adjustments through the ledger — it never sets a number directly."
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load stock counts" description={error} />
        </Card>
      ) : (
        <div className="space-y-6">
          {canCount && user.branch && (
            <StartStockCount branchId={user.branch.id} branchLabel={user.branch.name} />
          )}

          <ResourceTable
            rows={counts}
            columns={columns}
            caption="Stock counts"
            emptyTitle="No counts yet"
            emptyDescription="Open one to compare the shelf against the ledger."
            rowKey={(row) => row.id}
          />
        </div>
      )}
    </>
  );
}
