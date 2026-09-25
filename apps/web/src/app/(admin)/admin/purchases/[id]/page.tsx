import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ArrivedProducts, type UnpublishedProduct } from "@/components/admin/arrived-products";
import { PurchaseActions, type OrderStatus } from "@/components/admin/purchase-actions";
import { PageHeader } from "@/components/admin/shell";
import { SupplierPaymentForm } from "@/components/admin/supplier-payment-form";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorState } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { apiServer, currentUser, type Paginated } from "@/lib/api/server";
import type { Account, SessionUser } from "@/lib/api/types";
import type { OrderItem } from "@/lib/commerce/purchase-order";
import { dateOnly, dateTime, humanise, money, paymentMethodLabel } from "@/lib/format";

interface Receipt {
  id: string;
  number: string;
  received_at: string;
  received_by_email: string;
  notes: string;
  is_posted: boolean;
  items: { id: string; sku: string; quantity: number; unit_cost: string }[];
}

interface SupplierPayment {
  id: string;
  amount: string;
  method: string;
  reference: string;
  paid_at: string;
  notes: string;
  account_name: string;
}

interface PurchaseOrderDetail {
  id: string;
  number: string;
  supplier: string;
  supplier_name: string;
  branch: string;
  branch_code: string;
  status: OrderStatus;
  payment_status: string;
  invoice_number: string;
  ordered_at: string | null;
  expected_at: string | null;
  completed_at: string | null;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  shipping_total: string;
  grand_total: string;
  paid_total: string;
  outstanding: string;
  currency: string;
  notes: string;
  items: OrderItem[];
  receipts: Receipt[];
  /** Products on this order a shopper still cannot see. */
  unpublished_products: UnpublishedProduct[];
  created_at: string;
}

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "info" | "error"> = {
  DRAFT: "neutral",
  SENT: "info",
  PARTIALLY_RECEIVED: "warning",
  RECEIVED: "success",
  CLOSED: "neutral",
  CANCELLED: "error",
};

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  try {
    const order = await apiServer<{ number: string }>(`/purchase-orders/${id}/`);
    return { title: order.number };
  } catch {
    return { title: "Purchase order" };
  }
}

