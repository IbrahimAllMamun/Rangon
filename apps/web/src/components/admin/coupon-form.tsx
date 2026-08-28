"use client";

import { Check, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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

export type DiscountType = "PERCENTAGE" | "FIXED" | "FREE_SHIPPING";

export interface CouponRow {
  id: string;
  code: string;
  description: string;
  discount_type: DiscountType;
  value: string;
  minimum_order_value: string;
  maximum_discount: string | null;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  usage_limit_per_customer: number | null;
  used_count: number;
  is_exhausted: boolean;
  categories: string[];
  products: string[];
  channels: string[];
  is_active: boolean;
  created_at: string;
}

interface Draft {
  code: string;
  description: string;
  discount_type: DiscountType;
  value: string;
  minimum_order_value: string;
  maximum_discount: string;
  starts_at: string;
  ends_at: string;
  usage_limit: string;
  usage_limit_per_customer: string;
  is_active: boolean;
}

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time; the API sends ISO/UTC. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function blank(): Draft {
  return {
    code: "",
    description: "",
    discount_type: "PERCENTAGE",
    value: "",
    minimum_order_value: "0.00",
    maximum_discount: "",
    starts_at: "",
    ends_at: "",
    usage_limit: "",
    usage_limit_per_customer: "1",
    is_active: true,
  };
}

function fromRow(row: CouponRow): Draft {
  return {
    code: row.code,
    description: row.description,
    discount_type: row.discount_type,
    value: row.discount_type === "FREE_SHIPPING" ? "" : row.value,
    minimum_order_value: row.minimum_order_value,
    maximum_discount: row.maximum_discount ?? "",
    starts_at: toLocalInput(row.starts_at),
    ends_at: toLocalInput(row.ends_at),
    usage_limit: row.usage_limit === null ? "" : String(row.usage_limit),
    usage_limit_per_customer:
      row.usage_limit_per_customer === null ? "" : String(row.usage_limit_per_customer),
    is_active: row.is_active,
  };
}

/**
 * Create and edit a coupon.
 *
 * The three discount types ask for different things, so the form changes shape
 * rather than showing fields that do nothing:
 *
 * - **Free shipping** carries no amount at all — the discount is the shipping
 *   line being zeroed at checkout — so the value field is not shown. It used to
 *   be required by a database constraint, which meant inventing a number; the
 *   constraint now exempts this type.
 * - **Maximum discount** caps a percentage. On a fixed amount the cap can only
 *   ever be the amount itself, so it is hidden there too.
 *
 * Every rule is re-checked by the API — this is here to answer sooner, not
 * instead. Blank usage limits mean "unlimited", which is why they are sent as
 * `null` rather than 0: zero would mean a coupon nobody can use.
 */
export function CouponForm({
  editing,
  onDone,
  onCancel,
}: {
  editing?: CouponRow;
  onDone?: (coupon: CouponRow) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(editing ? fromRow(editing) : blank());
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const isFreeShipping = draft.discount_type === "FREE_SHIPPING";
  const isPercentage = draft.discount_type === "PERCENTAGE";

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];

    if (!draft.code.trim()) found.push({ field: "code", message: "A coupon code is required." });

    if (!isFreeShipping) {
      const value = Number(draft.value);
      if (!draft.value.trim() || Number.isNaN(value)) {
        found.push({ field: "value", message: "Enter the discount amount." });
      } else if (value <= 0) {
        found.push({
          field: "value",
          message: "A discount of zero gives nothing away. Enter an amount above 0.",
        });
      } else if (isPercentage && value > 100) {
        found.push({ field: "value", message: "A percentage cannot exceed 100." });
      }
    }

    const startsAt = fromLocalInput(draft.starts_at);
    const endsAt = fromLocalInput(draft.ends_at);
    if (startsAt && endsAt && endsAt <= startsAt) {
      found.push({ field: "ends_at", message: "The end date must be after the start." });
    }

    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const body = {
        code: draft.code.trim().toUpperCase(),
        description: draft.description,
        discount_type: draft.discount_type,
        // Free shipping carries no amount; the API normalises this to 0 anyway.
        value: isFreeShipping ? "0.00" : draft.value,
        minimum_order_value: draft.minimum_order_value || "0.00",
        maximum_discount: isPercentage && draft.maximum_discount ? draft.maximum_discount : null,
        starts_at: startsAt,
        ends_at: endsAt,
        // Blank means unlimited, which the API stores as null.
        usage_limit: draft.usage_limit.trim() ? Number(draft.usage_limit) : null,
        usage_limit_per_customer: draft.usage_limit_per_customer.trim()
          ? Number(draft.usage_limit_per_customer)
          : null,
        is_active: draft.is_active,
      };
      const coupon = editing
        ? await apiClient<CouponRow>(`/coupons/${editing.id}/`, { method: "PATCH", body })
        : await apiClient<CouponRow>("/coupons/", { method: "POST", body });

      setSaved(true);
      if (!editing) setDraft(blank());
      onDone?.(coupon);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(fieldErrors.length ? fieldErrors : [{ field: "code", message: caught.message }]);
      } else {
        setErrors([{ field: "code", message: "Could not save. Please try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.code}` : "New coupon"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save this coupon" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Code"
              htmlFor="cpn-code"
              required
              hint="What the shopper types at checkout."
              error={errorFor("code")}
            >
              <Input
                id="cpn-code"
                value={draft.code}
                onChange={(event) => set("code", event.target.value.toUpperCase())}
                invalid={Boolean(errorFor("code"))}
                autoComplete="off"
                maxLength={32}
              />
            </Field>

            <Field label="Discount type" htmlFor="cpn-type" error={errorFor("discount_type")}>
              <Select
                id="cpn-type"
                value={draft.discount_type}
                onChange={(event) => set("discount_type", event.target.value as DiscountType)}
              >
                <option value="PERCENTAGE">Percentage off</option>
                <option value="FIXED">Fixed amount off</option>
                <option value="FREE_SHIPPING">Free shipping</option>
              </Select>
            </Field>

            {!isFreeShipping && (
              <Field
                label={isPercentage ? "Percentage off" : "Amount off"}
                htmlFor="cpn-value"
                required
                hint={isPercentage ? "1–100." : "In taka."}
                error={errorFor("value")}
              >
                <Input
                  id="cpn-value"
                  type="number"
                  min="0"
                  max={isPercentage ? "100" : undefined}
                  step="0.01"
                  inputMode="decimal"
                  value={draft.value}
                  onChange={(event) => set("value", event.target.value)}
                  invalid={Boolean(errorFor("value"))}
                />
              </Field>
            )}

            {isPercentage && (
              <Field
                label="Maximum discount"
                htmlFor="cpn-max"
                hint="Optional cap in taka. Blank means no cap."
                error={errorFor("maximum_discount")}
              >
                <Input
                  id="cpn-max"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={draft.maximum_discount}
                  onChange={(event) => set("maximum_discount", event.target.value)}
                />
              </Field>
            )}

            <Field
              label="Minimum order value"
              htmlFor="cpn-min"
              hint="0 means no minimum."
              error={errorFor("minimum_order_value")}
            >
              <Input
                id="cpn-min"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={draft.minimum_order_value}
                onChange={(event) => set("minimum_order_value", event.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Description"
            htmlFor="cpn-desc"
            hint="Shown to the shopper when the coupon applies."
            error={errorFor("description")}
          >
            <Textarea
              id="cpn-desc"
              rows={2}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Starts"
              htmlFor="cpn-start"
              hint="Blank means it is live immediately."
              error={errorFor("starts_at")}
            >
              <Input
                id="cpn-start"
                type="datetime-local"
                value={draft.starts_at}
                onChange={(event) => set("starts_at", event.target.value)}
              />
            </Field>

            <Field
              label="Ends"
              htmlFor="cpn-end"
              hint="Blank means it never expires."
              error={errorFor("ends_at")}
            >
              <Input
                id="cpn-end"
                type="datetime-local"
                value={draft.ends_at}
                onChange={(event) => set("ends_at", event.target.value)}
                invalid={Boolean(errorFor("ends_at"))}
              />
            </Field>

            <Field
              label="Total uses"
              htmlFor="cpn-limit"
              hint="Blank means unlimited."
              error={errorFor("usage_limit")}
            >
              <Input
                id="cpn-limit"
                type="number"
                min="1"
                inputMode="numeric"
                value={draft.usage_limit}
                onChange={(event) => set("usage_limit", event.target.value)}
                placeholder="Unlimited"
              />
            </Field>

            <Field
              label="Uses per customer"
              htmlFor="cpn-percust"
              hint="Blank means unlimited."
              error={errorFor("usage_limit_per_customer")}
            >
              <Input
                id="cpn-percust"
                type="number"
                min="1"
                inputMode="numeric"
                value={draft.usage_limit_per_customer}
                onChange={(event) => set("usage_limit_per_customer", event.target.value)}
                placeholder="Unlimited"
              />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-body-sm">
            <Checkbox
              className="mt-0.5"
              checked={draft.is_active}
              onChange={(event) => set("is_active", event.target.checked)}
            />
            <span>
              Active
              <span className="block text-caption text-muted">
                An inactive coupon is refused at checkout, whatever its dates say.
              </span>
            </span>
          </label>

          {editing && editing.used_count > 0 && (
            <p className="rounded-md bg-neutral-50 p-3 text-body-sm text-muted">
              Used {editing.used_count} time{editing.used_count === 1 ? "" : "s"}. Editing the
              discount does not change orders already placed — they keep the amount they were given.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              {editing ? (
                "Save changes"
              ) : (
                <>
                  <Plus className="size-4" aria-hidden />
                  Create coupon
                </>
              )}
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
            )}
            {saved && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
              >
                <Check className="size-4" aria-hidden /> Saved
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
