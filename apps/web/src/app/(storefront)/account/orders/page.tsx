import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { OrderStatusBadge, PaymentStatusBadge } from "@/components/admin/status-badge";
import { Button, Card, EmptyState } from "@/components/ui/primitives";
import { apiServer, isAuthenticated } from "@/lib/api/client";
import type { Order } from "@/lib/api/types";
import { dateTime, money } from "@/lib/format";

export const metadata: Metadata = {
  title: "Your orders",
  robots: { index: false, follow: false },
};

export default async function AccountOrdersPage() {
  if (!(await isAuthenticated())) redirect("/login?next=/account/orders");

  let orders: Order[] = [];
  let error: string | null = null;
  try {
    const data = await apiServer<{ results: Order[] }>("/shop/account/orders/");
    orders = data.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load your orders.";
  }

  return (
    <div className="container-rangon max-w-4xl py-12">
      <h1 className="font-display text-h1">Your orders</h1>

      {error ? (
        <p role="alert" className="mt-6 text-body-sm text-[var(--error)]">
          {error}
        </p>
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Once you buy something it will show up here."
          action={
            <Button asChild>
              <Link href="/shop">Browse the shop</Link>
            </Button>
          }
        />
      ) : (
        <ul className="mt-6 space-y-4">
          {orders.map((order) => (
            <li key={order.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link
                      href={`/order/${order.number}`}
                      className="text-body font-semibold text-brand-600 hover:underline"
                    >
                      {order.number}
                    </Link>
                    <p className="text-caption text-muted">{dateTime(order.placed_at)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <OrderStatusBadge status={order.status} />
                    <PaymentStatusBadge status={order.payment_status} />
                    <span className="tabular text-body font-semibold">
                      {money(order.grand_total)}
                    </span>
                  </div>
                </div>
                <p className="mt-2 text-body-sm text-muted">
                  {order.item_count} item{order.item_count === 1 ? "" : "s"}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
