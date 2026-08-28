"use client";

import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export interface CourierRow {
  id: string;
  name: string;
  code: string;
  phone: string;
  tracking_url_template: string;
  integration: string;
  is_active: boolean;
}

interface Draft {
  name: string;
  code: string;
  phone: string;
  tracking_url_template: string;
  is_active: boolean;
}

function blank(): Draft {
  return { name: "", code: "", phone: "", tracking_url_template: "", is_active: true };
}

function fromRow(row: CourierRow): Draft {
  return {
    name: row.name,
    code: row.code,
    phone: row.phone,
    tracking_url_template: row.tracking_url_template,
    is_active: row.is_active,
  };
}

/**
 * The couriers a shipment can be handed to.
 *
 * `integration` is deliberately not editable here. It selects the code that
 * talks to a courier's API, and there is only one implementation today —
 * `manual`, meaning tracking numbers are typed in. Offering a free-text box for
 * it would let someone name a provider that does not exist and produce
 * shipments nothing can dispatch.
 */
export function Couriers({
  couriers,
  canManage,
}: {
  couriers: CourierRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<CourierRow | null>(null);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  function close() {
    setDraft(null);
    setEditing(null);
    setErrors([]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;

    const found: { field: string; message: string }[] = [];
    if (!draft.name.trim()) found.push({ field: "name", message: "A courier name is required." });
    if (
      draft.tracking_url_template &&
      !draft.tracking_url_template.includes("{tracking_number}")
    ) {
      found.push({
        field: "tracking_url_template",
        message: "Include {tracking_number} — that is where the number is substituted.",
      });
    }
    setErrors(found);
    if (found.length) return;

    setBusy(true);
    try {
      const body = {
        name: draft.name.trim(),
        code:
          draft.code.trim() || draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        phone: draft.phone,
        tracking_url_template: draft.tracking_url_template,
        is_active: draft.is_active,
      };
      if (editing) {
        await apiClient(`/couriers/${editing.id}/`, { method: "PATCH", body });
      } else {
        await apiClient("/couriers/", { method: "POST", body });
      }
      close();
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(fieldErrors.length ? fieldErrors : [{ field: "name", message: caught.message }]);
      } else {
        setErrors([{ field: "name", message: "Could not save. Please try again." }]);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: CourierRow) {
    if (!window.confirm(`Delete ${row.name}?`)) return;
    setBusy(true);
    try {
      await apiClient(`/couriers/${row.id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setErrors([
        {
          field: "name",
          message:
            caught instanceof ApiError
              ? caught.message
              : "Could not delete this courier. It may be carrying shipments.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Couriers</CardTitle>
        {canManage && !draft && (
          <Button variant="secondary" onClick={() => setDraft(blank())}>
            <Plus className="size-4" aria-hidden />
            Add courier
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {draft && (
          <form
            onSubmit={submit}
            noValidate
            className="space-y-4 rounded-lg border border-border bg-neutral-50 p-4"
          >
            <ErrorSummary errors={errors} title="Could not save this courier" />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="cr-name" required error={errorFor("name")}>
                <Input
                  id="cr-name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  invalid={Boolean(errorFor("name"))}
                />
              </Field>
              <Field label="Phone" htmlFor="cr-phone" error={errorFor("phone")}>
                <Input
                  id="cr-phone"
                  type="tel"
                  value={draft.phone}
                  onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label="Tracking URL"
              htmlFor="cr-track"
              hint="Use {tracking_number} where the number goes."
              error={errorFor("tracking_url_template")}
            >
              <Input
                id="cr-track"
                value={draft.tracking_url_template}
                onChange={(event) =>
                  setDraft({ ...draft, tracking_url_template: event.target.value })
                }
                invalid={Boolean(errorFor("tracking_url_template"))}
                placeholder="https://courier.example/track/{tracking_number}"
              />
            </Field>

            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={draft.is_active}
                onChange={(event) => setDraft({ ...draft, is_active: event.target.checked })}
              />
              Active
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={busy}>
                {editing ? "Save courier" : "Add courier"}
              </Button>
              <Button type="button" variant="ghost" onClick={close}>
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
            </div>
          </form>
        )}

        {couriers.length === 0 ? (
          <p className="text-body-sm text-muted">
            No couriers yet. A shipment can be created without one, but then nothing records who is
            carrying it.
          </p>
        ) : (
          <ul className="space-y-2">
            {couriers.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-body-sm"
              >
                <div>
                  <p className="font-medium">
                    {row.name}
                    {!row.is_active && (
                      <Badge tone="neutral" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                    {row.integration === "manual" && (
                      <Badge tone="neutral" className="ml-2">
                        Manual tracking
                      </Badge>
                    )}
                  </p>
                  <p className="text-muted">{row.phone || "No phone on file"}</p>
                </div>
                {canManage && !draft && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDraft(fromRow(row));
                        setEditing(row);
                      }}
                    >
                      <Pencil className="size-4" aria-hidden />
                      <span className="sr-only">Edit {row.name}</span>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(row)} disabled={busy}>
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only">Delete {row.name}</span>
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
