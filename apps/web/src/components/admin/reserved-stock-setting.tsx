"use client";

import { Info } from "lucide-react";
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
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

/**
 * Whether the counter may sell stock reserved for online orders -- D115,
 * docs/business-rules.md §1.4. The owner's decision alone: the API refuses
 * anyone else (403), and this card is read-only for them.
 *
 * Off, a cashier can sell only what no online order holds. On, the customer
 * standing at the counter comes first, and every online order left short is
 * flagged on its timeline and in staff notifications.
 */
export function ReservedStockSetting({
  initial,
  isOwner,
}: {
  initial: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(initial);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>(
    [],
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setErrors([]);
    setSaving(true);
    try {
      await apiClient("/organization/", {
        method: "PATCH",
        body: { counter_sells_reserved: allowed },
      });
      setSaved(true);
      router.refresh();
    } catch (error) {
      setErrors([
        {
          field: "counter_sells_reserved",
          message:
            error instanceof ApiError
              ? error.message
              : "Could not save. Try again.",
        },
      ]);
    } finally {
      setSaving(false);
    }
  }

  const options = [
    {
      value: false,
      label: "Keep reserved stock for online orders",
      hint: "The counter sells only what no online order holds. A cashier is told how many units are held.",
    },
    {
      value: true,
      label: "Let the counter sell reserved stock",
      hint: "The customer in the shop is served. Online orders left short are flagged for staff to restock or call the customer.",
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>Stock held for online orders</CardTitle>
        <Badge tone={initial ? "warning" : "success"}>
          {initial ? "Counter may sell it" : "Kept for online orders"}
        </Badge>
      </CardHeader>
      <CardContent>
        {!isOwner && (
          <p className="mb-4 rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
            Only the owner can change this.
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          noValidate
          className="space-y-4"
        >
          <ErrorSummary errors={errors} title="Could not save this setting" />
          <fieldset className="space-y-3" disabled={!isOwner}>
            <legend className="sr-only">
              When the counter sells stock reserved for online orders
            </legend>
            {options.map((option) => (
              <label
                key={String(option.value)}
                className="flex cursor-pointer gap-3 rounded-md border border-border p-3 has-[:checked]:border-brand-500"
              >
                <input
                  type="radio"
                  name="counter-sells-reserved"
                  className="mt-1 accent-[var(--brand-500)] focus-visible:ring-4 focus-visible:ring-[var(--ring)]"
                  checked={allowed === option.value}
                  onChange={() => {
                    setAllowed(option.value);
                    setSaved(false);
                  }}
                />
                <span>
                  <span className="block text-body-sm font-medium">
                    {option.label}
                  </span>
                  <span className="block text-caption text-muted">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="flex gap-2 rounded-md bg-neutral-50 p-3 text-caption text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Reserved stock is what online orders have bought and are waiting
              to be packed. It is still on the shelf, so a cashier can
              physically hand it over.
            </span>
          </p>
          {isOwner && (
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving || allowed === initial}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved && (
                <span role="status" className="text-body-sm text-muted">
                  Saved.
                </span>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
