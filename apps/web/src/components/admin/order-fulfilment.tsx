"use client";

import { ExternalLink, PackageCheck, Truck } from "lucide-react";
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
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { OrderStatus, Shipment, ShipmentStatus } from "@/lib/api/types";
import { dateTime, humanise, money } from "@/lib/format";

/**
 * Hand an order to a courier, and record what the courier says afterwards.
 *
 * `ShipmentViewSet` has existed since phase 18 and nothing had ever called it,
 * so `orders.fulfil` was a permission no screen could exercise, no tracking
 * number was ever written, and the `tracking_url_template` on `/admin/shipping`
 * could never be filled in. This is the caller.
 *
 * Every rule belongs to the server and is asserted in
 * `tests/api/test_shipment_fulfilment.py`: which order statuses may be shipped,
 * that a parcel always starts `PENDING`, that a tracking number needs the
 * courier that issued it, that one courier cannot give one number to two
 * parcels, and that a delivered parcel takes no further updates. The checks
 * here exist so the packer is told before the round trip, never to decide.
 */

/** Mirrors `shipping.services.SHIPPABLE_ORDER_STATUSES`. */
const SHIPPABLE: OrderStatus[] = ["CONFIRMED", "PROCESSING", "PACKED", "SHIPPED"];

/** Mirrors `shipping.services.FINISHED_SHIPMENT_STATUSES`. */
const FINISHED: ShipmentStatus[] = ["DELIVERED", "RETURNED"];

/**
 * The updates a person types by hand, in the order a parcel meets them.
 * `PENDING` is not offered: it is where a parcel starts, not somewhere it
 * returns to.
 */
const UPDATES: { value: ShipmentStatus; label: string }[] = [
  { value: "DISPATCHED", label: "Dispatched — the courier has it" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "FAILED", label: "Delivery failed — will retry" },
  { value: "RETURNED", label: "Returned to us" },
];

const TONE: Record<ShipmentStatus, "neutral" | "success" | "warning" | "error"> = {
  PENDING: "neutral",
  DISPATCHED: "warning",
  IN_TRANSIT: "warning",
  DELIVERED: "success",
  FAILED: "error",
  RETURNED: "error",
};

function toFieldErrors(caught: unknown, fallbackField: string) {
  if (caught instanceof ApiError) {
    const fieldErrors = caught.fieldErrors();
    return fieldErrors.length ? fieldErrors : [{ field: fallbackField, message: caught.message }];
  }
  return [{ field: fallbackField, message: "Could not save. Please try again." }];
}

