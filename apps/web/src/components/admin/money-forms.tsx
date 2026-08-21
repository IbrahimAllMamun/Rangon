"use client";

import { ArrowRightLeft, Check, PencilLine, X } from "lucide-react";
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
import type { Account } from "@/lib/api/types";
import { money } from "@/lib/format";

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

/**
 * Move money between two of the business's own accounts.
 *
 * Banking the day's takings, floating the drawer, cashing out a bKash wallet.
 * Never crosses the business boundary — paying someone is a supplier payment,
 * a refund or (from phase 36) an expense, and each of those has its own screen.
 */
export function TransferForm({
  accounts,
  onDone,
  onCancel,
}: {
  accounts: Account[];
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const open = accounts.filter((account) => account.is_active);
  const [source, setSource] = useState(open[0]?.id ?? "");
  const [target, setTarget] = useState(open[1]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const sourceAccount = open.find((account) => account.id === source);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];
    if (!source) found.push({ field: "tr-source", message: "Choose the account to move from." });
    if (!target) found.push({ field: "tr-target", message: "Choose the account to move to." });
    if (source && source === target) {
      found.push({ field: "tr-target", message: "Pick a different destination account." });
    }
    if (!amount || Number(amount) <= 0) {
      found.push({ field: "tr-amount", message: "Enter an amount greater than zero." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      await apiClient("/account-transfers/", {
        method: "POST",
        body: { source_account: source, target_account: target, amount, notes },
      });
      setSaved(true);
      setAmount("");
      setNotes("");
      onDone?.();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "tr-amount"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Move money between accounts</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not make this transfer" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="tr-source" required error={errorFor("tr-source")}>
              <Select
                id="tr-source"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                invalid={Boolean(errorFor("tr-source"))}
              >
                {open.map((account) => (
                  <option key={account.id} value={account.id}>
                    {label(account)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="To" htmlFor="tr-target" required error={errorFor("tr-target")}>
              <Select
                id="tr-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                invalid={Boolean(errorFor("tr-target"))}
              >
                {open.map((account) => (
                  <option key={account.id} value={account.id}>
                    {label(account)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Amount"
              htmlFor="tr-amount"
              required
              hint={
                sourceAccount
                  ? `${label(sourceAccount).split("— ")[1]} available.`
                  : undefined
              }
              error={errorFor("tr-amount")}
            >
              <Input
                id="tr-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                invalid={Boolean(errorFor("tr-amount"))}
                placeholder="0.00"
              />
            </Field>

            <Field label="Note" htmlFor="tr-notes">
              <Input
                id="tr-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Evening banking"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              <ArrowRightLeft className="size-4" aria-hidden />
              Transfer
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
            )}
            {saved && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
              >
                <Check className="size-4" aria-hidden /> Transferred
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const MANUAL_TYPES = [
  {
    value: "DEPOSIT",
    label: "Deposit — money in",
    hint: "Cash the owner put in, a float, a capital injection.",
  },
  {
    value: "WITHDRAWAL",
    label: "Withdrawal — money out",
    hint: "Money taken out that is not a supplier payment or a refund.",
  },
  {
    value: "ADJUSTMENT",
    label: "Correction",
    hint: "A counted difference. Enter a negative amount to reduce the balance.",
  },
] as const;

/**
 * A manual cash-book entry.
 *
 * Sale payments, refunds and supplier payments are deliberately absent: those
 * are posted by the services that cause them, and entering one here would
 * double-count money that is already in the account. The API refuses them too
 * — this list is a convenience, not the rule.
 */
export function MovementForm({
  accounts,
  onDone,
  onCancel,
}: {
  accounts: Account[];
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const open = accounts.filter((account) => account.is_active);
  const [account, setAccount] = useState(open[0]?.id ?? "");
  const [type, setType] = useState<(typeof MANUAL_TYPES)[number]["value"]>("DEPOSIT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const reasonRequired = type === "WITHDRAWAL" || type === "ADJUSTMENT";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];
    if (!account) found.push({ field: "mv-account", message: "Choose an account." });
    if (!amount || Number.isNaN(Number(amount))) {
      found.push({ field: "mv-amount", message: "Enter an amount." });
    } else if (type === "ADJUSTMENT" && Number(amount) === 0) {
      found.push({ field: "mv-amount", message: "A correction of zero changes nothing." });
    } else if (type !== "ADJUSTMENT" && Number(amount) <= 0) {
      found.push({ field: "mv-amount", message: "Enter an amount greater than zero." });
    }
    if (reasonRequired && !reason.trim()) {
      found.push({ field: "mv-reason", message: "Say why this money moved." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      await apiClient("/accounts/record-movement/", {
        method: "POST",
        body: { account, transaction_type: type, amount, reason },
      });
      setSaved(true);
      setAmount("");
      setReason("");
      onDone?.();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "mv-amount"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const activeType = MANUAL_TYPES.find((option) => option.value === type);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record a cash-book entry</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not record this entry" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Account" htmlFor="mv-account" required error={errorFor("mv-account")}>
              <Select
                id="mv-account"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                invalid={Boolean(errorFor("mv-account"))}
              >
                {open.map((row) => (
                  <option key={row.id} value={row.id}>
                    {label(row)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Entry" htmlFor="mv-type" hint={activeType?.hint}>
              <Select
                id="mv-type"
                value={type}
                onChange={(event) => setType(event.target.value as typeof type)}
              >
                {MANUAL_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Amount" htmlFor="mv-amount" required error={errorFor("mv-amount")}>
              <Input
                id="mv-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                invalid={Boolean(errorFor("mv-amount"))}
                placeholder={type === "ADJUSTMENT" ? "-250.00" : "0.00"}
              />
            </Field>

            <Field
              label="Reason"
              htmlFor="mv-reason"
              required={reasonRequired}
              hint={reasonRequired ? "Required — an unexplained movement is a red flag." : undefined}
              error={errorFor("mv-reason")}
            >
              <Textarea
                id="mv-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                invalid={Boolean(errorFor("mv-reason"))}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              <PencilLine className="size-4" aria-hidden />
              Record entry
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
            )}
            {saved && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
              >
                <Check className="size-4" aria-hidden /> Recorded
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
