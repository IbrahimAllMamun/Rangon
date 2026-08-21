"use client";

import { Ban, PackageCheck, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Textarea } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import {
  type OrderItem,
  type ReceiveDraft,
  defaultReceipt,
  receiptValue,
  toReceivePayload,
  validateReceipt,
} from "@/lib/commerce/purchase-order";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

export type OrderStatus =
  | "DRAFT"
  | "SENT"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CLOSED"
  | "CANCELLED";

/**
 * Send, cancel and receive a purchase order.
 *
 * **Receiving is the only action here that touches stock**, and it does so
 * through `POST /purchase-orders/{id}/receive/`, which writes `PURCHASE` rows to
 * the inventory ledger and recalculates weighted average cost inside one
 * transaction (ADR-0006, ADR-0008). There is no path from this component to a
 * stock column.
 */
export function PurchaseActions({
  orderId,
  status,
  items,
  branchLabel,
  canReceive,
  canManage,
}: {
  orderId: string;
  status: OrderStatus;
  items: OrderItem[];
  branchLabel: string;
  canReceive: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [receiving, setReceiving] = useState(false);
  const [drafts, setDrafts] = useState<ReceiveDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outstanding = items.filter((item) => item.quantity_outstanding > 0);
  const problems = useMemo(() => validateReceipt(drafts, items), [drafts, items]);
  const value = useMemo(() => receiptValue(drafts), [drafts]);
  const receivingNothing = drafts.every((draft) => Number(draft.quantity || 0) === 0);

  function openReceive() {
    setDrafts(defaultReceipt(items));
    setNotes("");
    setError(null);
    setReceiving(true);
  }

  function setDraft(itemId: string, patch: Partial<ReceiveDraft>) {
    setDrafts((current) =>
      current.map((draft) => (draft.itemId === itemId ? { ...draft, ...patch } : draft)),
    );
  }

  async function act(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await apiClient(`/purchase-orders/${orderId}/${path}/`, { method: "POST", body });
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That did not work. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    await act("send");
  }

  async function cancel() {
    // An inline field rather than window.prompt: the reason is stored on the
    // audit record, and a native prompt is unstyleable, unlabelled to a screen
    // reader, and silently suppressed in some browsers. Same shape as the stock
    // adjustment reason in the variant matrix.
    if (!cancelReason.trim()) {
      setError("Say why this order is being cancelled — it goes on the audit record.");
      return;
    }
    const ok = await act("cancel", { reason: cancelReason.trim() });
    if (ok) {
      setCancelling(false);
      setCancelReason("");
    }
  }

  async function receive() {
    if (problems.length > 0) return;
    if (receivingNothing) {
      setError("Enter a quantity for at least one line.");
      return;
    }
    const ok = await act("receive", {
      lines: toReceivePayload(drafts, items),
      notes,
    });
    if (ok) setReceiving(false);
  }

  const canSend = status === "DRAFT";
  const canCancelNow = status === "DRAFT" || status === "SENT";
  const canReceiveNow =
    (status === "SENT" || status === "PARTIALLY_RECEIVED") && outstanding.length > 0;

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-md bg-[var(--error-bg)] p-3 text-body-sm text-[var(--error)]">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canManage && canSend && (
          <Button onClick={send} loading={busy && !receiving}>
            <Send className="size-4" aria-hidden />
            Send to supplier
          </Button>
        )}

        {canReceive && canReceiveNow && (
          <Button variant={canSend ? "secondary" : "primary"} onClick={openReceive} disabled={busy}>
            <PackageCheck className="size-4" aria-hidden />
            Receive goods
          </Button>
        )}

        {canManage && canCancelNow && !cancelling && (
          <Button
            variant="ghost"
            onClick={() => {
              setCancelling(true);
              setError(null);
            }}
            disabled={busy}
          >
            <Ban className="size-4" aria-hidden />
            Cancel order
          </Button>
        )}

        {status === "RECEIVED" && (
          <p className="text-body-sm text-muted">
            Fully received. Stock is on the shelf at {branchLabel}.
          </p>
        )}
        {status === "CANCELLED" && (
          <p className="text-body-sm text-muted">This order was cancelled; nothing was received.</p>
        )}
      </div>

      {cancelling && (
        <Card>
          <CardHeader>
            <CardTitle>Cancel this purchase order</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field
              label="Reason"
              htmlFor="cancel-reason"
              required
              hint="Recorded on the audit log against this order."
            >
              <Input
                id="cancel-reason"
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="Supplier out of stock, ordered in error…"
                autoFocus
              />
            </Field>
            <div className="flex flex-wrap gap-3">
              <Button variant="destructive" onClick={cancel} loading={busy}>
                Cancel the order
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCancelling(false);
                  setCancelReason("");
                }}
                disabled={busy}
              >
                Keep it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {receiving && (
        <Card>
          <CardHeader>
            <CardTitle>Receive goods into {branchLabel}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-body-sm text-muted">
              Enter what actually arrived. Correct the unit cost if the supplier charged something
              different — that figure drives weighted average cost, so every future margin depends
              on it.
            </p>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Lines to receive</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Ordered</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Already in</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Outstanding</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Receiving now</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Unit cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {outstanding.map((item) => {
                    const draft = drafts.find((row) => row.itemId === item.id);
                    if (!draft) return null;
                    const problem = problems.find((row) => row.itemId === item.id);
                    const describe = `${item.product_name}${item.variant_label ? ` ${item.variant_label}` : ""}`;
                    return (
                      <tr key={item.id} className={cn(problem && "bg-[var(--error-bg)]")}>
                        <td className="px-3 py-2">
                          <span className="block font-medium">{item.product_name}</span>
                          <span className="font-mono block text-caption text-muted">
                            {item.sku}
                            {item.variant_label ? ` · ${item.variant_label}` : ""}
                          </span>
                          {problem && (
                            <span role="alert" className="block text-caption text-[var(--error)]">
                              {problem.message}
                            </span>
                          )}
                        </td>
                        <td className="tabular px-3 py-2 text-right">{item.quantity_ordered}</td>
                        <td className="tabular px-3 py-2 text-right text-muted">
                          {item.quantity_received}
                        </td>
                        <td className="tabular px-3 py-2 text-right font-medium">
                          {item.quantity_outstanding}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min="0"
                            max={item.quantity_outstanding}
                            step="1"
                            inputMode="numeric"
                            value={draft.quantity}
                            onChange={(event) => setDraft(item.id, { quantity: event.target.value })}
                            aria-label={`Quantity received for ${describe}`}
                            className="tabular h-8 w-24 text-right text-body-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            value={draft.unitCost}
                            onChange={(event) => setDraft(item.id, { unitCost: event.target.value })}
                            aria-label={`Unit cost received for ${describe}`}
                            className="tabular h-8 w-28 text-right text-body-sm"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Field label="Delivery note" htmlFor="receive-notes" hint="Optional. Kept on the receipt.">
              <Textarea
                id="receive-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={receive} loading={busy} disabled={problems.length > 0}>
                <PackageCheck className="size-4" aria-hidden />
                Receive {money(value)} of stock
              </Button>
              <Button variant="ghost" onClick={() => setReceiving(false)} disabled={busy}>
                Cancel
              </Button>
              <p className="text-caption text-muted">
                This writes <code>PURCHASE</code> rows to the inventory ledger and updates average
                cost. It cannot be undone — correct a mistake with a stock adjustment.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
