import type { Metadata } from "next";

import { Button, Card, ErrorSummary, Field, Input } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Track your order",
  description: "Look up a Rangon Fashion order using the order number and the tracking link we sent you.",
};

export default async function TrackPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  // `/order` bounces a malformed number back here rather than putting it into
  // a path segment. There is only one way to fail, so there is only one message.
  const { e } = await searchParams;
  const errors =
    e === "number"
      ? [
          {
            field: "number",
            message: "That does not look like an order number. It reads like RGN-WEB-000123.",
          },
        ]
      : [];

  return (
    <div className="container-rangon max-w-lg py-12">
      <h1 className="font-display text-h1">Track your order</h1>
      <p className="mt-2 text-body text-muted">
        Enter the order number and the tracking code from the confirmation we sent you, or open
        the link in that message directly.
      </p>

      <Card className="mt-6 p-5">
        {errors.length > 0 && (
          <div className="mb-4">
            <ErrorSummary errors={errors} title="Check the order number" />
          </div>
        )}
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
