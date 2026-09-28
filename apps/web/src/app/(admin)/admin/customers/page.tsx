import { Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { FilterField, FilterForm } from "@/components/admin/filter-form";
import { FilterTabs } from "@/components/admin/filter-tabs";
import { PageHeader } from "@/components/admin/shell";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { RowLink } from "@/components/admin/row-link";
import { Badge, Button } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { dateOnly, humanise, money } from "@/lib/format";
import { applyPaging, listHref, readPaging } from "@/lib/paging";

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

const PATH = "/admin/customers";

const TYPES = [
  { value: "", label: "All" },
  { value: "REGISTERED", label: "Registered" },
  { value: "GUEST", label: "Guest" },
  { value: "WHOLESALE", label: "Wholesale" },
  // One per branch: the record every anonymous counter sale is filed against.
  { value: "WALK_IN", label: "Walk-in" },
];

export default async function CustomersPage({ searchParams }: { searchParams: Search }) {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/customers");

  const canCreate =
    user.permissions.includes("*") || user.permissions.includes("customers.create");

  const params = await searchParams;
  const paging = readPaging(params);
  const query = new URLSearchParams();
  for (const key of ["search", "customer_type"]) {
    if (params[key]) query.set(key, params[key]!);
  }
  applyPaging(query, paging);

  let data: Paginated<Customer> | null = null;
  let error: string | null = null;
  try {
    data = await apiServer<Paginated<Customer>>(`/customers/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load customers.";
  }

  const filtered = Boolean(params.search || params.customer_type);

  const columns: Column<Customer>[] = [
    {
      header: "Customer",
      cell: (row) => (
        <>
          <RowLink
            href={`/admin/customers/${row.id}`}
            className="block font-medium text-brand-700"
          >
            {row.name}
          </RowLink>
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
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/admin/customers/new">
                <Plus className="size-4" aria-hidden />
                New customer
              </Link>
            </Button>
          ) : undefined
        }
      />
      <FilterTabs
        label="Kind of customer"
        className="mb-4"
        tabs={TYPES.map((type) => ({
          label: type.label,
          href: listHref(PATH, params, { customer_type: type.value }),
          active: (params.customer_type ?? "") === type.value,
        }))}
      />

      <FilterForm
        action={PATH}
        label="Search customers"
        keep={{ customer_type: params.customer_type }}
        clearHref={listHref(PATH, params, { search: undefined })}
        active={Boolean(params.search)}
      >
        <FilterField
          id="customer-search"
          name="search"
          type="search"
          label="Name, phone or email"
          defaultValue={params.search ?? ""}
          placeholder="e.g. Tasnim or 01712…"
          className="min-w-[14rem] flex-1"
        />
      </FilterForm>

      <ResourceTable
        rows={data?.results ?? []}
        columns={columns}
        caption="Customers"
        error={error}
        emptyTitle={filtered ? "No customer matches" : "No customers yet"}
        emptyDescription={
          filtered
            ? "Nobody on file matches this search. Check the spelling, or try the last digits of the phone number."
            : "Customers appear here after their first sale, online or at the counter — or add one now."
        }
        rowKey={(row) => row.id}
        paging={
          data
            ? { count: data.count, ...paging, query: params, unit: "customers" }
            : undefined
        }
      />
    </>
  );
}
