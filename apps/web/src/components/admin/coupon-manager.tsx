"use client";

import { Pencil, Plus, Ticket, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { CouponForm, type CouponRow } from "@/components/admin/coupon-form";
import { Badge, Button, Card, EmptyState } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { dateOnly, money } from "@/lib/format";

/** What the coupon is worth, in the units it is actually expressed in. */
function discountLabel(row: CouponRow): string {
  if (row.discount_type === "FREE_SHIPPING") return "Free shipping";
  if (row.discount_type === "PERCENTAGE") {
    const cap = row.maximum_discount ? ` (max ${money(row.maximum_discount)})` : "";
    return `${Number(row.value)}% off${cap}`;
  }
  return `${money(row.value)} off`;
}

/**
 * The state a shopper would actually meet.
 *
 * A coupon is not simply on or off: it can be switched on but exhausted, or
 * scheduled, or expired. Showing only `is_active` would say "Active" about a
 * coupon that refuses every shopper, which is exactly the question this column
 * exists to answer.
 */
function usageState(row: CouponRow, now: Date): { label: string; tone: "success" | "warning" | "neutral" | "error" } {
  if (!row.is_active) return { label: "Inactive", tone: "neutral" };
  if (row.is_exhausted) return { label: "Used up", tone: "error" };
  if (row.starts_at && new Date(row.starts_at) > now) return { label: "Scheduled", tone: "warning" };
  if (row.ends_at && new Date(row.ends_at) < now) return { label: "Expired", tone: "neutral" };
  return { label: "Live", tone: "success" };
}

export function CouponManager({
  coupons,
  canManage,
}: {
  coupons: CouponRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CouponRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Computed once per render rather than per row, so every badge is judged
  // against the same instant.
  const now = new Date();

  async function remove(row: CouponRow) {
    const used = row.used_count > 0;
    const question = used
      ? `${row.code} has been used ${row.used_count} time(s), so it will be deactivated rather than deleted. Continue?`
      : `Delete ${row.code}?`;
    if (!window.confirm(question)) return;

    setBusy(true);
    setError(null);
    try {
      await apiClient(`/coupons/${row.id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not remove this coupon.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {canManage && (creating || editing) && (
        <CouponForm
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
          New coupon
        </Button>
      )}

      {error && (
        <p role="alert" className="text-body-sm text-[var(--error)]">
          {error}
        </p>
      )}

      <Card className="overflow-hidden">
        {coupons.length === 0 ? (
          <EmptyState
            title="No coupons yet"
            description="A coupon is validated and priced by the server — the code is all the shopper sends."
            action={
              canManage ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden />
                  New coupon
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Coupons</caption>
              <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Code
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Discount
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Minimum
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Window
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Used
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    State
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {coupons.map((row) => {
                  const state = usageState(row, now);
                  return (
                    <tr key={row.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2 font-medium">
                          <Ticket className="size-4 text-muted" aria-hidden />
                          {row.code}
                        </span>
                        {row.description && (
                          <span className="block text-caption text-muted">{row.description}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">{discountLabel(row)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {Number(row.minimum_order_value) > 0
                          ? money(row.minimum_order_value)
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-muted">
                        {row.starts_at || row.ends_at
                          ? `${dateOnly(row.starts_at) || "any time"} → ${dateOnly(row.ends_at) || "no end"}`
                          : "Always"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {row.used_count}
                        {row.usage_limit !== null && (
                          <span className="text-muted"> / {row.usage_limit}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        {canManage && (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setCreating(false);
                                setEditing(row);
                              }}
                              disabled={busy}
                            >
                              <Pencil className="size-4" aria-hidden />
                              <span className="sr-only">Edit {row.code}</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => remove(row)}
                              disabled={busy}
                            >
                              <Trash2 className="size-4" aria-hidden />
                              <span className="sr-only">
                                {row.used_count > 0 ? `Deactivate ${row.code}` : `Delete ${row.code}`}
                              </span>
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
