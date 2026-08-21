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
  ErrorSummary,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export interface SupplierRow {
  id: string;
  name: string;
  code: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  tax_id: string;
  payment_terms_days: number;
  lead_time_days: number;
  status: "ACTIVE" | "INACTIVE";
  notes: string;
  outstanding_orders?: number;
  created_at: string;
}

interface Draft {
  name: string;
  code: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  tax_id: string;
  payment_terms_days: string;
  lead_time_days: string;
  status: "ACTIVE" | "INACTIVE";
  notes: string;
}

function blank(): Draft {
  return {
    name: "",
    code: "",
    contact_person: "",
    phone: "",
    email: "",
    address: "",
    tax_id: "",
    payment_terms_days: "0",
    lead_time_days: "7",
    status: "ACTIVE",
    notes: "",
  };
}

function fromRow(row: SupplierRow): Draft {
  return {
    name: row.name,
    code: row.code,
    contact_person: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    tax_id: row.tax_id,
    payment_terms_days: String(row.payment_terms_days),
    lead_time_days: String(row.lead_time_days),
    status: row.status,
    notes: row.notes,
  };
}

/**
 * Create and edit a supplier.
 *
 * A purchase order cannot name a supplier that does not exist, and until now
 * there was no screen to create one — so the purchasing form would have been a
 * dropdown with nothing in it and no way to fill it. That is the same dead end
 * the wishlist and reviews were (D1, D2).
 *
 * `code` is left blank by default: the API derives a unique one from the name
 * (`purchasing.services.unique_supplier_code`), so nobody has to invent an
 * identifier and no two people can invent the same one.
 */
export function SupplierForm({
  editing,
  onDone,
  onCancel,
}: {
  editing?: SupplierRow;
  onDone?: (supplier: SupplierRow) => void;
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
    if (!draft.name.trim()) found.push({ field: "name", message: "A supplier name is required." });
    if (draft.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.email)) {
      found.push({ field: "email", message: "Enter a valid email address." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const body = {
        ...draft,
        code: draft.code.trim() || undefined,
        payment_terms_days: Number(draft.payment_terms_days || 0),
        lead_time_days: Number(draft.lead_time_days || 0),
      };
      const supplier = editing
        ? await apiClient<SupplierRow>(`/suppliers/${editing.id}/`, { method: "PATCH", body })
        : await apiClient<SupplierRow>("/suppliers/", { method: "POST", body });

      setSaved(true);
      if (!editing) setDraft(blank());
      onDone?.(supplier);
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
        <CardTitle>{editing ? `Edit ${editing.name}` : "New supplier"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save this supplier" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Supplier name" htmlFor="sup-name" required error={errorFor("name")}>
              <Input
                id="sup-name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                invalid={Boolean(errorFor("name"))}
                autoComplete="off"
              />
            </Field>

            <Field
              label="Code"
              htmlFor="sup-code"
              hint="Left blank, one is derived from the name."
              error={errorFor("code")}
            >
              <Input
                id="sup-code"
                value={draft.code}
                onChange={(event) => set("code", event.target.value.toUpperCase())}
                placeholder={editing ? "" : "auto"}
                maxLength={32}
                autoComplete="off"
              />
            </Field>

            <Field label="Contact person" htmlFor="sup-contact" error={errorFor("contact_person")}>
              <Input
                id="sup-contact"
                value={draft.contact_person}
                onChange={(event) => set("contact_person", event.target.value)}
              />
            </Field>

            <Field label="Phone" htmlFor="sup-phone" error={errorFor("phone")}>
              <Input
                id="sup-phone"
                type="tel"
                value={draft.phone}
                onChange={(event) => set("phone", event.target.value)}
              />
            </Field>

            <Field label="Email" htmlFor="sup-email" error={errorFor("email")}>
              <Input
                id="sup-email"
                type="email"
                value={draft.email}
                onChange={(event) => set("email", event.target.value)}
                invalid={Boolean(errorFor("email"))}
              />
            </Field>

            <Field label="TIN / tax id" htmlFor="sup-tax" error={errorFor("tax_id")}>
              <Input
                id="sup-tax"
                value={draft.tax_id}
                onChange={(event) => set("tax_id", event.target.value)}
              />
            </Field>

            <Field
              label="Payment terms (days)"
              htmlFor="sup-terms"
              hint="0 means payment on delivery."
              error={errorFor("payment_terms_days")}
            >
              <Input
                id="sup-terms"
                type="number"
                min="0"
                inputMode="numeric"
                value={draft.payment_terms_days}
                onChange={(event) => set("payment_terms_days", event.target.value)}
              />
            </Field>

            <Field
              label="Lead time (days)"
              htmlFor="sup-lead"
              hint="Used to suggest an expected delivery date."
              error={errorFor("lead_time_days")}
            >
              <Input
                id="sup-lead"
                type="number"
                min="0"
                inputMode="numeric"
                value={draft.lead_time_days}
                onChange={(event) => set("lead_time_days", event.target.value)}
              />
            </Field>
          </div>

          <Field label="Address" htmlFor="sup-address" error={errorFor("address")}>
            <Textarea
              id="sup-address"
              rows={2}
              value={draft.address}
              onChange={(event) => set("address", event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Status" htmlFor="sup-status" error={errorFor("status")}>
              <Select
                id="sup-status"
                value={draft.status}
                onChange={(event) => set("status", event.target.value as Draft["status"])}
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>

            <Field label="Notes" htmlFor="sup-notes" error={errorFor("notes")}>
              <Input
                id="sup-notes"
                value={draft.notes}
                onChange={(event) => set("notes", event.target.value)}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              {editing ? (
                "Save changes"
              ) : (
                <>
                  <Plus className="size-4" aria-hidden />
                  Create supplier
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
