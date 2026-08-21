"use client";

import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, Bell, CheckCheck, CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button, Spinner } from "@/components/ui/primitives";
import { type Paginated, apiClient } from "@/lib/api/client";
import type { StaffNotification } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";

/** How often the unread count is refreshed while the tab is visible. */
const POLL_MS = 60_000;

const LEVEL_ICON = {
  INFO: Info,
  SUCCESS: CheckCheck,
  WARNING: AlertTriangle,
  ERROR: CircleAlert,
} as const;

const LEVEL_TONE = {
  INFO: "text-[var(--info)]",
  SUCCESS: "text-[var(--success)]",
  WARNING: "text-[var(--warning)]",
  ERROR: "text-[var(--error)]",
} as const;

/**
 * The staff alert feed (D3).
 *
 * Low stock, new online orders and integrity alerts have been written to
 * `notifications_notification` since phase 25; until now nothing in the app
 * read them. The count is polled (one indexed COUNT), the list is only fetched
 * when the panel opens.
 */
export function NotificationBell() {
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<StaffNotification[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadCount = useCallback(async () => {
    try {
      const { unread: count } = await apiClient<{ unread: number }>("/notifications/count/");
      setUnread(count);
    } catch {
      // A failed poll must never interrupt back-office work; the next one retries.
    }
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const page = await apiClient<Paginated<StaffNotification>>("/notifications/?page_size=8");
      setItems(page.results);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void loadCount();
    const timer = setInterval(() => {
      // Polling a hidden tab wakes the API for nobody.
      if (document.visibilityState === "visible") void loadCount();
    }, POLL_MS);
    const onFocus = () => void loadCount();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadCount]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setItems(null);
      void loadItems();
      void loadCount();
    }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      await apiClient("/notifications/mark-read/", { method: "POST", body: {} });
      setUnread(0);
      setItems((current) =>
        current ? current.map((item) => ({ ...item, is_read: true })) : current,
      );
      // The feed page renders on the server, so it needs telling.
      router.refresh();
    } catch {
      // Leave the badge alone: it is still the truth if the write failed.
    } finally {
      setBusy(false);
    }
  }

  async function markOneRead(id: string) {
    try {
      await apiClient("/notifications/mark-read/", { method: "POST", body: { ids: [id] } });
      setUnread((count) => Math.max(0, count - 1));
    } catch {
      /* following the link matters more than the read flag */
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative rounded-md p-2 text-neutral-700 transition-colors duration-fast hover:bg-neutral-100 data-[state=open]:bg-neutral-100"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-5" aria-hidden />
          {unread > 0 && (
            <span
              // Red here is emphasis, not error: an unread badge is the same
              // class of mark as the active nav item (CLAUDE.md §10).
              className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-brand-500 px-1 text-[0.65rem] font-semibold leading-[1.15rem] text-white"
              aria-hidden
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className={cn(
            "z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface shadow-lg",
            "motion-safe:data-[state=open]:animate-slide-up",
          )}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-body-sm font-semibold">Notifications</h2>
            {unread > 0 && (
              <Button variant="ghost" size="sm" onClick={markAllRead} loading={busy}>
                Mark all read
              </Button>
            )}
          </div>

          <div className="max-h-[24rem] overflow-y-auto">
            {items === null ? (
              <div className="flex items-center justify-center gap-2 p-8 text-body-sm text-muted">
                <Spinner /> Loading
              </div>
            ) : items.length === 0 ? (
              <p className="p-8 text-center text-body-sm text-muted">
                Nothing yet. Low stock, new orders and refunds appear here.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((item) => {
                  const Icon = LEVEL_ICON[item.level] ?? Info;
                  const inner = (
                    <>
                      <Icon
                        className={cn("mt-0.5 size-4 shrink-0", LEVEL_TONE[item.level])}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body-sm font-medium">{item.title}</span>
                        {item.body && (
                          <span className="mt-0.5 block truncate text-caption text-muted">
                            {item.body}
                          </span>
                        )}
                        <span className="mt-1 block text-caption text-muted">
                          {relativeTime(item.created_at)}
                          {!item.is_read && (
                            <span className="ml-2 font-medium text-brand-600">New</span>
                          )}
                        </span>
                      </span>
                    </>
                  );
                  const row = cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left",
                    !item.is_read && "bg-brand-50/60",
                  );
                  return (
                    <li key={item.id}>
                      {item.link ? (
                        <Link
                          href={item.link}
                          className={cn(row, "hover:bg-neutral-50")}
                          onClick={() => {
                            if (!item.is_read) void markOneRead(item.id);
                            setOpen(false);
                          }}
                        >
                          {inner}
                        </Link>
                      ) : (
                        <div className={row}>{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-border px-4 py-2.5">
            <Link
              href="/admin/notifications"
              onClick={() => setOpen(false)}
              className="text-body-sm font-medium text-brand-600 hover:underline"
            >
              See all notifications
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
