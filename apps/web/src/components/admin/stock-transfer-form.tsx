"use client";

import { ArrowRightLeft, Check, Trash2 } from "lucide-react";
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
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { BranchSummary } from "@/lib/api/types";

type FieldError = { field: string; message: string };
type Line = { variant: PickableVariant; quantity: string };

/**
 * Move stock between branches.
 *
 * One request, one transaction: the API writes TRANSFER_OUT and TRANSFER_IN
 * together, and the weighted average cost travels with the goods (ADR-0006) so
 * neither branch's margin is distorted by the move. Cost is therefore not an
 * input here — offering a box for it would invite someone to change what the
 * stock is worth by moving it between shelves.
 */
export function StockTransferForm({
  branches,
  defaultSourceId,
}: {
  branches: BranchSummary[];
  defaultSourceId: string;
}) {
  const router = useRouter();
  const active = branches.filter((branch) => branch.status === "ACTIVE");
  const [source, setSource] = useState(defaultSourceId || active[0]?.id || "");
  const [target, setTarget] = useState(
    active.find((branch) => branch.id !== (defaultSourceId || active[0]?.id))?.id ?? "",
  );
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  function addLine(variant: PickableVariant) {
    setLines((current) =>
      current.some((line) => line.variant.id === variant.id)
        ? current
        : [...current, { variant, quantity: "1" }],
    );
  }

  const units = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setDone(null);
    const found: FieldError[] = [];
    if (!source) found.push({ field: "tf-source", message: "Choose the branch sending stock." });
    if (!target) found.push({ field: "tf-target", message: "Choose the branch receiving it." });
    if (source && source === target) {
      found.push({ field: "tf-target", message: "Pick a different destination branch." });
    }
    if (lines.length === 0) {
      found.push({ field: "tf-search", message: "Add at least one product to move." });
    }
    for (const line of lines) {
      if (!line.quantity || Number(line.quantity) < 1) {
        found.push({
          field: `tf-qty-${line.variant.id}`,
          message: `Enter a quantity of at least one for ${line.variant.sku}.`,
        });
      }
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const created = await apiClient<{ number: string }>("/stock-transfers/", {
        method: "POST",
        body: {
          source_branch: source,
          target_branch: target,
          lines: lines.map((line) => ({
            variant: line.variant.id,
            quantity: Number(line.quantity),
          })),
          notes,
        },
      });
      setDone(`${created.number} moved ${units} unit${units === 1 ? "" : "s"}.`);
      setLines([]);
      setNotes("");
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "tf-search", message: caught.message }],
        );
      } else {
        setErrors([{ field: "tf-search", message: "Could not save. Please try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  if (active.length < 2) {
    return (
      <Card>
        <CardContent>
          <p className="p-4 text-body-sm text-muted">
            Transfers need two active branches. Add another from Settings first.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Move stock between branches</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not make this transfer" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="tf-source" required error={errorFor("tf-source")}>
              <Select
                id="tf-source"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                invalid={Boolean(errorFor("tf-source"))}
              >
                {active.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.code})
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="To" htmlFor="tf-target" required error={errorFor("tf-target")}>
              <Select
                id="tf-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                invalid={Boolean(errorFor("tf-target"))}
              >
                <option value="">Choose a branch…</option>
                {active
                  .filter((branch) => branch.id !== source)
                  .map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name} ({branch.code})
                    </option>
                  ))}
              </Select>
            </Field>
          </div>

          <Field label="Products" htmlFor="tf-search" required error={errorFor("tf-search")}>
            <div id="tf-search">
              <VariantPicker
                onPick={addLine}
                exclude={new Set(lines.map((line) => line.variant.id))}
                label="Search by SKU, barcode or name"
              />
            </div>
          </Field>

          {lines.length > 0 && (
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Products on this transfer</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Product</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
                    <th scope="col" className="px-3 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.map((line) => (
                    <tr key={line.variant.id}>
                      <td className="px-3 py-2">
                        <span className="block font-medium">{line.variant.product_name}</span>
                        <span className="block text-caption text-muted">
                          {line.variant.label} ·{" "}
                          <span className="font-mono">{line.variant.sku}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <label htmlFor={`tf-qty-${line.variant.id}`} className="sr-only">
                          Quantity for {line.variant.sku}
                        </label>
                        <Input
                          id={`tf-qty-${line.variant.id}`}
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          className="ml-auto w-24 text-right"
                          value={line.quantity}
                          invalid={Boolean(errorFor(`tf-qty-${line.variant.id}`))}
                          onChange={(event) =>
                            setLines((current) =>
                              current.map((row) =>
                                row.variant.id === line.variant.id
                                  ? { ...row, quantity: event.target.value }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${line.variant.sku}`}
                          onClick={() =>
                            setLines((current) =>
                              current.filter((row) => row.variant.id !== line.variant.id),
                            )
                          }
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-border bg-neutral-50">
                  <tr>
                    <td className="px-3 py-2 text-right font-medium">Units moving</td>
                    <td className="tabular px-3 py-2 text-right font-bold">{units}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <Field label="Note" htmlFor="tf-notes">
            <Input
              id="tf-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Restocking the Gulshan floor"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              <ArrowRightLeft className="size-4" aria-hidden />
              Transfer stock
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
