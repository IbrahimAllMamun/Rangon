"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Banknote, CreditCard, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button, Input, Label } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { Order, PaymentMethod } from "@/lib/api/types";
import { money } from "@/lib/format";
import { usePos } from "@/lib/store/pos";

interface Tender {
  method: PaymentMethod;
  amount: number;
  tendered?: number;
  reference?: string;
}

const METHODS: { method: PaymentMethod; label: string; icon: React.ReactNode }[] = [
  { method: "CASH", label: "Cash", icon: <Banknote className="size-5" aria-hidden /> },
  { method: "CARD", label: "Card", icon: <CreditCard className="size-5" aria-hidden /> },
  { method: "MOBILE_MFS", label: "bKash / Nagad", icon: <Smartphone className="size-5" aria-hidden /> },
];

/** Notes a Bangladeshi cashier actually handles. */
const QUICK_CASH = [100, 200, 500, 1000, 2000];

export function PaymentPanel({
  total,
  onClose,
  onCompleted,
}: {
  total: number;
  onClose: () => void;
  onCompleted: (order: Order) => void;
}) {
  const pos = usePos();
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [amount, setAmount] = useState<string>(total.toFixed(2));
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  /** One key per attempt at this sale: a retry must not create a second order. */
  const idempotencyKey = useMemo(
    () => `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  const paid = tenders.reduce((sum, tender) => sum + tender.amount, 0);
  const due = Math.max(0, total - paid);
  const tendered = Number(amount) || 0;
  const change = method === "CASH" ? Math.max(0, tendered - due) : 0;

  useEffect(() => {
    amountRef.current?.focus();
    amountRef.current?.select();
  }, []);

  useEffect(() => {
    setAmount(due.toFixed(2));
  }, [due]);

  function addTender() {
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Enter an amount.");
      return;
    }
    // Cash may be over-tendered (change is given); other methods may not.
    const applied = method === "CASH" ? Math.min(value, due) : value;
    if (method !== "CASH" && applied > due + 0.001) {
      setError("That is more than the amount due.");
      return;
    }

    setTenders((current) => [
      ...current,
      {
        method,
        amount: applied,
        tendered: method === "CASH" ? value : undefined,
        reference: reference || undefined,
      },
    ]);
    setReference("");
    setError(null);
  }

  async function complete() {
    const outstanding = total - tenders.reduce((sum, tender) => sum + tender.amount, 0);
    if (outstanding > 0.001) {
      setError(`${money(outstanding)} is still due.`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const order = await apiClient<Order>("/pos/sales/", {
        method: "POST",
        idempotencyKey,
        body: {
          lines: pos.lines.map((line) => ({
            variant: line.variantId,
            quantity: line.quantity,
            line_discount: line.discount.toFixed(2),
          })),
          payments: tenders.map((tender) => ({
            method: tender.method,
            amount: tender.amount.toFixed(2),
            tendered_amount: tender.tendered?.toFixed(2),
            reference: tender.reference ?? "",
          })),
          customer: pos.customerId,
          manual_discount: pos.orderDiscount.toFixed(2),
          register: pos.register,
          note: pos.note,
        },
      });
      onCompleted(order);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The sale could not be completed. Nothing has been charged.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-surface shadow-lg focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <Dialog.Title className="text-h3">Payment</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close payment">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          <div className="p-5">
            <div className="rounded-lg bg-neutral-100 p-4 text-center">
              <p className="text-body-sm text-muted">Amount due</p>
              <p className="tabular font-display text-[2.5rem] font-bold leading-none">
                {money(due)}
              </p>
              {change > 0 && (
                <p className="tabular mt-2 text-body font-semibold text-[var(--success)]">
                  Change: {money(change)}
                </p>
              )}
            </div>

            <fieldset className="mt-4">
              <legend className="text-body-sm font-semibold">Method</legend>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {METHODS.map((entry) => (
                  <button
                    key={entry.method}
                    type="button"
                    onClick={() => setMethod(entry.method)}
                    aria-pressed={method === entry.method}
                    className={`flex h-16 flex-col items-center justify-center gap-1 rounded-md border-2 text-body-sm font-medium transition-colors duration-fast ${
                      method === entry.method
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-neutral-300 hover:bg-neutral-100"
                    }`}
                  >
                    {entry.icon}
                    {entry.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="mt-4">
              <Label htmlFor="tender-amount">
                {method === "CASH" ? "Cash received" : "Amount"}
              </Label>
              <Input
                id="tender-amount"
                ref={amountRef}
                inputSize="lg"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTender();
                  }
                }}
                className="tabular mt-1.5 text-h3"
              />

              {method === "CASH" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setAmount(due.toFixed(2))}>
                    Exact
                  </Button>
                  {QUICK_CASH.filter((note) => note >= due).slice(0, 4).map((note) => (
                    <Button
                      key={note}
                      variant="secondary"
                      size="sm"
                      onClick={() => setAmount(note.toFixed(2))}
                    >
                      {money(note, false)}
                    </Button>
                  ))}
                </div>
              )}

              {method !== "CASH" && (
                <div className="mt-3">
                  <Label htmlFor="reference">Reference (slip / transaction id)</Label>
                  <Input
                    id="reference"
                    className="mt-1.5"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </div>
              )}
            </div>

            {tenders.length > 0 && (
              <ul className="mt-4 space-y-1 rounded-md border border-border p-3">
                {tenders.map((tender, index) => (
                  <li key={index} className="flex items-center justify-between text-body-sm">
                    <span>
                      {tender.method === "MOBILE_MFS" ? "bKash / Nagad" : tender.method}
                      {tender.reference ? ` · ${tender.reference}` : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular">{money(tender.amount)}</span>
                      <button
                        type="button"
                        onClick={() => setTenders((current) => current.filter((_, i) => i !== index))}
                        aria-label={`Remove ${tender.method} payment`}
                        className="rounded p-0.5 text-neutral-500 hover:text-[var(--error)]"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <p role="alert" className="mt-3 rounded-md bg-[var(--error-bg)] p-3 text-body-sm font-medium text-[var(--error)]">
                {error}
              </p>
            )}

            <div className="mt-5 grid grid-cols-2 gap-2">
              <Button variant="secondary" size="lg" onClick={addTender} disabled={due <= 0}>
                Add payment
              </Button>
              <Button size="lg" onClick={() => void complete()} loading={submitting} disabled={due > 0.001}>
                Complete sale
              </Button>
            </div>
            <p className="mt-2 text-center text-caption text-muted">
              Split a payment by adding more than one method.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
