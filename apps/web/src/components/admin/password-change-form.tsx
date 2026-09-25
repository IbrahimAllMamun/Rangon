"use client";

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { Button, ErrorSummary, Field, PasswordInput } from "@/components/ui/primitives";

type FieldError = { field: string; message: string };

/** API field → the input it belongs to. */
const FIELD_IDS: Record<string, string> = {
  current_password: "current-password",
  new_password: "new-password",
};

/**
 * Change your own password.
 *
 * Posts to the app's `/api/auth/password` route, not the generic proxy: the API
 * answers a successful change with a fresh token pair (every older one has
 * just been revoked), and that route keeps them in httpOnly cookies.
 *
 * The confirmation field is checked here and nowhere else — it guards against
 * a typo, not against anything the server needs to know. The strength rules
 * are the server's (`AUTH_PASSWORD_VALIDATORS`) and come back as field errors,
 * so this form never states a rule the server does not enforce.
 */
export function PasswordChangeForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setDone(false);

    const found: FieldError[] = [];
    if (!current) found.push({ field: "current-password", message: "Enter your current password." });
    if (!next) found.push({ field: "new-password", message: "Enter a new password." });
    else if (next !== confirm) {
      found.push({ field: "confirm-password", message: "The two new passwords do not match." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const details: Record<string, string[] | string> = body?.error?.details ?? {};
        const fromServer = Object.entries(details).map(([field, messages]) => ({
          field: FIELD_IDS[field] ?? "current-password",
          message: Array.isArray(messages) ? messages.join(" ") : String(messages),
        }));
        setErrors(
          fromServer.length
            ? fromServer
            : [
                {
                  field: "current-password",
                  message:
                    response.status === 429
                      ? "Too many attempts. Wait a minute and try again."
                      : (body?.error?.message ?? "Could not change your password."),
                },
              ],
        );
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch {
      setErrors([{ field: "current-password", message: "Could not reach the server. Try again." }]);
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <form onSubmit={submit} noValidate className="max-w-md space-y-4">
      <ErrorSummary errors={errors} title="Your password was not changed" />

      {done && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-[var(--success)] bg-[var(--success-bg)] p-3 text-body-sm"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success-text)]" aria-hidden />
          <span>
            Password changed. Anywhere else you were signed in — another browser, the counter, a
            phone — has been signed out. This window stays signed in.
          </span>
        </p>
      )}

      <Field label="Current password" htmlFor="current-password" required error={errorFor("current-password")}>
        <PasswordInput
          id="current-password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          invalid={Boolean(errorFor("current-password"))}
          aria-describedby={errorFor("current-password") ? "current-password-error" : undefined}
        />
      </Field>

      <Field
        label="New password"
        htmlFor="new-password"
        required
        hint="At least 10 characters, not a common password, not only numbers, and not close to your name or email."
        error={errorFor("new-password")}
      >
        <PasswordInput
          id="new-password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          invalid={Boolean(errorFor("new-password"))}
          aria-describedby={
            [errorFor("new-password") ? "new-password-error" : "", "new-password-hint"]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
      </Field>

      <Field
        label="New password again"
        htmlFor="confirm-password"
        required
        error={errorFor("confirm-password")}
      >
        <PasswordInput
          id="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          invalid={Boolean(errorFor("confirm-password"))}
          aria-describedby={errorFor("confirm-password") ? "confirm-password-error" : undefined}
        />
      </Field>

      <Button type="submit" loading={saving}>
        Change password
      </Button>
    </form>
  );
}
