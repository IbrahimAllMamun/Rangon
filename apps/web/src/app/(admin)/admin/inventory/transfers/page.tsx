import Link from "next/link";
import { redirect } from "next/navigation";

import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { PageHeader } from "@/components/admin/shell";
import { StockTransferForm } from "@/components/admin/stock-transfer-form";
import { TransferReceipt } from "@/components/admin/transfer-receipt";
import { Badge, Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { BranchSummary, SessionUser, StockTransfer } from "@/lib/api/types";
import { dateTime, money } from "@/lib/format";

export const metadata = { title: "Stock transfers" };

export default async function StockTransfersPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/inventory/transfers");

  const canTransfer =
    user.permissions.includes("*") || user.permissions.includes("inventory.transfer");

  let transfers: StockTransfer[] = [];
  let branches: BranchSummary[] = [];
  let error: string | null = null;
  try {
    const [transferPage, branchPage] = await Promise.all([
      apiServer<Paginated<StockTransfer>>("/stock-transfers/?page_size=50"),
      apiServer<Paginated<BranchSummary>>("/branches/?page_size=100"),
    ]);
    transfers = transferPage.results;
    branches = branchPage.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load transfers.";
  }

  const inTransit = transfers.filter((row) => row.status === "IN_TRANSIT");

  const columns: Column<StockTransfer>[] = [
    { header: "Transfer", cell: (row) => <span className="font-mono">{row.number}</span> },
    {
      header: "Route",
      cell: (row) => (
        <span>
          {row.source_code} <span aria-label="to">→</span> {row.target_code}
        </span>
      ),
    },
    {
      header: "Products",
      cell: (row) => (
        <>
          {row.items.slice(0, 2).map((item) => (
            <span key={item.id} className="block text-caption">
              {item.quantity} × <span className="font-mono">{item.sku}</span>
            </span>
          ))}
          {row.items.length > 2 && (
            <span className="block text-caption text-muted">
              and {row.items.length - 2} more
            </span>
          )}
        </>
      ),
    },
    {
      header: "Units",
      numeric: true,
      cell: (row) => (
        <>
          {row.units_dispatched}
          {/* A short receipt is the interesting case, so say it here rather
              than making somebody open the row to find out. */}
          {row.units_lost > 0 && (
            <span className="block text-caption text-[var(--error)]">
              {row.units_lost} lost in transit
            </span>
          )}
        </>
      ),
    },
    {
      header: "Value moved",
      numeric: true,
      cell: (row) =>
        money(
          row.items.reduce((sum, item) => sum + Number(item.unit_cost) * item.quantity, 0),
        ),
    },
    {
      header: "Status",
      cell: (row) => <TransferBadge row={row} />,
    },
    { header: "Dispatched", cell: (row) => dateTime(row.dispatched_at ?? row.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Stock transfers"
        description="Stock leaves the source when it is dispatched and arrives when somebody at the destination says it did. In between it is on nobody's shelf — which is what stops a branch selling goods that are still in the van. Weighted average cost travels with the goods, frozen at dispatch."
        actions={
          <Link href="/admin/inventory" className="text-body-sm text-brand-600 hover:underline">
            ← Inventory
          </Link>
        }
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load transfers" description={error} />
        </Card>
      ) : (
        <div className="space-y-6">
          {canTransfer && (
            <StockTransferForm branches={branches} defaultSourceId={user.branch?.id ?? ""} />
          )}

          <section aria-labelledby="in-transit">
            <h2 id="in-transit" className="mb-3 text-h4 font-semibold">
              In transit
              {inTransit.length > 0 && (
                <span className="ml-2 align-middle text-body-sm font-normal text-muted">
                  {inTransit.length} awaiting receipt
                </span>
              )}
            </h2>
            <TransferReceipt transfers={inTransit} canReceive={canTransfer} />
          </section>

          <section aria-labelledby="history">
            <h2 id="history" className="mb-3 text-h4 font-semibold">
              All transfers
            </h2>
            <ResourceTable
              rows={transfers}
              columns={columns}
              caption="Stock transfers between branches"
              emptyTitle="No transfers yet"
              emptyDescription="Stock has not been moved between branches."
              rowKey={(row) => row.id}
            />
          </section>
        </div>
      )}
    </>
  );
}

/** Status, with the fact that makes it worth reading attached. */
function TransferBadge({ row }: { row: StockTransfer }) {
  if (row.status === "IN_TRANSIT") return <Badge tone="warning">In transit</Badge>;
  if (row.status === "CANCELLED") {
    return (
      <>
        <Badge tone="neutral">Turned back</Badge>
        {row.cancellation_reason && (
          <span className="mt-1 block text-caption text-muted">{row.cancellation_reason}</span>
        )}
      </>
    );
  }
  if (row.status === "RECEIVED") {
    return (
      <>
        <Badge tone={row.units_lost > 0 ? "warning" : "success"}>Received</Badge>
        <span className="mt-1 block text-caption text-muted">
          {row.received_by_name ? `${row.received_by_name} · ` : ""}
          {dateTime(row.received_at)}
        </span>
      </>
    );
  }
  return <Badge tone="neutral">Draft</Badge>;
}
