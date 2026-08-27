"use client";

import { Ban, Check, PackageCheck, ThumbsUp, Undo2, X } from "lucide-react";
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
import type { Account, RestockDecision, ReturnItem, ReturnRequest } from "@/lib/api/types";
import { money } from "@/lib/format";

type FieldError = { field: string; message: string };

/**
 * What happens to each returned line. Only `RESTOCK` puts goods back into
 * sellable stock — the other two are recorded on the line and never increase
 * availability (docs/business-rules.md §2.3).
 */
const DECISIONS: { value: RestockDecision; label: string; hint: string }[] = [
  { value: "RESTOCK", label: "Back on the shelf", hint: "Sellable again." },
  { value: "DAMAGED", label: "Damaged", hint: "Written off. Never re-enters stock." },
  {
    value: "QUARANTINE",
    label: "Quarantine",
    hint: "Held for inspection. Not sellable and not written off.",
  },
];

function apiError(caught: unknown, field: string): FieldError[] {
  if (caught instanceof ApiError) {
    const fieldErrors = caught.fieldErrors();
    return fieldErrors.length ? fieldErrors : [{ field, message: caught.message }];
  }
  return [{ field, message: "That did not work. Please try again." }];
}

/**
 * Drive a return through its states.
 *
 * The stages are deliberately separate screens-within-a-screen rather than one
 * form: approving is a judgement about whether the return is allowed, the
 * per-line decision cannot honestly be made until the goods are physically in
 * hand, and the refund is money leaving. Collapsing them would invite someone
 * to declare an item damaged before seeing it.
 */
