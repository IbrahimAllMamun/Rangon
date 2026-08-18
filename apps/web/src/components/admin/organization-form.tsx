"use client";

import { Check } from "lucide-react";
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
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export interface OrganizationValues {
  name: string;
  legal_name: string;
  email: string;
  phone: string;
  address: string;
  vat_registration: string;
  currency: string;
  receipt_footer: string;
}

/**
 * Editable organisation details.
 *
 * Writes go to PATCH /organization/, which requires `settings.manage`. The
 * backend refuses regardless of what this renders, so a read-only user sees the
 * values without controls rather than a form that fails on submit.
 */
export function OrganizationForm({
  initial,
  canManage,
}: {
  initial: OrganizationValues;
  canManage: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<OrganizationValues>(initial);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = (Object.keys(initial) as (keyof OrganizationValues)[]).some(
    (key) => initial[key] !== values[key],
  );

  function set<K extends keyof OrganizationValues>(key: K, value: OrganizationValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors([]);

    const found: { field: string; message: string }[] = [];
    if (!values.name.trim()) found.push({ field: "name", message: "Business name is required." });
    if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
      found.push({ field: "email", message: "Enter a valid email address." });
    }
    if (!values.currency.trim()) {
      found.push({ field: "currency", message: "Currency is required." });
    }
    if (found.length) {
      setErrors(found);
      return;
    }

    setSaving(true);
    try {
      await apiClient("/organization/", { method: "PATCH", body: values });
      setSaved(true);
      // Receipts and invoices are rendered by server components, so refresh
      // rather than trusting local state.
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
        <CardTitle>Organisation</CardTitle>
      </CardHeader>
      <CardContent>
        {!canManage && (
          <p className="mb-4 rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
            You can view these details but not change them. Editing needs the
            <code className="mx-1">settings.manage</code> permission.
          </p>
        )}

        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save settings" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name" htmlFor="org-name" required error={errorFor("name")}>
              <Input
                id="org-name"
                value={values.name}
                onChange={(event) => set("name", event.target.value)}
                disabled={!canManage}
                invalid={Boolean(errorFor("name"))}
              />
            </Field>

            <Field label="Legal name" htmlFor="org-legal" error={errorFor("legal_name")}>
              <Input
                id="org-legal"
                value={values.legal_name}
                onChange={(event) => set("legal_name", event.target.value)}
                disabled={!canManage}
              />
            </Field>

            <Field label="Phone" htmlFor="org-phone" error={errorFor("phone")}>
              <Input
                id="org-phone"
                type="tel"
                value={values.phone}
                onChange={(event) => set("phone", event.target.value)}
                disabled={!canManage}
              />
            </Field>

            <Field label="Email" htmlFor="org-email" error={errorFor("email")}>
              <Input
                id="org-email"
                type="email"
                value={values.email}
                onChange={(event) => set("email", event.target.value)}
                disabled={!canManage}
                invalid={Boolean(errorFor("email"))}
              />
            </Field>

            <Field
              label="VAT registration"
              htmlFor="org-vat"
              hint="Printed on invoices and receipts when set."
              error={errorFor("vat_registration")}
            >
              <Input
                id="org-vat"
                value={values.vat_registration}
                onChange={(event) => set("vat_registration", event.target.value)}
                disabled={!canManage}
              />
            </Field>

            <Field
              label="Currency"
              htmlFor="org-currency"
              required
              hint="Changing this does not convert existing figures."
              error={errorFor("currency")}
            >
              <Input
                id="org-currency"
                value={values.currency}
                onChange={(event) => set("currency", event.target.value.toUpperCase())}
                disabled={!canManage}
                maxLength={8}
                invalid={Boolean(errorFor("currency"))}
              />
            </Field>
          </div>

          <Field label="Address" htmlFor="org-address" error={errorFor("address")}>
            <Textarea
              id="org-address"
              rows={3}
              value={values.address}
              onChange={(event) => set("address", event.target.value)}
              disabled={!canManage}
            />
          </Field>

          <Field
            label="Receipt footer"
            htmlFor="org-footer"
            hint="Printed at the bottom of every POS receipt. Line breaks are kept."
            error={errorFor("receipt_footer")}
          >
            <Textarea
              id="org-footer"
              rows={3}
              value={values.receipt_footer}
              onChange={(event) => set("receipt_footer", event.target.value)}
              disabled={!canManage}
            />
          </Field>

          {canManage && (
            <div className="flex items-center gap-3">
              <Button type="submit" loading={saving} disabled={!dirty}>
                Save changes
              </Button>
              {saved && !dirty && (
                <span
                  role="status"
                  className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
                >
                  <Check className="size-4" aria-hidden /> Saved
                </span>
              )}
              {dirty && !saving && <span className="text-caption text-muted">Unsaved changes</span>}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
