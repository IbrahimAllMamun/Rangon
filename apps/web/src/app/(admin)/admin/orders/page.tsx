import Link from "next/link";

import { PageHeader } from "@/components/admin/shell";
import { OrderStatusBadge, PaymentStatusBadge } from "@/components/admin/status-badge";
import { Card, EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { Order } from "@/lib/api/types";
import { dateTime, humanise, money } from "@/lib/format";

export const metadata = { title: "Orders" };

type Search = Promise<Record<string, string | undefined>>;

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "PROCESSING", label: "Processing" },
  { value: "PACKED", label: "Packed" },
  { value: "SHIPPED", label: "Shipped" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "CANCELLED", label: "Cancelled" },
];

const CHANNEL_FILTERS = [
  { value: "", label: "All channels" },
  { value: "POS", label: "POS" },
  { value: "ONLINE", label: "Online" },
];

export default async function OrdersPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["status", "channel", "search", "page"]) {
    if (params[key]) query.set(key, params[key]!);
  }

  let orders: Paginated<Order> | null = null;
  let error: string | null = null;
  try {
    orders = await apiServer<Paginated<Order>>(`/orders/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load orders.";
  }

  return (
    <>
      <PageHeader
        title="Orders"
        description={orders ? `${orders.count} order${orders.count === 1 ? "" : "s"}` : undefined}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => (
          <FilterLink
            key={filter.value || "all"}
            label={filter.label}
            active={(params.status ?? "") === filter.value}
            href={buildHref(params, { status: filter.value || undefined, page: undefined })}
          />
        ))}
        <span className="mx-2 w-px bg-border" aria-hidden />
        {CHANNEL_FILTERS.map((filter) => (
          <FilterLink
            key={filter.value || "all-channels"}
            label={filter.label}
            active={(params.channel ?? "") === filter.value}
            href={buildHref(params, { channel: filter.value || undefined, page: undefined })}
          />
        ))}
      </div>

      <Card className="overflow-hidden">
        {error ? (
          <p role="alert" className="p-6 text-body-sm text-[var(--error)]">
            {error}
          </p>
        ) : !orders || orders.results.length === 0 ? (
          <EmptyState title="No orders" description="Nothing matches these filters yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Orders</caption>
              <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Order</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Customer</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Channel</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Payment</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Placed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.results.map((order) => (
                  <tr key={order.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/admin/orders/${order.id}`}
                        className="font-medium text-brand-600 hover:underline"
                      >
                        {order.number}
                      </Link>
                      <span className="block text-caption text-muted">
                        {order.item_count} item(s)
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="block">{order.customer_name}</span>
                      <span className="block text-caption text-muted">{order.customer_phone}</span>
                    </td>
                    <td className="px-4 py-2.5">{humanise(order.channel)}</td>
                    <td className="px-4 py-2.5">
                      <OrderStatusBadge status={order.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <PaymentStatusBadge status={order.payment_status} />
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-medium">
                      {money(order.grand_total)}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{dateTime(order.placed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function FilterLink({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded-md px-3 py-1.5 text-body-sm font-medium ${
        active ? "bg-neutral-900 text-white" : "border border-border bg-surface hover:bg-neutral-100"
      }`}
    >
      {label}
    </Link>
  );
}

function buildHref(
  params: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...overrides })) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `/admin/orders?${query}` : "/admin/orders";
}
