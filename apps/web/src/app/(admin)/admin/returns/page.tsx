import Link from "next/link";

import { PageHeader } from "@/components/admin/shell";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { Badge } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { RestockDecision, ReturnRequest, ReturnStatus } from "@/lib/api/types";
import { dateTime, humanise, money } from "@/lib/format";

export const metadata = { title: "Returns" };


const STATUS_TONE: Record<ReturnStatus, "warning" | "info" | "success" | "error"> = {
  REQUESTED: "warning",
  APPROVED: "info",
  RECEIVED: "info",
  COMPLETED: "success",
  REJECTED: "error",
};

const RESTOCK_TONE: Record<RestockDecision, "success" | "error" | "warning"> = {
  RESTOCK: "success",
  DAMAGED: "error",
  QUARANTINE: "warning",
};

type Search = Promise<Record<string, string | undefined>>;

export default async function ReturnsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["status", "reason", "page"]) {
    if (params[key]) query.set(key, params[key]!);
  }

  let data: Paginated<ReturnRequest> | null = null;
  let error: string | null = null;
  try {
    data = await apiServer<Paginated<ReturnRequest>>(`/returns/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load returns.";
  }

  const columns: Column<ReturnRequest>[] = [
    {
      header: "Return",
      cell: (row) => (
        <>
          <Link
            href={`/admin/returns/${row.id}`}
            className="block font-medium text-brand-600 hover:underline"
          >
            {row.number}
          </Link>
          <span className="block text-caption text-muted">Order {row.order_number}</span>
        </>
      ),
    },
    { header: "Customer", cell: (row) => row.customer_name },
    { header: "Reason", cell: (row) => humanise(row.reason) },
    {
      header: "Items",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.items.map((item) => (
            <Badge key={item.id} tone={RESTOCK_TONE[item.restock_decision] ?? "neutral"}>
              {item.sku} ×{item.quantity}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      header: "Status",
      cell: (row) => (
        <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{humanise(row.status)}</Badge>
      ),
    },
    { header: "Refund", numeric: true, cell: (row) => money(row.refund_amount) },
    { header: "Requested", cell: (row) => dateTime(row.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Returns"
        description="Only RESTOCK lines go back into sellable stock. DAMAGED and QUARANTINE never increase availability."
      />
      <ResourceTable
        rows={data?.results ?? []}
        columns={columns}
        caption="Return requests"
        error={error}
        emptyTitle="No returns"
        emptyDescription="Return requests from the storefront and the counter appear here."
        rowKey={(row) => row.id}
        footer={
          data
            ? `Showing ${data.results.length} of ${data.count}. Open a return to approve, receive and refund it; the POS handles in-store returns in one step.`
            : undefined
        }
      />
    </>
  );
}
