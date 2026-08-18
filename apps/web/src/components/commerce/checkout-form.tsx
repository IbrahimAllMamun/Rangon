"use client";

import { Loader2, Lock } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { LogoLoaderOverlay } from "@/components/brand/logo-loader-overlay";
import {
  Button,
  Card,
  ErrorSummary,
  Field,
  Input,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { Order, ShippingOption } from "@/lib/api/types";
import { money } from "@/lib/format";
import { useCart } from "@/lib/store/cart";

interface FormState {
  recipient_name: string;
  phone: string;
  email: string;
  line1: string;
  line2: string;
  area: string;
  city: string;
  postal_code: string;
  note: string;
}

const EMPTY: FormState = {
  recipient_name: "",
  phone: "",
  email: "",
  line1: "",
  line2: "",
  area: "",
  city: "Dhaka",
  postal_code: "",
  note: "",
};

const REQUIRED: (keyof FormState)[] = ["recipient_name", "phone", "line1", "city"];

export function CheckoutForm() {
  const router = useRouter();
  const { cart, load, loading: cartLoading } = useCart();

  const [form, setForm] = useState<FormState>(EMPTY);
  const [shippingOptions, setShippingOptions] = useState<ShippingOption[]>([]);
  const [shippingId, setShippingId] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<"COD" | "ONLINE_GATEWAY">("COD");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  /**
   * A key that survives re-renders but changes per cart, so a double-clicked
   * "Place order" reuses it and the server returns the same order
   * (docs/architecture/orders.md — Idempotency).
   */
  const idempotencyKey = useMemo(
    () => `checkout-${cart?.id ?? "new"}-${Date.now().toString(36)}`,
    [cart?.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const loadShipping = useCallback(async (city: string) => {
    try {
      const options = await apiClient<ShippingOption[]>(
        `/shop/shipping-options/?city=${encodeURIComponent(city)}`,
      );
      setShippingOptions(options);
      setShippingId((current) => current || options[0]?.id || "");
    } catch {
      setShippingOptions([]);
    }
  }, []);

  useEffect(() => {
    if (form.city) void loadShipping(form.city);
  }, [form.city, loadShipping]);

  const selectedShipping = shippingOptions.find((option) => option.id === shippingId);
  const shippingCost = Number(selectedShipping?.price ?? 0);
  const itemsTotal = Number(cart?.totals?.grand_total ?? 0);
  const total = itemsTotal + shippingCost;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function validate(): { field: string; message: string }[] {
    const found: { field: string; message: string }[] = [];
    for (const key of REQUIRED) {
      if (!form[key].trim()) {
        found.push({ field: key, message: `${labelFor(key)} is required.` });
      }
    }
    if (form.phone && !/^01[3-9]\d{8}$/.test(form.phone.replace(/[\s-]/g, ""))) {
      found.push({ field: "phone", message: "Enter a valid Bangladeshi mobile number (01XXXXXXXXX)." });
    }
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) {
      found.push({ field: "email", message: "Enter a valid email address." });
    }
    if (!shippingId) {
      found.push({ field: "shipping", message: "Choose a delivery option." });
    }
    return found;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (found.length) return;

    setSubmitting(true);
    try {
      const response = await apiClient<{ order: Order; tracking_token: string }>(
        "/shop/checkout/",
        {
          method: "POST",
          idempotencyKey,
          body: {
            shipping_address: {
              recipient_name: form.recipient_name,
              phone: form.phone,
              line1: form.line1,
              line2: form.line2,
              area: form.area,
              city: form.city,
              postal_code: form.postal_code,
              country: "Bangladesh",
            },
            payment_method: paymentMethod,
            shipping_method: shippingId,
            contact_name: form.recipient_name,
            contact_phone: form.phone,
            contact_email: form.email,
            note: form.note,
          },
        },
      );
      router.push(
        `/order/${response.order.number}?token=${encodeURIComponent(response.tracking_token)}`,
      );
    } catch (error) {
      if (error instanceof ApiError) {
        const fieldErrors = error.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "form", message: error.message }],
        );
      } else {
        setErrors([{ field: "form", message: "Your order could not be placed. Please try again." }]);
      }
      setSubmitting(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  if (!cartLoading && cart && cart.items.length === 0) {
    return (
      <Card className="mt-8 p-10 text-center">
        <h2 className="text-h4">Your cart is empty</h2>
        <p className="mt-2 text-body-sm text-muted">Add something before checking out.</p>
        <Button asChild className="mt-4">
          <Link href="/shop">Browse the shop</Link>
        </Button>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]">
      {/* The longest wait in the app, and the one where a second click costs
          real money. `submitting` is deliberately never cleared on success, so
          the loader carries straight through to the confirmation page instead
          of blinking off while the router navigates. */}
      <LogoLoaderOverlay active={submitting} label="Placing your order" delay={350} />

      <div className="space-y-6">
        <ErrorSummary errors={errors} />

        <Card>
          <div className="border-b border-border p-4">
            <h2 className="text-h4">Delivery address</h2>
          </div>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field
              label="Full name"
              htmlFor="recipient_name"
              required
              error={errorFor("recipient_name")}
              className="sm:col-span-2"
            >
              <Input
                id="recipient_name"
                autoComplete="name"
                value={form.recipient_name}
                onChange={(event) => set("recipient_name", event.target.value)}
                invalid={Boolean(errorFor("recipient_name"))}
                aria-describedby={errorFor("recipient_name") ? "recipient_name-error" : undefined}
              />
            </Field>

            <Field
              label="Mobile number"
              htmlFor="phone"
              required
              hint="We will call this number about your delivery."
              error={errorFor("phone")}
            >
              <Input
                id="phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={form.phone}
                onChange={(event) => set("phone", event.target.value)}
                invalid={Boolean(errorFor("phone"))}
                aria-describedby={errorFor("phone") ? "phone-error" : "phone-hint"}
              />
            </Field>

            <Field label="Email (optional)" htmlFor="email" error={errorFor("email")}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(event) => set("email", event.target.value)}
                invalid={Boolean(errorFor("email"))}
              />
            </Field>

            <Field
              label="Address"
              htmlFor="line1"
              required
              error={errorFor("line1")}
              className="sm:col-span-2"
            >
              <Input
                id="line1"
                autoComplete="address-line1"
                value={form.line1}
                onChange={(event) => set("line1", event.target.value)}
                invalid={Boolean(errorFor("line1"))}
              />
            </Field>

            <Field label="Area" htmlFor="area">
              <Input
                id="area"
                autoComplete="address-level3"
                value={form.area}
                onChange={(event) => set("area", event.target.value)}
              />
            </Field>

            <Field label="City / District" htmlFor="city" required error={errorFor("city")}>
              <Input
                id="city"
                autoComplete="address-level2"
                value={form.city}
                onChange={(event) => set("city", event.target.value)}
                invalid={Boolean(errorFor("city"))}
              />
            </Field>
          </div>
        </Card>

        <Card id="shipping">
          <div className="border-b border-border p-4">
            <h2 className="text-h4">Delivery option</h2>
          </div>
          <fieldset className="space-y-2 p-4">
            <legend className="sr-only">Delivery option</legend>
            {shippingOptions.length === 0 && (
              <p className="text-body-sm text-muted">
                Enter your city to see delivery options.
              </p>
            )}
            {shippingOptions.map((option) => (
              <label
                key={option.id}
                className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors duration-fast ${
                  shippingId === option.id
                    ? "border-brand-500 bg-brand-50"
                    : "border-neutral-300 hover:bg-neutral-100"
                }`}
              >
                <input
                  type="radio"
                  name="shipping"
                  value={option.id}
                  checked={shippingId === option.id}
                  onChange={() => setShippingId(option.id)}
                  className="size-4 accent-[var(--brand-500)]"
                />
                <span className="flex-1">
                  <span className="block text-body-sm font-medium">{option.name}</span>
                  <span className="block text-caption text-muted">{option.eta}</span>
                </span>
                <span className="tabular text-body-sm font-semibold">
                  {Number(option.price) === 0 ? "Free" : money(option.price)}
                </span>
              </label>
            ))}
            {errorFor("shipping") && (
              <p className="text-caption font-medium text-[var(--error)]">{errorFor("shipping")}</p>
            )}
          </fieldset>
        </Card>

        <Card>
          <div className="border-b border-border p-4">
            <h2 className="text-h4">Payment</h2>
          </div>
          <fieldset className="space-y-2 p-4">
            <legend className="sr-only">Payment method</legend>
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 ${
                paymentMethod === "COD" ? "border-brand-500 bg-brand-50" : "border-neutral-300"
              }`}
            >
              <input
                type="radio"
                name="payment"
                checked={paymentMethod === "COD"}
                onChange={() => setPaymentMethod("COD")}
                className="size-4 accent-[var(--brand-500)]"
                disabled={selectedShipping ? !selectedShipping.supports_cod : false}
              />
              <span className="flex-1">
                <span className="block text-body-sm font-medium">Cash on delivery</span>
                <span className="block text-caption text-muted">
                  Pay the courier when your order arrives.
                </span>
              </span>
            </label>

            <label className="flex cursor-not-allowed items-center gap-3 rounded-md border border-neutral-200 p-3 opacity-60">
              <input type="radio" name="payment" disabled className="size-4" />
              <span className="flex-1">
                <span className="block text-body-sm font-medium">Card / mobile banking</span>
                <span className="block text-caption text-muted">
                  Coming soon — online payment is not yet enabled.
                </span>
              </span>
            </label>
          </fieldset>
        </Card>

        <Field label="Order note (optional)" htmlFor="note">
          <Textarea
            id="note"
            rows={3}
            value={form.note}
            onChange={(event) => set("note", event.target.value)}
            placeholder="Landmark, preferred delivery time…"
          />
        </Field>
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <Card>
          <div className="border-b border-border p-4">
            <h2 className="text-h4">Order summary</h2>
          </div>

          <ul className="max-h-64 divide-y divide-border overflow-y-auto px-4">
            {cart?.items.map((item) => (
              <li key={item.id} className="flex gap-3 py-3">
                <div className="relative size-14 shrink-0 overflow-hidden rounded-md bg-neutral-100">
                  {item.image && (
                    <Image src={item.image} alt="" fill sizes="56px" className="object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-body-sm font-medium">{item.product_name}</p>
                  <p className="text-caption text-muted">
                    {item.variant_label} · Qty {item.quantity}
                  </p>
                </div>
                <p className="tabular text-body-sm">
                  {money(Number(item.unit_price) * item.quantity)}
                </p>
              </li>
            ))}
          </ul>

          <dl className="space-y-2 border-t border-border p-4 text-body-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd className="tabular">{money(cart?.totals.subtotal)}</dd>
            </div>
            {Number(cart?.totals.discount_total ?? 0) > 0 && (
              <div className="flex justify-between text-[var(--success)]">
                <dt>Discount</dt>
                <dd className="tabular">− {money(cart?.totals.discount_total)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted">Delivery</dt>
              <dd className="tabular">
                {selectedShipping ? (shippingCost === 0 ? "Free" : money(shippingCost)) : "—"}
              </dd>
            </div>
            {Number(cart?.totals.tax_total ?? 0) > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">VAT</dt>
                <dd className="tabular">{money(cart?.totals.tax_total)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between border-t border-border pt-3">
              <dt className="text-body font-semibold">Total</dt>
              <dd className="tabular text-h3 font-bold">{money(total)}</dd>
            </div>
          </dl>

          <div className="p-4 pt-0">
            <Button type="submit" size="lg" full loading={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden /> Placing your order…
                </>
              ) : (
                `Place order · ${money(total)}`
              )}
            </Button>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-caption text-muted">
              <Lock className="size-3" aria-hidden />
              Your details are sent over a secure connection.
            </p>
          </div>
        </Card>
      </aside>
    </form>
  );
}

function labelFor(key: keyof FormState): string {
  const labels: Record<keyof FormState, string> = {
    recipient_name: "Full name",
    phone: "Mobile number",
    email: "Email",
    line1: "Address",
    line2: "Address line 2",
    area: "Area",
    city: "City",
    postal_code: "Postal code",
    note: "Note",
  };
  return labels[key];
}
