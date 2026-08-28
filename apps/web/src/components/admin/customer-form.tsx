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

export interface CustomerAddressRow {
  id: string;
  label: string;
  address_type: "SHIPPING" | "BILLING" | "BOTH";
  recipient_name: string;
  phone: string;
  line1: string;
  line2: string;
  area: string;
  city: string;
  district: string;
  postal_code: string;
  country: string;
  is_default: boolean;
  notes: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  customer_type: "WALK_IN" | "REGISTERED" | "GUEST" | "WHOLESALE";
  is_walk_in: boolean;
  is_active: boolean;
  date_of_birth: string | null;
  notes: string;
  tags: string[];
  total_orders: number;
  total_spent: string;
  loyalty_points: number;
  last_order_at: string | null;
  has_account: boolean;
  addresses: CustomerAddressRow[];
  created_at: string;
}

interface Draft {
  name: string;
  phone: string;
  email: string;
  customer_type: CustomerRow["customer_type"];
  date_of_birth: string;
  notes: string;
  tags: string;
  is_active: boolean;
}

function blank(): Draft {
  return {
    name: "",
    phone: "",
    email: "",
    customer_type: "REGISTERED",
    date_of_birth: "",
    notes: "",
    tags: "",
    is_active: true,
  };
}

function fromRow(row: CustomerRow): Draft {
  return {
    name: row.name,
    phone: row.phone ?? "",
    email: row.email ?? "",
    customer_type: row.customer_type,
    date_of_birth: row.date_of_birth ?? "",
    notes: row.notes,
    tags: row.tags.join(", "),
    is_active: row.is_active,
  };
}

/**
 * Create and edit a customer.
 *
 * Identity here is phone-first (business-rules §6): most walk-in shoppers have
 * no email, and a phone number is what the counter actually searches on. The
 * API refuses a record with neither, on create *and* on edit — clearing both
 * would leave a customer nobody can ever find again — so this form asks for one
 * before it will submit rather than letting the server bounce it back.
 *
 * The server still decides. This check exists to answer sooner, not instead.
 */
export function CustomerForm({
  editing,
  onDone,
  onCancel,
}: {
  editing?: CustomerRow;
  onDone?: (customer: CustomerRow) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(editing ? fromRow(editing) : blank());
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];
    if (!draft.name.trim()) found.push({ field: "name", message: "A customer name is required." });
    if (!draft.phone.trim() && !draft.email.trim()) {
      found.push({
        field: "phone",
        message: "Provide a phone number or an email address, so this customer can be found again.",
      });
    }
    if (draft.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.email)) {
      found.push({ field: "email", message: "Enter a valid email address." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        // Empty string, not omitted: on an edit this is how a field is cleared.
        phone: draft.phone.trim(),
        email: draft.email.trim(),
        customer_type: draft.customer_type,
        date_of_birth: draft.date_of_birth || null,
        notes: draft.notes,
        tags: draft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        is_active: draft.is_active,
      };
      const customer = editing
        ? await apiClient<CustomerRow>(`/customers/${editing.id}/`, { method: "PATCH", body })
        : await apiClient<CustomerRow>("/customers/", { method: "POST", body });

      setSaved(true);
      if (!editing) setDraft(blank());
      onDone?.(customer);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(fieldErrors.length ? fieldErrors : [{ field: "name", message: caught.message }]);
      } else {
        setErrors([{ field: "name", message: "Could not save. Please try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.name}` : "New customer"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save this customer" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="cus-name" required error={errorFor("name")}>
              <Input
                id="cus-name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                invalid={Boolean(errorFor("name"))}
                autoComplete="off"
              />
            </Field>

            <Field
              label="Phone"
              htmlFor="cus-phone"
              hint="How the counter finds this customer."
              error={errorFor("phone")}
            >
              <Input
                id="cus-phone"
                type="tel"
                inputMode="tel"
                value={draft.phone}
                onChange={(event) => set("phone", event.target.value)}
                invalid={Boolean(errorFor("phone"))}
                autoComplete="off"
              />
            </Field>

            <Field label="Email" htmlFor="cus-email" error={errorFor("email")}>
              <Input
                id="cus-email"
                type="email"
                value={draft.email}
                onChange={(event) => set("email", event.target.value)}
                invalid={Boolean(errorFor("email"))}
                autoComplete="off"
              />
            </Field>

            <Field label="Type" htmlFor="cus-type" error={errorFor("customer_type")}>
              <Select
                id="cus-type"
                value={draft.customer_type}
                onChange={(event) =>
                  set("customer_type", event.target.value as Draft["customer_type"])
                }
              >
                <option value="REGISTERED">Registered</option>
                <option value="GUEST">Guest</option>
                <option value="WALK_IN">Walk-in</option>
                <option value="WHOLESALE">Wholesale</option>
              </Select>
            </Field>

            <Field
              label="Date of birth"
              htmlFor="cus-dob"
              hint="Optional — used for birthday offers."
              error={errorFor("date_of_birth")}
            >
              <Input
                id="cus-dob"
                type="date"
                value={draft.date_of_birth}
                onChange={(event) => set("date_of_birth", event.target.value)}
              />
            </Field>

            <Field
              label="Tags"
              htmlFor="cus-tags"
              hint="Comma separated, e.g. vip, wholesale."
              error={errorFor("tags")}
            >
              <Input
                id="cus-tags"
                value={draft.tags}
                onChange={(event) => set("tags", event.target.value)}
                autoComplete="off"
              />
            </Field>
          </div>

          <Field label="Notes" htmlFor="cus-notes" error={errorFor("notes")}>
            <Textarea
              id="cus-notes"
              rows={2}
              value={draft.notes}
              onChange={(event) => set("notes", event.target.value)}
            />
          </Field>

          {editing && !editing.is_walk_in && (
            <label className="flex items-start gap-2 text-body-sm">
              <Checkbox
                className="mt-0.5"
                checked={draft.is_active}
                onChange={(event) => set("is_active", event.target.checked)}
              />
              <span>
                Active
                <span className="block text-caption text-muted">
                  An inactive customer keeps their order history but no longer appears at the
                  counter.
                </span>
              </span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              {editing ? (
                "Save changes"
              ) : (
                <>
                  <Plus className="size-4" aria-hidden />
                  Create customer
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
