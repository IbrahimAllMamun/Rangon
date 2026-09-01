import { ArrowDownLeft, ArrowUpRight, Scale } from "lucide-react";
import Link from "next/link";

import { PartyLedgerTable } from "@/components/admin/party-ledger-table";
import { PageHeader } from "@/components/admin/shell";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, ErrorState } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";
import { money } from "@/lib/format";

export const metadata = { title: "Receivable & payable" };

export interface Ageing {
  current: string;
  d31_60: string;
  d61_90: string;
  over_90: string;
}

export interface PartyDocument {
  id: string;
  number: string;
  dated: string;
  due?: string;
  days: number;
  status: string;
  channel?: string;
  invoice_number?: string;
  total: string;
  paid: string;
  outstanding: string;
}

export interface Party {
  party_id: string;
  name: string;
  phone: string;
  outstanding: string;
  document_count: number;
  oldest_days: number;
  ageing: Ageing;
  documents: PartyDocument[];
}

export interface PartySide {
  total: string;
  party_count: number;
  document_count: number;
  ageing: Ageing;
  parties: Party[];
}

interface PartyLedger {
  receivable: PartySide;
  payable: PartySide;
  net_position: string;
}

export default async function PartyLedgerPage() {
  let ledger: PartyLedger | null = null;
  let error: string | null = null;
  try {
    ledger = await apiServer<PartyLedger>("/party-ledger/");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load the party ledger.";
  }

  const net = ledger ? Number.parseFloat(ledger.net_position) : 0;

  return (
    <>
      <PageHeader
        title="Receivable &amp; payable"
        description="Both sides are worked out from the orders and purchase orders themselves every time this page loads. Nothing here is a stored balance, so nothing can drift from the documents behind it."
      />

      {error || !ledger ? (
        <ErrorState title="Could not load the party ledger" description={error ?? undefined} />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Owed to the business"
              value={money(ledger.receivable.total)}
              context={`${ledger.receivable.party_count} customer${
                ledger.receivable.party_count === 1 ? "" : "s"
              } · ${ledger.receivable.document_count} order${
                ledger.receivable.document_count === 1 ? "" : "s"
              }`}
              icon={<ArrowDownLeft className="size-4" aria-hidden />}
            />
            <StatCard
              label="Owed by the business"
              value={money(ledger.payable.total)}
              context={`${ledger.payable.party_count} supplier${
                ledger.payable.party_count === 1 ? "" : "s"
              } · ${ledger.payable.document_count} purchase${
                ledger.payable.document_count === 1 ? "" : "s"
              }`}
              icon={<ArrowUpRight className="size-4" aria-hidden />}
            />
            <StatCard
              label="Net position"
              value={money(ledger.net_position)}
              context={net < 0 ? "The business owes more than it is owed" : "More is owed to the business"}
              icon={<Scale className="size-4" aria-hidden />}
              tone={net < 0 ? "warning" : "neutral"}
            />
          </div>

          <div className="space-y-6">
            <PartyLedgerTable
              title="Receivable — customers who owe money"
              side={ledger.receivable}
              emptyMessage="Every order is paid for. Nothing is outstanding."
              partyLabel="Customer"
              documentLabel="Order"
              ageingNote="Aged from the date the order was placed."
              documentHrefPrefix="/admin/orders"
            />

            <PartyLedgerTable
              title="Payable — suppliers waiting to be paid"
              side={ledger.payable}
              emptyMessage="Every purchase order is settled. Nothing is outstanding."
              partyLabel="Supplier"
              documentLabel="Purchase order"
              ageingNote="Aged from the due date, so a supplier on terms is not overdue until the terms run out."
              documentHrefPrefix="/admin/purchases"
            />
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>How these figures are reached</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-body-sm text-neutral-700">
                <li>
                  <strong>Receivable</strong> is every order charged more than it has been paid.
                  Unconfirmed baskets, cancelled orders and refunded orders are not debts and do not
                  appear.
                </li>
                <li>
                  <strong>Payable</strong> is every purchase order received but not fully paid. A
                  draft purchase order is not a liability — nothing has been committed to the
                  supplier yet.
                </li>
                <li>
                  <strong>Ageing</strong> runs from the order date for customers and from the{" "}
                  <em>due</em> date for suppliers, using each supplier&apos;s payment terms. Record a
                  supplier payment from the{" "}
                  <Link href="/admin/purchases" className="text-brand-600 hover:underline">
                    purchase order
                  </Link>
                  .
                </li>
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
