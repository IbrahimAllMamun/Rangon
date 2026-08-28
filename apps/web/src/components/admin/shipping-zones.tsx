"use client";

import { MapPin, Pencil, Plus, Star, Trash2, Truck, X } from "lucide-react";
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
  EmptyState,
  ErrorSummary,
  Field,
  Input,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { money } from "@/lib/format";

export interface ShippingMethodRow {
  id: string;
  zone: string;
  zone_name: string;
  name: string;
  code: string;
  description: string;
  price: string;
  free_over: string | null;
  min_days: number;
  max_days: number;
  eta_label: string;
  is_pickup: boolean;
  supports_cod: boolean;
  is_active: boolean;
  position: number;
}

export interface ShippingZoneRow {
  id: string;
  name: string;
  description: string;
  cities: string[];
  is_default: boolean;
  position: number;
  is_active: boolean;
  methods: ShippingMethodRow[];
}

interface ZoneDraft {
  name: string;
  description: string;
  cities: string;
  is_default: boolean;
  position: string;
  is_active: boolean;
}

interface MethodDraft {
  name: string;
  code: string;
  description: string;
  price: string;
  free_over: string;
  min_days: string;
  max_days: string;
  is_pickup: boolean;
  supports_cod: boolean;
  is_active: boolean;
  position: string;
}

function blankZone(): ZoneDraft {
  return {
    name: "",
    description: "",
    cities: "",
    is_default: false,
    position: "0",
    is_active: true,
  };
}

function zoneFrom(row: ShippingZoneRow): ZoneDraft {
  return {
    name: row.name,
    description: row.description,
    cities: row.cities.join(", "),
    is_default: row.is_default,
    position: String(row.position),
    is_active: row.is_active,
  };
}

function blankMethod(): MethodDraft {
  return {
    name: "",
    code: "",
    description: "",
    price: "0.00",
    free_over: "",
    min_days: "1",
    max_days: "3",
    is_pickup: false,
    supports_cod: true,
    is_active: true,
    position: "0",
  };
}

function methodFrom(row: ShippingMethodRow): MethodDraft {
  return {
    name: row.name,
    code: row.code,
    description: row.description,
    price: row.price,
    free_over: row.free_over ?? "",
    min_days: String(row.min_days),
    max_days: String(row.max_days),
    is_pickup: row.is_pickup,
    supports_cod: row.supports_cod,
    is_active: row.is_active,
    position: String(row.position),
  };
}

type ErrorList = { field: string; message: string }[];

/**
 * Delivery zones and the methods inside them.
 *
 * A zone is matched by city name at checkout, falling back to the zone marked
 * default. That fallback is the thing worth understanding here: with no default
 * zone, a shopper in a city nobody listed is offered **no delivery options at
 * all** and cannot check out. The screen says so rather than letting the shop
 * discover it from a customer.
 *
 * Cities are stored lower-cased because matching lower-cases both sides; the
 * API normalises whatever is typed here, so "  Dhaka " and "dhaka" are the same
 * entry.
 */
