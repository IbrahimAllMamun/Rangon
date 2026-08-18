"use client";

import { Printer } from "lucide-react";
import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/primitives";
import type { Order } from "@/lib/api/types";
import { dateTime, humanise, money } from "@/lib/format";

/**
 * A4 invoice / packing slip.
 *
 * Same data, two documents: a packing slip shows no prices, because the person
 * packing the box does not need them and the customer's neighbour should not
 * read them off the outside.
 *
 * Printing goes through the browser dialog and the `@media print` rules in
 * globals.css. A native driver would replace only this component.
 */
export function PrintDocument({
  order,
  organization,
  documentType,
}: {
  order: Order;
  organization: {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    vat_registration?: string;
    receipt_footer?: string;
  };
  documentType: "INVOICE" | "PACKING_SLIP";
}) {
  const isInvoice = documentType === "INVOICE";

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => window.print()}>
          <Printer aria-hidden /> Print
        </Button>
        <Button asChild variant="secondary">
          <Link href={`/admin/orders/${order.id}/print?type=${isInvoice ? "packing-slip" : ""}`}>
            Switch to {isInvoice ? "packing slip" : "invoice"}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href={`/admin/orders/${order.id}`}>Back to order</Link>
        </Button>
      </div>

      <article className="print-a4 mx-auto max-w-[210mm] bg-white p-8 text-neutral-900 shadow-sm print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-neutral-900 pb-4">
          <Logo variant="full-on-light" height={36} />
          <div className="text-right text-caption">
            <h1 className="text-h3 font-bold">{isInvoice ? "INVOICE" : "PACKING SLIP"}</h1>
            <p className="mt-1 font-medium">{order.number}</p>
            <p className="text-neutral-600">{dateTime(order.placed_at)}</p>
          </div>
        </header>

        <div className="mt-6 grid grid-cols-2 gap-8 text-caption">
          <div>
            <h2 className="font-semibold uppercase tracking-wide text-neutral-600">From</h2>
            <p className="mt-1 font-medium">{organization.name}</p>
            <p className="whitespace-pre-line text-neutral-700">{organization.address}</p>
            {organization.phone && <p className="text-neutral-700">{organization.phone}</p>}
            {isInvoice && organization.vat_registration && (
              <p className="text-neutral-700">VAT: {organization.vat_registration}</p>
            )}
          </div>

          <div>
            <h2 className="font-semibold uppercase tracking-wide text-neutral-600">
              {isInvoice ? "Bill to" : "Deliver to"}
            </h2>
            <p className="mt-1 font-medium">
              {order.shipping_address?.recipient_name ?? order.customer_name}
            </p>
            <address className="not-italic text-neutral-700">
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
              {order.shipping_address?.phone ?? order.customer_phone}
            </address>
          </div>
        </div>

        <table className="mt-8 w-full text-caption">
          <caption className="sr-only">
            Items on {isInvoice ? "invoice" : "packing slip"} {order.number}
          </caption>
          <thead>
            <tr className="border-b border-neutral-400 text-left">
              <th scope="col" className="pb-2 font-semibold">Item</th>
              <th scope="col" className="pb-2 font-semibold">SKU</th>
              <th scope="col" className="pb-2 text-right font-semibold">Qty</th>
              {isInvoice && (
                <>
                  <th scope="col" className="pb-2 text-right font-semibold">Unit</th>
                  <th scope="col" className="pb-2 text-right font-semibold">Amount</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="border-b border-neutral-200">
                <td className="py-2">
                  <span className="block font-medium">{item.product_name}</span>
                  <span className="block text-neutral-600">{item.variant_label}</span>
                </td>
                <td className="py-2 font-mono">{item.sku}</td>
                <td className="tabular py-2 text-right">{item.quantity}</td>
                {isInvoice && (
                  <>
                    <td className="tabular py-2 text-right">{money(item.unit_price, false)}</td>
                    <td className="tabular py-2 text-right">{money(item.line_total, false)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {isInvoice ? (
          <div className="mt-6 flex justify-end">
            <dl className="w-64 space-y-1 text-caption">
              <Row term="Subtotal" value={money(order.subtotal)} />
              {Number(order.discount_total) > 0 && (
                <Row term="Discount" value={`− ${money(order.discount_total)}`} />
              )}
              {Number(order.tax_total) > 0 && <Row term="VAT" value={money(order.tax_total)} />}
              {Number(order.shipping_total) > 0 && (
                <Row term="Delivery" value={money(order.shipping_total)} />
              )}
              <div className="flex justify-between border-t-2 border-neutral-900 pt-1 text-body font-bold">
                <dt>Total</dt>
                <dd className="tabular">{money(order.grand_total)}</dd>
              </div>
              <Row term="Paid" value={money(order.paid_total)} />
              {Number(order.grand_total) - Number(order.paid_total) > 0 && (
                <Row
                  term="Due"
                  value={money(Number(order.grand_total) - Number(order.paid_total))}
                />
              )}
            </dl>
          </div>
        ) : (
          <div className="mt-8 border border-neutral-300 p-4 text-caption">
            <p className="font-semibold">Packed by ____________________</p>
            <p className="mt-3 font-semibold">Checked by ____________________</p>
            <p className="mt-3 text-neutral-600">
              {order.item_count} item{order.item_count === 1 ? "" : "s"} · {humanise(order.channel)}
            </p>
          </div>
        )}

        {order.customer_note && (
          <div className="mt-6 border-l-4 border-neutral-300 pl-3 text-caption">
            <p className="font-semibold">Customer note</p>
            <p className="text-neutral-700">{order.customer_note}</p>
          </div>
        )}

        <footer className="mt-10 border-t border-neutral-300 pt-4 text-center text-caption text-neutral-600">
          <p className="whitespace-pre-line">{organization.receipt_footer}</p>
        </footer>
      </article>
    </>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-600">{term}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