export function ReturnActions({
  request,
  accounts,
  canAct,
}: {
  request: ReturnRequest;
  accounts: Account[];
  canAct: boolean;
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [decisions, setDecisions] = useState<Record<string, RestockDecision>>(
    Object.fromEntries(request.items.map((item) => [item.id, item.restock_decision])),
  );
  const [notes, setNotes] = useState<Record<string, string>>(
    Object.fromEntries(request.items.map((item) => [item.id, item.condition_note])),
  );
  const [amount, setAmount] = useState(request.refund_amount);
  const [account, setAccount] = useState(
    accounts.find((row) => row.is_default && row.kind === "CASH")?.id ?? accounts[0]?.id ?? "",
  );

  async function act(path: string, body: Record<string, unknown>, field: string) {
    setBusy(true);
    setErrors([]);
    try {
      await apiClient(`/returns/${request.id}/${path}/`, { method: "POST", body });
      router.refresh();
    } catch (caught) {
      setErrors(apiError(caught, field));
    } finally {
      setBusy(false);
    }
  }

  if (!canAct) {
    return (
      <Card>
        <CardContent>
          <p className="p-4 text-body-sm text-muted">
            Approving, receiving and refunding a return need the{" "}
            <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-caption">
              sales.refund
            </code>{" "}
            permission. The API refuses these regardless of what this screen shows.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (request.status === "COMPLETED" || request.status === "REJECTED") {
    return (
      <Card>
        <CardContent>
          <p className="p-4 text-body-sm text-muted">
            {request.status === "COMPLETED"
              ? `Closed. ${money(request.refund_amount)} was refunded and the stock decisions are in the ledger.`
              : "Rejected. Nothing was restocked and no money moved."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const chosenAccount = accounts.find((row) => row.id === account);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {request.status === "REQUESTED"
            ? "Approve or reject"
            : request.status === "APPROVED"
              ? "Receive the goods"
              : "Issue the refund"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <ErrorSummary errors={errors} title="Could not do that" />

          {request.status === "REQUESTED" && (
            <>
              <Field
                label="Comment"
                htmlFor="rt-comment"
                hint="Recorded on the return either way. Required in practice when rejecting — say why."
              >
                <Textarea
                  id="rt-comment"
                  rows={2}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Within the 14-day window, tags intact"
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  loading={busy}
                  onClick={() => act("approve", { comment }, "rt-comment")}
                >
                  <ThumbsUp className="size-4" aria-hidden />
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (!comment.trim()) {
                      setErrors([
                        { field: "rt-comment", message: "Say why this return is being rejected." },
                      ]);
                      return;
                    }
                    act("reject", { comment }, "rt-comment");
                  }}
                >
                  <Ban className="size-4" aria-hidden />
                  Reject
                </Button>
              </div>
            </>
          )}

          {request.status === "APPROVED" && (
            <>
              <p className="text-body-sm text-muted">
                Decide each line now that the goods are in hand. Only{" "}
                <strong>back on the shelf</strong> returns stock to sellable.
              </p>
              <div className="space-y-3">
                {request.items.map((item: ReturnItem) => (
                  <div key={item.id} className="rounded-md border border-border p-3">
                    <p className="text-body-sm font-medium">
                      {item.product_name}{" "}
                      <span className="text-muted">
                        ×{item.quantity} · <span className="font-mono">{item.sku}</span>
                      </span>
                    </p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Condition"
                        htmlFor={`rt-decision-${item.id}`}
                        hint={DECISIONS.find((d) => d.value === decisions[item.id])?.hint}
                      >
                        <Select
                          id={`rt-decision-${item.id}`}
                          value={decisions[item.id]}
                          onChange={(event) =>
                            setDecisions((current) => ({
                              ...current,
                              [item.id]: event.target.value as RestockDecision,
                            }))
                          }
                        >
                          {DECISIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Note" htmlFor={`rt-note-${item.id}`}>
                        <Input
                          id={`rt-note-${item.id}`}
                          value={notes[item.id] ?? ""}
                          onChange={(event) =>
                            setNotes((current) => ({ ...current, [item.id]: event.target.value }))
                          }
                          placeholder="Seam split on arrival"
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                loading={busy}
                onClick={() =>
                  act(
                    "receive",
                    {
                      items: request.items.map((item) => ({
                        id: item.id,
                        restock_decision: decisions[item.id],
                        condition_note: notes[item.id] ?? "",
                      })),
                    },
                    "rt-receive",
                  )
                }
              >
                <PackageCheck className="size-4" aria-hidden />
                Receive goods
              </Button>
            </>
          )}

          {request.status === "RECEIVED" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Refund amount"
                  htmlFor="rt-amount"
                  required
                  hint={`Requested: ${money(request.refund_amount)}. Never more than was captured.`}
                  error={errorFor("rt-amount") ?? errorFor("refund_amount")}
                >
                  <Input
                    id="rt-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    invalid={Boolean(errorFor("rt-amount") ?? errorFor("refund_amount"))}
                  />
                </Field>
                <Field
                  label="Refund from"
                  htmlFor="rt-account"
                  hint={
                    chosenAccount
                      ? `${money(chosenAccount.balance)} available.`
                      : "No account: the refund still completes and is reported by verify_accounts."
                  }
                  error={errorFor("account")}
                >
                  <Select
                    id="rt-account"
                    value={account}
                    onChange={(event) => setAccount(event.target.value)}
                  >
                    <option value="">Default for the method</option>
                    {accounts
                      .filter((row) => row.is_active)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name} — {money(row.balance)}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
              <Button
                type="button"
                loading={busy}
                onClick={() => {
                  if (!amount || Number(amount) <= 0) {
                    setErrors([
                      { field: "rt-amount", message: "Enter an amount greater than zero." },
                    ]);
                    return;
                  }
                  act(
                    "complete",
                    { refund_amount: amount, ...(account ? { account } : {}) },
                    "rt-amount",
                  );
                }}
              >
                <Undo2 className="size-4" aria-hidden />
                Refund {money(amount || "0")}
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The stage stamps, so the sequence and who did what is legible at a glance. */
export function ReturnProgress({ request }: { request: ReturnRequest }) {
  const stages = [
    { label: "Requested", at: request.created_at },
    { label: "Approved", at: request.approved_at },
    { label: "Received", at: request.received_at },
    { label: "Refunded", at: request.completed_at },
  ];
  const rejected = request.status === "REJECTED";

  return (
    <ol className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-body-sm">
      {stages.map((stage) => (
        <li key={stage.label} className="flex items-center gap-1.5">
          {stage.at ? (
            <Check className="size-4 text-[var(--success)]" aria-hidden />
          ) : rejected ? (
            <X className="size-4 text-muted" aria-hidden />
          ) : (
            <span
              className="inline-block size-4 rounded-full border border-neutral-300"
              aria-hidden
            />
          )}
          <span className={stage.at ? "font-medium" : "text-muted"}>{stage.label}</span>
        </li>
      ))}
    </ol>
  );
}
