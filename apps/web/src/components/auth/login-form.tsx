"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Logo } from "@/components/brand/logo";
import { Button, Card, ErrorSummary, Field, Input } from "@/components/ui/primitives";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const found: { field: string; message: string }[] = [];
    if (!email.trim()) found.push({ field: "email", message: "Email address is required." });
    if (!password) found.push({ field: "password", message: "Password is required." });
    setErrors(found);
    if (found.length) return;

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setErrors([
          {
            field: "email",
            message: body?.error?.message ?? "Incorrect email address or password.",
          },
        ]);
        setSubmitting(false);
        return;
      }

      const { user } = await response.json();
      // Send staff where they actually work.
      const destination =
        next !== "/"
          ? next
          : user?.role === "CASHIER"
            ? "/pos"
            : user?.role === "CUSTOMER"
              ? "/account"
              : "/admin";

      router.push(destination);
      router.refresh();
    } catch {
      setErrors([{ field: "email", message: "Could not reach the server. Please try again." }]);
      setSubmitting(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card className="w-full p-6 sm:p-8">
      <div className="flex justify-center">
        <Logo variant="vertical-on-light" height={96} priority />
      </div>
      <h1 className="mt-6 text-center text-h3">Sign in</h1>
      <p className="mt-1 text-center text-body-sm text-muted">
        Staff, cashiers and customers all sign in here.
      </p>

      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        <ErrorSummary errors={errors} title="Could not sign you in" />

        <Field label="Email address" htmlFor="email" required error={errorFor("email")}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            invalid={Boolean(errorFor("email"))}
            aria-describedby={errorFor("email") ? "email-error" : undefined}
          />
        </Field>

        <Field label="Password" htmlFor="password" required error={errorFor("password")}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            invalid={Boolean(errorFor("password"))}
            aria-describedby={errorFor("password") ? "password-error" : undefined}
          />
        </Field>

        <Button type="submit" size="lg" full loading={submitting}>
          Sign in
        </Button>
      </form>
    </Card>
  );
}
