import { PageHeader } from "@/components/admin/shell";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { Badge } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import { dateOnly, humanise, money } from "@/lib/format";

export const metadata = { title: "Customers" };

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  customer_type: string;
  is_active: boolean;
  total_orders: number;
  total_spent: string;
  last_order_at: string | null;
  created_at: string;
}

type Search = Promise<Record<string, string | undefined>>;

export default async function CustomersPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["search", "customer_type", "page"]) {
    if (params[key]) query.set(key, params[key]!);
  }

  let data: Paginated<Customer> | null = null;
  let error: string | null = null;
  try {
    data = await apiServer<Paginated<Customer>>(`/customers/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load customers.";
  }

  const columns: Column<Customer>[] = [
    {
      header: "Customer",
      cell: (row) => (
        <>
          <span className="block font-medium">{row.name}</span>
          <span className="block text-caption text-muted">{humanise(row.customer_type)}</span>
        </>
      ),
    },
    { header: "Phone", cell: (row) => row.phone ?? "—" },
    { header: "Email", cell: (row) => row.email ?? "—" },
    { header: "Orders", numeric: true, cell: (row) => row.total_orders },
    { header: "Lifetime value", numeric: true, cell: (row) => money(row.total_spent) },
    { header: "Last order", cell: (row) => dateOnly(row.last_order_at) },
    {
      header: "Status",
      cell: (row) => (
        <Badge tone={row.is_active ? "success" : "neutral"}>
          {row.is_active ? "Active" : "Inactive"}
        </Badge>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Customers"
        description={
          data
            ? `${data.count} customer${data.count === 1 ? "" : "s"}. Identity is phone-first — many walk-in shoppers have no email.`
            : undefined
        }
      />
      <ResourceTable
        rows={data?.results ?? []}
        columns={columns}
        caption="Customers"
        error={error}
        emptyTitle="No customers yet"
        emptyDescription="Customers appear here after their first sale, online or at the counter."
        rowKey={(row) => row.id}
        footer={data ? `Showing ${data.results.length} of ${data.count}.` : undefined}
      />
    </>
  );
}
