import { PageHeader } from "@/components/admin/shell";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { Badge } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import { dateOnly, humanise, money } from "@/lib/format";

export const metadata = { title: "Purchases" };

interface PurchaseOrder {
  id: string;
  number: string;
  supplier_name: string;
  branch_code: string;
  status: string;
  payment_status: string;
  invoice_number: string;
  expected_at: string | null;
  grand_total: string;
  paid_total: string;
  outstanding: string;
  created_at: string;
}

const STATUS_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "error"> = {
  DRAFT: "neutral",
  SENT: "info",
  PARTIALLY_RECEIVED: "warning",
  RECEIVED: "success",
  CLOSED: "neutral",
  CANCELLED: "error",
};

const PAYMENT_TONE: Record<string, "warning" | "success" | "neutral"> = {
  UNPAID: "warning",
  PARTIALLY_PAID: "warning",
  PAID: "success",
};

type Search = Promise<Record<string, string | undefined>>;

export default async function PurchasesPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["status", "supplier", "page"]) {
    if (params[key]) query.set(key, params[key]!);
  }

  let data: Paginated<PurchaseOrder> | null = null;
  let error: string | null = null;
  try {
    data = await apiServer<Paginated<PurchaseOrder>>(`/purchase-orders/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load purchase orders.";
  }

  const columns: Column<PurchaseOrder>[] = [
    {
      header: "Purchase",
      cell: (row) => (
        <>
          <span className="block font-medium">{row.number}</span>
          {row.invoice_number && (
            <span className="block text-caption text-muted">Invoice {row.invoice_number}</span>
          )}
        </>
      ),
    },
    { header: "Supplier", cell: (row) => row.supplier_name },
    {
      header: "Status",
      cell: (row) => (
        <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{humanise(row.status)}</Badge>
      ),
    },
    {
      header: "Payment",
      cell: (row) => (
        <Badge tone={PAYMENT_TONE[row.payment_status] ?? "neutral"}>
          {humanise(row.payment_status)}
        </Badge>
      ),
    },
    { header: "Expected", cell: (row) => dateOnly(row.expected_at) },
    { header: "Total", numeric: true, cell: (row) => money(row.grand_total) },
    { header: "Outstanding", numeric: true, cell: (row) => money(row.outstanding) },
  ];

  return (
    <>
      <PageHeader
        title="Purchases"
        description="Receiving is the only step that adds stock — it writes PURCHASE ledger rows and recalculates weighted average cost."
      />
      <ResourceTable
        rows={data?.results ?? []}
        columns={columns}
        caption="Purchase orders"
        error={error}
        emptyTitle="No purchase orders"
        emptyDescription="Create one to bring stock in from a supplier."
        rowKey={(row) => row.id}
        footer={
          data
            ? `Showing ${data.results.length} of ${data.count}. Creating and receiving is API-only for now (POST /purchase-orders/ and /receive/).`
            : undefined
        }
      />
    </>
  );
}
