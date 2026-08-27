"use client";

import { Ban, Check, Paperclip, Receipt, X } from "lucide-react";
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
import { ApiError, apiClient, apiUpload } from "@/lib/api/client";
import type { Account, ExpenseCategory } from "@/lib/api/types";
import { money } from "@/lib/format";

type FieldError = { field: string; message: string };

function toFieldErrors(caught: unknown, fallbackField: string): FieldError[] {
  if (caught instanceof ApiError) {
    const fieldErrors = caught.fieldErrors();
    return fieldErrors.length ? fieldErrors : [{ field: fallbackField, message: caught.message }];
  }
  return [{ field: fallbackField, message: "Could not save. Please try again." }];
}

/** Today, as the `YYYY-MM-DD` a date input expects, in the viewer's timezone. */
function todayValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * What to send as `spent_at` for the chosen day.
 *
 * Today is sent as nothing at all, so the server stamps the actual moment.
 * Naming a clock time for today would be guessing, and any guess later than
 * now is refused outright — the server will not date an expense in the future,
 * which a fixed midday would be for anyone recording one in the morning.
 * A past day keeps midday, which is far enough from either midnight to survive
 * the timezone gap between the browser and the shop.
 */
function spentAtFor(day: string) {
  if (!day || day === todayValue()) return undefined;
  return `${day}T12:00:00`;
}

/**
 * Record an expense.
 *
 * The money leaves an account the moment this succeeds — the API posts an
 * `EXPENSE` row to that account's cash book inside the same transaction, so
 * there is no state where the expense exists but the balance has not moved.
 * The account picker therefore shows live balances: choosing a drawer that
 * cannot cover the amount is refused by the server, not by this form.
 */