export function OrderFulfilment({
  orderId,
  orderStatus,
  shipments,
  couriers,
  canFulfil,
}: {
  orderId: string;
  orderStatus: OrderStatus;
  shipments: Shipment[];
  couriers: { id: string; name: string }[];
  canFulfil: boolean;
}) {
  const router = useRouter();
  const [courier, setCourier] = useState("");
  const [tracking, setTracking] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const shippable = SHIPPABLE.includes(orderStatus);
  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  async function book(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];

    // The server's rule, checked here only to save a round trip.
    if (tracking.trim() && !courier) {
      found.push({
        field: "ship-courier",
        message: "Choose the courier that issued this tracking number.",
      });
    }
    if (cost && Number(cost) < 0) {
      found.push({ field: "ship-cost", message: "A shipment cost cannot be negative." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      await apiClient("/shipments/", {
        method: "POST",
        body: {
          order: orderId,
          tracking_number: tracking.trim(),
          notes,
          ...(courier ? { courier } : {}),
          ...(cost ? { cost } : {}),
        },
      });
      setCourier("");
      setTracking("");
      setCost("");
      setNotes("");
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "ship-tracking"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {shipments.length === 0 ? (
          <p className="text-body-sm text-muted">
            No parcel booked yet. Until one is, the customer&rsquo;s tracking page has nothing to
            show them.
          </p>
        ) : (
          <ul className="space-y-4">
            {shipments.map((shipment) => (
              <Parcel
                key={shipment.id}
                shipment={shipment}
                canFulfil={canFulfil}
                onChanged={() => router.refresh()}
              />
            ))}
          </ul>
        )}

        {canFulfil && shippable && (
          <form onSubmit={book} noValidate className="space-y-4 border-t border-border pt-5">
            <ErrorSummary errors={errors} title="Could not book this parcel" />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Courier" htmlFor="ship-courier" error={errorFor("ship-courier")}>
                <Select
                  id="ship-courier"
                  value={courier}
                  onChange={(event) => setCourier(event.target.value)}
                  invalid={Boolean(errorFor("ship-courier"))}
                >
                  <option value="">Not decided yet</option>
                  {couriers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Tracking number"
                htmlFor="ship-tracking"
                hint="Leave empty until the courier gives you one."
                error={errorFor("ship-tracking")}
              >
                <Input
                  id="ship-tracking"
                  value={tracking}
                  onChange={(event) => setTracking(event.target.value)}
                  invalid={Boolean(errorFor("ship-tracking"))}
                  placeholder="CX-88213"
                />
              </Field>

              <Field
                label="What the courier charges us"
                htmlFor="ship-cost"
                hint="Not shown to the customer."
                error={errorFor("ship-cost")}
              >
                <Input
                  id="ship-cost"
                  type="text"
                  inputMode="decimal"
                  value={cost}
                  onChange={(event) => setCost(event.target.value)}
                  invalid={Boolean(errorFor("ship-cost"))}
                  placeholder="0.00"
                />
              </Field>
            </div>

            <Field label="Note for the packing bench" htmlFor="ship-notes">
              <Textarea
                id="ship-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>

            <Button type="submit" disabled={saving}>
              <Truck className="size-4" aria-hidden />
              {saving ? "Booking…" : shipments.length ? "Book another parcel" : "Book a parcel"}
            </Button>
          </form>
        )}

        {canFulfil && !shippable && shipments.length === 0 && (
          <p className="border-t border-border pt-5 text-body-sm text-muted">
            A {humanise(orderStatus).toLowerCase()} order cannot be shipped.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Parcel({
  shipment,
  canFulfil,
  onChanged,
}: {
  shipment: Shipment;
  canFulfil: boolean;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<ShipmentStatus>("DISPATCHED");
  const [message, setMessage] = useState("");
  const [location, setLocation] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const finished = FINISHED.includes(shipment.status);
  const field = `ship-update-${shipment.id}`;

  async function update(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      await apiClient(`/shipments/${shipment.id}/events/`, {
        method: "POST",
        body: { status, message, location },
      });
      setMessage("");
      setLocation("");
      setOpen(false);
      onChanged();
    } catch (caught) {
      setErrors(toFieldErrors(caught, field));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body-sm font-medium">
            {shipment.courier_name || "Courier not chosen"}
            {shipment.tracking_number ? ` · ${shipment.tracking_number}` : ""}
          </p>
          <p className="text-caption text-muted">
            Booked {dateTime(shipment.created_at)}
            {Number(shipment.cost) > 0 ? ` · costs us ${money(shipment.cost)}` : ""}
          </p>
        </div>
        <Badge tone={TONE[shipment.status]}>{humanise(shipment.status)}</Badge>
      </div>

      {shipment.tracking_url && (
        <a
          href={shipment.tracking_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-caption text-brand-600 underline"
        >
          Open on the courier&rsquo;s site
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}

      {shipment.events.length > 0 && (
        <ol className="mt-3 space-y-1 border-l border-border pl-3">
          {shipment.events.map((event, index) => (
            <li key={`${event.occurred_at}-${index}`} className="text-caption">
              <span className="font-medium">{humanise(event.status)}</span>
              {event.message ? ` — ${event.message}` : ""}
              {event.location ? ` (${event.location})` : ""}
              <span className="block text-muted">{dateTime(event.occurred_at)}</span>
            </li>
          ))}
        </ol>
      )}

      {canFulfil && !finished && (
        <div className="mt-3">
          <ErrorSummary errors={errors} title="Could not record this update" />
          {open ? (
            <form onSubmit={update} noValidate className="mt-2 space-y-3">
              <Field label="What happened" htmlFor={field} required>
                <Select
                  id={field}
                  value={status}
                  onChange={(event) => setStatus(event.target.value as ShipmentStatus)}
                >
                  {UPDATES.map((row) => (
                    <option key={row.value} value={row.value}>
                      {row.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Note" htmlFor={`${field}-message`}>
                  <Input
                    id={`${field}-message`}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Collected from the shop"
                  />
                </Field>
                <Field label="Where" htmlFor={`${field}-location`}>
                  <Input
                    id={`${field}-location`}
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="Dhaka"
                  />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={saving}>
                  <PackageCheck className="size-4" aria-hidden />
                  {saving ? "Saving…" : "Record update"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Record an update
            </Button>
          )}
        </div>
      )}

      {finished && (
        <p className="mt-3 text-caption text-muted">
          This parcel is {humanise(shipment.status).toLowerCase()}; its history is closed.
        </p>
      )}
    </li>
  );
}
