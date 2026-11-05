"use client";

import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { Order, ReturnRequest } from "@/lib/api/types";
import {
  RETURN_DECISIONS,
  RETURN_REASONS,
  type LineChoice,
  type ReturnDecision,
  canReturn,
  defaultDecision,
  returnLines,
} from "@/lib/commerce/returns";
import { money } from "@/lib/format";
import { REFUND_METHODS, defaultRefundMethod } from "@/lib/money-accounts";
import { refreshAfterWrite } from "@/lib/navigation/refresh-after-write";

/**
 * "Return items" on the order page: a customer who brings goods back is a
 * return, never a bare refund (business rules 2.4).
 *
 * A counter sale's customer is standing there with the goods, so its return is
 * done in one step: received, each line decided, and refunded (`/pos/returns/`).
 * An online order's goods are on their way back, so its return is opened and
 * then taken through on the return's own page as they arrive (`/returns/`).
 */
export function ReturnItems({ order, permissions }: { order: Order; permissions: string[] }) {
  const router = useRouter();
  const formId = useId();
  const atCounter = order.channel === "POS";
  const can = permissions.includes("*") || permissions.includes("sales.refund");
  const [reason, setReason] = useState("WRONG_SIZE");
  const [method, setMethod] = useState(() => defaultRefundMethod(order.payments));
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!can || !canReturn(order)) return null;

  const lines = order.items.filter((item) => item.returnable_quantity > 0);
  const chosen = returnLines(lines, choices);
  const choose = (id: string, change: Partial<LineChoice>) =>
    setChoices((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { quantity: 0, decision: defaultDecision(reason) }), ...change },
    }));

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const body = { order: order.id, reason, lines: chosen };
      if (atCounter) {
        const made = await apiClient<ReturnRequest>("/pos/returns/", {
          method: "POST",
          body: { ...body, refund_method: method },
        });
        setDone(`${made.number}: ${money(made.refund_amount)} refunded.`);
        setChoices({});
        await refreshAfterWrite(router);
      } else {
        const made = await apiClient<ReturnRequest>("/returns/", { method: "POST", body });
        router.push(`/admin/returns/${made.id}`);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The return could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Return items</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-caption text-muted">
          {atCounter
            ? "The customer is here with the goods: they are received and refunded now."
            : "Opens a return. Approve it, receive the goods and refund on the return's page."}
        </p>

        <Field label="Why it came back" htmlFor={`${formId}-reason`}>
          <Select
            id={`${formId}-reason`}
            value={reason}
            onChange={(event) => {
              const next = event.target.value;
              setReason(next);
              // Lines not decided yet follow the new reason's suggestion.
              setChoices((current) =>
                Object.fromEntries(
                  Object.entries(current).map(([id, choice]) => [
                    id,
                    choice.quantity > 0 ? choice : { ...choice, decision: defaultDecision(next) },
                  ]),
                ),
              );
            }}
          >
            {RETURN_REASONS.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </Select>
        </Field>

        <ul className="space-y-3">
          {lines.map((item) => {
            const choice = choices[item.id];
            const decision = choice?.decision ?? defaultDecision(reason);
            return (
              <li key={item.id} className="rounded-md border border-border p-3">
                <p className="text-body-sm font-medium">{item.product_name}</p>
                <p className="text-caption text-muted">
                  {item.variant_label} · {item.sku} · {item.returnable_quantity} can come back
                </p>
                <div className="mt-2 grid grid-cols-[5rem_1fr] gap-2">
                  <Field label="Qty" htmlFor={`${formId}-${item.id}-qty`}>
                    <Input
                      id={`${formId}-${item.id}-qty`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={item.returnable_quantity}
                      step={1}
                      value={choice?.quantity ?? 0}
                      onChange={(event) =>
                        choose(item.id, { quantity: Number(event.target.value), decision })
                      }
                    />
                  </Field>
                  <Field
                    label="Goes"
                    htmlFor={`${formId}-${item.id}-decision`}
                    hint={RETURN_DECISIONS.find((row) => row.value === decision)?.hint}
                  >
                    <Select
                      id={`${formId}-${item.id}-decision`}
                      value={decision}
                      onChange={(event) =>
                        choose(item.id, { decision: event.target.value as ReturnDecision })
                      }
                    >
                      {RETURN_DECISIONS.map((row) => (
                        <option key={row.value} value={row.value}>
                          {row.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </li>
            );
          })}
        </ul>

        {atCounter && (
          <Field label="Refund as" htmlFor={`${formId}-method`}>
            <Select
              id={`${formId}-method`}
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              {REFUND_METHODS.map((row) => (
                <option key={row.value} value={row.value}>
                  {row.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

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

        <Button
          full
          loading={busy}
          disabled={chosen.length === 0}
          onClick={() => {
            const units = chosen.reduce((sum, line) => sum + line.quantity, 0);
            const prompt = atCounter
              ? `Take back ${units} item(s) and refund the customer now?`
              : `Open a return for ${units} item(s)?`;
            if (confirm(prompt)) void submit();
          }}
        >
          <Undo2 aria-hidden /> {atCounter ? "Return and refund" : "Open return"}
        </Button>
      </CardContent>
    </Card>
  );
}
