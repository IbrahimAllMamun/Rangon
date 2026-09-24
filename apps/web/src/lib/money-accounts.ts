import type { Account, AccountKind, Payment } from "@/lib/api/types";

/**
 * Which kind of account each method's money moves through.
 *
 * Mirrors `finance.models.METHOD_TO_KIND`. Since D95 the server refuses a named
 * account of any other kind, or of another branch; these helpers only keep the
 * screens from offering one. Cash into a drawer, card settlements into a bank,
 * bKash into the wallet — a cheque paid out of the drawer, or card takings
 * dropped into it, leave the drawer impossible to count.
 */
export const METHOD_KIND: Record<string, AccountKind> = {
  CASH: "CASH",
  COD: "CASH",
  CARD: "BANK",
  BANK: "BANK",
  ONLINE_GATEWAY: "BANK",
  CHEQUE: "BANK",
  MOBILE_MFS: "MFS",
  STORE_CREDIT: "OTHER",
  OTHER: "OTHER",
};

/**
 * The accounts this money may name: open, of the method's kind and, when the
 * money belongs to a branch, that branch's own. An owner's account list spans
 * every branch, so without the branch the choice offered other shops' drawers.
 */
export function accountsFor(accounts: Account[], method: string, branch?: string): Account[] {
  const kind = METHOD_KIND[method];
  return accounts.filter(
    (row) => row.is_active && row.kind === kind && (branch === undefined || row.branch === branch),
  );
}

/**
 * How a refund can go back. No store credit: nothing would record the credit,
 * so offering it would promise the customer something the system forgets.
 */
export const REFUND_METHODS: { value: string; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Back to the card" },
  { value: "MOBILE_MFS", label: "bKash / Nagad" },
  { value: "BANK", label: "Bank transfer" },
  { value: "ONLINE_GATEWAY", label: "Through the online gateway" },
];

const CAPTURED = new Set(["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"]);

/** The payment a refund goes back through: the largest captured one, as `refund_order` picks it. */
export function sourcePayment(payments: Payment[] | undefined): Payment | undefined {
  return [...(payments ?? [])]
    .filter((row) => CAPTURED.has(row.status))
    .sort((a, b) => Number(b.amount) - Number(a.amount))[0];
}

/**
 * The method a refund starts out as: the way the money came in
 * (business-rules.md §2.4). Cash on delivery refunds in cash — the courier's
 * cash is in the drawer by now — and a method no refund can use falls back to
 * cash rather than to a choice the list does not offer.
 */
export function defaultRefundMethod(payments: Payment[] | undefined): string {
  const method = sourcePayment(payments)?.method ?? "CASH";
  if (method === "COD") return "CASH";
  return REFUND_METHODS.some((row) => row.value === method) ? method : "CASH";
}

/**
 * Which of `candidates` to start a refund on: the account the payment came
 * into when it is one of them — the refund going back the way it came —
 * otherwise the branch's default for the kind, as `resolve_account` picks.
 */
export function suggestedAccount(candidates: Account[], cameInto?: string | null): string {
  return (
    candidates.find((row) => row.id === cameInto) ??
    candidates.find((row) => row.is_default) ??
    candidates[0]
  )?.id ?? "";
}
