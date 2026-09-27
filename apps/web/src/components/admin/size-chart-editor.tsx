"use client";

/**
 * Edit one size chart: its name, sizing system, notes, and the grid.
 *
 * The grid is sizes down, headings across. The sizes are the attribute's own
 * values in the attribute's order — they are ticked in or out, never typed —
 * so the chart can only describe sizes the shop actually has, and a renamed
 * size is renamed in every chart. The headings are free text, because they are
 * what differs by region: `Chest (cm)` in one chart, `UK` / `US` / `EU` in
 * another (docs/business-rules.md §5b).
 *
 * Built for the keyboard, like the rest of the admin: every cell is a real
 * input in reading order, and columns move with buttons rather than by
 * dragging. The size column is sticky so a wide chart keeps its row labels in
 * view; the scroller's `scroll-padding-left` matches that column's width, so a
 * focused cell scrolled into view is never hidden underneath it (WCAG 2.2
 * "focus not obscured").
 */

import { ArrowLeft, ArrowRight, Check, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

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
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import {
  type ChartDraft,
  type ChartProblem,
  type SizeChartData,
  type SizeOption,
  MAX_COLUMNS,
  SIZING_SYSTEMS,
  addColumn,
  chartFieldId,
  chartPayload,
  draftFromChart,
  moveColumn,
  removeColumn,
  renameColumn,
  setCell,
  setIncluded,
  validateChartDraft,
} from "@/lib/commerce/size-chart";

/** Width of the sticky size column, and the scroller's matching padding. */
const SIZE_COLUMN = "9rem";

/** The API keys its refusals by field; this puts each beside its control. */
function fromApi(caught: unknown, draft: ChartDraft): ChartProblem[] {
  if (!(caught instanceof ApiError)) {
    return [{ field: chartFieldId.name, message: "Could not save the chart. Please try again." }];
  }
  const firstIncluded = draft.rows.find((row) => row.included);
  const target: Record<string, string> = {
    name: chartFieldId.name,
    system: chartFieldId.system,
    notes: chartFieldId.notes,
    columns: chartFieldId.column(0),
    rows: firstIncluded ? chartFieldId.cell(firstIncluded.valueId, 0) : chartFieldId.name,
  };
  const found = caught.fieldErrors();
  if (!found.length) return [{ field: chartFieldId.name, message: caught.message }];
  return found.map((error) => ({
    field: target[error.field.split(".")[0]] ?? chartFieldId.name,
    message: error.message,
  }));
}

export function SizeChartEditor({
  attribute,
  sizes,
  chart,
  canManage,
  canDelete,
}: {
  attribute: { id: string; name: string };
  sizes: SizeOption[];
  chart: SizeChartData | null;
  canManage: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ChartDraft>(() => draftFromChart(chart, sizes));
  const [errors, setErrors] = useState<ChartProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const productCount = chart?.product_count ?? 0;
  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const included = useMemo(() => draft.rows.filter((row) => row.included).length, [draft.rows]);

  function update(next: ChartDraft) {
    setDraft(next);
    setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const problems = validateChartDraft(draft);
    setErrors(problems);
    if (problems.length) return;

    setSaving(true);
    try {
      const body = chartPayload(draft);
      if (chart) {
        await apiClient(`/size-charts/${chart.id}/`, { method: "PATCH", body });
        setSaved(true);
        router.refresh();
      } else {
        const created = await apiClient<{ id: string }>("/size-charts/", {
          method: "POST",
          body: { ...body, attribute: attribute.id },
        });
        // Onto the chart's own page, so the next save edits it rather than
        // creating a second one.
        router.replace(`/admin/taxonomy/size-charts/${created.id}`);
      }
    } catch (caught) {
      setErrors(fromApi(caught, draft));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!chart) return;
    if (!window.confirm(`Delete the “${chart.name}” size chart?`)) return;
    setDeleting(true);
    try {
      await apiClient(`/size-charts/${chart.id}/`, { method: "DELETE" });
      router.push("/admin/taxonomy#attributes");
      router.refresh();
    } catch (caught) {
      // A chart products still use is refused, and the API says how many.
      setErrors([
        {
          field: chartFieldId.name,
          message: caught instanceof ApiError ? caught.message : "Could not delete the chart.",
        },
      ]);
      setDeleting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <ErrorSummary errors={errors} title="Could not save the size chart" />

      {!canManage && (
        <p className="rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
          You can view this chart but not change it. Editing needs the
          <code className="mx-1">products.update</code> permission — the API refuses the write
          regardless of what this screen shows.
        </p>
      )}

      {/* `disabled` on a fieldset disables every control inside it natively. */}
      <fieldset disabled={!canManage} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Chart</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Name"
                htmlFor={chartFieldId.name}
                required
                error={errorFor(chartFieldId.name)}
                hint="What the admin picks from, e.g. “Men's shirts” or “Kids”."
              >
                <Input
                  id={chartFieldId.name}
                  value={draft.name}
                  onChange={(event) => update({ ...draft, name: event.target.value })}
                  invalid={Boolean(errorFor(chartFieldId.name))}
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Sizing system"
                htmlFor={chartFieldId.system}
                error={errorFor(chartFieldId.system)}
                hint="Which standard the sizes follow. Shown to shoppers beside the chart."
              >
                <Input
                  id={chartFieldId.system}
                  list="sizing-systems"
                  value={draft.system}
                  onChange={(event) => update({ ...draft, system: event.target.value })}
                  placeholder="International"
                  autoComplete="off"
                />
                <datalist id="sizing-systems">
                  {SIZING_SYSTEMS.map((system) => (
                    <option key={system} value={system} />
                  ))}
                </datalist>
              </Field>
            </div>

            <Field
              label="How to measure"
              htmlFor={chartFieldId.notes}
              error={errorFor(chartFieldId.notes)}
              hint="Optional. Shown under the chart on the product page."
            >
              <Textarea
                id={chartFieldId.notes}
                rows={3}
                value={draft.notes}
                onChange={(event) => update({ ...draft, notes: event.target.value })}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sizes and figures</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-body-sm text-muted">
              Tick the {attribute.name.toLowerCase()} values this chart covers and fill in a figure
              under each heading. Headings are free text — measurements such as{" "}
              <strong>Chest (cm)</strong>, or other sizing systems such as <strong>UK</strong> or{" "}
              <strong>EU</strong>. Ranges like “92–96” are fine. The sizes follow the order set on
              the attribute.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => update(addColumn(draft))}
                disabled={draft.columns.length >= MAX_COLUMNS}
              >
                <Plus aria-hidden /> Add column
              </Button>
              <span className="text-caption text-muted" aria-live="polite">
                {draft.columns.length} of {MAX_COLUMNS} columns · {included} of {draft.rows.length}{" "}
                sizes included
              </span>
            </div>

            <div
              className="overflow-x-auto rounded-md border border-border"
              style={{ scrollPaddingLeft: SIZE_COLUMN }}
            >
              <table className="w-full border-collapse text-body-sm">
                <caption className="sr-only">
                  {draft.name || "New size chart"}: one row per {attribute.name.toLowerCase()}, one
                  column per heading.
                </caption>
                <thead>
                  <tr className="bg-neutral-50">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 border-b border-r border-border bg-neutral-50 px-3 py-2 text-left font-medium"
                      style={{ width: SIZE_COLUMN, minWidth: SIZE_COLUMN }}
                    >
                      {attribute.name}
                    </th>
                    {draft.columns.map((label, index) => {
                      const id = chartFieldId.column(index);
                      const name = label.trim() || `column ${index + 1}`;
                      return (
                        <th
                          key={index}
                          scope="col"
                          className="min-w-40 border-b border-border px-2 py-2 text-left align-top font-normal"
                        >
                          <Input
                            id={id}
                            value={label}
                            onChange={(event) => update(renameColumn(draft, index, event.target.value))}
                            placeholder={index === 0 ? "Chest (cm)" : "UK"}
                            aria-label={`Heading of column ${index + 1}`}
                            invalid={Boolean(errorFor(id))}
                            className="h-9 font-medium"
                          />
                          <div className="mt-1 flex gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              disabled={index === 0}
                              onClick={() => update(moveColumn(draft, index, "left"))}
                              aria-label={`Move ${name} left`}
                            >
                              <ArrowLeft aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              disabled={index === draft.columns.length - 1}
                              onClick={() => update(moveColumn(draft, index, "right"))}
                              aria-label={`Move ${name} right`}
                            >
                              <ArrowRight aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              disabled={draft.columns.length <= 1}
                              onClick={() => update(removeColumn(draft, index))}
                              aria-label={`Remove ${name}`}
                            >
                              <X aria-hidden />
                            </Button>
                          </div>
                          {errorFor(id) && (
                            <p className="mt-1 text-caption text-[var(--error)]">{errorFor(id)}</p>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {draft.rows.map((row) => {
                    const includeId = chartFieldId.include(row.valueId);
                    const rowError = draft.columns
                      .map((_, index) => errorFor(chartFieldId.cell(row.valueId, index)))
                      .find(Boolean);
                    return (
                      <tr
                        key={row.valueId}
                        className={cn("border-b border-border last:border-b-0", !row.included && "bg-neutral-50")}
                      >
                        <th
                          scope="row"
                          className={cn(
                            "sticky left-0 z-10 border-r border-border px-3 py-1.5 text-left font-medium",
                            row.included ? "bg-surface" : "bg-neutral-50",
                          )}
                          style={{ width: SIZE_COLUMN, minWidth: SIZE_COLUMN }}
                        >
                          <label htmlFor={includeId} className="flex cursor-pointer items-center gap-2">
                            <Checkbox
                              id={includeId}
                              checked={row.included}
                              onChange={(event) =>
                                update(setIncluded(draft, row.valueId, event.target.checked))
                              }
                            />
                            <span className={cn(!row.included && "text-muted")}>{row.label}</span>
                          </label>
                          {rowError && (
                            <p className="mt-1 text-caption font-normal text-[var(--error)]">{rowError}</p>
                          )}
                        </th>
                        {row.cells.map((cell, index) => {
                          const id = chartFieldId.cell(row.valueId, index);
                          return (
                            <td key={index} className="px-2 py-1.5">
                              <Input
                                id={id}
                                value={cell}
                                disabled={!row.included}
                                onChange={(event) =>
                                  update(setCell(draft, row.valueId, index, event.target.value))
                                }
                                aria-label={`${draft.columns[index].trim() || `Column ${index + 1}`} for ${row.label}`}
                                invalid={Boolean(errorFor(id))}
                                className="h-9 tabular"
                                autoComplete="off"
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {draft.rows.length === 0 && (
              <p className="text-body-sm text-muted">
                {attribute.name} has no values yet. Add sizes to it on{" "}
                <Link href="/admin/taxonomy#attributes" className="underline hover:text-brand-600">
                  Categories &amp; brands
                </Link>{" "}
                first.
              </p>
            )}
          </CardContent>
        </Card>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        {canManage && (
          <Button type="submit" loading={saving}>
            {chart ? "Save chart" : "Create chart"}
          </Button>
        )}
        <Button asChild variant="secondary">
          <Link href="/admin/taxonomy#attributes">{canManage ? "Cancel" : "Back"}</Link>
        </Button>
        {saved && (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success-text)]"
          >
            <Check className="size-4" aria-hidden /> Saved
          </span>
        )}

        {chart && canDelete && (
          <div className="ml-auto flex items-center gap-3">
            {productCount > 0 && (
              <span className="text-caption text-muted">
                Used by {productCount} product{productCount === 1 ? "" : "s"} — pick another chart
                for {productCount === 1 ? "it" : "them"} before deleting.
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={remove}
              loading={deleting}
              disabled={productCount > 0}
            >
              <Trash2 aria-hidden /> Delete chart
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
