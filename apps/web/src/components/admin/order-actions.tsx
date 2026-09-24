"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { Account, Order, OrderStatus } from "@/lib/api/types";
import { humanise, money } from "@/lib/format";
import {
  METHOD_KIND,
  REFUND_METHODS,
  accountsFor,
  defaultRefundMethod,
  sourcePayment,
} from "@/lib/money-accounts";
import { refreshAfterWrite } from "@/lib/navigation/refresh-after-write";

/**
 * Status changes, payment capture and refunds.
 *
 * The buttons shown here follow the same status machine the backend enforces
 * (docs/architecture/orders.md §5.1). Hiding a button is a courtesy — the API
 * refuses the transition regardless.
 */
const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "DELIVERED"],
  SHIPPED: ["DELIVERED"],
};

export function OrderActions({
  order,
  permissions,
  accounts = [],
}: {
  order: Order;
  permissions: string[];
  /** Accounts the money can land in / come out of. Empty hides the choice. */
  accounts?: Account[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [captureAccount, setCaptureAccount] = useState("");
  const [refundAccount, setRefundAccount] = useState("");
  const [refundMethod, setRefundMethod] = useState(() => defaultRefundMethod(order.payments));

  const can = (code: string) => permissions.includes("*") || permissions.includes(code);
  const transitions = NEXT_STATUS[order.status] ?? [];
  const outstanding = Number(order.grand_total) - Number(order.paid_total);
  const refundable = Number(order.paid_total) - Number(order.refunded_total);

  // Only this order's branch's accounts, of the kind the money is: the API
  // refuses anything else (D95), and an owner's list spans every branch.
  const captureMethod = order.payments?.[0]?.method ?? "CASH";
  const captureCandidates = accountsFor(accounts, captureMethod, order.branch);
  const refundCandidates = accountsFor(accounts, refundMethod, order.branch);
  // Left blank, the refund leaves the account the payment came into when it
  // goes back the same way, and the branch's account for the method otherwise.
  const source = sourcePayment(order.payments);
  const sourceKind =
    accounts.find((row) => row.id === source?.account)?.kind ??
    (source ? METHOD_KIND[source.method] : undefined);
  const refundDefault =
    source?.account && sourceKind === METHOD_KIND[refundMethod]
      ? `Where it came in — ${source.account_name}`
      : "The branch's account for this method";

  async function run(label: string, work: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await work();
      await refreshAfterWrite(router);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That action could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  const changeStatus = (to: OrderStatus) =>
    run(to, () =>
      apiClient(`/orders/${order.id}/status/`, {
        method: "POST",
        body: { to_status: to },
      }),
    );

  const capturePayment = () =>
    run("capture", () =>
      apiClient(`/orders/${order.id}/payments/`, {
        method: "POST",
        body: {
          method: captureMethod,
          amount: outstanding.toFixed(2),
          // Blank lets the server pick the branch default for this method.
          account: captureAccount || null,
        },
      }),
    );

  const refund = () =>
    run("refund", () =>
      apiClient(`/orders/${order.id}/refunds/`, {
        method: "POST",
        idempotencyKey: `refund-${order.id}-${refundAmount}-${Date.now()}`,
        body: {
          amount: Number(refundAmount).toFixed(2),
          reason: refundReason,
          // Always stated: a card sale refunded in cash is a cash refund, and
          // it is the drawer the notes leave (business-rules.md §2.4).
          method: refundMethod,
          account: refundAccount || null,
        },
      }),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md bg-[var(--error-bg)] p-3 text-body-sm font-medium text-[var(--error)]">
            {error}
          </p>
        )}

        {can("orders.update_status") && transitions.length > 0 && (
          <div className="space-y-2">
            {transitions.map((next) => (
              <Button
                key={next}
                full
                variant={next === "CANCELLED" ? "destructive" : "primary"}
                loading={busy === next}
                onClick={() => {
                  if (next === "CANCELLED" && !confirm("Cancel this order and release its stock?"))
                    return;
                  void changeStatus(next);
                }}
              >
                Mark as {humanise(next).toLowerCase()}
              </Button>
            ))}
          </div>
        )}

        {can("sales.payment_record") && outstanding > 0.001 && (
          <div className="border-t border-border pt-4">
            <p className="text-body-sm">
              Outstanding: <span className="tabular font-semibold">{money(outstanding)}</span>
            </p>
            {captureCandidates.length > 1 && (
              <Field label="Money goes into" htmlFor="capture-account" className="mt-2">
                <Select
                  id="capture-account"
                  value={captureAccount}
                  onChange={(event) => setCaptureAccount(event.target.value)}
                >
                  <option value="">Branch default for this method</option>
                  {captureCandidates.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Button
              full
              variant="secondary"
              className="mt-2"
              loading={busy === "capture"}
              onClick={() => void capturePayment()}
            >
              Record payment received
            </Button>
            <p className="mt-1 text-caption text-muted">
              Use this when the courier remits a cash-on-delivery order.
            </p>
          </div>
        )}

        {can("sales.refund") && refundable > 0.001 && (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-body-sm">
              Refundable: <span className="tabular font-semibold">{money(refundable)}</span>
            </p>
            <Field label="Refund amount" htmlFor="refund-amount">
              <Input
                id="refund-amount"
                type="number"
                step="0.01"
                max={refundable}
                value={refundAmount}
                onChange={(event) => setRefundAmount(event.target.value)}
                placeholder={refundable.toFixed(2)}
              />
            </Field>
            <Field label="Reason" htmlFor="refund-reason">
              <Select
                id="refund-reason"
                value={refundReason}
                onChange={(event) => setRefundReason(event.target.value)}
              >
                <option value="">Choose a reason…</option>
                <option value="Customer returned the item">Customer returned the item</option>
                <option value="Item was defective">Item was defective</option>
                <option value="Wrong item delivered">Wrong item delivered</option>
                <option value="Goodwill">Goodwill</option>
              </Select>
            </Field>
            <Field label="Refund as" htmlFor="refund-method">
              <Select
                id="refund-method"
                value={refundMethod}
                onChange={(event) => {
                  setRefundMethod(event.target.value);
                  setRefundAccount("");
                }}
              >
                {REFUND_METHODS.map((row) => (
                  <option key={row.value} value={row.value}>
                    {row.label}
                  </option>
                ))}
              </Select>
            </Field>
            {refundCandidates.length > 0 && (
              <Field label="Money comes out of" htmlFor="refund-account">
                <Select
                  id="refund-account"
                  value={refundAccount}
                  onChange={(event) => setRefundAccount(event.target.value)}
                >
                  <option value="">{refundDefault}</option>
                  {refundCandidates.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Button
              full
              variant="destructive"
              loading={busy === "refund"}
              disabled={!refundAmount || Number(refundAmount) <= 0 || !refundReason}
              onClick={() => {
                if (!confirm(`Refund ${money(refundAmount)}? This cannot be undone.`)) return;
                void refund();
              }}
            >
              Issue refund
            </Button>
            <p className="text-caption text-muted">
              A refund never exceeds what was actually captured, and is recorded against the original
              payment.
            </p>
          </div>
        )}

        {transitions.length === 0 && refundable <= 0.001 && outstanding <= 0.001 && (
          <p className="text-body-sm text-muted">
            No further actions are available for a {humanise(order.status).toLowerCase()} order.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
