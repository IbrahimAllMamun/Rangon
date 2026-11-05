"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeftRight, Undo2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { ApiError, apiClient, type Paginated } from "@/lib/api/client";
import type { Order, PosSession, ReturnRequest } from "@/lib/api/types";
import {
  RETURN_DECISIONS,
  RETURN_REASONS,
  type LineChoice,
  type ReturnDecision,
  canReturn,
  defaultDecision,
  returnLines,
} from "@/lib/commerce/returns";
import { money } from "@/lib/format";
import { REFUND_METHODS, defaultRefundMethod } from "@/lib/money-accounts";
import type { PosExchange } from "@/lib/store/pos";

/**
 * A customer at the counter with goods they bought: always a return
 * (business rules 2.4). Scan the receipt's barcode -- or type its number --
 * choose what comes back and where each item goes, then either refund now or
 * exchange: the goods' worth comes off the new items the customer takes.
 *
 * Taking goods back moves money, so it needs `sales.refund`; a cashier
 * without it is told to fetch someone who has it.
 */
export function ReturnDialog({
  session,
  number: scanned,
  onClose,
  onExchange,
}: {
  session: PosSession;
  /** The order number a scanned receipt carried, if one did. */
  number?: string;
  onClose: () => void;
  /** The goods and their worth, for the register to sell new goods against. */
  onExchange: (exchange: PosExchange) => void;
}) {
  const formId = useId();
  const numberRef = useRef<HTMLInputElement>(null);
  const permissions = session.cashier.permissions;
  const allowed =
    permissions.includes("*") || permissions.includes("sales.refund");
  const [number, setNumber] = useState(scanned ?? "");
  const [order, setOrder] = useState<Order | null>(null);
  const [reason, setReason] = useState("WRONG_SIZE");
  const [method, setMethod] = useState("CASH");
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refunded, setRefunded] = useState<ReturnRequest | null>(null);

  async function find(wanted: string) {
    const term = wanted.trim().toUpperCase();
    if (!term) return;
    setBusy("find");
    setError(null);
    setOrder(null);
    setChoices({});
    try {
      const page = await apiClient<Paginated<Order>>(
        `/orders/?search=${encodeURIComponent(term)}&page_size=10`,
      );
      const match = page.results.find(
        (row) => row.number.toUpperCase() === term,
      );
      if (!match) {
        setError(`No order ${term}.`);
        return;
      }
      const full = await apiClient<Order>(`/orders/${match.id}/`);
      if (full.branch !== session.branch.id) {
        setError(`${full.number} was sold at another branch: return it there.`);
        return;
      }
      if (!canReturn(full)) {
        setError(`Nothing on ${full.number} can come back.`);
        return;
      }
      setOrder(full);
      setMethod(defaultRefundMethod(full.payments));
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The order could not be found.",
      );
    } finally {
      setBusy(null);
    }
  }

  // A scanned receipt is looked up at once.
  useEffect(() => {
    if (scanned) void find(scanned);
    else numberRef.current?.focus();
    // Once, for the receipt that opened the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines = order
    ? order.items.filter((item) => item.returnable_quantity > 0)
    : [];
  const chosen = returnLines(lines, choices);
  const units = chosen.reduce((sum, line) => sum + line.quantity, 0);
  const choose = (id: string, change: Partial<LineChoice>) =>
    setChoices((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { quantity: 0, decision: defaultDecision(reason) }),
        ...change,
      },
    }));

  async function refund() {
    if (!order) return;
    setBusy("refund");
    setError(null);
    try {
      setRefunded(
        await apiClient<ReturnRequest>("/pos/returns/", {
          method: "POST",
          body: {
            order: order.id,
            reason,
            lines: chosen,
            refund_method: method,
          },
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The return could not be recorded.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function exchange() {
    if (!order) return;
    setBusy("exchange");
    setError(null);
    try {
      const request = { order: order.id, reason, lines: chosen };
      const quote = await apiClient<{ credit: string }>(
        "/pos/exchanges/quote/",
        {
          method: "POST",
          body: { return: request },
        },
      );
      onExchange({
        orderId: order.id,
        orderNumber: order.number,
        reason,
        lines: chosen,
        credit: Number(quote.credit),
        summary: `${units} item(s) from ${order.number}`,
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The exchange could not be started.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(94vw,620px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-surface shadow-lg focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <Dialog.Title className="text-h3">Return or exchange</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          <div className="space-y-4 p-5">
            {!allowed && (
              <p role="alert" className="text-body-sm text-[var(--error)]">
                Taking goods back needs a manager. Ask one to sign in at this
                register.
              </p>
            )}

            {refunded ? (
              <div role="status" className="space-y-3 text-center">
                <p className="text-h4">{refunded.number}</p>
                <p className="tabular font-display text-[2rem] font-bold">
                  Give back {money(refunded.refund_amount)}
                </p>
                <p className="text-body-sm text-muted">
                  Recorded against {refunded.order_number}. Items marked back on
                  the shelf are in stock again.
                </p>
                <Button size="lg" full onClick={onClose} autoFocus>
                  Done
                </Button>
              </div>
            ) : (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void find(number);
                  }}
                  className="flex items-end gap-2"
                >
                  <Field
                    label="Receipt number"
                    htmlFor={`${formId}-number`}
                    className="flex-1"
                  >
                    <Input
                      id={`${formId}-number`}
                      ref={numberRef}
                      inputSize="lg"
                      autoComplete="off"
                      value={number}
                      placeholder="Scan the receipt, or type RGN-POS-…"
                      onChange={(event) => setNumber(event.target.value)}
                    />
                  </Field>
                  <Button
                    type="submit"
                    size="lg"
                    variant="secondary"
                    loading={busy === "find"}
                  >
                    Find
                  </Button>
                </form>

                {order && (
                  <>
                    <Field
                      label="Why it came back"
                      htmlFor={`${formId}-reason`}
                    >
                      <Select
                        id={`${formId}-reason`}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      >
                        {RETURN_REASONS.map((row) => (
                          <option key={row.value} value={row.value}>
                            {row.label}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <ul className="space-y-2">
                      {lines.map((item) => {
                        const choice = choices[item.id];
                        const decision =
                          choice?.decision ?? defaultDecision(reason);
                        return (
                          <li
                            key={item.id}
                            className="rounded-md border border-border p-3"
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <p className="text-body-sm font-medium">
                                {item.product_name}{" "}
                                <span className="text-muted">
                                  {item.variant_label}
                                </span>
                              </p>
                              <p className="tabular text-caption text-muted">
                                {money(item.line_total)} ·{" "}
                                {item.returnable_quantity} can come back
                              </p>
                            </div>
                            <div className="mt-2 grid grid-cols-[5rem_1fr] gap-2">
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={item.returnable_quantity}
                                aria-label={`How many ${item.sku} come back`}
                                value={choice?.quantity ?? 0}
                                onChange={(event) =>
                                  choose(item.id, {
                                    quantity: Number(event.target.value),
                                    decision,
                                  })
                                }
                              />
                              <Select
                                aria-label={`Where ${item.sku} goes`}
                                value={decision}
                                onChange={(event) =>
                                  choose(item.id, {
                                    decision: event.target
                                      .value as ReturnDecision,
                                  })
                                }
                              >
                                {RETURN_DECISIONS.map((row) => (
                                  <option key={row.value} value={row.value}>
                                    {row.label}
                                  </option>
                                ))}
                              </Select>
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <Field label="Refund as" htmlFor={`${formId}-method`}>
                      <Select
                        id={`${formId}-method`}
                        value={method}
                        onChange={(event) => setMethod(event.target.value)}
                      >
                        {REFUND_METHODS.map((row) => (
                          <option key={row.value} value={row.value}>
                            {row.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </>
                )}

                {error && (
                  <p role="alert" className="text-body-sm text-[var(--error)]">
                    {error}
                  </p>
                )}

                {order && (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="lg"
                      variant="secondary"
                      loading={busy === "refund"}
                      disabled={!allowed || units === 0 || busy !== null}
                      onClick={() => {
                        if (
                          confirm(
                            `Take back ${units} item(s) and refund the customer?`,
                          )
                        )
                          void refund();
                      }}
                    >
                      <Undo2 aria-hidden /> Refund
                    </Button>
                    <Button
                      size="lg"
                      loading={busy === "exchange"}
                      disabled={!allowed || units === 0 || busy !== null}
                      onClick={() => void exchange()}
                    >
                      <ArrowLeftRight aria-hidden /> Exchange
                    </Button>
                  </div>
                )}
                {order && (
                  <p className="text-caption text-muted">
                    Exchange: the goods&apos; worth comes off the new items.
                    Scan them next; the customer pays only the difference, or
                    gets it back.
                  </p>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
