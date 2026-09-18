"use client";

import { Ban, PackageCheck, Send, Undo2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import {
  type OrderItem,
  type ReceiveDraft,
  type ReturnDraft,
  defaultReceipt,
  receiptValue,
  blankReturn,
  returnCredit,
  returnableOf,
  toReceivePayload,
  toReturnPayload,
  validateReturn,
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
  const [receiving, setReceiving] = useState(false);
  const [drafts, setDrafts] = useState<ReceiveDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [returning, setReturning] = useState(false);
  // Minted when the panel opens, so a retried submit of the *same* return is
  // recognised as a replay while a fresh return gets its own key.
  const returnKey = useRef("");
  const [returnDrafts, setReturnDrafts] = useState<ReturnDraft[]>([]);
  const [returnReason, setReturnReason] = useState("DEFECTIVE");
  const [returnNotes, setReturnNotes] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outstanding = items.filter((item) => item.quantity_outstanding > 0);
  const returnable = items.filter((item) => returnableOf(item) > 0);
  const returnProblems = useMemo(
    () => validateReturn(returnDrafts, items),
    [returnDrafts, items],
  );
  const credit = useMemo(() => returnCredit(returnDrafts, items), [returnDrafts, items]);
  const returningNothing = returnDrafts.every((draft) => Number(draft.quantity || 0) === 0);
  const problems = useMemo(() => validateReceipt(drafts, items), [drafts, items]);
  const value = useMemo(() => receiptValue(drafts), [drafts]);
  const receivingNothing = drafts.every((draft) => Number(draft.quantity || 0) === 0);

  function openReceive() {
    setDrafts(defaultReceipt(items));
    setNotes("");
    setError(null);
    setReceiving(true);
  }

  function openReturn() {
    returnKey.current = crypto.randomUUID();
    setReturnDrafts(blankReturn(items));
    setReturnReason("DEFECTIVE");
    setReturnNotes("");
    setError(null);
    setReturning(true);
  }

  function setReturnDraft(itemId: string, quantity: string) {
    setReturnDrafts((current) =>
      current.map((draft) => (draft.itemId === itemId ? { ...draft, quantity } : draft)),
    );
  }

  /**
   * Send goods back. An `Idempotency-Key` because a replay would take the stock
   * off the shelf twice and credit the order twice — the endpoint honours it,
   * and this is the click that would produce one.
   */
  async function sendBack() {
    if (returnProblems.length > 0) return;
    if (returningNothing) {
      setError("Enter a quantity for at least one line.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiClient(`/purchase-orders/${orderId}/return/`, {
        method: "POST",
        body: {
          lines: toReturnPayload(returnDrafts),
          reason: returnReason,
          notes: returnNotes,
        },
        idempotencyKey: returnKey.current,
      });
      setReturning(false);
      reload();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not record the return. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function setDraft(itemId: string, patch: Partial<ReceiveDraft>) {
    setDrafts((current) =>
      current.map((draft) => (draft.itemId === itemId ? { ...draft, ...patch } : draft)),
    );
  }

  /**
   * Call the endpoint, then reload the page outright.
   *
   * `router.refresh()` is unreliable on this screen and it was measured, not
   * guessed: receive the goods, read the page without reloading, and it still
   * showed the un-received state in **3 runs out of 5** — bimodal, landing in
   * ~220 ms or never at all, even given 45 seconds. The server had re-rendered
   * correctly every time (the RSC response carried the new receipt); the
   * browser simply discarded it. A manual reload always showed the truth.
   *
   * Two explanations were tested and **both were wrong**, recorded so nobody
   * spends the time again: moving `router.refresh()` after the local state
   * updates so it could not be interrupted (still 2/5), and disabling the
   * admin sidebar's link prefetching, which `force-dynamic` turns into a
   * storm of full server renders (0/5, no better).
   *
   * So: a real reload. These three actions are deliberate, rare, and two of
   * them write to the inventory ledger — a screen that says "not received"
   * about stock now sitting on the shelf is far worse than ~300 ms. Elegance
   * loses to being right. The underlying flake is D77 and is not fixed here.
   */
  /** A full reload, for the reason set out above. */
  function reload() {
    window.location.reload();
  }

  async function act(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await apiClient(`/purchase-orders/${orderId}/${path}/`, { method: "POST", body });
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That did not work. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (await act("send")) reload();
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
      reload();
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
    if (ok) {
      setReceiving(false);
      reload();
    }
  }

  const canSend = status === "DRAFT";
  const canCancelNow = status === "DRAFT" || status === "SENT";
  const canReceiveNow =
    (status === "SENT" || status === "PARTIALLY_RECEIVED") && outstanding.length > 0;
  // Only what has actually arrived can go back, so a cancelled order has
  // nothing to offer here however many lines it carries.
  const canReturnNow = status !== "CANCELLED" && returnable.length > 0;

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

        {canReceive && canReturnNow && (
          <Button variant="secondary" onClick={openReturn} disabled={busy}>
            <Undo2 className="size-4" aria-hidden />
            Return to supplier
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

      {returning && (
        <Card>
          <CardHeader>
            <CardTitle>Return goods to the supplier</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-body-sm text-muted">
              The stock leaves {branchLabel} through the ledger, and the order is credited at what
              the supplier charged — not at today&rsquo;s price. The order total itself never
              changes; the credit is set against what is owed.
            </p>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Lines that can be sent back</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Can go back</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Returning</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {returnDrafts.map((draft) => {
                    const item = items.find((row) => row.id === draft.itemId);
                    if (!item) return null;
                    const problem = returnProblems.find((p) => p.itemId === draft.itemId);
                    const describe = `${item.product_name}${item.variant_label ? ` ${item.variant_label}` : ""}`;
                    return (
                      <tr key={draft.itemId} className={cn(problem && "bg-[var(--error-bg)]")}>
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
                        <td className="tabular px-3 py-2 text-right text-muted">
                          {returnableOf(item)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min="0"
                            max={returnableOf(item)}
                            step="1"
                            inputMode="numeric"
                            value={draft.quantity}
                            onChange={(event) => setReturnDraft(draft.itemId, event.target.value)}
                            aria-label={`Quantity of ${describe} to return`}
                            className="tabular h-8 w-24 text-right text-body-sm"
                          />
                        </td>
                        <td className="tabular px-3 py-2 text-right">
                          {money(String(Number(draft.quantity || 0) * Number(item.unit_cost)))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Why are they going back?"
                htmlFor="return-reason"
                required
                hint="Recorded on the audit log against this order."
              >
                <Select
                  id="return-reason"
                  value={returnReason}
                  onChange={(event) => setReturnReason(event.target.value)}
                >
                  <option value="DEFECTIVE">Faulty goods</option>
                  <option value="DAMAGED">Damaged in transit</option>
                  <option value="WRONG_ITEM">Wrong item delivered</option>
                  <option value="OVER_DELIVERED">More than was ordered</option>
                  <option value="EXPIRED">Expired or short-dated</option>
                  <option value="OTHER">Other</option>
                </Select>
              </Field>

              <Field label="Notes" htmlFor="return-notes">
                <Input
                  id="return-notes"
                  value={returnNotes}
                  onChange={(event) => setReturnNotes(event.target.value)}
                  placeholder="Their reference, who collected it…"
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={sendBack}
                loading={busy}
                disabled={returnProblems.length > 0 || returningNothing}
              >
                <Undo2 className="size-4" aria-hidden />
                Return {money(String(credit))} of stock
              </Button>
              <Button variant="ghost" onClick={() => setReturning(false)} disabled={busy}>
                Cancel
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
