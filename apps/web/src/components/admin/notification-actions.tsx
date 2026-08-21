"use client";

import { CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/primitives";
import { apiClient } from "@/lib/api/client";

/** "Mark all read" for the feed page; the bell has its own copy for the panel. */
export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function markAll() {
    setBusy(true);
    setFailed(false);
    try {
      await apiClient("/notifications/mark-read/", { method: "POST", body: {} });
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {failed && (
        <span role="alert" className="text-body-sm text-[var(--error)]">
          Could not update. Try again.
        </span>
      )}
      <Button variant="secondary" onClick={markAll} loading={busy} disabled={disabled}>
        <CheckCheck className="size-4" aria-hidden />
        Mark all read
      </Button>
    </div>
  );
}
