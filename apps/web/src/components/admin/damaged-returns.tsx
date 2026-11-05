"use client";

import { Truck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, EmptyState, Select } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { DamagedReturn } from "@/lib/api/types";
import { dateTime, money } from "@/lib/format";
import { refreshAfterWrite } from "@/lib/navigation/refresh-after-write";

/**
 * Pick, for each damaged item, the purchase order it goes back on (the newest
 * that can take it is chosen for you), then send each order's items back in
 * one supplier return: credit on that order, no stock moved.
 */
export function DamagedReturnsList({ rows }: { rows: DamagedReturn[] }) {
  const router = useRouter();
  const [line, setLine] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.id, row.purchase_lines[0]?.id ?? ""])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!rows.length) {
    return (
      <EmptyState
        title="Nothing waiting"
        description="Damaged goods from returns appear here until they go back to the supplier."
      />
    );
  }

  // The items going back on each purchase order, as currently chosen.
  const groups = new Map<
    string,
    { number: string; supplier: string; items: { row: DamagedReturn; lineId: string; cost: string }[] }
  >();
  for (const row of rows) {
    const chosen = row.purchase_lines.find((option) => option.id === line[row.id]);
    if (!chosen) continue;
    const group = groups.get(chosen.purchase_order.id) ?? {
      number: chosen.purchase_order.number,
      supplier: chosen.supplier.name,
      items: [],
    };
    group.items.push({ row, lineId: chosen.id, cost: chosen.unit_cost });
    groups.set(chosen.purchase_order.id, group);
  }

  async function send(purchaseOrder: string) {
    const group = groups.get(purchaseOrder);
    if (!group) return;
    setBusy(purchaseOrder);
    setError(null);
    setDone(null);
    try {
      const made = await apiClient<{ purchase_return: { number: string; credit_total: string } }>(
        "/damaged-returns/send/",
        {
          method: "POST",
          // One supplier return for these items, however often it is pressed.
          idempotencyKey: `damaged-${purchaseOrder}-${digest(group.items.map((item) => item.row.id).sort().join("."))}`,
          body: {
            purchase_order: purchaseOrder,
            reason: "DAMAGED",
            lines: group.items.map((item) => ({
              return_item: item.row.id,
              purchase_order_item: item.lineId,
            })),
          },
        },
      );
      setDone(
        `${made.purchase_return.number}: ${money(made.purchase_return.credit_total)} credited by ${group.supplier}.`,
      );
      await refreshAfterWrite(router);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "It could not be sent back.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <caption className="sr-only">Damaged items waiting to go back to the supplier</caption>
            <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Item</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Qty</th>
                <th scope="col" className="px-4 py-2.5 font-medium">From return</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Goes back on</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-2.5">
                    <span className="block font-medium">{row.product_name}</span>
                    <span className="block text-caption text-muted">
                      {row.variant_label} · {row.sku}
                      {row.condition_note ? ` · “${row.condition_note}”` : ""}
                    </span>
                  </td>
                  <td className="tabular px-4 py-2.5 text-right">{row.quantity}</td>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/returns/${row.return_request.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {row.return_request.number}
                    </Link>
                    <span className="block text-caption text-muted">
                      {row.order.number} · {row.branch.code}
                      {row.received_at ? ` · ${dateTime(row.received_at)}` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {row.purchase_lines.length ? (
                      <Select
                        aria-label={`Purchase order for ${row.sku}`}
                        value={line[row.id] ?? ""}
                        onChange={(event) =>
                          setLine((current) => ({ ...current, [row.id]: event.target.value }))
                        }
                      >
                        {row.purchase_lines.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.purchase_order.number} · {option.supplier.name} ·{" "}
                            {money(option.unit_cost)} each
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <p className="text-caption text-[var(--warning-text)]">
                        No purchase order at {row.branch.code} brought this item in with units
                        left to send back.
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {error && (
        <p role="alert" className="text-body-sm text-[var(--error)]">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-body-sm text-[var(--success-text)]">
          {done}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        {[...groups.entries()].map(([id, group]) => {
          const credit = group.items.reduce(
            (sum, item) => sum + Number(item.cost) * item.row.quantity,
            0,
          );
          return (
            <Button
              key={id}
              loading={busy === id}
              disabled={busy !== null}
              onClick={() => {
                const units = group.items.reduce((sum, item) => sum + item.row.quantity, 0);
                if (confirm(`Send ${units} item(s) back to ${group.supplier} on ${group.number}?`))
                  void send(id);
              }}
            >
              <Truck aria-hidden /> Send back on {group.number} · {group.supplier} ·{" "}
              {money(credit)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A short, stable digest of the items being sent (two FNV-1a passes, 16 hex
 * characters): the same choice gives the same key, a different one another,
 * and the key stays inside the 64 characters the API keeps.
 */
function digest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
