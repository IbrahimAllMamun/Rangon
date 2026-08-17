"use client";

import { Check, Printer, ShoppingCart } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/primitives";
import type { Order, PosSession } from "@/lib/api/types";
import { dateTime, money } from "@/lib/format";

/**
 * Sale complete + 80 mm receipt.
 *
 * The receipt is normal DOM styled by the print stylesheet (globals.css
 * `@media print`), so any browser-visible printer works. A native ESC/POS
 * driver would slot in behind the same button.
 */
export function Receipt({
  order,
  session,
  onNewSale,
}: {
  order: Order;
  session: PosSession;
  onNewSale: () => void;
}) {
  const cashPayment = order.payments?.find((payment) => payment.method === "CASH");

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="no-print rounded-t-xl bg-[var(--success)] px-6 py-5 text-center text-white">
          <Check className="mx-auto size-8" aria-hidden />
          <h1 className="mt-2 text-h3">Sale complete</h1>
          <p className="tabular mt-1 text-body-lg">{money(order.grand_total)}</p>
          {cashPayment && Number(cashPayment.change_amount) > 0 && (
            <p className="tabular mt-2 rounded-md bg-white/15 px-3 py-2 text-h4 font-bold">
              Change due: {money(cashPayment.change_amount)}
            </p>
          )}
        </div>

        {/* --- the receipt itself ---------------------------------------- */}
        <div className="print-receipt rounded-b-xl border border-border bg-white p-5">
          <div className="text-center">
            <div className="flex justify-center">
              <Logo variant="vertical-on-light" height={72} />
            </div>
            <p className="mt-2 text-caption">{session.branch.name}</p>
            <p className="text-caption text-muted">{session.branch.address}</p>
            {session.branch.phone && <p className="text-caption text-muted">{session.branch.phone}</p>}
            {session.organization.vat_registration && (
              <p className="text-caption text-muted">
                VAT: {session.organization.vat_registration}
              </p>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-y-1 border-y border-dashed border-neutral-300 py-2 text-caption">
            <dt className="text-muted">Receipt</dt>
            <dd className="text-right font-medium">{order.number}</dd>
            <dt className="text-muted">Date</dt>
            <dd className="text-right">{dateTime(order.placed_at)}</dd>
            <dt className="text-muted">Cashier</dt>
            <dd className="text-right">{session.cashier.name}</dd>
            <dt className="text-muted">Register</dt>
            <dd className="text-right">{order.register || "—"}</dd>
          </dl>

          <table className="mt-3 w-full text-caption">
            <caption className="sr-only">Items purchased</caption>
            <thead>
              <tr className="border-b border-dashed border-neutral-300 text-left">
                <th scope="col" className="pb-1 font-medium">Item</th>
                <th scope="col" className="pb-1 text-center font-medium">Qty</th>
                <th scope="col" className="pb-1 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="py-1">
                    <span className="block">{item.product_name}</span>
                    <span className="block text-neutral-500">
                      {item.variant_label} @ {money(item.unit_price, false)}
                    </span>
                  </td>
                  <td className="tabular py-1 text-center">{item.quantity}</td>
                  <td className="tabular py-1 text-right">{money(item.line_total, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-2 space-y-0.5 border-t border-dashed border-neutral-300 pt-2 text-caption">
            <Line term="Subtotal" value={money(order.subtotal, false)} />
            {Number(order.discount_total) > 0 && (
              <Line term="Discount" value={`- ${money(order.discount_total, false)}`} />
            )}
            {Number(order.tax_total) > 0 && <Line term="VAT" value={money(order.tax_total, false)} />}
            <div className="flex justify-between border-t border-neutral-300 pt-1 text-body font-bold">
              <dt>TOTAL</dt>
              <dd className="tabular">{money(order.grand_total)}</dd>
            </div>

            {order.payments?.map((payment) => (
              <Line
                key={payment.id}
                term={payment.method === "MOBILE_MFS" ? "bKash / Nagad" : payment.method}
                value={money(payment.amount, false)}
              />
            ))}
            {cashPayment && Number(cashPayment.change_amount) > 0 && (
              <Line term="Change" value={money(cashPayment.change_amount, false)} />
            )}
          </dl>

          <p className="mt-4 whitespace-pre-line text-center text-caption text-neutral-600">
            {session.organization.receipt_footer}
          </p>
        </div>

        <div className="no-print mt-4 grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={() => window.print()}>
            <Printer aria-hidden /> Print receipt
          </Button>
          <Button size="lg" onClick={onNewSale} autoFocus>
            <ShoppingCart aria-hidden /> New sale
          </Button>
        </div>
      </div>
    </div>
  );
}

function Line({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-600">{term}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
