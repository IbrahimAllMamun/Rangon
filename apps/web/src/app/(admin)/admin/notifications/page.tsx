import { AlertTriangle, CheckCheck, CircleAlert, Info } from "lucide-react";
import Link from "next/link";

import { FilterTabs } from "@/components/admin/filter-tabs";
import { MarkAllReadButton } from "@/components/admin/notification-actions";
import { Pagination } from "@/components/admin/pagination";
import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { StaffNotification } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { dateTime, humanise, relativeTime } from "@/lib/format";
import { applyPaging, readPaging } from "@/lib/paging";

export const metadata = { title: "Notifications" };

const LEVEL_ICON = {
  INFO: Info,
  SUCCESS: CheckCheck,
  WARNING: AlertTriangle,
  ERROR: CircleAlert,
} as const;

const LEVEL_TONE = {
  INFO: "text-[var(--info)]",
  SUCCESS: "text-[var(--success-text)]",
  WARNING: "text-[var(--warning-text)]",
  ERROR: "text-[var(--error)]",
} as const;

type Search = Promise<Record<string, string | undefined>>;

export default async function NotificationsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const unreadOnly = params.filter === "unread";

  const paging = readPaging(params);
  const query = new URLSearchParams();
  if (unreadOnly) query.set("unread", "true");
  applyPaging(query, paging);

  let feed: Paginated<StaffNotification> | null = null;
  let unreadCount = 0;
  let error: string | null = null;
  try {
    [feed, { unread: unreadCount }] = await Promise.all([
      apiServer<Paginated<StaffNotification>>(`/notifications/?${query.toString()}`),
      apiServer<{ unread: number }>("/notifications/count/"),
    ]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load notifications.";
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        description={
          feed
            ? `${feed.count} ${unreadOnly ? "unread" : "total"} · ${unreadCount} unread`
            : undefined
        }
        actions={<MarkAllReadButton disabled={unreadCount === 0} />}
      />

      <FilterTabs
        label="Which notifications"
        className="mb-4"
        tabs={[
          { label: "All", href: "/admin/notifications", active: !unreadOnly },
          {
            label: `Unread${unreadCount > 0 ? ` (${unreadCount})` : ""}`,
            href: "/admin/notifications?filter=unread",
            active: unreadOnly,
          },
        ]}
      />

      <Card className="overflow-hidden">
        {error ? (
          <p role="alert" className="p-6 text-body-sm text-[var(--error)]">
            {error}
          </p>
        ) : !feed || feed.results.length === 0 ? (
          <EmptyState
            title={unreadOnly ? "Nothing unread" : "No notifications yet"}
            description="Low stock, new online orders, returns and refunds raise an alert here as they happen."
          />
        ) : (
          <ul className="divide-y divide-border">
            {feed.results.map((item) => {
              const Icon = LEVEL_ICON[item.level] ?? Info;
              return (
                <li
                  key={item.id}
                  className={cn("flex items-start gap-4 p-4", !item.is_read && "bg-brand-50/60")}
                >
                  <Icon
                    className={cn("mt-0.5 size-5 shrink-0", LEVEL_TONE[item.level])}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-body font-semibold">{item.title}</h2>
                      <Badge tone="neutral">{humanise(item.notification_type)}</Badge>
                      {!item.is_read && <Badge tone="brand">New</Badge>}
                    </div>
                    {item.body && (
                      <p className="mt-1 text-body-sm text-neutral-700">{item.body}</p>
                    )}
                    <p className="mt-1.5 text-caption text-muted">
                      <time dateTime={item.created_at} title={dateTime(item.created_at)}>
                        {relativeTime(item.created_at)}
                      </time>
                    </p>
                  </div>
                  {item.link && (
                    <Link
                      href={item.link}
                      className="shrink-0 text-body-sm font-medium text-brand-700 hover:underline"
                    >
                      Open
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {feed && feed.results.length > 0 && (
          <Pagination
            count={feed.count}
            page={paging.page}
            pageSize={paging.pageSize}
            query={params}
            unit="notifications"
          />
        )}
      </Card>
    </>
  );
}
