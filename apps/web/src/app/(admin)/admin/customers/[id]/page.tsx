import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CustomerAddresses } from "@/components/admin/customer-addresses";
import { CustomerForm, type CustomerRow } from "@/components/admin/customer-form";
import { CustomerNotes, type CustomerNoteRow } from "@/components/admin/customer-notes";
import { PageHeader } from "@/components/admin/shell";
import { OrderStatusBadge } from "@/components/admin/status-badge";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
} from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { Order, SessionUser } from "@/lib/api/types";
import { dateOnly, dateTime, humanise, money } from "@/lib/format";

export const metadata = { title: "Customer" };

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=/admin/customers/${id}`);

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);
  const canManage = can("customers.update");

  let customer: CustomerRow | null = null;
  let notes: CustomerNoteRow[] = [];
  let orders: Order[] = [];
  let error: string | null = null;

  try {
    customer = await apiServer<CustomerRow>(`/customers/${id}/`);
    // Notes and orders are separate reads: both are unpaginated sub-resources
    // and neither is needed to render the header, so a failure in one should
    // not blank the page.
    [notes, orders] = await Promise.all([
      apiServer<CustomerNoteRow[]>(`/customers/${id}/notes/`).catch(() => []),
      apiServer<Order[]>(`/customers/${id}/orders/`).catch(() => []),
    ]);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    error = caught instanceof Error ? caught.message : "Could not load this customer.";
  }

  if (error || !customer) {
    return (
      <>
        <PageHeader title="Customer" />
        <Card>
          <ErrorState
            title="Could not load this customer"
            description={error ?? "The record came back empty."}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={customer.name}
        description={[customer.phone, customer.email].filter(Boolean).join(" · ") || undefined}
      />

      <p className="mb-4 text-body-sm text-muted">
        <Link href="/admin/customers" className="text-brand-600 hover:underline">
          ← Customers
        </Link>
      </p>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge tone={customer.is_active ? "success" : "neutral"}>
          {customer.is_active ? "Active" : "Inactive"}
        </Badge>
        <Badge tone="neutral">{humanise(customer.customer_type)}</Badge>
        {customer.has_account && <Badge tone="info">Has a storefront login</Badge>}
        {customer.is_walk_in && <Badge tone="warning">Counter walk-in record</Badge>}
        {customer.tags.map((tag) => (
          <Badge key={tag} tone="brand">
            {tag}
          </Badge>
        ))}
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-caption uppercase text-muted">Orders</p>
            <p className="text-display-sm font-semibold">{customer.total_orders}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-caption uppercase text-muted">Lifetime value</p>
            <p className="text-display-sm font-semibold">{money(customer.total_spent)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-caption uppercase text-muted">Last order</p>
            <p className="text-display-sm font-semibold">{dateOnly(customer.last_order_at)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-caption uppercase text-muted">Customer since</p>
            <p className="text-display-sm font-semibold">{dateOnly(customer.created_at)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {canManage ? (
            <CustomerForm editing={customer} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-body-sm">
                <p>
                  <span className="text-muted">Phone: </span>
                  {customer.phone ?? "—"}
                </p>
                <p>
                  <span className="text-muted">Email: </span>
                  {customer.email ?? "—"}
                </p>
                <p>
                  <span className="text-muted">Date of birth: </span>
                  {dateOnly(customer.date_of_birth)}
                </p>
                {customer.notes && <p className="whitespace-pre-line">{customer.notes}</p>}
              </CardContent>
            </Card>
          )}

          <CustomerAddresses
            customerId={customer.id}
            customerName={customer.name}
            customerPhone={customer.phone ?? ""}
            addresses={customer.addresses}
            canManage={canManage}
          />
        </div>

        <div className="space-y-6">
          <CustomerNotes customerId={customer.id} notes={notes} canManage={canManage} />

          <Card>
            <CardHeader>
              <CardTitle>Order history</CardTitle>
            </CardHeader>
            <CardContent>
              {orders.length === 0 ? (
                <EmptyState
                  title="No orders yet"
                  description="Orders placed online or at the counter will appear here."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-body-sm">
                    <caption className="sr-only">Orders placed by {customer.name}</caption>
                    <thead className="border-b border-border text-left text-caption uppercase text-muted">
                      <tr>
                        <th scope="col" className="px-2 py-2 font-medium">
                          Order
                        </th>
                        <th scope="col" className="px-2 py-2 font-medium">
                          Placed
                        </th>
                        <th scope="col" className="px-2 py-2 font-medium">
                          Status
                        </th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {orders.map((order) => (
                        <tr key={order.id}>
                          <td className="px-2 py-2">
                            <Link
                              href={`/admin/orders/${order.id}`}
                              className="font-medium text-brand-600 hover:underline"
                            >
                              {order.number}
                            </Link>
                            <span className="block text-caption text-muted">
                              {humanise(order.channel)}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-muted">{dateTime(order.placed_at)}</td>
                          <td className="px-2 py-2">
                            <OrderStatusBadge status={order.status} />
                          </td>
                          <td className="px-2 py-2 text-right font-medium">
                            {money(order.grand_total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
