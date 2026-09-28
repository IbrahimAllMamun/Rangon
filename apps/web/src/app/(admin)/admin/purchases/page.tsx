import { Plus } from "lucide-react";
import Link from "next/link";

import { FilterField, FilterForm } from "@/components/admin/filter-form";
import { FilterTabs } from "@/components/admin/filter-tabs";
import { PageHeader } from "@/components/admin/shell";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { RowLink } from "@/components/admin/row-link";
import { Badge, Button } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import { dateOnly, humanise, money } from "@/lib/format";
import { applyPaging, listHref, readPaging } from "@/lib/paging";

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

const PATH = "/admin/purchases";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "PARTIALLY_RECEIVED", label: "Part received" },
  { value: "RECEIVED", label: "Received" },
  { value: "CLOSED", label: "Closed" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default async function PurchasesPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const paging = readPaging(params);
  const query = new URLSearchParams();
  // The dates are the day each order was raised, in the shop's timezone,
  // both ends included -- as the VAT return dates a purchase.
  for (const key of ["status", "supplier", "date_from", "date_to"]) {
    if (params[key]) query.set(key, params[key]!);
  }
  applyPaging(query, paging);

  let data: Paginated<PurchaseOrder> | null = null;
  let error: string | null = null;
  try {
    data = await apiServer<Paginated<PurchaseOrder>>(`/purchase-orders/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load purchase orders.";
  }

  const filtered = Boolean(params.status || params.date_from || params.date_to);

  const columns: Column<PurchaseOrder>[] = [
    {
      header: "Purchase",
      cell: (row) => (
        <>
          <RowLink
            href={`/admin/purchases/${row.id}`}
            className="block font-medium text-brand-700"
          >
            {row.number}
          </RowLink>
          {row.invoice_number && (
            <span className="block text-caption text-muted">Invoice {row.invoice_number}</span>
          )}
        </>
      ),
    },
    { header: "Supplier", cell: (row) => row.supplier_name },
    { header: "Raised", cell: (row) => dateOnly(row.created_at) },
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
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/admin/suppliers">Suppliers</Link>
            </Button>
            <Button asChild>
              <Link href="/admin/purchases/new">
                <Plus className="size-4" aria-hidden />
                New purchase order
              </Link>
            </Button>
          </>
        }
      />
      <FilterTabs
        label="Purchase order status"
        className="mb-4"
        tabs={STATUS_FILTERS.map((filter) => ({
          label: filter.label,
          href: listHref(PATH, params, { status: filter.value }),
          active: (params.status ?? "") === filter.value,
        }))}
      />

      <FilterForm
        action={PATH}
        label="Filter purchase orders by date"
        keep={{ status: params.status, supplier: params.supplier }}
        clearHref={listHref(PATH, params, { date_from: undefined, date_to: undefined })}
        active={Boolean(params.date_from || params.date_to)}
      >
        <FilterField
          id="purchase-from"
          name="date_from"
          type="date"
          label="Raised from"
          defaultValue={params.date_from ?? ""}
          max={params.date_to || undefined}
        />
        <FilterField
          id="purchase-to"
          name="date_to"
          type="date"
          label="Raised to"
          defaultValue={params.date_to ?? ""}
          min={params.date_from || undefined}
        />
      </FilterForm>

      <ResourceTable
        rows={data?.results ?? []}
        columns={columns}
        caption="Purchase orders"
        error={error}
        emptyTitle={filtered ? "No purchase order matches" : "No purchase orders"}
        emptyDescription={
          filtered
            ? "Nothing raised matches these filters."
            : "Raise one to bring stock in from a supplier."
        }
        rowKey={(row) => row.id}
        paging={
          data
            ? { count: data.count, ...paging, query: params, unit: "purchase orders" }
            : undefined
        }
      />
    </>
  );
}