export default async function PurchaseOrderPage({ params }: { params: Params }) {
  const { id } = await params;

  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=/admin/purchases/${id}`);

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  let order: PurchaseOrderDetail;
  try {
    order = await apiServer<PurchaseOrderDetail>(`/purchase-orders/${id}/`);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    return (
      <>
        <PageHeader title="Purchase order" />
        <Card>
          <ErrorState
            title="Could not load this purchase order"
            description={caught instanceof Error ? caught.message : "Try again in a moment."}
          />
        </Card>
      </>
    );
  }

  const orderedUnits = order.items.reduce((total, item) => total + item.quantity_ordered, 0);
  const receivedUnits = order.items.reduce((total, item) => total + item.quantity_received, 0);

  // Both are allowed to fail on their own: a buyer without `finance.view` or
  // `purchases.view` still gets the order, just without the payment history or
  // the choice of which account the money leaves.
  let payments: SupplierPayment[] = [];
  try {
    const page = await apiServer<Paginated<SupplierPayment>>(
      `/supplier-payments/?purchase_order=${order.id}&page_size=50`,
    );
    payments = page.results;
  } catch {
    payments = [];
  }

  let accounts: Account[] = [];
  try {
    // The order's own branch only: its goods are what the money pays for, and
    // the server refuses any other branch's account (D95). Unfiltered, an
    // owner was offered every branch's drawer for every branch's order.
    const page = await apiServer<Paginated<Account>>(
      `/accounts/?is_active=true&branch=${order.branch}&page_size=50`,
    );
    accounts = page.results;
  } catch {
    accounts = [];
  }

  const canPay =
    can("purchases.pay") && !["DRAFT", "CANCELLED"].includes(order.status);

  return (
    <>
      <PageHeader
        title={order.number}
        description={`${order.supplier_name} · ${receivedUnits} of ${orderedUnits} units received`}
      />

      <p className="mb-4 flex flex-wrap gap-4 text-body-sm">
        <Link href="/admin/purchases" className="text-brand-600 hover:underline">
          ← Purchase orders
        </Link>
        <Link href="/admin/suppliers" className="text-brand-600 hover:underline">
          Suppliers
        </Link>
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        <Badge tone={STATUS_TONE[order.status] ?? "neutral"}>{humanise(order.status)}</Badge>
        <Badge tone={order.payment_status === "PAID" ? "success" : "neutral"}>
          {humanise(order.payment_status)}
        </Badge>
        <Badge tone="neutral">{order.branch_code}</Badge>
      </div>

      <div className="space-y-6">
        <PurchaseActions
          orderId={order.id}
          status={order.status}
          items={order.items}
          branchLabel={order.branch_code}
          canReceive={can("purchases.receive")}
          canManage={can("purchases.create")}
        />

        {/* Only once something has actually arrived. Before that, a product
            being a draft is not a problem — it is the plan. */}
        {order.receipts.length > 0 && (order.unpublished_products?.length ?? 0) > 0 && (
          <ArrivedProducts
            products={order.unpublished_products}
            canPublish={can("products.update")}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Order</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail term="Supplier" value={order.supplier_name} />
              <Detail term="Supplier invoice" value={order.invoice_number || "—"} />
              <Detail
                term="Expected"
                value={order.expected_at ? dateOnly(order.expected_at) : "Not stated"}
              />
              <Detail
                term="Sent"
                value={order.ordered_at ? dateTime(order.ordered_at) : "Not sent yet"}
              />
            </dl>
            {order.notes && <p className="mt-4 text-body-sm text-neutral-700">{order.notes}</p>}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Purchase order lines</caption>
              <thead className="border-y border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Product</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Ordered</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Received</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Outstanding</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Unit cost</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Line total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-2.5">
                      <span className="block font-medium">{item.product_name}</span>
                      <span className="font-mono block text-caption text-muted">
                        {item.sku}
                        {item.variant_label ? ` · ${item.variant_label}` : ""}
                      </span>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{item.quantity_ordered}</td>
                    <td className="tabular px-4 py-2.5 text-right">{item.quantity_received}</td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {item.quantity_outstanding > 0 ? (
                        <span className="font-medium text-[var(--warning)]">
                          {item.quantity_outstanding}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{money(item.unit_cost)}</td>
                    <td className="tabular px-4 py-2.5 text-right">{money(item.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CardContent>
            <dl className="ml-auto max-w-sm space-y-1.5 text-body-sm">
              <Row term="Subtotal" value={money(order.subtotal)} />
              {Number(order.discount_total) > 0 && (
                <Row term="Discount" value={`− ${money(order.discount_total)}`} />
              )}
              {/* Shown only when the supplier charged it, the same rule the
                  memo and the storefront follow. Without this row an order
                  carrying VAT reads as a subtotal and a grand total with an
                  unexplained gap between them. */}
              {Number(order.tax_total) > 0 && (
                <Row term="VAT" value={money(order.tax_total)} />
              )}
              {Number(order.shipping_total) > 0 && (
                <Row term="Shipping" value={money(order.shipping_total)} />
              )}
              <div className="flex items-baseline justify-between border-t border-border pt-1.5 text-body font-semibold">
                <dt>Grand total</dt>
                <dd className="tabular">{money(order.grand_total)}</dd>
              </div>
              <Row term="Paid" value={money(order.paid_total)} />
              <Row term="Outstanding" value={money(order.outstanding)} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Deliveries</CardTitle>
          </CardHeader>
          <CardContent>
            {order.receipts.length === 0 ? (
              <p className="text-body-sm text-muted">
                Nothing received yet. Each delivery is recorded here with what it added to the
                ledger.
              </p>
            ) : (
              <ul className="space-y-4">
                {order.receipts.map((receipt) => (
                  <li key={receipt.id} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-mono font-medium">{receipt.number}</span>
                      <span className="text-body-sm text-muted">{dateTime(receipt.received_at)}</span>
                      {receipt.received_by_email && (
                        <span className="text-caption text-muted">by {receipt.received_by_email}</span>
                      )}
                      <Badge tone={receipt.is_posted ? "success" : "warning"}>
                        {receipt.is_posted ? "Posted to the ledger" : "Not posted"}
                      </Badge>
                    </div>
                    <ul className="mt-2 space-y-0.5 text-body-sm text-neutral-700">
                      {receipt.items.map((line) => (
                        <li key={line.id} className="tabular">
                          {line.quantity} × <span className="font-mono">{line.sku}</span> at{" "}
                          {money(line.unit_cost)}
                        </li>
                      ))}
                    </ul>
                    {receipt.notes && (
                      <p className="mt-2 text-caption text-muted">{receipt.notes}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {payments.length === 0 ? (
              <p className="text-body-sm text-muted">
                {order.status === "DRAFT"
                  ? "This order has not been sent to the supplier yet, so nothing is owed on it."
                  : order.status === "CANCELLED"
                    ? "This order was cancelled, so nothing is owed on it."
                    : "Nothing paid yet. Each payment is recorded here and in the cash book."}
              </p>
            ) : (
              <ul className="space-y-3">
                {payments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border p-3"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="tabular font-medium">{money(payment.amount)}</span>
                      <Badge tone="neutral">{paymentMethodLabel(payment.method)}</Badge>
                      {payment.account_name && (
                        <span className="text-body-sm text-muted">
                          from {payment.account_name}
                        </span>
                      )}
                      {payment.reference && (
                        <span className="font-mono text-caption text-muted">
                          {payment.reference}
                        </span>
                      )}
                    </span>
                    <span className="text-body-sm text-muted">{dateTime(payment.paid_at)}</span>
                    {payment.notes && (
                      <p className="w-full text-caption text-muted">{payment.notes}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {canPay && (
          <SupplierPaymentForm
            purchaseOrderId={order.id}
            supplierId={order.supplier}
            outstanding={order.outstanding}
            accounts={accounts}
          />
        )}
      </div>
    </>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-caption uppercase text-muted">{term}</dt>
      <dd className="mt-0.5 text-body-sm">{value}</dd>
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{term}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
