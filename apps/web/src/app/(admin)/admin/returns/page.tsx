import { PageHeader } from "@/components/admin/shell";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { Badge } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import { dateTime, humanise, money } from "@/lib/format";

export const metadata = { title: "Returns" };

interface ReturnRequest {
  id: string;
  number: string;
  order_number: string;
  customer_name: string;
  status: string;
  reason: string;
  refund_amount: string;
  refund_shipping: boolean;
  created_at: string;
  completed_at: string | null;
  items: { id: string; sku: string; product_name: string; quantity: number; restock_decision: string }[];
}

const STATUS_TONE: Record<string, "warning" | "info" | "success" | "error" | "neutral"> = {
  REQUESTED: "warning",
  APPROVED: "info",
  RECEIVED: "info",
  COMPLETED: "success",
  REJECTED: "error",
};

const RESTOCK_TONE: Record<string, "success" | "error" | "warning"> = {
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
          <span className="block font-medium">{row.number}</span>
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
            ? `Showing ${data.results.length} of ${data.count}. Approve / receive / refund are API-only for now; the POS handles in-store returns in one step.`
            : undefined
        }
      />
    </>
  );
}
