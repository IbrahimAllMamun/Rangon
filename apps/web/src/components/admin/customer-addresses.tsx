"use client";

import { MapPin, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CustomerAddressRow } from "@/components/admin/customer-form";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorSummary,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

interface Draft {
  label: string;
  address_type: CustomerAddressRow["address_type"];
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
}

function blank(customerName: string, customerPhone: string): Draft {
  return {
    label: "",
    address_type: "BOTH",
    // Pre-filling saves retyping in the common case: the customer is the
    // recipient. It stays editable for gifts and office deliveries.
    recipient_name: customerName,
    phone: customerPhone,
    line1: "",
    line2: "",
    area: "",
    city: "",
    district: "",
    postal_code: "",
    country: "Bangladesh",
    is_default: false,
  };
}

function fromRow(row: CustomerAddressRow): Draft {
  return {
    label: row.label,
    address_type: row.address_type,
    recipient_name: row.recipient_name,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    area: row.area,
    city: row.city,
    district: row.district,
    postal_code: row.postal_code,
    country: row.country,
    is_default: row.is_default,
  };
}

/**
 * A customer's delivery addresses.
 *
 * The default matters more than it looks: `CustomerAddress` is ordered
 * `("-is_default", "-created_at")`, and checkout pre-fills from the first row.
 * The API guarantees exactly one default while any address exists — it promotes
 * the first one, demotes the previous on a change, and promotes a replacement
 * when the default is deleted — so this panel shows the flag but never has to
 * reconcile it. Refusing to un-set the only default is the server's rule too;
 * the star is simply not offered there.
 */
