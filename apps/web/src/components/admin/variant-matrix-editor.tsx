"use client";

import { AlertTriangle, Check, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge, Button, Input } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { MatrixAttribute, MatrixRow } from "@/lib/commerce/variant-matrix";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

export interface RowDraft {
  price: string;
  compareAt: string;
  cost: string;
  sku: string;
  barcode: string;
  /** Only meaningful for rows that do not exist yet. */
  openingStock: string;
}

export function blankDraft(price: string, cost: string): RowDraft {
  return { price, compareAt: "", cost, sku: "", barcode: "", openingStock: "0" };
}

export function draftFromRow(row: MatrixRow, price: string, cost: string): RowDraft {
  if (!row.existing) return blankDraft(price, cost);
  return {
    price: row.existing.price,
    compareAt: row.existing.compare_at_price ?? "",
    cost: row.existing.cost,
    sku: row.existing.sku,
    barcode: row.existing.barcode ?? "",
    openingStock: "0",
  };
}

/**
 * One row per sellable combination.
 *
 * The stock column is the part worth reading twice. It **never writes stock
 * directly** (CLAUDE.md §3.2, §13): a row that does not exist yet takes an
 * opening figure, which the form posts as an inventory adjustment once the
 * variant has an id; a row that exists shows its counted stock read-only, with
 * an Adjust action that writes a reasoned `InventoryTransaction` through
 * `POST /inventory/adjust/`. There is no path from this table to
 * `on_hand = on_hand - 1`.
 */
export function VariantMatrixEditor({
  rows,
  attributes,
  drafts,
  onDraftChange,
  onRemoved,
  onAdjusted,
  branchLabel,
  disabled,
  truncated,
}: {
  rows: MatrixRow[];
  attributes: MatrixAttribute[];
  drafts: Record<string, RowDraft>;
  onDraftChange: (key: string, patch: Partial<RowDraft>) => void;
  onRemoved: (variantId: string) => void;
  onAdjusted: () => void;
  branchLabel: string;
  disabled: boolean;
  truncated: boolean;
}) {
  const codes = columnCodes(rows);
  const nameFor = (code: string) =>
    attributes.find((attribute) => attribute.code === code)?.name ?? code;

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-body-sm text-muted">
        Tick the values this product comes in — the sellable rows appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {truncated && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-[var(--warning)]/10 p-3 text-body-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden />
          <span>
            That many ticks would generate thousands of SKUs, so the table is capped. Narrow the
            selection before saving.
          </span>
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-body-sm">
          <caption className="sr-only">
            Variants: one row per combination, with price, cost and stock
          </caption>
          <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
            <tr>
              {/* Column headers once, rather than a label on every row. */}
              {codes.map((code) => (
                <th key={code} scope="col" className="px-3 py-2.5 font-medium">
                  {nameFor(code)}
                </th>
              ))}
              <th scope="col" className="px-3 py-2.5 font-medium">SKU</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Price</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Compare at</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Cost</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                Stock
                <span className="block font-normal normal-case">{branchLabel}</span>
              </th>
              <th scope="col" className="px-3 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <MatrixRowView
                key={row.key}
                row={row}
                codes={codes}
                draft={drafts[row.key] ?? blankDraft("0", "0")}
                onDraftChange={(patch) => onDraftChange(row.key, patch)}
                onRemoved={onRemoved}
                onAdjusted={onAdjusted}
                disabled={disabled}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-caption text-muted">
        SKU and barcode are generated when a row is first saved; clear a SKU to keep the generated
        one. Rows marked <em>not selected</em> are kept, never silently deleted — they may hold stock
        or sales history.
      </p>
    </div>
  );
}

