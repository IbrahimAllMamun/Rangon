"use client";

import { PackageCheck, TruckIcon, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorSummary,
  Field,
  Input,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { StockTransfer } from "@/lib/api/types";
import { dateTime } from "@/lib/format";

type Mode = "receive" | "cancel";

/**
 * Transfers that have left one shelf and not reached another.
 *
 * This stock is in nobody's `on_hand` — correctly, it is in a van — so without
 * a screen for it, it is simply missing from the system's view of itself.
 * business-rules §1.6 has always described transfers this way; the code only
 * started doing it on 2026-09-01.
 *
 * Receiving defaults every line to the quantity that was dispatched, because
 * "it all turned up" is the ordinary case and should not need typing out. A
 * shortfall is written off at the destination in the same request, and the API
 * refuses one without a reason.
 */
export function TransferReceipt({
  transfers,
  canReceive,
}: {
  transfers: StockTransfer[];
  canReceive: boolean;
}) {
  const router = useRouter();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("receive");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);

  function start(transfer: StockTransfer, next: Mode) {
    setOpenFor(transfer.id);
    setMode(next);
    setCounts(
      Object.fromEntries(transfer.items.map((item) => [item.id, String(item.quantity)])),
    );
    setReason("");
    setErrors([]);
  }

  async function submit(event: React.FormEvent, transfer: StockTransfer) {
    event.preventDefault();
    setErrors([]);

    if (mode === "cancel") {
      if (!reason.trim()) {
        setErrors([
          {
            field: "tr-reason",
            message: "Say why it is being turned back. Stock reappearing without a reason is indistinguishable from stock being invented.",
          },
        ]);
        return;
      }
    }

    const lines = transfer.items.map((item) => ({
      variant: item.variant,
      received_quantity: Number(counts[item.id] ?? item.quantity),
    }));
    const bad = lines.find(
      (line, index) =>
        !Number.isInteger(line.received_quantity) ||
        line.received_quantity < 0 ||
        line.received_quantity > transfer.items[index].quantity,
    );
    if (mode === "receive" && bad) {
      setErrors([
        {
          field: `tr-qty-${transfer.items.find((item) => item.variant === bad.variant)?.id}`,
          message: "Enter a whole number between zero and the quantity dispatched.",
        },
      ]);
      return;
    }
    const short = mode === "receive" && lines.some((line, index) => line.received_quantity < transfer.items[index].quantity);
    if (short && !reason.trim()) {
      setErrors([
        {
          field: "tr-reason",
          message: "Say what happened to the stock that did not arrive. It will be written off at this branch.",
        },
      ]);
      return;
    }

    setSaving(true);
    try {
      await apiClient(
        `/stock-transfers/${transfer.id}/${mode === "receive" ? "receive" : "cancel"}/`,
        {
          method: "POST",
          body: mode === "receive" ? { lines, reason } : { reason },
        },
      );
      setOpenFor(null);
      router.refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not save. Please try again.";
      setErrors([{ field: "tr-reason", message }]);
    } finally {
      setSaving(false);
    }
  }

  if (transfers.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<PackageCheck className="size-8" aria-hidden />}
          title="Nothing in transit"
          description="Every transfer that has been dispatched has also been accounted for."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {transfers.map((transfer) => {
        const open = openFor === transfer.id;
        return (
          <Card key={transfer.id}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <TruckIcon className="size-4 text-[var(--warning)]" aria-hidden />
                  <span className="font-mono">{transfer.number}</span>
                  <Badge tone="warning">In transit</Badge>
                </CardTitle>
                <p className="mt-1 text-body-sm text-muted">
                  {transfer.source_code} <span aria-label="to">→</span> {transfer.target_code} ·{" "}
                  {transfer.units_dispatched} units · dispatched{" "}
                  {dateTime(transfer.dispatched_at ?? transfer.created_at)}
                </p>
              </div>
              {canReceive && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    aria-expanded={open && mode === "receive"}
                    onClick={() =>
                      open && mode === "receive" ? setOpenFor(null) : start(transfer, "receive")
                    }
                  >
                    <PackageCheck className="size-4" aria-hidden /> Receive
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-expanded={open && mode === "cancel"}
                    onClick={() =>
                      open && mode === "cancel" ? setOpenFor(null) : start(transfer, "cancel")
                    }
                  >
                    <Undo2 className="size-4" aria-hidden /> Turn back
                  </Button>
                </div>
              )}
            </CardHeader>

            <CardContent>
              <ul className="mb-3 space-y-1 text-body-sm">
                {transfer.items.map((item) => (
                  <li key={item.id}>
                    <span className="font-medium">{item.quantity} ×</span> {item.product_name}{" "}
                    <span className="font-mono text-muted">{item.sku}</span>
                  </li>
                ))}
              </ul>

              {open && (
                <form onSubmit={(event) => submit(event, transfer)} noValidate className="space-y-3 border-t border-neutral-200 pt-4">
                  <ErrorSummary
                    errors={errors}
                    title={mode === "receive" ? "Could not receive this" : "Could not turn this back"}
                  />

                  {mode === "receive" ? (
                    <>
                      <p className="text-body-sm text-neutral-700">
                        How many actually arrived. Anything short of what was sent is written off
                        at <strong>{transfer.target_code}</strong> in the same step — the ledger
                        shows both what was dispatched and what was lost.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {transfer.items.map((item) => (
                          <Field
                            key={item.id}
                            label={`${item.product_name} (${item.sku})`}
                            htmlFor={`tr-qty-${item.id}`}
                            hint={`${item.quantity} dispatched`}
                            error={errors.find((error) => error.field === `tr-qty-${item.id}`)?.message}
                          >
                            <Input
                              id={`tr-qty-${item.id}`}
                              type="number"
                              min={0}
                              max={item.quantity}
                              step={1}
                              inputMode="numeric"
                              value={counts[item.id] ?? String(item.quantity)}
                              onChange={(event) =>
                                setCounts((current) => ({
                                  ...current,
                                  [item.id]: event.target.value,
                                }))
                              }
                            />
                          </Field>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="text-body-sm text-neutral-700">
                      The stock goes back onto <strong>{transfer.source_code}</strong>&rsquo;s
                      shelf. This is not a delete: it physically left and physically came back, so
                      both movements stay on the ledger.
                    </p>
                  )}

                  <Field
                    label={mode === "receive" ? "Reason (only if something is missing)" : "Why is it coming back"}
                    htmlFor="tr-reason"
                    required={mode === "cancel"}
                    error={errors.find((error) => error.field === "tr-reason")?.message}
                  >
                    <Textarea
                      id="tr-reason"
                      rows={2}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      invalid={errors.some((error) => error.field === "tr-reason")}
                    />
                  </Field>

                  <div className="flex gap-2">
                    <Button type="submit" disabled={saving}>
                      {saving ? "Saving…" : mode === "receive" ? "Receive" : "Turn back"}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setOpenFor(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
