"use client";

/**
 * The call-back list.
 *
 * Shoppers who typed a phone number into checkout and did not finish. For a
 * cash-on-delivery shop the recovery action is a phone call, so this screen is
 * built to be worked down a row at a time by someone holding a handset: the
 * number is the most prominent thing on the row and is a `tel:` link, the
 * basket value is next to it so the caller knows what is at stake, and the
 * note is where "no answer, try after six" goes.
 *
 * Nothing here can declare a lead recovered. That is a fact about an order
 * arriving, decided server-side when one does — the recovery rate is the only
 * number this list is judged by, and a button that fakes it would make the
 * number worthless.
 */

import { CheckCircle2, Phone, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { dateTime, money } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

export interface AbandonedCheckoutRow {
  id: string;
  phone: string;
  name: string;
  email: string;
  status: "OPEN" | "RECOVERED" | "LOST";
  cart_total: string;
  item_count: number;
  branch_code: string;
  last_seen_at: string;
  recovered_at: string | null;
  recovered_order_number: string;
  note: string;
}

const STATUS_TONE = {
  OPEN: "warning",
  RECOVERED: "success",
  LOST: "neutral",
} as const;

export function AbandonedCheckouts({
  leads,
  canManage,
}: {
  leads: AbandonedCheckoutRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function saveNote(lead: AbandonedCheckoutRow) {
    const note = drafts[lead.id] ?? lead.note;
    setBusy(lead.id);
    setNotice(null);
    try {
      await apiClient(`/abandoned-checkouts/${lead.id}/`, {
        method: "PATCH",
        body: { note },
      });
      router.refresh();
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : "Could not save that note.");
    } finally {
      setBusy(null);
    }
  }

  async function writeOff(lead: AbandonedCheckoutRow) {
    if (!window.confirm(`Write off ${formatPhone(lead.phone)}? It leaves the call list.`)) return;
    setBusy(lead.id);
    setNotice(null);
    try {
      await apiClient(`/abandoned-checkouts/${lead.id}/lost/`, {
        method: "POST",
        body: { note: drafts[lead.id] ?? lead.note },
      });
      router.refresh();
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : "Could not write that lead off.");
    } finally {
      setBusy(null);
    }
  }

  if (leads.length === 0) {
    return (
      <Card>
        <div className="px-4 py-10 text-center">
          <p className="text-body-sm font-medium">Nobody to call back</p>
          <p className="mt-1 text-caption text-muted">
            A lead appears here when someone types their number at checkout and does not finish.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div
          role="alert"
          className="rounded-md border border-[var(--error)] bg-[var(--error-soft,#FEF2F2)] px-4 py-3 text-body-sm text-[var(--error)]"
        >
          {notice}
        </div>
      )}

      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {leads.map((lead) => (
            <li key={lead.id} className="px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* The number is the action. `tel:` so a tablet at the
                        counter dials it rather than making someone retype. */}
                    <a
                      href={`tel:+${lead.phone}`}
                      className="text-body font-semibold text-brand-600 hover:underline"
                    >
                      {formatPhone(lead.phone)}
                    </a>
                    <Badge tone={STATUS_TONE[lead.status] ?? "neutral"}>
                      {lead.status === "OPEN"
                        ? "To call"
                        : lead.status === "RECOVERED"
                          ? "Bought"
                          : "Written off"}
                    </Badge>
                    {lead.branch_code && (
                      <span className="text-caption text-muted">{lead.branch_code}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-body-sm">
                    {lead.name || <span className="text-muted">No name given</span>}
                    {lead.email && <span className="ml-2 text-caption text-muted">{lead.email}</span>}
                  </p>
                  <p className="mt-0.5 text-caption text-muted">
                    Last seen {dateTime(lead.last_seen_at)}
                    {lead.status === "RECOVERED" && lead.recovered_order_number && (
                      <> · became {lead.recovered_order_number}</>
                    )}
                  </p>
                </div>

                <div className="text-right">
                  <p className="tabular text-body font-semibold">{money(lead.cart_total)}</p>
                  <p className="text-caption text-muted">
                    {lead.item_count} item{lead.item_count === 1 ? "" : "s"} in the basket
                  </p>
                </div>
              </div>

              {canManage && lead.status === "OPEN" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`Note for ${formatPhone(lead.phone)}`}
                    placeholder="No answer, try after 6…"
                    className="max-w-md"
                    value={drafts[lead.id] ?? lead.note}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [lead.id]: event.target.value }))
                    }
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === lead.id}
                    onClick={() => saveNote(lead)}
                  >
                    <CheckCircle2 className="size-4" aria-hidden /> Save note
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === lead.id}
                    onClick={() => writeOff(lead)}
                  >
                    <X className="size-4" aria-hidden /> Write off
                  </Button>
                </div>
              )}

              {lead.status !== "OPEN" && lead.note && (
                <p className="mt-2 text-caption text-muted">{lead.note}</p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <p className="flex items-start gap-2 text-caption text-muted">
        <Phone className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          A lead marks itself <strong>Bought</strong> when an order arrives from that number — from
          the storefront or the counter. Nothing on this screen can do it by hand, so the recovery
          figure stays worth reading.
        </span>
      </p>
    </div>
  );
}