function columnCodes(rows: MatrixRow[]): string[] {
  const codes: string[] = [];
  for (const row of rows) {
    for (const code of Object.keys(row.combination)) {
      if (!codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

function MatrixRowView({
  row,
  codes,
  draft,
  onDraftChange,
  onRemoved,
  onAdjusted,
  disabled,
}: {
  row: MatrixRow;
  codes: string[];
  draft: RowDraft;
  onDraftChange: (patch: Partial<RowDraft>) => void;
  onRemoved: (variantId: string) => void;
  onAdjusted: () => void;
  disabled: boolean;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [adjusted, setAdjusted] = useState(false);

  const saved = row.existing;
  const stock = saved?.stock;

  async function submitAdjustment() {
    setRowError(null);
    if (!reason.trim()) {
      setRowError("A reason is required for an adjustment.");
      return;
    }
    const value = Number(counted);
    if (!Number.isInteger(value) || value < 0) {
      setRowError("Counted stock must be a whole number, zero or more.");
      return;
    }

    setBusy(true);
    try {
      // The branch is left to the API: `resolve_branch` uses the signed-in
      // user's branch, or the default one. Sending a branch id would need
      // `settings.view`, which a merchandiser does not have.
      await apiClient("/inventory/adjust/", {
        method: "POST",
        body: { variant: saved!.id, new_on_hand: value, reason: reason.trim() },
      });
      setAdjusting(false);
      setReason("");
      setCounted("");
      setAdjusted(true);
      onAdjusted();
    } catch (caught) {
      setRowError(caught instanceof ApiError ? caught.message : "Could not adjust stock.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!saved) return;
    const confirmed = window.confirm(
      `Remove ${saved.sku}? If it has stock or sales it is archived rather than deleted, so history keeps resolving.`,
    );
    if (!confirmed) return;

    setBusy(true);
    setRowError(null);
    try {
      await apiClient(`/variants/${saved.id}/`, { method: "DELETE" });
      onRemoved(saved.id);
    } catch (caught) {
      setRowError(caught instanceof ApiError ? caught.message : "Could not remove this variant.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr className={cn(row.state === "unselected" && "bg-[var(--warning)]/5")}>
        {codes.map((code) => (
          <td key={code} className="px-3 py-2">
            {row.labels[code] ?? "—"}
          </td>
        ))}

        <td className="px-3 py-2">
          <Input
            value={draft.sku}
            onChange={(event) => onDraftChange({ sku: event.target.value })}
            placeholder={saved ? "" : "auto"}
            aria-label={`SKU for ${describe(row)}`}
            disabled={disabled}
            className="h-8 w-32 text-body-sm"
          />
          {row.state === "new" && <Badge tone="brand">New</Badge>}
          {row.state === "unselected" && <Badge tone="warning">Not selected</Badge>}
          {saved?.status === "ARCHIVED" && <Badge tone="neutral">Archived</Badge>}
        </td>

        <td className="px-3 py-2 text-right">
          <Input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={draft.price}
            onChange={(event) => onDraftChange({ price: event.target.value })}
            aria-label={`Price for ${describe(row)}`}
            disabled={disabled}
            className="tabular h-8 w-24 text-right text-body-sm"
          />
        </td>

        <td className="px-3 py-2 text-right">
          <Input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={draft.compareAt}
            onChange={(event) => onDraftChange({ compareAt: event.target.value })}
            aria-label={`Compare-at price for ${describe(row)}`}
            disabled={disabled}
            className="tabular h-8 w-24 text-right text-body-sm"
          />
        </td>

        <td className="px-3 py-2 text-right">
          <Input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={draft.cost}
            onChange={(event) => onDraftChange({ cost: event.target.value })}
            aria-label={`Cost for ${describe(row)}`}
            disabled={disabled}
            className="tabular h-8 w-24 text-right text-body-sm"
          />
        </td>

        <td className="px-3 py-2 text-right">
          {saved ? (
            <div className="flex items-center justify-end gap-2">
              <span className="tabular">
                {stock ? stock.on_hand : 0}
                {stock && stock.reserved > 0 && (
                  <span className="ml-1 text-caption text-muted">({stock.reserved} held)</span>
                )}
              </span>
              {adjusted && (
                <Check className="size-4 text-[var(--success)]" aria-label="Stock adjusted" />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAdjusting((open) => !open)}
                aria-expanded={adjusting}
                disabled={disabled}
              >
                Adjust
              </Button>
            </div>
          ) : (
            <Input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={draft.openingStock}
              onChange={(event) => onDraftChange({ openingStock: event.target.value })}
              aria-label={`Opening stock for ${describe(row)}`}
              disabled={disabled}
              className="tabular h-8 w-20 text-right text-body-sm"
            />
          )}
        </td>

        <td className="px-3 py-2 text-right">
          {saved && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={remove}
              loading={busy && !adjusting}
              disabled={disabled}
              aria-label={`Remove ${saved.sku}`}
            >
              <Trash2 aria-hidden />
            </Button>
          )}
        </td>
      </tr>

      {(adjusting || rowError) && (
        <tr className="bg-neutral-50">
          <td colSpan={codes.length + 6} className="px-3 py-3">
            {rowError && (
              <p role="alert" className="mb-2 text-body-sm text-[var(--error)]">
                {rowError}
              </p>
            )}
            {adjusting && saved && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-body-sm">
                  <span className="mb-1 block font-medium">Counted stock</span>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    value={counted}
                    onChange={(event) => setCounted(event.target.value)}
                    className="tabular h-9 w-28"
                  />
                </label>
                <label className="min-w-[16rem] flex-1 text-body-sm">
                  <span className="mb-1 block font-medium">Reason</span>
                  <Input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Opening stock, stock count, damage found…"
                    className="h-9"
                  />
                </label>
                <Button type="button" onClick={submitAdjustment} loading={busy}>
                  Write adjustment
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAdjusting(false)}>
                  Cancel
                </Button>
                <p className="w-full text-caption text-muted">
                  This writes an <code>ADJUSTMENT</code> row to the inventory ledger against{" "}
                  {saved.sku}, attributed to you. Unit cost on record {money(saved.cost)}.
                </p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function describe(row: MatrixRow): string {
  const labels = Object.values(row.labels);
  return labels.length ? labels.join(" / ") : (row.existing?.sku ?? "variant");
}
