"use client";

import { Check, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { StockBadge } from "@/components/admin/status-badge";
import { Button, ErrorSummary, Field, Input, Textarea } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { InventoryRow } from "@/lib/api/types";
import { money } from "@/lib/format";

type FieldError = { field: string; message: string };

/**
 * The stock table, with a correction available on the row that is wrong.
 *
 * An adjustment is always about a row somebody is already looking at — "the
 * shelf says nine and the screen says twelve" — which is why this is a per-row
 * action rather than another product picker like the write-off panel above it.
 * The picker is right there because a write-off starts from an event, not from
 * a row.
 *
 * The form opens inline, in a row beneath the one being corrected, so the
 * figures being compared stay on screen. Admin has no dialog anywhere and this
 * is not the screen to introduce one (CLAUDE.md §10).
 *
 * Nothing here writes stock. It posts the counted figure and the service works
 * out the difference, writes the ledger row and the audit entry.
 */
export function InventoryRows({
  rows,
  showBranch,
  canAdjust,
}: {
  rows: InventoryRow[];
  showBranch: boolean;
  canAdjust: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const columns = showBranch ? 10 : 9;

  return (
    <tbody className="divide-y divide-border">
      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          showBranch={showBranch}
          canAdjust={canAdjust}
          columns={columns}
          open={openId === row.id}
          onToggle={() => setOpenId((current) => (current === row.id ? null : row.id))}
          onDone={() => setOpenId(null)}
        />
      ))}
    </tbody>
  );
}

function Row({
  row,
  showBranch,
  canAdjust,
  columns,
  open,
  onToggle,
  onDone,
}: {
  row: InventoryRow;
  showBranch: boolean;
  canAdjust: boolean;
  columns: number;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  return (
    <>
      <tr className={open ? "bg-neutral-50" : "hover:bg-neutral-50"}>
        <td className="px-4 py-2.5">
          <span className="block font-medium">{row.product_name}</span>
          <span className="block text-caption text-muted">
            {row.variant_label} · {row.category}
          </span>
        </td>
        <td className="px-4 py-2.5 font-mono text-caption">{row.sku}</td>
        {showBranch && <td className="px-4 py-2.5">{row.branch_code}</td>}
        <td className="tabular px-4 py-2.5 text-right">{row.on_hand}</td>
        <td className="tabular px-4 py-2.5 text-right text-muted">{row.reserved}</td>
        <td className="tabular px-4 py-2.5 text-right font-medium">{row.available}</td>
        <td className="tabular px-4 py-2.5 text-right">{money(row.average_cost)}</td>
        <td className="tabular px-4 py-2.5 text-right">{money(row.stock_value)}</td>
        <td className="px-4 py-2.5">
          <StockBadge available={row.available} reorderPoint={row.reorder_point} />
        </td>
        {canAdjust && (
          <td className="px-4 py-2.5 text-right">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={`adjust-${row.id}`}
            >
              {open ? <X className="size-4" aria-hidden /> : <Pencil className="size-4" aria-hidden />}
              {open ? "Cancel" : "Adjust"}
            </Button>
          </td>
        )}
      </tr>
      {canAdjust && open && (
        <tr id={`adjust-${row.id}`} className="bg-neutral-50">
          <td colSpan={columns} className="px-4 pb-4 pt-1">
            <AdjustForm row={row} onDone={onDone} />
          </td>
        </tr>
      )}
    </>
  );
}

function AdjustForm({ row, onDone }: { row: InventoryRow; onDone: () => void }) {
  const router = useRouter();
  const [counted, setCounted] = useState(String(row.on_hand));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const countedNumber = Number(counted);
  const valid = counted !== "" && Number.isInteger(countedNumber) && countedNumber >= 0;
  const delta = valid ? countedNumber - row.on_hand : 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!valid) {
      found.push({
        field: `counted-${row.id}`,
        message: "Enter the counted quantity as a whole number, zero or more.",
      });
    } else if (delta === 0) {
      found.push({
        field: `counted-${row.id}`,
        message: "That is what the ledger already says, so there is nothing to correct.",
      });
    }
    if (!reason.trim()) {
      found.push({
        field: `reason-${row.id}`,
        message: "Say why the figure was wrong. This is written to the ledger.",
      });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      await apiClient("/inventory/adjust/", {
        method: "POST",
        body: {
          variant: row.variant,
          // The row's own branch, not the signed-in user's: this table can show
          // more than one. The API refuses a branch the user may not act on.
          branch: row.branch,
          new_on_hand: countedNumber,
          reason,
        },
      });
      onDone();
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length
            ? fieldErrors
            : [{ field: `counted-${row.id}`, message: caught.message }],
        );
      } else {
        setErrors([
          { field: `counted-${row.id}`, message: "Could not save. Please try again." },
        ]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <form onSubmit={submit} noValidate className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <ErrorSummary errors={errors} title="Could not adjust this stock" />

      <p className="text-body-sm text-muted">
        Correcting <span className="font-medium text-neutral-900">{row.product_name}</span>{" "}
        {row.variant_label} at <span className="font-mono">{row.branch_code}</span>. The ledger has{" "}
        <span className="tabular font-medium text-neutral-900">{row.on_hand}</span> on hand.
      </p>

      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <Field
          label="Counted"
          htmlFor={`counted-${row.id}`}
          required
          error={errorFor(`counted-${row.id}`)}
        >
          <Input
            id={`counted-${row.id}`}
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={counted}
            autoFocus
            onChange={(event) => setCounted(event.target.value)}
            invalid={Boolean(errorFor(`counted-${row.id}`))}
          />
        </Field>

        <Field
          label="Reason"
          htmlFor={`reason-${row.id}`}
          required
          hint="Goes on the ledger row and the audit trail, and cannot be edited afterwards."
          error={errorFor(`reason-${row.id}`)}
        >
          <Textarea
            id={`reason-${row.id}`}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            invalid={Boolean(errorFor(`reason-${row.id}`))}
            placeholder="Counted the rail on Tuesday — two had been mis-scanned at the counter"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving}>
          <Check className="size-4" aria-hidden />
          Save the count
        </Button>
        <span role="status" className="text-body-sm text-muted">
          {!valid || delta === 0
            ? "No movement yet."
            : `Writes ${delta > 0 ? "+" : "−"}${Math.abs(delta)} to the ledger.`}
        </span>
      </div>
    </form>
  );
}