export function CustomerAddresses({
  customerId,
  customerName,
  customerPhone,
  addresses,
  canManage,
}: {
  customerId: string;
  customerName: string;
  customerPhone: string;
  addresses: CustomerAddressRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomerAddressRow | null>(null);
  const [draft, setDraft] = useState<Draft>(blank(customerName, customerPhone));
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  function openCreate() {
    setDraft(blank(customerName, customerPhone));
    setErrors([]);
    setEditing(null);
    setCreating(true);
  }

  function openEdit(row: CustomerAddressRow) {
    setDraft(fromRow(row));
    setErrors([]);
    setCreating(false);
    setEditing(row);
  }

  function close() {
    setCreating(false);
    setEditing(null);
    setErrors([]);
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];
    if (!draft.recipient_name.trim()) {
      found.push({ field: "recipient_name", message: "Who should the courier ask for?" });
    }
    if (!draft.phone.trim()) {
      found.push({ field: "phone", message: "A delivery phone number is required." });
    }
    if (!draft.line1.trim()) found.push({ field: "line1", message: "A street address is required." });
    if (!draft.city.trim()) found.push({ field: "city", message: "A city is required." });
    setErrors(found);
    if (found.length) return;

    setBusy(true);
    try {
      if (editing) {
        await apiClient(`/customers/${customerId}/addresses/${editing.id}/`, {
          method: "PATCH",
          body: draft,
        });
      } else {
        await apiClient(`/customers/${customerId}/addresses/`, { method: "POST", body: draft });
      }
      close();
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "line1", message: caught.message }],
        );
      } else {
        setErrors([{ field: "line1", message: "Could not save this address." }]);
      }
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(row: CustomerAddressRow) {
    setBusy(true);
    setListError(null);
    try {
      await apiClient(`/customers/${customerId}/addresses/${row.id}/`, {
        method: "PATCH",
        body: { is_default: true },
      });
      router.refresh();
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : "Could not set the default address.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: CustomerAddressRow) {
    if (!window.confirm(`Delete the address at ${row.line1}, ${row.city}?`)) return;
    setBusy(true);
    setListError(null);
    try {
      await apiClient(`/customers/${customerId}/addresses/${row.id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : "Could not delete this address.");
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Addresses</CardTitle>
        {canManage && !creating && !editing && (
          <Button variant="secondary" onClick={openCreate}>
            <Plus className="size-4" aria-hidden />
            Add address
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {listError && (
          <p role="alert" className="text-body-sm text-[var(--error)]">
            {listError}
          </p>
        )}

        {(creating || editing) && (
          <form
            onSubmit={submit}
            noValidate
            className="space-y-4 rounded-lg border border-border bg-neutral-50 p-4"
          >
            <ErrorSummary errors={errors} title="Could not save this address" />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Recipient"
                htmlFor="adr-recipient"
                required
                error={errorFor("recipient_name")}
              >
                <Input
                  id="adr-recipient"
                  value={draft.recipient_name}
                  onChange={(event) => set("recipient_name", event.target.value)}
                  invalid={Boolean(errorFor("recipient_name"))}
                />
              </Field>

              <Field label="Phone" htmlFor="adr-phone" required error={errorFor("phone")}>
                <Input
                  id="adr-phone"
                  type="tel"
                  value={draft.phone}
                  onChange={(event) => set("phone", event.target.value)}
                  invalid={Boolean(errorFor("phone"))}
                />
              </Field>

              <Field
                label="Label"
                htmlFor="adr-label"
                hint="Home, Office…"
                error={errorFor("label")}
              >
                <Input
                  id="adr-label"
                  value={draft.label}
                  onChange={(event) => set("label", event.target.value)}
                />
              </Field>

              <Field label="Used for" htmlFor="adr-type" error={errorFor("address_type")}>
                <Select
                  id="adr-type"
                  value={draft.address_type}
                  onChange={(event) =>
                    set("address_type", event.target.value as Draft["address_type"])
                  }
                >
                  <option value="BOTH">Shipping and billing</option>
                  <option value="SHIPPING">Shipping</option>
                  <option value="BILLING">Billing</option>
                </Select>
              </Field>
            </div>

            <Field label="Address line 1" htmlFor="adr-line1" required error={errorFor("line1")}>
              <Input
                id="adr-line1"
                value={draft.line1}
                onChange={(event) => set("line1", event.target.value)}
                invalid={Boolean(errorFor("line1"))}
              />
            </Field>

            <Field label="Address line 2" htmlFor="adr-line2" error={errorFor("line2")}>
              <Input
                id="adr-line2"
                value={draft.line2}
                onChange={(event) => set("line2", event.target.value)}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Area" htmlFor="adr-area" error={errorFor("area")}>
                <Input
                  id="adr-area"
                  value={draft.area}
                  onChange={(event) => set("area", event.target.value)}
                />
              </Field>
              <Field label="City" htmlFor="adr-city" required error={errorFor("city")}>
                <Input
                  id="adr-city"
                  value={draft.city}
                  onChange={(event) => set("city", event.target.value)}
                  invalid={Boolean(errorFor("city"))}
                />
              </Field>
              <Field label="District" htmlFor="adr-district" error={errorFor("district")}>
                <Input
                  id="adr-district"
                  value={draft.district}
                  onChange={(event) => set("district", event.target.value)}
                />
              </Field>
              <Field label="Postcode" htmlFor="adr-post" error={errorFor("postal_code")}>
                <Input
                  id="adr-post"
                  value={draft.postal_code}
                  onChange={(event) => set("postal_code", event.target.value)}
                />
              </Field>
            </div>

            {/* Hidden while editing the only default: the server refuses to
                clear it, so offering the box would be offering a dead end. */}
            {!(editing?.is_default && addresses.length === 1) && (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={draft.is_default}
                  onChange={(event) => set("is_default", event.target.checked)}
                />
                Use this as the default delivery address
              </label>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={busy}>
                {editing ? "Save address" : "Add address"}
              </Button>
              <Button type="button" variant="ghost" onClick={close}>
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
            </div>
          </form>
        )}

        {addresses.length === 0 ? (
          <EmptyState
            title="No addresses on file"
            description="Add one so an online or phone order can be delivered without retyping it."
            action={
              canManage && !creating ? (
                <Button onClick={openCreate}>
                  <Plus className="size-4" aria-hidden />
                  Add address
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-3">
            {addresses.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="flex gap-3">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <div className="text-body-sm">
                    <p className="font-medium">
                      {row.recipient_name}
                      {row.label && <span className="text-muted"> · {row.label}</span>}
                    </p>
                    <p className="text-muted">
                      {[row.line1, row.line2, row.area, row.city, row.district, row.postal_code]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    <p className="text-muted">{row.phone}</p>
                    {row.is_default && (
                      <Badge tone="brand" className="mt-1.5">
                        <Star className="size-3" aria-hidden />
                        Default
                      </Badge>
                    )}
                  </div>
                </div>

                {canManage && (
                  <div className="flex items-center gap-1">
                    {!row.is_default && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => makeDefault(row)}
                        disabled={busy}
                      >
                        <Star className="size-4" aria-hidden />
                        <span className="sr-only sm:not-sr-only">Make default</span>
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => openEdit(row)} disabled={busy}>
                      <Pencil className="size-4" aria-hidden />
                      <span className="sr-only">Edit address for {row.recipient_name}</span>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(row)} disabled={busy}>
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only">Delete address for {row.recipient_name}</span>
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
