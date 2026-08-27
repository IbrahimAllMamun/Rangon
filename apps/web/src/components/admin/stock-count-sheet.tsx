"use client";

import { Ban, Check, ClipboardCheck, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Badge, Button, Card, ErrorSummary, Input } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { StockCount, StockCountItem } from "@/lib/api/types";

type FieldError = { field: string; message: string };

function variance(item: StockCountItem, typed: string | undefined) {
  const value = typed ?? (item.counted_quantity === null ? "" : String(item.counted_quantity));
  if (value === "") return null;
  const counted = Number(value);
  return Number.isFinite(counted) ? counted - item.expected_quantity : null;
}

/**
 * The count sheet: what the ledger believes, beside what was found.
 *
 * `expected_quantity` is deliberately not editable. It is the ledger's
 * snapshot taken when the count was opened, and it is the only thing that
 * makes the variance meaningful — a sheet where both columns can be typed is
 * just a form for asserting whatever total you like.
 *
 * Saving and applying are separate on purpose. Counting a shop takes hours and
 * more than one person; nothing touches stock until somebody applies the sheet,
 * and applying writes ADJUSTMENT rows through the ledger rather than setting
 * any number directly.
 */
export function StockCountSheet({ count, canCount }: { count: StockCount; canCount: boolean }) {
  const router = useRouter();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const open = count.status === "COUNTING";

  const countedSoFar = useMemo(
    () =>
      count.items.filter(
        (item) => item.counted_quantity !== null || (typed[item.id] ?? "") !== "",
      ).length,
    [count.items, typed],
  );

  const dirty = Object.keys(typed).length > 0 || Object.keys(notes).length > 0;

  async function save() {
    setErrors([]);
    setSaved(null);
    const lines = count.items
      .filter((item) => (typed[item.id] ?? "") !== "" || notes[item.id] !== undefined)
      .map((item) => {
        const raw = typed[item.id] ?? (item.counted_quantity === null ? "" : String(item.counted_quantity));
        return {
          variant: item.variant,
          counted_quantity: Number(raw),
          notes: notes[item.id] ?? item.notes,
          sku: item.sku,
          raw,
        };
      });

    const bad = lines.filter(
      (line) => line.raw === "" || !Number.isInteger(line.counted_quantity) || line.counted_quantity < 0,
    );
    if (bad.length) {
      setErrors(
        bad.map((line) => ({
          field: `count-${line.variant}`,
          message: `Enter a whole number of zero or more for ${line.sku}.`,
        })),
      );
      return;
    }
    if (lines.length === 0) {
      setErrors([{ field: "sheet", message: "Nothing has been typed in yet." }]);
      return;
    }

    setSaving(true);
    try {
      const result = await apiClient<{ recorded: number; counted: number; total: number }>(
        `/stock-counts/${count.id}/record/`,
        {
          method: "POST",
          body: {
            lines: lines.map(({ variant, counted_quantity, notes: note }) => ({
              variant,
              counted_quantity,
              notes: note,
            })),
          },
        },
      );
      setSaved(`Saved ${result.recorded} line${result.recorded === 1 ? "" : "s"} — ${result.counted} of ${result.total} counted.`);
      setTyped({});
      setNotes({});
      router.refresh();
    } catch (caught) {
      setErrors([
        {
          field: "sheet",
          message: caught instanceof ApiError ? caught.message : "Could not save the count.",
        },
      ]);
    } finally {
      setSaving(false);
    }
  }

  async function act(path: "apply" | "cancel") {
    setErrors([]);
    setSaved(null);
    setApplying(true);
    try {
      await apiClient(`/stock-counts/${count.id}/${path}/`, { method: "POST", body: {} });
      router.refresh();
    } catch (caught) {
      setErrors([
        {
          field: "sheet",
          message: caught instanceof ApiError ? caught.message : "That did not work. Try again.",
        },
      ]);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorSummary errors={errors} title="Could not save this count" />

      {saved && (
        <p
          role="status"
          className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
        >
          <Check className="size-4" aria-hidden /> {saved}
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <caption className="sr-only">
              Stock count {count.number}: expected against counted
            </caption>
            <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Product</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Expected</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Counted</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Variance</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {count.items.map((item) => {
                const value = typed[item.id] ?? (item.counted_quantity === null ? "" : String(item.counted_quantity));
                const delta = variance(item, typed[item.id]);
                return (
                  <tr key={item.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-2">
                      <span className="block font-medium">{item.product_name}</span>
                      <span className="block font-mono text-caption text-muted">{item.sku}</span>
                    </td>
                    <td className="tabular px-4 py-2 text-right text-muted">
                      {item.expected_quantity}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <label htmlFor={`count-${item.variant}`} className="sr-only">
                        Counted quantity for {item.sku}
                      </label>
                      <Input
                        id={`count-${item.variant}`}
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        className="ml-auto w-24 text-right"
                        disabled={!open || !canCount}
                        value={value}
                        placeholder="—"
                        onChange={(event) =>
                          setTyped((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                      />
                    </td>
                    <td className="tabular px-4 py-2 text-right">
                      {delta === null ? (
                        <span className="text-muted">—</span>
                      ) : delta === 0 ? (
                        <Badge tone="success">Matches</Badge>
                      ) : (
                        <Badge tone={delta < 0 ? "error" : "warning"}>
                          {delta > 0 ? "+" : ""}
                          {delta}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <label htmlFor={`note-${item.variant}`} className="sr-only">
                        Note for {item.sku}
                      </label>
                      <Input
                        id={`note-${item.variant}`}
                        disabled={!open || !canCount}
                        value={notes[item.id] ?? item.notes}
                        placeholder="Optional"
                        onChange={(event) =>
                          setNotes((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2 text-caption text-muted">
          {countedSoFar} of {count.items.length} lines counted. An uncounted line is left alone when
          the sheet is applied — it is not treated as a count of zero.
        </p>
      </Card>

      {open && canCount && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={save} loading={saving} variant="secondary">
            <Save className="size-4" aria-hidden />
            Save progress
          </Button>
          <Button
            type="button"
            onClick={() => act("apply")}
            loading={applying}
            disabled={dirty || countedSoFar === 0}
          >
            <ClipboardCheck className="size-4" aria-hidden />
            Apply to stock
          </Button>
          <Button type="button" variant="ghost" onClick={() => act("cancel")} disabled={applying}>
            <Ban className="size-4" aria-hidden />
            Cancel count
          </Button>
          {dirty && (
            <span className="text-caption text-muted">
              Save your typed figures before applying.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
