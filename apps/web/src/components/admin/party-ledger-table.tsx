"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { Party, PartySide } from "@/app/(admin)/admin/finance/parties/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { dateOnly, humanise, money } from "@/lib/format";

const AGEING_COLUMNS = [
  { key: "current", label: "Current" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "over_90", label: "90+ days" },
] as const;

/**
 * One side of the party ledger: a row per party, expandable to the documents
 * behind the balance.
 *
 * The documents matter more here than in most tables — a balance nobody can
 * trace back to an order number is a number the owner has to take on trust, and
 * this whole feature exists because the balance is *derived* rather than
 * stored. Expanding is how you check it.
 */
export function PartyLedgerTable({
  title,
  side,
  emptyMessage,
  partyLabel,
  documentLabel,
  ageingNote,
  documentHrefPrefix,
}: {
  title: string;
  side: PartySide;
  emptyMessage: string;
  partyLabel: string;
  documentLabel: string;
  ageingNote: string;
  /** Admin route each document links to; the id is appended.
   *
   *  A string rather than a `(document) => string` callback: this is a client
   *  component and the page rendering it is a server component, and React
   *  refuses to serialise a function across that boundary. */
  documentHrefPrefix: string;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        <span className="tabular text-body font-semibold">{money(side.total)}</span>
      </CardHeader>
      <CardContent className="p-0">
        {side.parties.length === 0 ? (
          <p className="p-6 text-body-sm text-muted">{emptyMessage}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm">
                <caption className="sr-only">
                  {title}. {ageingNote}
                </caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      {partyLabel}
                    </th>
                    {AGEING_COLUMNS.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className="px-4 py-2.5 text-right font-medium"
                      >
                        {column.label}
                      </th>
                    ))}
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">
                      Outstanding
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {side.parties.map((party) => (
                    <PartyRows
                      key={party.party_id || party.name}
                      party={party}
                      documentLabel={documentLabel}
                      documentHrefPrefix={documentHrefPrefix}
                      expanded={open === party.party_id}
                      onToggle={() =>
                        setOpen(open === party.party_id ? null : party.party_id)
                      }
                    />
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-neutral-300 bg-neutral-50">
                  <tr>
                    <th scope="row" className="px-4 py-2.5 text-left font-semibold">
                      Total
                    </th>
                    {AGEING_COLUMNS.map((column) => (
                      <td
                        key={column.key}
                        className="tabular px-4 py-2.5 text-right font-semibold"
                      >
                        {money(side.ageing[column.key])}
                      </td>
                    ))}
                    <td className="tabular px-4 py-2.5 text-right font-bold">
                      {money(side.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="border-t border-border px-4 py-2.5 text-caption text-muted">
              {ageingNote}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PartyRows({
  party,
  documentLabel,
  documentHrefPrefix,
  expanded,
  onToggle,
}: {
  party: Party;
  documentLabel: string;
  documentHrefPrefix: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const panelId = `party-${party.party_id || party.name}`;

  return (
    <>
      <tr className={expanded ? "bg-neutral-50" : undefined}>
        <th scope="row" className="px-4 py-2.5 text-left font-normal">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={panelId}
            className="flex items-center gap-1.5 rounded text-left font-medium hover:text-brand-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]"
          >
            <ChevronRight
              className={`size-4 shrink-0 text-neutral-400 transition-transform duration-fast ${
                expanded ? "rotate-90" : ""
              }`}
              aria-hidden
            />
            <span>
              {party.name}
              <span className="block pl-0 text-caption font-normal text-muted">
                {party.phone ? `${party.phone} · ` : ""}
                {party.document_count}{" "}
                {party.document_count === 1
                  ? documentLabel.toLowerCase()
                  : `${documentLabel.toLowerCase()}s`}
                {party.oldest_days > 0 ? ` · oldest ${party.oldest_days}d` : ""}
              </span>
            </span>
          </button>
        </th>
        {AGEING_COLUMNS.map((column) => (
          <td key={column.key} className="tabular px-4 py-2.5 text-right text-muted">
            {Number.parseFloat(party.ageing[column.key]) === 0
              ? "—"
              : money(party.ageing[column.key])}
          </td>
        ))}
        <td className="tabular px-4 py-2.5 text-right font-semibold">
          {money(party.outstanding)}
        </td>
      </tr>

      {expanded && (
        <tr id={panelId}>
          <td colSpan={AGEING_COLUMNS.length + 2} className="bg-neutral-50 px-4 pb-4 pt-0">
            <table className="w-full text-caption">
              <caption className="sr-only">
                {documentLabel}s making up {party.name}&apos;s balance
              </caption>
              <thead className="text-left uppercase text-muted">
                <tr>
                  <th scope="col" className="py-2 font-medium">
                    {documentLabel}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Dated
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Total
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Paid
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Outstanding
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {party.documents.map((document) => (
                  <tr key={document.id}>
                    <td className="py-2">
                      <Link
                        href={`${documentHrefPrefix}/${document.id}`}
                        className="font-medium text-brand-600 hover:underline"
                      >
                        {document.number}
                      </Link>
                    </td>
                    <td className="py-2 text-muted">
                      {dateOnly(document.dated)}
                      {document.due && (
                        <span className="block">due {dateOnly(document.due)}</span>
                      )}
                    </td>
                    <td className="py-2 text-muted">{humanise(document.status)}</td>
                    <td className="tabular py-2 text-right">{money(document.total)}</td>
                    <td className="tabular py-2 text-right text-muted">
                      {money(document.paid)}
                    </td>
                    <td className="tabular py-2 text-right font-medium">
                      {money(document.outstanding)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
