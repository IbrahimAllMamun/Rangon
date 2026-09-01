"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorSummary,
  Field,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { dateTime } from "@/lib/format";

export interface StockExceptionRow {
  id: string;
  branch_code: string;
  sku: string;
  product_name: string;
  variant_label: string;
  shortfall: number;
  on_hand_after: number;
  on_hand_now: number | null;
  reference_type: string;
  reference_id: string;
  status: "OPEN" | "RESOLVED";
  resolution: string;
  resolution_note: string;
  resolved_at: string | null;
  resolved_by_name: string;
  created_at: string;
}

/**
 * What the manager concluded. These four are the whole vocabulary — the API
 * refuses anything else — and each one means something different to whoever
 * reads the history later:
 *
 *   RESTOCKED    the goods turned up; nothing was actually lost
 *   WRITTEN_OFF  they never turned up; this is shrinkage
 *   COUNTED      a stock count has since re-baselined the figure
 *   NOT_AN_ERROR the system was wrong about the stock, not the shop
 *
 * Resolving does not move stock. If the shortfall needs correcting that is a
 * receipt, a write-off or a count, each of which writes its own ledger row.
 */
const RESOLUTIONS = [
  {
    value: "RESTOCKED",
    label: "Stock arrived and covers it",
    hint: "A delivery has since made the balance good.",
  },
  {
    value: "WRITTEN_OFF",
    label: "Written off as lost",
    hint: "The goods never turned up. Record the write-off separately so the ledger agrees.",
  },
  {
    value: "COUNTED",
    label: "Corrected by a stock count",
    hint: "A count has re-baselined this variant since.",
  },
  {
    value: "NOT_AN_ERROR",
    label: "Expected — no action needed",
    hint: "Consignment stock, a known data gap, or a sale recorded twice deliberately.",
  },
] as const;

function referenceLabel(row: StockExceptionRow): string {
  if (!row.reference_id) return "—";
  const kind = row.reference_type.replace(/_/g, " ");
  return `${kind} ${row.reference_id}`;
}

/**
 * The oversell report.
 *
 * `docs/architecture/offline-pos.md` makes this screen the price of admission
 * for offline selling: stock is allowed below zero only because somebody is
 * guaranteed to be shown it here. So the open queue is deliberately loud, and
 * a resolution cannot be clicked away without a written reason — a queue that
 * empties itself is the same as no queue at all.
 */
export function StockExceptionTable({
  rows,
  canResolve,
}: {
  rows: StockExceptionRow[];
  canResolve: boolean;
}) {
  const router = useRouter();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [resolution, setResolution] = useState<string>(RESOLUTIONS[0].value);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);

  function startResolving(id: string) {
    setOpenFor(id);
    setResolution(RESOLUTIONS[0].value);
    setNote("");
    setErrors([]);
  }

  async function submit(event: React.FormEvent, id: string) {
    event.preventDefault();
    if (!note.trim()) {
      setErrors([
        { field: "se-note", message: "Say what was done about it. An unexplained close explains nothing." },
      ]);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      await apiClient(`/stock-exceptions/${id}/resolve/`, {
        method: "POST",
        body: { resolution, note },
      });
      setOpenFor(null);
      setNote("");
      router.refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not resolve. Please try again.";
      setErrors([{ field: "se-note", message }]);
    } finally {
      setSaving(false);
    }
  }

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Check className="size-8" aria-hidden />}
          title="Nothing oversold"
          description="Every movement so far has left stock at zero or above."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[64rem] text-body-sm">
        <caption className="sr-only">
          Movements that took stock below zero, newest first
        </caption>
        <thead className="border-b border-neutral-200 text-left text-caption uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">When</th>
            <th scope="col" className="px-4 py-3 font-medium">Product</th>
            <th scope="col" className="px-4 py-3 font-medium">Source</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Short by</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Balance now</th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((row) => {
            const covered = row.on_hand_now !== null && row.on_hand_now >= 0;
            return (
              <Fragment key={row.id}>
                <tr className={row.status === "OPEN" ? "bg-[var(--warning-bg)]/40" : ""}>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">
                    {dateTime(row.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{row.product_name}</span>
                    <span className="block text-caption text-muted">
                      {row.variant_label} · <span className="font-mono">{row.sku}</span> ·{" "}
                      {row.branch_code}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">{referenceLabel(row)}</td>
                  <td className="px-4 py-3 text-right font-mono font-medium text-[var(--error)]">
                    {row.shortfall}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {row.on_hand_now === null ? (
                      "—"
                    ) : (
                      <span className={covered ? "" : "text-[var(--error)]"}>{row.on_hand_now}</span>
                    )}
                    {covered && row.status === "OPEN" && (
                      <span className="block text-caption font-sans text-muted">covered since</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.status === "OPEN" ? (
                      <Badge tone="warning">Open</Badge>
                    ) : (
                      <>
                        <Badge tone="success">Resolved</Badge>
                        <span className="mt-1 block text-caption text-muted">
                          {RESOLUTIONS.find((option) => option.value === row.resolution)?.label ??
                            row.resolution}
                          {row.resolved_by_name ? ` · ${row.resolved_by_name}` : ""}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.status === "OPEN" && canResolve && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-expanded={openFor === row.id}
                        aria-controls={`se-form-${row.id}`}
                        onClick={() => (openFor === row.id ? setOpenFor(null) : startResolving(row.id))}
                      >
                        {openFor === row.id ? "Cancel" : "Resolve"}
                      </Button>
                    )}
                  </td>
                </tr>

                {row.status === "RESOLVED" && row.resolution_note && (
                  <tr>
                    <td colSpan={7} className="px-4 pb-3 text-caption text-muted">
                      <span className="font-medium">Note:</span> {row.resolution_note}
                    </td>
                  </tr>
                )}

                {openFor === row.id && (
                  <tr>
                    <td colSpan={7} className="bg-neutral-50 px-4 py-4">
                      <form
                        id={`se-form-${row.id}`}
                        onSubmit={(event) => submit(event, row.id)}
                        noValidate
                        className="max-w-2xl space-y-3"
                      >
                        <ErrorSummary errors={errors} title="Could not resolve this" />
                        <p className="flex items-start gap-2 text-body-sm text-neutral-700">
                          <AlertTriangle
                            className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
                            aria-hidden
                          />
                          <span>
                            Resolving records what you concluded. It does not move stock — if the
                            shortfall still needs correcting, receive it, write it off or run a count.
                          </span>
                        </p>

                        <Field
                          label="What was it"
                          htmlFor={`se-resolution-${row.id}`}
                          hint={RESOLUTIONS.find((option) => option.value === resolution)?.hint}
                        >
                          <Select
                            id={`se-resolution-${row.id}`}
                            value={resolution}
                            onChange={(event) => setResolution(event.target.value)}
                          >
                            {RESOLUTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </Field>

                        <Field
                          label="Note"
                          htmlFor="se-note"
                          required
                          error={errors.find((error) => error.field === "se-note")?.message}
                          hint="What you checked and what you found. This is the permanent record."
                        >
                          <Textarea
                            id="se-note"
                            rows={3}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            invalid={errors.some((error) => error.field === "se-note")}
                          />
                        </Field>

                        <div className="flex gap-2">
                          <Button type="submit" disabled={saving}>
                            {saving ? "Saving…" : "Resolve"}
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => setOpenFor(null)}>
                            Cancel
                          </Button>
                        </div>
                      </form>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
