"use client";

import { Check, Info, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export type TaxMode = "EXCLUSIVE" | "INCLUSIVE";

export interface TaxSettingsValues {
  tax_mode: TaxMode;
  /** A fraction as the API stores it: "0.1500" is 15%. */
  default_tax_rate: string;
  tax_settled_at: string | null;
  tax_settled_by_name: string;
}

/**
 * The VAT decision, made in the app instead of in an environment variable.
 *
 * This is decision D-C in docs/business-rules.md §3.4 — the one the build plan
 * said had to be settled before the first real sale. Two things make it
 * different from the fields above it on this page:
 *
 *  1. It changes arithmetic, not a label. Under EXCLUSIVE the tax is added to
 *     the shown price; under INCLUSIVE it is extracted from it.
 *  2. Once orders exist the API refuses an unconfirmed change (409
 *     TAX_CHANGE_NEEDS_CONFIRMATION) and tells us how many orders were priced
 *     under the current treatment. We surface that count and ask, rather than
 *     retrying silently.
 *
 * The API stores a fraction; a shopkeeper thinks in percent. The conversion
 * happens here so the stored value stays exact.
 */
export function TaxSettingsForm({
  initial,
  canManage,
}: {
  initial: TaxSettingsValues;
  canManage: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<TaxMode>(initial.tax_mode);
  const [percent, setPercent] = useState(toPercent(initial.default_tax_rate));
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState<{ count: number; message: string } | null>(null);

  const initialPercent = toPercent(initial.default_tax_rate);
  const dirty = mode !== initial.tax_mode || percent !== initialPercent;

  async function save(confirm: boolean) {
    setErrors([]);

    const parsed = Number(percent);
    if (!percent.trim() || Number.isNaN(parsed)) {
      setErrors([{ field: "rate", message: "Enter the VAT rate as a percentage, e.g. 15." }]);
      return;
    }
    if (parsed < 0 || parsed > 100) {
      setErrors([{ field: "rate", message: "The VAT rate must be between 0 and 100%." }]);
      return;
    }

    setSaving(true);
    try {
      await apiClient("/organization/tax/", {
        method: "PATCH",
        body: {
          tax_mode: mode,
          default_tax_rate: toFraction(parsed),
          ...(confirm ? { confirm: true } : {}),
        },
      });
      setSaved(true);
      setConfirming(null);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "TAX_CHANGE_NEEDS_CONFIRMATION") {
        const details = (caught.details ?? {}) as { order_count?: number; message?: string };
        setConfirming({
          count: details.order_count ?? 0,
          message: details.message ?? caught.message,
        });
      } else if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length
            ? fieldErrors.map((error) => ({
                field: error.field === "default_tax_rate" ? "rate" : error.field,
                message: error.message,
              }))
            : [{ field: "rate", message: caught.message }],
        );
      } else {
        setErrors([{ field: "rate", message: "Could not save. Please try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const settled = Boolean(initial.tax_settled_at);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>VAT</CardTitle>
        <Badge tone={settled ? "success" : "warning"}>
          {settled ? "Settled" : "Not yet decided"}
        </Badge>
      </CardHeader>
      <CardContent>
        {!settled && (
          <p className="mb-4 flex gap-2 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-body-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden />
            <span>
              Settle this before the first real sale. Every order records the treatment it was
              priced under, so deciding late leaves reports spanning two different meanings of the
              same total.
            </span>
          </p>
        )}

        {!canManage && (
          <p className="mb-4 rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
            You can view the VAT treatment but not change it. Editing needs the
            <code className="mx-1">settings.manage</code> permission.
          </p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
          noValidate
          className="space-y-4"
        >
          <ErrorSummary errors={errors} title="Could not save the VAT settings" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="How prices include VAT"
              htmlFor="tax-mode"
              required
              hint={
                mode === "INCLUSIVE"
                  ? "Catalogue prices already contain VAT. The shopper pays the price on the label."
                  : "VAT is added on top of the catalogue price at checkout."
              }
            >
              <Select
                id="tax-mode"
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as TaxMode);
                  setSaved(false);
                  setConfirming(null);
                }}
                disabled={!canManage}
              >
                <option value="EXCLUSIVE">Exclusive — added on top of the shown price</option>
                <option value="INCLUSIVE">Inclusive — already inside the shown price</option>
              </Select>
            </Field>

            <Field
              label="Default VAT rate"
              htmlFor="tax-rate"
              required
              hint="A percentage. Individual categories can override it."
              error={errorFor("rate")}
            >
              <div className="flex items-center gap-2">
                <Input
                  id="tax-rate"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step="0.01"
                  value={percent}
                  onChange={(event) => {
                    setPercent(event.target.value);
                    setSaved(false);
                    setConfirming(null);
                  }}
                  disabled={!canManage}
                  invalid={Boolean(errorFor("rate"))}
                  aria-describedby="tax-rate-hint"
                />
                <span aria-hidden className="text-body-sm text-muted">
                  %
                </span>
              </div>
            </Field>
          </div>

          <p className="flex gap-2 rounded-md bg-neutral-50 p-3 text-caption text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {mode === "INCLUSIVE"
                ? "A ৳1,150 item at 15% is recorded as ৳1,000 of revenue and ৳150 of VAT. The customer pays ৳1,150."
                : "A ৳1,000 item at 15% is recorded as ৳1,000 of revenue and ৳150 of VAT. The customer pays ৳1,150."}{" "}
              Delivery is never taxed under either treatment.
            </span>
          </p>

          {confirming && (
            <div
              role="alert"
              className="space-y-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-4"
            >
              <p className="flex gap-2 text-body-sm font-medium">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden />
                <span>
                  {confirming.count} order{confirming.count === 1 ? "" : "s"} already priced under
                  the current treatment
                </span>
              </p>
              <p className="text-body-sm text-neutral-700">{confirming.message}</p>
              {canManage && (
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    loading={saving}
                    onClick={() => {
                      void save(true);
                    }}
                  >
                    Change it anyway
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}

          {canManage && !confirming && (
            <div className="flex items-center gap-3">
              <Button type="submit" loading={saving} disabled={!dirty && settled}>
                {settled ? "Save changes" : "Confirm VAT treatment"}
              </Button>
              {saved && (
                <span
                  role="status"
                  className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
                >
                  <Check className="size-4" aria-hidden /> Saved
                </span>
              )}
              {dirty && !saving && !saved && (
                <span className="text-caption text-muted">Unsaved changes</span>
              )}
            </div>
          )}
        </form>

        {settled && (
          <p className="mt-4 border-t border-border pt-3 text-caption text-muted">
            Last confirmed {formatDate(initial.tax_settled_at)}
            {initial.tax_settled_by_name ? ` by ${initial.tax_settled_by_name}` : ""}. Every change
            is written to the audit log.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** "0.1500" -> "15". Trailing zeros are dropped so the input reads naturally. */
function toPercent(fraction: string): string {
  const value = Number(fraction);
  if (Number.isNaN(value)) return "0";
  return String(Number((value * 100).toFixed(2)));
}

/** 15 -> "0.1500", matching the DecimalField(6, 4) the API stores. */
function toFraction(percent: number): string {
  return (percent / 100).toFixed(4);
}

function formatDate(value: string | null): string {
  if (!value) return "never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "never";
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
