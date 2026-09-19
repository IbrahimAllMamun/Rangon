"use client";

import { PackageCheck, PackagePlus, Plus, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { NewProductPanel, type NewProductResult } from "@/components/admin/new-product-panel";
import { SupplierForm, type SupplierRow } from "@/components/admin/supplier-form";
import { VariantPicker, type PickableVariant } from "@/components/admin/variant-picker";
import {
  Badge,
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
import type { CategoryNode } from "@/lib/commerce/categories";
import {
  type DraftLine,
  lineFromVariant,
  lineTotals,
  orderTotals,
  repriceForSupplier,
  toCreatePayload,
  validateLines,
} from "@/lib/commerce/purchase-order";
import type { MatrixAttribute } from "@/lib/commerce/variant-matrix";
import { cn } from "@/lib/cn";
import { dateOnly, money } from "@/lib/format";

/** A variant this supplier has delivered before, with what they were last paid. */
interface SupplierProduct extends PickableVariant {
  last_cost: string;
  last_received_at: string;
}

/** What the new-product panel needs; absent when the user may not create products. */
export interface ProductReference {
  categories: CategoryNode[];
  brands: { id: string; name: string }[];
  attributes: MatrixAttribute[];
}

type SaveMode = "draft" | "send" | "receive";

/** How many of the supplier's past products show before "Show all". */
const HISTORY_PREVIEW = 8;

/**
 * Raise a purchase order -- or record goods that have already arrived.
 *
 * Goods enter the shop through purchasing and nowhere else (business-rules
 * §4.0a), so this screen has to be able to do the whole job: a product that
 * has never been stocked is made here (`NewProductPanel`), a supplier's usual
 * lines are one click away at the price they were last paid, and goods that
 * came with the supplier are received in the same step that records them
 * (`receive_now`, §4.0b).
 *
 * Nothing here writes stock directly. Receiving goes through
 * `purchasing.services.receive_purchase`, which writes `PURCHASE` ledger rows
 * through `inventory.services` and recalculates weighted average cost
 * (ADR-0006, ADR-0008) -- whether it happens now or later from the order.
 */
export function PurchaseOrderForm({
  suppliers: initialSuppliers,
  defaultBranchLabel,
  productReference,
  canReceive,
}: {
  suppliers: SupplierRow[];
  defaultBranchLabel: string;
  productReference: ProductReference | null;
  canReceive: boolean;
}) {
  const router = useRouter();

  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [history, setHistory] = useState<SupplierProduct[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [expectedAt, setExpectedAt] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [shipping, setShipping] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [mode, setMode] = useState<SaveMode>("draft");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const nextKey = useRef(0);

  const totals = useMemo(() => orderTotals(lines, shipping), [lines, shipping]);
  const lineProblems = useMemo(() => validateLines(lines), [lines]);
  const chosen = useMemo(() => new Set(lines.map((line) => line.variantId)), [lines]);
  const supplier = suppliers.find((row) => row.id === supplierId);
  const supplierCosts = useMemo(
    () => new Map((history ?? []).map((row) => [row.id, row.last_cost])),
    [history],
  );

  // The supplier's past deliveries, fetched when one is chosen. A slow answer
  // for the previous supplier is aborted rather than allowed to land last.
  useEffect(() => {
    setHistory(null);
    setHistoryFailed(false);
    setShowAllHistory(false);
    if (!supplierId) return;

    const controller = new AbortController();
    apiClient<SupplierProduct[]>(`/suppliers/${supplierId}/products/`, {
      signal: controller.signal,
    })
      .then((rows) => {
        if (!controller.signal.aborted) setHistory(rows);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryFailed(true);
      });
    return () => controller.abort();
  }, [supplierId]);

  // A line priced from a guess follows the supplier: choosing a different one
  // re-prices it from *their* last delivery. A cost somebody typed stays put.
  useEffect(() => {
    if (history === null) return;
    const costs = new Map(history.map((row) => [row.id, row.last_cost]));
    setLines((current) => repriceForSupplier(current, costs));
  }, [history]);

  function key() {
    nextKey.current += 1;
    return `line-${nextKey.current}`;
  }

  function addLine(variant: PickableVariant) {
    setLines((current) => [...current, lineFromVariant(variant, { key: key(), supplierCosts })]);
  }

  function addNewProduct(result: NewProductResult) {
    setLines((current) => [
      ...current,
      ...result.variants.map((variant) =>
        lineFromVariant(variant, {
          key: key(),
          quantity: result.quantity,
          unitCost: result.unitCost,
          isNew: true,
        }),
      ),
    ]);
    setAddingProduct(false);
  }

  function setLine(lineKey: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(lineKey: string) {
    setLines((current) => current.filter((line) => line.key !== lineKey));
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

  async function submit() {
    const found: { field: string; message: string }[] = [];
    if (!supplierId) found.push({ field: "supplier", message: "Choose a supplier." });
    if (lines.length === 0) {
      found.push({ field: "lines", message: "A purchase order needs at least one line." });
    }
    for (const problem of lineProblems) {
      found.push({ field: "lines", message: problem.message });
    }
    if (Number(shipping || 0) < 0) {
      found.push({ field: "shipping_total", message: "Shipping cannot be negative." });
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
          // One transaction on the server: created, sent and received, or none
          // of the three.
          receive_now: mode === "receive",
        },
      });

      // Sending is a separate, explicit act — the API refuses to send twice, and
      // a draft is the right place to stop if the buyer wants to check it first.
      if (mode === "send") {
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
  const problemFor = (lineKey: string) =>
    lineProblems.find((problem) => problem.key === lineKey)?.message;
  const visibleHistory = showAllHistory ? history ?? [] : (history ?? []).slice(0, HISTORY_PREVIEW);

  // Deliberately not a <form>. The supplier and new-product panels below are
  // forms of their own, and in this app a <form> nested inside another never
  // reaches React's onSubmit: the browser performed a native GET submission of
  // the inner one instead, reloading the page and losing the whole order (D81).
  // Nested forms are invalid HTML anyway. The order is saved by the button's
  // click; Enter inside a line no longer submits a purchase order by accident.
  return (
    <div className="space-y-6">
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
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <VariantPicker onPick={addLine} exclude={chosen} label="Add a product to this order" />
            </div>
            {productReference && !addingProduct && (
              <Button type="button" variant="secondary" onClick={() => setAddingProduct(true)}>
                <PackagePlus className="size-4" aria-hidden />
                New product
              </Button>
            )}
          </div>

          {addingProduct && productReference && (
            <NewProductPanel
              categories={productReference.categories}
              brands={productReference.brands}
              attributes={productReference.attributes}
              onCreated={addNewProduct}
              onCancel={() => setAddingProduct(false)}
            />
          )}

          {supplier && historyFailed && (
            <p className="text-body-sm text-muted">
              Could not load what {supplier.name} has supplied before. Search above instead.
            </p>
          )}
          {supplier && history && history.length > 0 && (
            <section aria-labelledby="po-history-heading" className="space-y-2">
              <h3 id="po-history-heading" className="text-body-sm font-medium">
                Supplied by {supplier.name} before
                <span className="ml-2 font-normal text-muted">
                  priced at what they were last paid
                </span>
              </h3>
              <ul className="flex flex-wrap gap-2">
                {visibleHistory.map((row) => {
                  const onOrder = chosen.has(row.id);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => addLine(row)}
                        disabled={onOrder}
                        className={cn(
                          "inline-flex items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-left text-body-sm transition-colors duration-fast hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                          onOrder && "cursor-default opacity-50 hover:bg-white",
                        )}
                        aria-label={`Add ${row.product_name}${row.label ? ` ${row.label}` : ""}, last ${money(row.last_cost)} on ${dateOnly(row.last_received_at)}`}
                      >
                        <Plus className="size-3.5 shrink-0" aria-hidden />
                        <span>
                          {row.product_name}
                          {row.label ? <span className="text-muted"> · {row.label}</span> : null}
                        </span>
                        <span className="tabular text-muted">{money(row.last_cost)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {history.length > HISTORY_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setShowAllHistory((shown) => !shown)}
                  className="text-body-sm text-brand-600 hover:underline"
                >
                  {showAllHistory ? "Show fewer" : `Show all ${history.length}`}
                </button>
              )}
            </section>
          )}

          {errorFor("lines") && (
            <p role="alert" className="text-body-sm text-[var(--error)]">
              {errorFor("lines")}
            </p>
          )}

          {lines.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-8 text-center text-body-sm text-muted">
              No lines yet. Scan a barcode or search for a product above
              {productReference ? ", or make a new one." : "."}
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
                          <span className="flex items-center gap-2 font-medium">
                            {line.productName}
                            {line.isNew && <Badge tone="brand">New</Badge>}
                          </span>
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
                            onChange={(event) =>
                              setLine(line.key, {
                                unitCost: event.target.value,
                                costSource: "entered",
                              })
                            }
                            aria-label={`Unit cost for ${describe}`}
                            className="tabular h-8 w-28 text-right text-body-sm"
                          />
                          {line.costSource === "supplier" && (
                            <span className="mt-0.5 block text-caption text-muted">
                              last paid to them
                            </span>
                          )}
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
            <Field
              label="Shipping / other cost"
              htmlFor="po-shipping"
              error={errorFor("shipping_total")}
            >
              <Input
                id="po-shipping"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={shipping}
                onChange={(event) => setShipping(event.target.value)}
                invalid={Boolean(errorFor("shipping_total"))}
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

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border bg-surface px-4 py-3 sm:-mx-6 sm:px-6">
        <Button type="button" onClick={submit} loading={saving} disabled={lines.length === 0}>
          {mode === "receive" ? (
            <>
              <PackageCheck className="size-4" aria-hidden />
              Receive {totals.unitCount} {totals.unitCount === 1 ? "unit" : "units"} into stock
            </>
          ) : mode === "send" ? (
            <>
              <Send className="size-4" aria-hidden />
              Create and send
            </>
          ) : (
            "Save as draft"
          )}
        </Button>

        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body-sm">
          <legend className="sr-only">When saving</legend>
          <ModeOption mode="draft" current={mode} onChange={setMode}>
            Keep as a draft
          </ModeOption>
          <ModeOption mode="send" current={mode} onChange={setMode}>
            Send to the supplier
          </ModeOption>
          {canReceive && (
            <ModeOption mode="receive" current={mode} onChange={setMode}>
              The goods are here — receive them now
            </ModeOption>
          )}
        </fieldset>

        <Button type="button" variant="ghost" className="ml-auto" asChild>
          <Link href="/admin/purchases">Cancel</Link>
        </Button>
      </div>
    </div>
  );
}

function ModeOption({
  mode,
  current,
  onChange,
  children,
}: {
  mode: SaveMode;
  current: SaveMode;
  onChange: (mode: SaveMode) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        name="po-save-mode"
        value={mode}
        checked={current === mode}
        onChange={() => onChange(mode)}
        className="size-4 accent-[var(--brand-500)]"
      />
      {children}
    </label>
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
