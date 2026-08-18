import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OrderActions } from "@/components/admin/order-actions";
import { OrderStatusBadge, PaymentStatusBadge } from "@/components/admin/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { apiServer, currentUser } from "@/lib/api/server";
import type { Order, SessionUser } from "@/lib/api/types";
import { dateTime, humanise, money } from "@/lib/format";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  try {
    const order = await apiServer<Order>(`/orders/${id}/`);
    return { title: order.number };
  } catch {
    return { title: "Order" };
  }
}

export default async function OrderDetailPage({ params }: { params: Params }) {
  const { id } = await params;

  let order: Order;
  try {
    order = await apiServer<Order>(`/orders/${id}/`);
  } catch {
    notFound();
  }

  const user = await currentUser<SessionUser>();
  const permissions = user?.permissions ?? [];

  return (
    <>
      <Link
        href="/admin/orders"
        className="mb-4 inline-flex items-center gap-1.5 text-body-sm text-muted hover:text-brand-600"
      >
        <ArrowLeft className="size-4" aria-hidden /> Back to orders
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-h2">{order.number}</h1>
          <p className="mt-1 text-body-sm text-muted">
            {humanise(order.channel)} · {dateTime(order.placed_at)}
            {order.created_by_email ? ` · ${order.created_by_email}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OrderStatusBadge status={order.status} />
          <PaymentStatusBadge status={order.payment_status} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Items</CardTitle>
              <Link
                href={`/admin/orders/${order.id}/print`}
                className="inline-flex items-center gap-1.5 text-body-sm text-brand-600 hover:underline"
              >
                <Printer className="size-4" aria-hidden /> Invoice / packing slip
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-body-sm">
                  <caption className="sr-only">Items on order {order.number}</caption>
                  <thead className="border-b border-border text-left text-caption uppercase text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">Product</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Qty</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Unit</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Returned</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {order.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-4 py-2.5">
                          <span className="block font-medium">{item.product_name}</span>
                          <span className="block text-caption text-muted">
                            {item.variant_label} · {item.sku}
                          </span>
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">{item.quantity}</td>
                        <td className="tabular px-4 py-2.5 text-right">{money(item.unit_price)}</td>
                        <td className="tabular px-4 py-2.5 text-right text-muted">
                          {item.returned_quantity || "—"}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right font-medium">
                          {money(item.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <dl className="space-y-1.5 border-t border-border p-4 text-body-sm">
                <Row term="Subtotal" value={money(order.subtotal)} />
                {Number(order.discount_total) > 0 && (
                  <Row term="Discount" value={`− ${money(order.discount_total)}`} />
                )}
                {Number(order.tax_total) > 0 && <Row term="VAT" value={money(order.tax_total)} />}
                {Number(order.shipping_total) > 0 && (
                  <Row term="Delivery" value={money(order.shipping_total)} />
                )}
                <div className="flex justify-between border-t border-border pt-2 text-body font-bold">
                  <dt>Total</dt>
                  <dd className="tabular">{money(order.grand_total)}</dd>
                </div>
                <Row term="Paid" value={money(order.paid_total)} />
                {Number(order.refunded_total) > 0 && (
                  <Row term="Refunded" value={money(order.refunded_total)} />
                )}
              </dl>
            </CardContent>
          </Card>

          {order.events && order.events.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 border-l border-border pl-5">
                  {order.events.map((event) => (
                    <li key={event.id} className="relative">
                      <span
                        className="absolute -left-[23px] top-1.5 size-2.5 rounded-full bg-brand-500"
                        aria-hidden
                      />
                      <p className="text-body-sm">
                        {event.message || humanise(event.event_type)}
                      </p>
                      <p className="text-caption text-muted">
                        {dateTime(event.created_at)}
                        {event.actor_email ? ` · ${event.actor_email}` : ""}
                      </p>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <OrderActions order={order} permissions={permissions} />

          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-body-sm">
              <p className="font-medium">{order.customer_name}</p>
              {order.customer_phone && (
                <p>
                  <a href={`tel:${order.customer_phone}`} className="text-brand-600 hover:underline">
                    {order.customer_phone}
                  </a>
                </p>
              )}
              {order.shipping_address?.line1 && (
                <address className="mt-3 not-italic text-neutral-700">
                  {order.shipping_address.recipient_name}
                  <br />
                  {order.shipping_address.line1}
                  {order.shipping_address.line2 && (
                    <>
                      <br />
                      {order.shipping_address.line2}
                    </>
                  )}
                  <br />
                  {[order.shipping_address.area, order.shipping_address.city]
                    .filter(Boolean)
                    .join(", ")}
                </address>
              )}
              {order.customer_note && (
                <p className="mt-3 rounded-md bg-neutral-100 p-2 text-caption">
                  “{order.customer_note}”
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payments</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-body-sm">
              {order.payments?.length ? (
                order.payments.map((payment) => (
                  <div key={payment.id} className="flex justify-between">
                    <span>
                      {humanise(payment.method)}
                      <span className="block text-caption text-muted">
                        {humanise(payment.status)}
                        {payment.reference ? ` · ${payment.reference}` : ""}
                      </span>
                    </span>
                    <span className="tabular font-medium">{money(payment.amount)}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted">No payments recorded.</p>
              )}

              {order.refunds?.map((refund) => (
                <div key={refund.id} className="flex justify-between text-[var(--error)]">
                  <span>
                    Refund
                    <span className="block text-caption">{refund.reason}</span>
                  </span>
                  <span className="tabular font-medium">− {money(refund.amount)}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Stock</CardTitle>
            </CardHeader>
            <CardContent className="text-body-sm">
              {order.stock_committed ? (
                <p className="text-[var(--success)]">
                  Deducted — the goods have left the shelf.
                </p>
              ) : order.status === "CANCELLED" ? (
                <p className="text-muted">Released back to available stock.</p>
              ) : (
                <p className="text-[var(--warning)]">
                  Reserved — held for this order, not yet deducted.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{term}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
