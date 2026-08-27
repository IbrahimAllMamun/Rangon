"use client";

import { ClipboardList } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, ErrorSummary } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

/**
 * Open a new count sheet.
 *
 * The sheet is generated server-side from the ledger at the moment it opens —
 * that snapshot is the whole point, so there is nothing to configure here
 * beyond which branch is being counted.
 */
export function StartStockCount({ branchId, branchLabel }: { branchId: string; branchLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const created = await apiClient<{ id: string }>("/stock-counts/", {
        method: "POST",
        body: { branch: branchId, notes: "" },
      });
      router.push(`/admin/inventory/counts/${created.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not open a count.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <ErrorSummary
        errors={error ? [{ field: "start-count", message: error }] : []}
        title="Could not open a count"
      />
      <Button type="button" onClick={start} loading={busy} id="start-count">
        <ClipboardList className="size-4" aria-hidden />
        Start a count of {branchLabel}
      </Button>
    </div>
  );
}