export function ExpenseForm({
  categories,
  accounts,
  branchId,
  onDone,
  onCancel,
}: {
  categories: ExpenseCategory[];
  accounts: Account[];
  branchId: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const open = accounts.filter((account) => account.is_active);
  const usable = categories.filter((category) => category.is_active);

  const [category, setCategory] = useState(usable[0]?.id ?? "");
  // Day-to-day spending comes out of the drawer, so the branch's default CASH
  // account wins over its default bank account — which sorts first, and would
  // otherwise pre-select a bank transfer for a taxi fare.
  const [account, setAccount] = useState(
    open.find((row) => row.is_default && row.kind === "CASH")?.id ??
      open.find((row) => row.kind === "CASH")?.id ??
      open.find((row) => row.is_default)?.id ??
      open[0]?.id ??
      "",
  );
  const [amount, setAmount] = useState("");
  const [spentOn, setSpentOn] = useState(todayValue());
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const chosenAccount = open.find((row) => row.id === account);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Clear the previous success first: leaving "Recorded" on screen beside a
    // failed submit tells the user their money moved when it did not.
    setSaved(false);
    const found: FieldError[] = [];
    if (!category) found.push({ field: "ex-category", message: "Choose what this was spent on." });
    if (!account) found.push({ field: "ex-account", message: "Choose the account it came from." });
    if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
      found.push({ field: "ex-amount", message: "Enter an amount greater than zero." });
    }
    if (spentOn && spentOn > todayValue()) {
      found.push({ field: "ex-date", message: "An expense cannot be dated in the future." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      // Multipart only when there is a receipt: `apiClient` forces a JSON
      // content type, so a file has to go through `apiUpload` instead.
      if (receipt) {
        const form = new FormData();
        form.append("branch", branchId);
        form.append("category", category);
        form.append("account", account);
        form.append("amount", amount);
        const spentAt = spentAtFor(spentOn);
        if (spentAt) form.append("spent_at", spentAt);
        form.append("note", note);
        form.append("attachment", receipt);
        await apiUpload("/expenses/", form);
      } else {
        await apiClient("/expenses/", {
          method: "POST",
          body: {
            branch: branchId,
            category,
            account,
            amount,
            ...(spentAtFor(spentOn) ? { spent_at: spentAtFor(spentOn) } : {}),
            note,
          },
        });
      }
      setSaved(true);
      setAmount("");
      setNote("");
      setReceipt(null);
      onDone?.();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "ex-amount"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  if (usable.length === 0 || open.length === 0) {
    return (
      <Card>
        <CardContent>
          <p className="p-4 text-body-sm text-muted">
            {open.length === 0
              ? "This branch has no account to spend from. Open one from Finance first."
              : "Every expense category has been retired. Re-activate one from the list below."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record an expense</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not record this expense" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Spent on" htmlFor="ex-category" required error={errorFor("ex-category")}>
              <Select
                id="ex-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                invalid={Boolean(errorFor("ex-category"))}
              >
                {usable.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Paid from"
              htmlFor="ex-account"
              required
              hint={chosenAccount ? `${money(chosenAccount.balance)} available.` : undefined}
              error={errorFor("ex-account")}
            >
              <Select
                id="ex-account"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                invalid={Boolean(errorFor("ex-account"))}
              >
                {open.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} — {money(row.balance)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Amount" htmlFor="ex-amount" required error={errorFor("ex-amount")}>
              <Input
                id="ex-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                invalid={Boolean(errorFor("ex-amount"))}
                placeholder="0.00"
              />
            </Field>

            <Field
              label="Date"
              htmlFor="ex-date"
              hint="When the money actually left, which may be before today."
              error={errorFor("ex-date")}
            >
              <Input
                id="ex-date"
                type="date"
                max={todayValue()}
                value={spentOn}
                onChange={(event) => setSpentOn(event.target.value)}
                invalid={Boolean(errorFor("ex-date"))}
              />
            </Field>

            <Field label="Note" htmlFor="ex-note" className="sm:col-span-2">
              <Textarea
                id="ex-note"
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="September shop rent, paid to the landlord"
              />
            </Field>

            <Field
              label="Receipt"
              htmlFor="ex-receipt"
              hint="Optional. An image or a PDF, up to 10 MB."
              className="sm:col-span-2"
            >
              <input
                id="ex-receipt"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif,application/pdf"
                onChange={(event) => setReceipt(event.target.files?.[0] ?? null)}
                className="block w-full text-body-sm file:mr-3 file:rounded-md file:border file:border-neutral-300 file:bg-surface file:px-3 file:py-1.5 file:text-body-sm file:font-medium hover:file:bg-neutral-100"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              <Receipt className="size-4" aria-hidden />
              Record expense
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
            )}
            {receipt && (
              <span className="inline-flex items-center gap-1.5 text-caption text-muted">
                <Paperclip className="size-3.5" aria-hidden />
                {receipt.name}
              </span>
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

/**
 * Void an expense.
 *
 * Nothing is deleted: the API posts a compensating movement that puts the
 * money back and marks the document VOID, so the cash book still reads as what
 * happened — it went out, then it came back. The reason is required, and it is
 * what the confirmation step asks for rather than a bare "are you sure".
 */
export function VoidExpenseButton({
  expenseId,
  expenseNumber,
  amount,
}: {
  expenseId: string;
  expenseNumber: string;
  amount: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setError("Say why this expense is being voided.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiClient(`/expenses/${expenseId}/void/`, {
        method: "POST",
        body: { reason },
      });
      setConfirming(false);
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        aria-label={`Void expense ${expenseNumber}`}
      >
        <Ban className="size-4" aria-hidden />
        Void
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Field
        label={`Why is ${expenseNumber} being voided?`}
        htmlFor={`void-${expenseId}`}
        required
        hint={`${money(amount)} goes back into the account it came from.`}
        error={error ?? undefined}
      >
        <Input
          id={`void-${expenseId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          invalid={Boolean(error)}
          placeholder="Filed twice"
          autoFocus
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy}>
          Void it
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          Keep it
        </Button>
      </div>
    </form>
  );
}
