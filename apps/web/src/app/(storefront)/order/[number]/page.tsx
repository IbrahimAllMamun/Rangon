import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge, Card } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";
import type { Order } from "@/lib/api/types";
import { dateTime, humanise, money } from "@/lib/format";

export const metadata: Metadata = {
  title: "Your order",
  robots: { index: false, follow: false },
};

type Params = Promise<{ number: string }>;
type Search = Promise<{ token?: string }>;

const STEPS = ["CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "DELIVERED"] as const;

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { number } = await params;
  const { token } = await searchParams;

  let order: Order;
  try {
    order = await apiServer<Order>(
      `/shop/orders/${number}/${token ? `?token=${encodeURIComponent(token)}` : ""}`,
      { auth: true },
    );
  } catch {
    notFound();
  }

  const currentStep = STEPS.indexOf(order.status as (typeof STEPS)[number]);
  const cancelled = order.status === "CANCELLED";

  return (
    <div className="container-rangon max-w-4xl py-10">
      <div className="rounded-xl border border-border bg-surface p-6 sm:p-8">
        <p className="text-caption font-semibold uppercase tracking-wide text-[var(--success)]">
          Order placed
        </p>
        <h1 className="font-display mt-2 text-h1">Thank you</h1>
        <p className="mt-2 text-body text-neutral-700">
          Your order <span className="font-semibold">{order.number}</span> is confirmed. We will
          call {order.customer_phone || "you"} before delivery.
        </p>

        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <Summary term="Order number" value={order.number} />
          <Summary term="Placed" value={dateTime(order.placed_at)} />
          <Summary term="Total" value={money(order.grand_total)} />
        </dl>
      </div>

      {!cancelled && (
        <section aria-labelledby="progress-heading" className="mt-8">
          <h2 id="progress-heading" className="text-h4">
            Progress
          </h2>
          <ol className="mt-4 grid grid-cols-5 gap-1">
            {STEPS.map((step, index) => {
              const done = currentStep >= index;
              return (
                <li key={step} className="flex flex-col items-center gap-2 text-center">
                  <span
                    className={`h-1.5 w-full rounded-full ${done ? "bg-brand-500" : "bg-neutral-200"}`}
                    aria-hidden
                  />
                  <span
                    className={`text-caption ${done ? "font-semibold text-neutral-900" : "text-muted"}`}
                  >
                    {humanise(step)}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="sr-only">Current status: {humanise(order.status)}</p>
        </section>
      )}

      {cancelled && (
        <div role="alert" className="mt-8 rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-4">
          <p className="text-body font-semibold text-[var(--error)]">This order was cancelled</p>
          {order.cancel_reason && <p className="mt-1 text-body-sm">{order.cancel_reason}</p>}
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <div className="border-b border-border p-4">
            <h2 className="text-h4">Items</h2>
          </div>
          <ul className="divide-y divide-border">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 p-4">
                <div>
                  <p className="text-body-sm font-medium">{item.product_name}</p>
                  <p className="text-caption text-muted">
                    {item.variant_label} · {item.sku} · Qty {item.quantity}
                  </p>
                </div>
                <p className="tabular shrink-0 text-body-sm">{money(item.line_total)}</p>
              </li>
            ))}
          </ul>
          <dl className="space-y-2 border-t border-border p-4 text-body-sm">
            <Row term="Subtotal" value={money(order.subtotal)} />
            {Number(order.discount_total) > 0 && (
              <Row term="Discount" value={`− ${money(order.discount_total)}`} />
            )}
            {Number(order.shipping_total) > 0 && (
              <Row term="Delivery" value={money(order.shipping_total)} />
            )}
            {Number(order.tax_total) > 0 && <Row term="VAT" value={money(order.tax_total)} />}
            <div className="flex items-baseline justify-between border-t border-border pt-3">
              <dt className="text-body font-semibold">Total</dt>
              <dd className="tabular text-h4 font-bold">{money(order.grand_total)}</dd>
            </div>
          </dl>
        </Card>

        <div className="space-y-6">
          <Card>
            <div className="border-b border-border p-4">
              <h2 className="text-h4">Delivery to</h2>
            </div>
            <address className="p-4 text-body-sm not-italic text-neutral-700">
              {order.shipping_address?.recipient_name}
              <br />
              {order.shipping_address?.line1}
              {order.shipping_address?.line2 && (
                <>
                  <br />
                  {order.shipping_address.line2}
                </>
              )}
              <br />
              {[order.shipping_address?.area, order.shipping_address?.city]
                .filter(Boolean)
                .join(", ")}
              <br />
              {order.shipping_address?.phone}
            </address>
          </Card>

          <Card>
            <div className="border-b border-border p-4">
              <h2 className="text-h4">Payment</h2>
            </div>
            <div className="space-y-2 p-4">
              <Badge
                tone={
                  order.payment_status === "PAID"
                    ? "success"
                    : order.payment_status === "UNPAID"
                      ? "warning"
                      : "info"
                }
              >
                {humanise(order.payment_status)}
              </Badge>
              {order.payments?.map((payment) => (
                <p key={payment.id} className="text-body-sm text-neutral-700">
                  {humanise(payment.method)} · {money(payment.amount)}
                </p>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {order.events && order.events.length > 0 && (
        <section aria-labelledby="timeline-heading" className="mt-8">
          <h2 id="timeline-heading" className="text-h4">
            Timeline
          </h2>
          <ol className="mt-4 space-y-3 border-l border-border pl-5">
            {order.events.map((event) => (
              <li key={event.id} className="relative">
                <span
                  className="absolute -left-[23px] top-1.5 size-2.5 rounded-full bg-brand-500"
                  aria-hidden
                />
                <p className="text-body-sm">{event.message || humanise(event.event_type)}</p>
                <p className="text-caption text-muted">{dateTime(event.created_at)}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/shop"
          className="rounded-md bg-brand-500 px-5 py-2.5 text-body-sm font-semibold text-white hover:bg-brand-600"
        >
          Continue shopping
        </Link>
        <Link
          href="/contact"
          className="rounded-md border border-neutral-300 px-5 py-2.5 text-body-sm font-semibold hover:bg-neutral-100"
        >
          Need help with this order?
        </Link>
      </div>
    </div>
  );
}

function Summary({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-caption text-muted">{term}</dt>
      <dd className="tabular mt-0.5 text-body font-semibold">{value}</dd>
    </div>
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
