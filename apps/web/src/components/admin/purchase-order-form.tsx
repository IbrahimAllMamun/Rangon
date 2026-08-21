"use client";

import { Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { SupplierForm, type SupplierRow } from "@/components/admin/supplier-form";
import { VariantPicker, type PickableVariant } from "@/components/admin/variant-picker";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import {
  type DraftLine,
  lineTotals,
  orderTotals,
  toCreatePayload,
  validateLines,
} from "@/lib/commerce/purchase-order";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

/**
 * Raise a purchase order (roadmap phase 07 frontend).
 *
 * The endpoints have existed and been tested since the backend was built; what
 * was missing was the screen, so ordering stock meant calling the API by hand.
 *
 * Nothing here touches inventory. A purchase order is a *promise* — stock moves
 * only when goods are received, and that writes `PURCHASE` ledger rows through
 * `inventory.services` and recalculates weighted average cost (ADR-0006,
 * ADR-0008). Receiving lives on the order's detail screen for exactly that
 * reason: it is a different, heavier act than raising the order.
 */
export function PurchaseOrderForm({
  suppliers: initialSuppliers,
  defaultBranchLabel,
}: {
  suppliers: SupplierRow[];
  defaultBranchLabel: string;
}) {
  const router = useRouter();

  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [shipping, setShipping] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [sendNow, setSendNow] = useState(false);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const totals = useMemo(() => orderTotals(lines, shipping), [lines, shipping]);
  const lineProblems = useMemo(() => validateLines(lines), [lines]);
  const chosen = useMemo(() => new Set(lines.map((line) => line.variantId)), [lines]);
  const supplier = suppliers.find((row) => row.id === supplierId);

  function addLine(variant: PickableVariant) {
    setLines((current) => [
      ...current,
      {
        key: `${variant.id}-${current.length}`,
        variantId: variant.id,
        sku: variant.sku,
        productName: variant.product_name,
        variantLabel: variant.label,
        quantity: "1",
        // The last cost paid is the best first guess at what it will cost again.
        unitCost: variant.cost,
        discount: "0",
      },
    ]);
  }

  function setLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  /** Choosing a supplier suggests a delivery date from their lead time. */
  function chooseSupplier(id: string) {
    setSupplierId(id);
    const picked = suppliers.find((row) => row.id === id);
    if (picked && !expectedAt) {
      const due = new Date();
      due.setDate(due.getDate() + picked.lead_time_days);
      setExpectedAt(due.toISOString().slice(0, 10));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const found: { field: string; message: string }[] = [];
    if (!supplierId) found.push({ field: "supplier", message: "Choose a supplier." });
    if (lines.length === 0) {
      found.push({ field: "lines", message: "A purchase order needs at least one line." });
    }
    for (const problem of lineProblems) {
      found.push({ field: "lines", message: problem.message });
    }
    setErrors(found);
    if (found.length) {
      document.getElementById("po-error-summary")?.scrollIntoView({ block: "center" });
      return;
    }

    setSaving(true);
    try {
      const order = await apiClient<{ id: string; number: string }>("/purchase-orders/", {
        method: "POST",
        body: {
          supplier: supplierId,
          lines: toCreatePayload(lines),
          expected_at: expectedAt || null,
          invoice_number: invoiceNumber,
          shipping_total: shipping || "0",
          notes,
        },
      });

      // Sending is a separate, explicit act — the API refuses to send twice, and
      // a draft is the right place to stop if the buyer wants to check it first.
      if (sendNow) {
        await apiClient(`/purchase-orders/${order.id}/send/`, { method: "POST", body: {} });
      }

      router.push(`/admin/purchases/${order.id}`);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "supplier", message: caught.message }],
        );
      } else {
        setErrors([{ field: "supplier", message: "Could not save. Please try again." }]);
      }
      document.getElementById("po-error-summary")?.scrollIntoView({ block: "center" });
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const problemFor = (key: string) =>
    lineProblems.find((problem) => problem.key === key)?.message;

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <div id="po-error-summary">
        <ErrorSummary errors={errors} title="Could not raise this purchase order" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {addingSupplier ? (
            <SupplierForm
              onDone={(created) => {
                setSuppliers((current) =>
                  [...current, created].sort((a, b) => a.name.localeCompare(b.name)),
                );
                chooseSupplier(created.id);
                setAddingSupplier(false);
              }}
              onCancel={() => setAddingSupplier(false)}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Supplier" htmlFor="po-supplier" required error={errorFor("supplier")}>
                <div className="flex gap-2">
                  <Select
                    id="po-supplier"
                    value={supplierId}
                    onChange={(event) => chooseSupplier(event.target.value)}
                    invalid={Boolean(errorFor("supplier"))}
                  >
                    <option value="">Choose a supplier…</option>
                    {suppliers
                      .filter((row) => row.status === "ACTIVE" || row.id === supplierId)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                          {row.status === "INACTIVE" ? " (inactive)" : ""}
                        </option>
                      ))}
                  </Select>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setAddingSupplier(true)}
                    className="shrink-0"
                  >
                    New
                  </Button>
                </div>
              </Field>

              <Field
                label="Expected delivery"
                htmlFor="po-expected"
                hint={
                  supplier
                    ? `${supplier.name} usually takes ${supplier.lead_time_days} days.`
                    : "Suggested from the supplier's lead time."
                }
                error={errorFor("expected_at")}
              >
                <Input
                  id="po-expected"
                  type="date"
                  value={expectedAt}
                  onChange={(event) => setExpectedAt(event.target.value)}
                />
              </Field>

              <Field
                label="Supplier invoice number"
                htmlFor="po-invoice"
                error={errorFor("invoice_number")}
              >
                <Input
                  id="po-invoice"
                  value={invoiceNumber}
                  onChange={(event) => setInvoiceNumber(event.target.value)}
                  maxLength={64}
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Branch"
                htmlFor="po-branch"
                hint="Goods are received into your branch."
              >
                <Input id="po-branch" value={defaultBranchLabel} disabled readOnly />
              </Field>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <VariantPicker onPick={addLine} exclude={chosen} label="Add a product to this order" />

          {errorFor("lines") && (
            <p role="alert" className="text-body-sm text-[var(--error)]">
              {errorFor("lines")}
            </p>
          )}

          {lines.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-8 text-center text-body-sm text-muted">
              No lines yet. Scan a barcode or search for a product above.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Purchase order lines</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Quantity</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Unit cost</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Discount</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Line total</th>
                    <th scope="col" className="px-3 py-2.5">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.map((line) => {
                    const totals = lineTotals(line);
                    const problem = problemFor(line.key);
                    const describe = `${line.productName}${line.variantLabel ? ` ${line.variantLabel}` : ""}`;
                    return (
                      <tr key={line.key} className={cn(problem && "bg-[var(--error-bg)]")}>
                        <td className="px-3 py-2">
                          <span className="block font-medium">{line.productName}</span>
                          <span className="font-mono block text-caption text-muted">
                            {line.sku}
                            {line.variantLabel ? ` · ${line.variantLabel}` : ""}
                          </span>
                          {problem && (
                            <span role="alert" className="block text-caption text-[var(--error)]">
                              {problem}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            inputMode="numeric"
                            value={line.quantity}
                            onChange={(event) => setLine(line.key, { quantity: event.target.value })}
                            aria-label={`Quantity for ${describe}`}
                            className="tabular h-8 w-24 text-right text-body-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            value={line.unitCost}
                            onChange={(event) => setLine(line.key, { unitCost: event.target.value })}
                            aria-label={`Unit cost for ${describe}`}
                            className="tabular h-8 w-28 text-right text-body-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            value={line.discount}
                            onChange={(event) => setLine(line.key, { discount: event.target.value })}
                            aria-label={`Discount for ${describe}`}
                            className="tabular h-8 w-28 text-right text-body-sm"
                          />
                        </td>
                        <td className="tabular px-3 py-2 text-right font-medium">
                          {money(totals.net)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeLine(line.key)}
                            aria-label={`Remove ${describe}`}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:w-2/3">
            <Field label="Shipping / other cost" htmlFor="po-shipping">
              <Input
                id="po-shipping"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={shipping}
                onChange={(event) => setShipping(event.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Notes" htmlFor="po-notes">
              <Textarea
                id="po-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>

          <dl className="ml-auto max-w-sm space-y-1.5 text-body-sm">
            <Row term={`Subtotal (${totals.unitCount} units on ${totals.lineCount} lines)`} value={money(totals.subtotal)} />
            {totals.discountTotal > 0 && (
              <Row term="Discount" value={`− ${money(totals.discountTotal)}`} />
            )}
            {totals.shipping > 0 && <Row term="Shipping" value={money(totals.shipping)} />}
            <div className="flex items-baseline justify-between border-t border-border pt-1.5 text-body font-semibold">
              <dt>Grand total</dt>
              <dd className="tabular">{money(totals.grandTotal)}</dd>
            </div>
          </dl>
          <p className="text-caption text-muted">
            The server recalculates every figure from the lines it is sent; this is a preview.
          </p>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-border bg-surface px-4 py-3 sm:-mx-6 sm:px-6">
        <Button type="submit" loading={saving} disabled={lines.length === 0}>
          {sendNow ? (
            <>
              <Send className="size-4" aria-hidden />
              Create and send
            </>
          ) : (
            "Save as draft"
          )}
        </Button>

        <label className="flex items-center gap-2 text-body-sm">
          <Checkbox checked={sendNow} onChange={(event) => setSendNow(event.target.checked)} />
          Send to the supplier straight away
        </label>

        <Button type="button" variant="ghost" className="ml-auto" asChild>
          <Link href="/admin/purchases">Cancel</Link>
        </Button>
      </div>
    </form>
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
