import Link from "next/link";

import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import type { AccountTransaction, AccountTransactionType } from "@/lib/api/types";
import { dateTime, money } from "@/lib/format";

/** Human labels for what caused a movement. */
const REFERENCE_LABEL: Record<string, string> = {
  payment: "Sale payment",
  refund: "Customer refund",
  supplier_payment: "Supplier payment",
  account_transfer: "Transfer",
  account: "Account opened",
  integrity_repair: "Reconciliation",
  stock_count: "Stock count",
};

/**
 * What caused this movement.
 *
 * Only `supplier_payment` gets a link: the reference on a sale payment is the
 * payment's own id rather than the order's, so a link built from it would
 * guess at a URL. A wrong link on a financial screen is worse than none.
 */
function Reference({ row }: { row: AccountTransaction }) {
  if (!row.reference_type || row.reference_type === "manual") {
    return <span className="text-muted">Manual entry</span>;
  }
  const label = REFERENCE_LABEL[row.reference_type] ?? row.reference_type.replace(/_/g, " ");
  if (row.reference_type === "supplier_payment") {
    return (
      <Link href="/admin/purchases" className="text-brand-600 hover:underline">
        {label}
      </Link>
    );
  }
  return <span className="text-muted">{label}</span>;
}

const TYPE_TONE: Partial<Record<AccountTransactionType, "success" | "warning" | "error" | "info" | "neutral">> = {
  OPENING: "info",
  SALE_PAYMENT: "success",
  REFUND: "warning",
  SUPPLIER_PAYMENT: "warning",
  EXPENSE: "warning",
  TRANSFER_IN: "neutral",
  TRANSFER_OUT: "neutral",
  DEPOSIT: "success",
  WITHDRAWAL: "warning",
  ADJUSTMENT: "error",
};

/**
 * The cash book: one row per movement, newest first.
 *
 * Signs are shown explicitly (+1,290 / −450) as well as coloured, because
 * colour alone must never carry meaning (WCAG 2.2, CLAUDE.md section 11).
 */
export function CashBook({
  rows,
  total,
  showAccount = false,
  emptyDescription = "Movements appear here as sales, refunds, purchases and transfers happen.",
}: {
  rows: AccountTransaction[];
  total?: number;
  showAccount?: boolean;
  emptyDescription?: string;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title="Nothing in the cash book yet" description={emptyDescription} />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-body-sm">
          <caption className="sr-only">Cash book, newest movement first</caption>
          <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">When</th>
              {showAccount && (
                <th scope="col" className="px-4 py-2.5 font-medium">Account</th>
              )}
              <th scope="col" className="px-4 py-2.5 font-medium">Entry</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Reference</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Reason</th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">Amount</th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">Balance after</th>
              <th scope="col" className="px-4 py-2.5 font-medium">By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const amount = Number(row.amount);
              const isIn = amount >= 0;
              return (
                <tr key={row.id} className="hover:bg-neutral-50">
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                    {dateTime(row.occurred_at)}
                  </td>
                  {showAccount && (
                    <td className="px-4 py-2.5">{row.account_name}</td>
                  )}
                  <td className="px-4 py-2.5">
                    <Badge tone={TYPE_TONE[row.transaction_type] ?? "neutral"}>
                      {row.type_display}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <Reference row={row} />
                  </td>
                  <td className="max-w-[24ch] truncate px-4 py-2.5 text-muted" title={row.reason || row.notes}>
                    {row.reason || row.notes || "—"}
                  </td>
                  <td
                    className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-medium ${
                      isIn ? "text-[var(--success)]" : "text-[var(--error)]"
                    }`}
                  >
                    {/* The sign is spelled out, never left to colour alone. */}
                    {isIn ? "+" : "−"}
                    {money(Math.abs(amount), false)}
                  </td>
                  <td className="tabular whitespace-nowrap px-4 py-2.5 text-right">
                    {money(row.balance_after)}
                  </td>
                  <td className="px-4 py-2.5 text-caption text-muted">
                    {row.created_by_email || "system"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total !== undefined && (
        <p className="border-t border-border px-4 py-2 text-caption text-muted">
          Showing {rows.length} of {total} movements.
        </p>
      )}
    </Card>
  );
}
