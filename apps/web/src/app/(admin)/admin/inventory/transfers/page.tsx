import Link from "next/link";
import { redirect } from "next/navigation";

import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { PageHeader } from "@/components/admin/shell";
import { StockTransferForm } from "@/components/admin/stock-transfer-form";
import { Card, ErrorState } from "@/components/ui/primitives";
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
      cell: (row) => row.items.reduce((sum, item) => sum + item.quantity, 0),
    },
    {
      header: "Value moved",
      numeric: true,
      cell: (row) =>
        money(
          row.items.reduce((sum, item) => sum + Number(item.unit_cost) * item.quantity, 0),
        ),
    },
    { header: "When", cell: (row) => dateTime(row.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Stock transfers"
        description="Moving stock between branches writes both sides in one transaction, and the weighted average cost travels with the goods — so neither branch's margin is distorted by the move."
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

          <section aria-labelledby="history">
            <h2 id="history" className="mb-3 text-h4 font-semibold">
              Recent transfers
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
