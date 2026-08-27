"use client";

import { AlertTriangle, Check, PackageX, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { type PickableVariant, VariantPicker } from "@/components/admin/variant-picker";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorSummary,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

type FieldError = { field: string; message: string };

/**
 * Why the stock left. These are the only two the API accepts — a write-off is
 * not an adjustment, and the distinction matters downstream: damage is a cost
 * of doing business, loss is shrinkage, and the profit report will read them
 * differently.
 */
const KINDS = [
  {
    value: "DAMAGE",
    label: "Damaged",
    hint: "Broken, stained, water-damaged — the goods exist but cannot be sold.",
  },
  {
    value: "LOSS",
    label: "Lost or stolen",
    hint: "Shrinkage. The goods are gone and nobody paid for them.",
  },
] as const;

/**
 * Write stock off the ledger.
 *
 * This is the one admin screen whose whole purpose is to *reduce* stock
 * without a sale, so it is deliberately awkward in one respect: the reason is
 * mandatory and free-text, because an unexplained write-off is indistinguishable
 * from theft by the person recording it. The API enforces that too — this form
 * only avoids offering a dead end.
 */
export function WriteOffForm({ branchId, branchLabel }: { branchId: string; branchLabel: string }) {
  const router = useRouter();
  const [variant, setVariant] = useState<PickableVariant | null>(null);
  const [quantity, setQuantity] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("DAMAGE");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setDone(null);
    const found: FieldError[] = [];
    if (!variant) found.push({ field: "wo-search", message: "Choose the product being written off." });
    if (!quantity || Number(quantity) < 1 || !Number.isInteger(Number(quantity))) {
      found.push({ field: "wo-quantity", message: "Enter a whole quantity of at least one." });
    }
    if (!reason.trim()) {
      found.push({ field: "wo-reason", message: "Say what happened. This is permanent." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      await apiClient("/inventory/write-off/", {
        method: "POST",
        body: {
          variant: variant!.id,
          branch: branchId,
          quantity: Number(quantity),
          transaction_type: kind,
          reason,
          notes,
        },
      });
      setDone(`${quantity} × ${variant!.sku} written off.`);
      setVariant(null);
      setQuantity("");
      setReason("");
      setNotes("");
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "wo-quantity", message: caught.message }],
        );
      } else {
        setErrors([{ field: "wo-quantity", message: "Could not save. Please try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const activeKind = KINDS.find((option) => option.value === kind);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Write stock off</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not write this off" />

          <div
            className="flex items-start gap-2 rounded-md border border-[var(--warning)] bg-[var(--warning-bg)] p-3 text-body-sm"
            role="note"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden />
            <p>
              This permanently reduces stock at <strong>{branchLabel}</strong> and writes a ledger
              row that cannot be deleted. To correct a mistake, receive the stock back in — the
              history keeps both movements.
            </p>
          </div>

          <Field label="Product" htmlFor="wo-search" required error={errorFor("wo-search")}>
            <div id="wo-search">
              <VariantPicker onPick={setVariant} label="Search by SKU, barcode or name" />
            </div>
          </Field>

          {variant && (
            <p className="rounded-md bg-neutral-50 px-3 py-2 text-body-sm">
              <span className="font-medium">{variant.product_name}</span>{" "}
              <span className="text-muted">
                {variant.label} · <span className="font-mono">{variant.sku}</span>
              </span>
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quantity" htmlFor="wo-quantity" required error={errorFor("wo-quantity")}>
              <Input
                id="wo-quantity"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                invalid={Boolean(errorFor("wo-quantity"))}
              />
            </Field>

            <Field label="What happened" htmlFor="wo-kind" hint={activeKind?.hint}>
              <Select
                id="wo-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                {KINDS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Reason"
              htmlFor="wo-reason"
              required
              hint="Required — an unexplained write-off is a red flag."
              error={errorFor("wo-reason")}
              className="sm:col-span-2"
            >
              <Textarea
                id="wo-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                invalid={Boolean(errorFor("wo-reason"))}
                placeholder="Water damage in the stockroom after the roof leak"
              />
            </Field>

            <Field label="Note" htmlFor="wo-notes" className="sm:col-span-2">
              <Input
                id="wo-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional — reference, incident number"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving} variant="destructive">
              <PackageX className="size-4" aria-hidden />
              Write off
            </Button>
            {done && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
              >
                <Check className="size-4" aria-hidden /> {done}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Collapsed by default: writing stock off is not the reason most people open this page. */
export function WriteOffPanel({ branchId, branchLabel }: { branchId: string; branchLabel: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <PackageX className="size-4" aria-hidden />
        Write stock off
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <WriteOffForm branchId={branchId} branchLabel={branchLabel} />
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        <X className="size-4" aria-hidden />
        Close
      </Button>
    </div>
  );
}
