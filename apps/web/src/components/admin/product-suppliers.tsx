"use client";

import { Star } from "lucide-react";
import { useState } from "react";

import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { dateOnly, money } from "@/lib/format";

export interface SupplierOfferRow {
  id: string;
  supplier: string;
  supplier_name: string;
  supplier_status: string;
  variant: string;
  sku: string;
  variant_label: string;
  supplier_sku: string;
  last_cost: string;
  effective_lead_time_days: number;
  minimum_order_quantity: number;
  is_preferred: boolean;
  is_active: boolean;
  last_purchased_at: string | null;
}

/**
 * Who supplies this product, and at whose price.
 *
 * Until `SupplierProduct` existed nothing joined a supplier to a variant, so
 * this screen could not answer the two questions a buyer actually asks before
 * reordering: who sells us this, and what did each of them last charge.
 *
 * Read-only apart from promoting a supplier. Rows appear by themselves when a
 * delivery is received, so there is no "add" here — a price with no purchase
 * behind it belongs on the purchase order form, where the quote is being taken.
 */
export function ProductSuppliers({
  offers: initial,
  canManage,
}: {
  offers: SupplierOfferRow[];
  canManage: boolean;
}) {
  const [offers, setOffers] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function promote(offer: SupplierOfferRow) {
    setBusy(offer.id);
    setError(null);
    try {
      await apiClient(`/supplier-products/${offer.id}/set-preferred/`, {
        method: "POST",
        body: {},
      });
      // Exactly one row may be preferred, so demote the rest here too rather
      // than re-fetching: the server has already done the same thing.
      setOffers((current) =>
        current.map((row) =>
          row.variant === offer.variant ? { ...row, is_preferred: row.id === offer.id } : row,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not change the preferred supplier.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Suppliers</CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <p role="alert" className="mb-3 text-body-sm text-[var(--error)]">
            {error}
          </p>
        )}

        {offers.length === 0 ? (
          <EmptyState
            title="No supplier recorded yet"
            description="Receiving a purchase order records who supplied each variant and what they charged, so this fills itself in."
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-body-sm">
                <caption className="sr-only">
                  Suppliers of this product, with the price each last charged
                </caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium">Variant</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Supplier</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Their code</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Last cost</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Lead time</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Last bought</th>
                    <th scope="col" className="px-3 py-2.5">
                      <span className="sr-only">Preferred</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {offers.map((offer) => (
                    <tr key={offer.id} className={offer.is_active ? undefined : "opacity-60"}>
                      <td className="px-3 py-2">
                        <span className="font-mono block text-caption">{offer.sku}</span>
                        {offer.variant_label && (
                          <span className="block text-caption text-muted">
                            {offer.variant_label}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="block font-medium">{offer.supplier_name}</span>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {offer.is_preferred && (
                            <Badge tone="brand">
                              <Star className="size-3" aria-hidden /> Preferred
                            </Badge>
                          )}
                          {!offer.is_active && <Badge tone="neutral">Discontinued</Badge>}
                          {offer.supplier_status === "INACTIVE" && (
                            <Badge tone="warning">Supplier inactive</Badge>
                          )}
                        </div>
                      </td>
                      <td className="font-mono px-3 py-2 text-caption text-muted">
                        {offer.supplier_sku || "—"}
                      </td>
                      <td className="tabular px-3 py-2 text-right">{money(offer.last_cost)}</td>
                      <td className="tabular px-3 py-2 text-right text-muted">
                        {offer.effective_lead_time_days} d
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {offer.last_purchased_at ? dateOnly(offer.last_purchased_at) : "Quoted only"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canManage && !offer.is_preferred && offer.is_active && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => promote(offer)}
                            loading={busy === offer.id}
                          >
                            Prefer
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-caption text-muted">
              Last cost is what that supplier charged on their most recent delivery — not the
              stock&rsquo;s value, which is the weighted average of everything on the shelf. The
              preferred supplier is the one a new purchase order suggests.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
