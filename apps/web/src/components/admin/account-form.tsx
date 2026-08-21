"use client";

import { Check, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { Account, AccountKind } from "@/lib/api/types";

const KINDS: { value: AccountKind; label: string; hint: string }[] = [
  { value: "CASH", label: "Cash drawer", hint: "Notes and coins at the counter." },
  { value: "BANK", label: "Bank account", hint: "Card settlements and transfers land here." },
  { value: "MFS", label: "Mobile financial service", hint: "bKash, Nagad, Rocket." },
  { value: "OTHER", label: "Other", hint: "Anything that is none of the above." },
];

interface Draft {
  name: string;
  kind: AccountKind;
  account_number: string;
  bank_name: string;
  opening_balance: string;
  is_default: boolean;
  allow_overdraft: boolean;
  is_active: boolean;
  notes: string;
}

function blank(): Draft {
  return {
    name: "",
    kind: "CASH",
    account_number: "",
    bank_name: "",
    opening_balance: "",
    is_default: true,
    allow_overdraft: false,
    is_active: true,
    notes: "",
  };
}

function fromRow(row: Account): Draft {
  return {
    name: row.name,
    kind: row.kind,
    account_number: row.account_number,
    bank_name: row.bank_name,
    opening_balance: "",
    is_default: row.is_default,
    allow_overdraft: row.allow_overdraft,
    is_active: row.is_active,
    notes: row.notes,
  };
}

/**
 * Open or edit an account.
 *
 * The opening balance is write-once and only on create, because it is not a
 * column — the API posts it as an `OPENING` row in the cash book. Editing it
 * later would mean rewriting history, so the field simply disappears when
 * editing and the balance moves through a deposit or an adjustment instead.
 */
export function AccountForm({
  editing,
  branchId,
  onDone,
  onCancel,
}: {
  editing?: Account;
  branchId: string;
  onDone?: (account: Account) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(editing ? fromRow(editing) : blank());
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: { field: string; message: string }[] = [];
    if (!draft.name.trim()) {
      found.push({ field: "acct-name", message: "An account needs a name." });
    }
    if (draft.opening_balance && Number.isNaN(Number(draft.opening_balance))) {
      found.push({ field: "acct-opening", message: "The opening balance must be a number." });
    }
    if (
      !editing &&
      Number(draft.opening_balance || 0) < 0 &&
      !draft.allow_overdraft
    ) {
      found.push({
        field: "acct-opening",
        message: "An opening balance cannot be negative unless the account allows overdraft.",
      });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const account = editing
        ? await apiClient<Account>(`/accounts/${editing.id}/`, {
            method: "PATCH",
            body: {
              name: draft.name.trim(),
              kind: draft.kind,
              account_number: draft.account_number,
              bank_name: draft.bank_name,
              is_default: draft.is_default,
              allow_overdraft: draft.allow_overdraft,
              is_active: draft.is_active,
              notes: draft.notes,
            },
          })
        : await apiClient<Account>("/accounts/", {
            method: "POST",
            body: {
              branch: branchId,
              name: draft.name.trim(),
              kind: draft.kind,
              account_number: draft.account_number,
              bank_name: draft.bank_name,
              opening_balance: draft.opening_balance || "0.00",
              is_default: draft.is_default,
              allow_overdraft: draft.allow_overdraft,
              notes: draft.notes,
            },
          });

      setSaved(true);
      if (!editing) setDraft(blank());
      onDone?.(account);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "acct-name", message: caught.message }],
        );
      } else {
        setErrors([{ field: "acct-name", message: "Could not save. Please try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const needsBankFields = draft.kind === "BANK" || draft.kind === "MFS";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.name}` : "Open an account"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save this account" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Account name" htmlFor="acct-name" required error={errorFor("acct-name")}>
              <Input
                id="acct-name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                invalid={Boolean(errorFor("acct-name"))}
                placeholder="Counter Cash Drawer"
                autoComplete="off"
              />
            </Field>

            <Field label="Kind" htmlFor="acct-kind" hint={KINDS.find((k) => k.value === draft.kind)?.hint}>
              <Select
                id="acct-kind"
                value={draft.kind}
                onChange={(event) => set("kind", event.target.value as AccountKind)}
              >
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </Select>
            </Field>

            {needsBankFields && (
              <>
                <Field label="Bank or provider" htmlFor="acct-bank">
                  <Input
                    id="acct-bank"
                    value={draft.bank_name}
                    onChange={(event) => set("bank_name", event.target.value)}
                    placeholder={draft.kind === "MFS" ? "bKash" : "City Bank PLC"}
                  />
                </Field>
                <Field
                  label={draft.kind === "MFS" ? "Wallet number" : "Account number"}
                  htmlFor="acct-number"
                >
                  <Input
                    id="acct-number"
                    value={draft.account_number}
                    onChange={(event) => set("account_number", event.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </>
            )}

            {!editing && (
              <Field
                label="Opening balance"
                htmlFor="acct-opening"
                hint="What this account holds today. Recorded as an opening entry in the cash book, not as a figure that can be edited later."
                error={errorFor("acct-opening")}
              >
                <Input
                  id="acct-opening"
                  type="text"
                  inputMode="decimal"
                  value={draft.opening_balance}
                  onChange={(event) => set("opening_balance", event.target.value)}
                  invalid={Boolean(errorFor("acct-opening"))}
                  placeholder="0.00"
                />
              </Field>
            )}
          </div>

          <Field label="Notes" htmlFor="acct-notes">
            <Textarea
              id="acct-notes"
              rows={2}
              value={draft.notes}
              onChange={(event) => set("notes", event.target.value)}
            />
          </Field>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-body-sm font-medium">Behaviour</legend>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={draft.is_default}
                onChange={(event) => set("is_default", event.target.checked)}
              />
              Money of this kind lands here by default
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={draft.allow_overdraft}
                onChange={(event) => set("allow_overdraft", event.target.checked)}
              />
              Allow the balance to go negative (an overdraft line)
            </label>
            {editing && (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={draft.is_active}
                  onChange={(event) => set("is_active", event.target.checked)}
                />
                Open — money may move through it
              </label>
            )}
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              {editing ? (
                "Save changes"
              ) : (
                <>
                  <Plus className="size-4" aria-hidden />
                  Open account
                </>
              )}
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
                <Check className="size-4" aria-hidden /> Saved
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
