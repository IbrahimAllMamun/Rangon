"use client";

import { Pencil, Plus } from "lucide-react";
import { useState } from "react";

import { SupplierForm, type SupplierRow } from "@/components/admin/supplier-form";
import { Badge, Button, Card, EmptyState } from "@/components/ui/primitives";
import { dateOnly } from "@/lib/format";

/**
 * Supplier list with an inline create/edit panel.
 *
 * A separate `/suppliers/new` route would be more consistent with products, but
 * a supplier is eight fields and the list is the place you realise one is
 * missing — usually while raising a purchase order. Editing in place keeps that
 * realisation one click from the fix.
 */
export function SupplierManager({
  suppliers,
  canManage,
}: {
  suppliers: SupplierRow[];
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SupplierRow | null>(null);

  return (
    <div className="space-y-6">
      {canManage && (creating || editing) && (
        <SupplierForm
          editing={editing ?? undefined}
          onDone={() => {
            setCreating(false);
            setEditing(null);
          }}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {canManage && !creating && !editing && (
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden />
          New supplier
        </Button>
      )}

      <Card className="overflow-hidden">
        {suppliers.length === 0 ? (
          <EmptyState
            title="No suppliers yet"
            description="A purchase order has to name a supplier, so add the first one here."
            action={
              canManage ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden />
                  New supplier
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Suppliers</caption>
              <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Supplier</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Contact</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Terms</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Lead time</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Open orders</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Added</th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {suppliers.map((supplier) => (
                  <tr key={supplier.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-2.5">
                      <span className="block font-medium">{supplier.name}</span>
                      <span className="font-mono text-caption text-muted">{supplier.code}</span>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {supplier.contact_person && <span className="block">{supplier.contact_person}</span>}
                      {supplier.phone || supplier.email || "—"}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {supplier.payment_terms_days === 0
                        ? "On delivery"
                        : `${supplier.payment_terms_days} days`}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{supplier.lead_time_days} days</td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {supplier.outstanding_orders ?? 0}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={supplier.status === "ACTIVE" ? "success" : "neutral"}>
                        {supplier.status === "ACTIVE" ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{dateOnly(supplier.created_at)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(supplier);
                            setCreating(false);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          <Pencil className="size-4" aria-hidden />
                          Edit
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
