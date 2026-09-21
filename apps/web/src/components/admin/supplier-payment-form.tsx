"use client";

import { Banknote, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
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
import type { Account, AccountKind } from "@/lib/api/types";
import { money } from "@/lib/format";
import { refreshAfterWrite } from "@/lib/navigation/refresh-after-write";

/**
 * Which kind of account each supplier-payment method comes out of.
 * Mirrors `finance.models.METHOD_TO_KIND` — a cheque clears through the bank,
 * so paying one out of the cash drawer would make the drawer unreconcilable.
 */
const METHOD_KIND: Record<string, AccountKind> = {
  CASH: "CASH",
  BANK: "BANK",
  CHEQUE: "BANK",
  MOBILE_MFS: "MFS",
  OTHER: "OTHER",
};

const METHODS: { value: string; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "BANK", label: "Bank transfer" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "MOBILE_MFS", label: "bKash / Nagad" },
  { value: "OTHER", label: "Other" },
];

function label(account: Account) {
  return `${account.name} — ${money(account.balance)}`;
}

function toFieldErrors(caught: unknown, fallbackField: string) {
  if (caught instanceof ApiError) {
    const fieldErrors = caught.fieldErrors();
    return fieldErrors.length ? fieldErrors : [{ field: fallbackField, message: caught.message }];
  }
  return [{ field: fallbackField, message: "Could not save. Please try again." }];
}

/** One key per attempt: a retry must not pay the supplier twice. */
function newKey() {
  return `sup-pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Record money paid to a supplier against one purchase order.
 *
 * The server owns every rule here — it refuses an overpayment, a draft or
 * cancelled order, and a supplier that does not match the order (see
 * business-rules.md §6b.1b). This form checks the same things first only so the
 * buyer is told before the round trip; it never decides anything.
 */
export function SupplierPaymentForm({
  purchaseOrderId,
  supplierId,
  outstanding,
  accounts,
}: {
  purchaseOrderId: string;
  supplierId: string;
  outstanding: string;
  accounts: Account[];
}) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [account, setAccount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Regenerated after every success: two genuine part-payments must not be
  // collapsed into one by a key that outlives the submit it belonged to.
  const [key, setKey] = useState(newKey);

  const owed = Number(outstanding);
  const candidates = accounts.filter(
    (row) => row.is_active && row.kind === METHOD_KIND[method],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];
    if (!amount || Number(amount) <= 0) {
      found.push({ field: "sp-amount", message: "Enter an amount greater than zero." });
    } else if (Number(amount) > owed) {
      found.push({
        field: "sp-amount",
        message: `Only ${money(outstanding)} is outstanding on this order.`,
      });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      await apiClient("/supplier-payments/", {
        method: "POST",
        body: {
          supplier: supplierId,
          purchase_order: purchaseOrderId,
          amount,
          method,
          reference,
          notes,
          ...(account ? { account } : {}),
        },
        idempotencyKey: key,
      });
      setSaved(true);
      setAmount("");
      setReference("");
      setNotes("");
      setKey(newKey());
      await refreshAfterWrite(router);
    } catch (caught) {
      setErrors(toFieldErrors(caught, "sp-amount"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  if (owed <= 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record a payment</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not record this payment" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Amount"
              htmlFor="sp-amount"
              required
              hint={`${money(outstanding)} outstanding.`}
              error={errorFor("sp-amount")}
            >
              <Input
                id="sp-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                invalid={Boolean(errorFor("sp-amount"))}
                placeholder="0.00"
              />
            </Field>

            <Field label="Method" htmlFor="sp-method" required>
              <Select
                id="sp-method"
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value);
                  setAccount("");
                }}
              >
                {METHODS.map((row) => (
                  <option key={row.value} value={row.value}>
                    {row.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Paid from"
              htmlFor="sp-account"
              hint={
                candidates.length === 0
                  ? "This branch has no account of that kind; the payment is still recorded and verify_accounts will report it."
                  : undefined
              }
            >
              <Select
                id="sp-account"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                disabled={candidates.length === 0}
              >
                <option value="">Use the branch default</option>
                {candidates.map((row) => (
                  <option key={row.id} value={row.id}>
                    {label(row)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Reference" htmlFor="sp-reference" hint="Cheque or transaction number.">
              <Input
                id="sp-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="CHQ-004521"
              />
            </Field>
          </div>

          <Field label="Note" htmlFor="sp-notes">
            <Textarea
              id="sp-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Part payment agreed with the mill."
            />
          </Field>

          <p className="text-caption text-muted">
            A recorded payment reaches the cash book and cannot be undone from this screen.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              <Banknote className="size-4" aria-hidden />
              Record payment
            </Button>
            {saved && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
              >
                <Check className="size-4" aria-hidden /> Payment recorded
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
