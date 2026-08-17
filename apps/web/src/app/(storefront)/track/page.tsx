import type { Metadata } from "next";

import { Button, Card, Field, Input } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Track your order",
  description: "Look up a Rangon Fashion order using the order number and the tracking link we sent you.",
};

export default function TrackPage() {
  return (
    <div className="container-rangon max-w-lg py-12">
      <h1 className="font-display text-h1">Track your order</h1>
      <p className="mt-2 text-body text-muted">
        Use the tracking link from your confirmation. If you have an account, your orders are in{" "}
        <a href="/account/orders" className="text-brand-600 underline">
          your account
        </a>
        .
      </p>

      <Card className="mt-6 p-5">
        {/* The order number alone is not enough to open an order — a signed
            token is required as well, so numbers cannot be guessed. */}
        <form action="/order" method="get" className="space-y-4">
          <Field
            label="Order number"
            htmlFor="number"
            required
            hint="For example RGN-WEB-000123"
          >
            <Input id="number" name="number" placeholder="RGN-WEB-000123" required />
          </Field>

          <Field
            label="Tracking code"
            htmlFor="token"
            required
            hint="From the confirmation link we sent you."
          >
            <Input id="token" name="token" required />
          </Field>

          <Button type="submit" size="lg" full>
            Find my order
          </Button>
        </form>
      </Card>

      <p className="mt-6 text-body-sm text-muted">
        Lost your tracking code?{" "}
        <a href="/contact" className="text-brand-600 underline">
          Contact us
        </a>{" "}
        with your phone number and we will look it up.
      </p>
    </div>
  );
}