export function ShippingZones({
  zones,
  canManage,
}: {
  zones: ShippingZoneRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [zoneDraft, setZoneDraft] = useState<ZoneDraft | null>(null);
  const [editingZone, setEditingZone] = useState<ShippingZoneRow | null>(null);
  const [methodDraft, setMethodDraft] = useState<MethodDraft | null>(null);
  const [methodZone, setMethodZone] = useState<ShippingZoneRow | null>(null);
  const [editingMethod, setEditingMethod] = useState<ShippingMethodRow | null>(null);
  const [errors, setErrors] = useState<ErrorList>([]);
  const [busy, setBusy] = useState(false);

  const hasDefault = zones.some((zone) => zone.is_default && zone.is_active);

  function closeAll() {
    setZoneDraft(null);
    setEditingZone(null);
    setMethodDraft(null);
    setMethodZone(null);
    setEditingMethod(null);
    setErrors([]);
  }

  function handleError(caught: unknown, fallbackField: string) {
    if (caught instanceof ApiError) {
      const fieldErrors = caught.fieldErrors();
      setErrors(
        fieldErrors.length ? fieldErrors : [{ field: fallbackField, message: caught.message }],
      );
    } else {
      setErrors([{ field: fallbackField, message: "Could not save. Please try again." }]);
    }
  }

  async function saveZone(event: React.FormEvent) {
    event.preventDefault();
    if (!zoneDraft) return;

    const found: ErrorList = [];
    if (!zoneDraft.name.trim()) found.push({ field: "name", message: "A zone name is required." });
    const cities = zoneDraft.cities
      .split(",")
      .map((city) => city.trim().toLowerCase())
      .filter(Boolean);
    if (!cities.length && !zoneDraft.is_default) {
      found.push({
        field: "cities",
        message:
          "List at least one city, or mark this the default zone — a zone with neither can never match an order.",
      });
    }
    setErrors(found);
    if (found.length) return;

    setBusy(true);
    try {
      const body = {
        name: zoneDraft.name.trim(),
        description: zoneDraft.description,
        cities,
        is_default: zoneDraft.is_default,
        position: Number(zoneDraft.position || 0),
        is_active: zoneDraft.is_active,
      };
      if (editingZone) {
        await apiClient(`/shipping-zones/${editingZone.id}/`, { method: "PATCH", body });
      } else {
        await apiClient("/shipping-zones/", { method: "POST", body });
      }
      closeAll();
      router.refresh();
    } catch (caught) {
      handleError(caught, "name");
    } finally {
      setBusy(false);
    }
  }

  async function saveMethod(event: React.FormEvent) {
    event.preventDefault();
    if (!methodDraft || !methodZone) return;

    const found: ErrorList = [];
    if (!methodDraft.name.trim()) {
      found.push({ field: "name", message: "A method name is required." });
    }
    if (Number(methodDraft.price) < 0) {
      found.push({ field: "price", message: "A shipping price cannot be negative." });
    }
    if (methodDraft.free_over.trim() && Number(methodDraft.free_over) < 0) {
      found.push({
        field: "free_over",
        message: "A free-shipping threshold cannot be negative — that would make every order free.",
      });
    }
    if (Number(methodDraft.max_days) < Number(methodDraft.min_days)) {
      found.push({
        field: "max_days",
        message: "The longest estimate cannot be shorter than the shortest.",
      });
    }
    setErrors(found);
    if (found.length) return;

    setBusy(true);
    try {
      const body = {
        zone: methodZone.id,
        name: methodDraft.name.trim(),
        code:
          methodDraft.code.trim() ||
          methodDraft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        description: methodDraft.description,
        price: methodDraft.price || "0.00",
        // Blank means there is no free-shipping offer, which the API stores as
        // null — not 0, which would make every order free.
        free_over: methodDraft.free_over.trim() ? methodDraft.free_over : null,
        min_days: Number(methodDraft.min_days || 1),
        max_days: Number(methodDraft.max_days || 1),
        is_pickup: methodDraft.is_pickup,
        supports_cod: methodDraft.supports_cod,
        is_active: methodDraft.is_active,
        position: Number(methodDraft.position || 0),
      };
      if (editingMethod) {
        await apiClient(`/shipping-methods/${editingMethod.id}/`, { method: "PATCH", body });
      } else {
        await apiClient("/shipping-methods/", { method: "POST", body });
      }
      closeAll();
      router.refresh();
    } catch (caught) {
      handleError(caught, "name");
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind: "shipping-zones" | "shipping-methods", id: string, label: string) {
    if (!window.confirm(`Delete ${label}?`)) return;
    setBusy(true);
    setErrors([]);
    try {
      await apiClient(`/${kind}/${id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      handleError(caught, "name");
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const editingSomething = zoneDraft !== null || methodDraft !== null;

  return (
    <div className="space-y-6">
      {!hasDefault && zones.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <p role="alert" className="text-body-sm text-[var(--warning)]">
              <strong>No default zone.</strong> A shopper in a city none of these zones lists is
              offered no delivery options and cannot check out. Mark one zone as the fallback.
            </p>
          </CardContent>
        </Card>
      )}

      {canManage && !editingSomething && (
        <Button
          onClick={() => {
            setZoneDraft(blankZone());
            setEditingZone(null);
          }}
        >
          <Plus className="size-4" aria-hidden />
          New zone
        </Button>
      )}

      {zoneDraft && (
        <Card>
          <CardHeader>
            <CardTitle>{editingZone ? `Edit ${editingZone.name}` : "New zone"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveZone} noValidate className="space-y-4">
              <ErrorSummary errors={errors} title="Could not save this zone" />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Zone name" htmlFor="zone-name" required error={errorFor("name")}>
                  <Input
                    id="zone-name"
                    value={zoneDraft.name}
                    onChange={(event) =>
                      setZoneDraft({ ...zoneDraft, name: event.target.value })
                    }
                    invalid={Boolean(errorFor("name"))}
                  />
                </Field>

                <Field
                  label="Order in the list"
                  htmlFor="zone-position"
                  hint="Lower numbers are matched first."
                  error={errorFor("position")}
                >
                  <Input
                    id="zone-position"
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={zoneDraft.position}
                    onChange={(event) =>
                      setZoneDraft({ ...zoneDraft, position: event.target.value })
                    }
                  />
                </Field>
              </div>

              <Field
                label="Cities"
                htmlFor="zone-cities"
                hint="Comma separated, e.g. dhaka, gazipur. Matched against the delivery address."
                error={errorFor("cities")}
              >
                <Textarea
                  id="zone-cities"
                  rows={2}
                  value={zoneDraft.cities}
                  onChange={(event) => setZoneDraft({ ...zoneDraft, cities: event.target.value })}
                  invalid={Boolean(errorFor("cities"))}
                />
              </Field>

              <Field label="Description" htmlFor="zone-desc" error={errorFor("description")}>
                <Input
                  id="zone-desc"
                  value={zoneDraft.description}
                  onChange={(event) =>
                    setZoneDraft({ ...zoneDraft, description: event.target.value })
                  }
                />
              </Field>

              <label className="flex items-start gap-2 text-body-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={zoneDraft.is_default}
                  onChange={(event) =>
                    setZoneDraft({ ...zoneDraft, is_default: event.target.checked })
                  }
                />
                <span>
                  Fallback zone
                  <span className="block text-caption text-muted">
                    Used when the delivery city matches no other zone. Without one, those orders get
                    no delivery options at all.
                  </span>
                </span>
              </label>

              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={zoneDraft.is_active}
                  onChange={(event) =>
                    setZoneDraft({ ...zoneDraft, is_active: event.target.checked })
                  }
                />
                Active
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={busy}>
                  {editingZone ? "Save zone" : "Create zone"}
                </Button>
                <Button type="button" variant="ghost" onClick={closeAll}>
                  <X className="size-4" aria-hidden />
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {methodDraft && methodZone && (
        <Card>
          <CardHeader>
            <CardTitle>
              {editingMethod ? `Edit ${editingMethod.name}` : "New method"} — {methodZone.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveMethod} noValidate className="space-y-4">
              <ErrorSummary errors={errors} title="Could not save this method" />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Method name" htmlFor="m-name" required error={errorFor("name")}>
                  <Input
                    id="m-name"
                    value={methodDraft.name}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, name: event.target.value })
                    }
                    invalid={Boolean(errorFor("name"))}
                  />
                </Field>

                <Field
                  label="Code"
                  htmlFor="m-code"
                  hint="Left blank, one is derived from the name."
                  error={errorFor("code")}
                >
                  <Input
                    id="m-code"
                    value={methodDraft.code}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, code: event.target.value })
                    }
                    placeholder="auto"
                  />
                </Field>

                <Field label="Price" htmlFor="m-price" required error={errorFor("price")}>
                  <Input
                    id="m-price"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={methodDraft.price}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, price: event.target.value })
                    }
                    invalid={Boolean(errorFor("price"))}
                  />
                </Field>

                <Field
                  label="Free over"
                  htmlFor="m-free"
                  hint="Blank means shipping is never free."
                  error={errorFor("free_over")}
                >
                  <Input
                    id="m-free"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={methodDraft.free_over}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, free_over: event.target.value })
                    }
                    invalid={Boolean(errorFor("free_over"))}
                    placeholder="Never"
                  />
                </Field>

                <Field
                  label="Fastest (days)"
                  htmlFor="m-min"
                  error={errorFor("min_days")}
                >
                  <Input
                    id="m-min"
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={methodDraft.min_days}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, min_days: event.target.value })
                    }
                  />
                </Field>

                <Field label="Slowest (days)" htmlFor="m-max" error={errorFor("max_days")}>
                  <Input
                    id="m-max"
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={methodDraft.max_days}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, max_days: event.target.value })
                    }
                    invalid={Boolean(errorFor("max_days"))}
                  />
                </Field>
              </div>

              <Field label="Description" htmlFor="m-desc" error={errorFor("description")}>
                <Input
                  id="m-desc"
                  value={methodDraft.description}
                  onChange={(event) =>
                    setMethodDraft({ ...methodDraft, description: event.target.value })
                  }
                />
              </Field>

              <fieldset className="flex flex-wrap gap-4">
                <legend className="sr-only">Method options</legend>
                <label className="flex items-center gap-2 text-body-sm">
                  <Checkbox
                    checked={methodDraft.is_pickup}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, is_pickup: event.target.checked })
                    }
                  />
                  Collect in store
                </label>
                <label className="flex items-center gap-2 text-body-sm">
                  <Checkbox
                    checked={methodDraft.supports_cod}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, supports_cod: event.target.checked })
                    }
                  />
                  Cash on delivery allowed
                </label>
                <label className="flex items-center gap-2 text-body-sm">
                  <Checkbox
                    checked={methodDraft.is_active}
                    onChange={(event) =>
                      setMethodDraft({ ...methodDraft, is_active: event.target.checked })
                    }
                  />
                  Active
                </label>
              </fieldset>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={busy}>
                  {editingMethod ? "Save method" : "Add method"}
                </Button>
                <Button type="button" variant="ghost" onClick={closeAll}>
                  <X className="size-4" aria-hidden />
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {zones.length === 0 ? (
        <Card>
          <EmptyState
            title="No delivery zones yet"
            description="Checkout offers the methods inside the zone that matches the delivery city, so a shop with no zones can take no online orders."
            action={
              canManage ? (
                <Button onClick={() => setZoneDraft(blankZone())}>
                  <Plus className="size-4" aria-hidden />
                  New zone
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        zones.map((zone) => (
          <Card key={zone.id}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="size-4 text-muted" aria-hidden />
                  {zone.name}
                  {zone.is_default && (
                    <Badge tone="brand">
                      <Star className="size-3" aria-hidden />
                      Fallback
                    </Badge>
                  )}
                  {!zone.is_active && <Badge tone="neutral">Inactive</Badge>}
                </CardTitle>
                <p className="mt-1 text-body-sm text-muted">
                  {zone.cities.length
                    ? zone.cities.join(", ")
                    : zone.is_default
                      ? "Any city not listed elsewhere"
                      : "No cities — this zone can never match"}
                </p>
              </div>
              {canManage && !editingSomething && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setMethodDraft(blankMethod());
                      setMethodZone(zone);
                      setEditingMethod(null);
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    Method
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setZoneDraft(zoneFrom(zone));
                      setEditingZone(zone);
                    }}
                  >
                    <Pencil className="size-4" aria-hidden />
                    <span className="sr-only">Edit {zone.name}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove("shipping-zones", zone.id, zone.name)}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    <span className="sr-only">Delete {zone.name}</span>
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {zone.methods.length === 0 ? (
                <p className="text-body-sm text-muted">
                  No methods. A zone with no methods offers nothing at checkout.
                </p>
              ) : (
                <ul className="space-y-2">
                  {zone.methods.map((method) => (
                    <li
                      key={method.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="flex items-start gap-3">
                        <Truck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                        <div className="text-body-sm">
                          <p className="font-medium">
                            {method.name}
                            <span className="ml-2 font-normal text-muted">{method.eta_label}</span>
                          </p>
                          <p className="text-muted">
                            {money(method.price)}
                            {method.free_over &&
                              ` · free over ${money(method.free_over)}`}
                            {method.is_pickup && " · collect in store"}
                            {!method.supports_cod && " · no cash on delivery"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {!method.is_active && <Badge tone="neutral">Inactive</Badge>}
                        {canManage && !editingSomething && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setMethodDraft(methodFrom(method));
                                setMethodZone(zone);
                                setEditingMethod(method);
                              }}
                            >
                              <Pencil className="size-4" aria-hidden />
                              <span className="sr-only">Edit {method.name}</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                remove("shipping-methods", method.id, method.name)
                              }
                              disabled={busy}
                            >
                              <Trash2 className="size-4" aria-hidden />
                              <span className="sr-only">Delete {method.name}</span>
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
