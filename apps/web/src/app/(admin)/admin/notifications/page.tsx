import { AlertTriangle, CheckCheck, CircleAlert, Info } from "lucide-react";
import Link from "next/link";

import { MarkAllReadButton } from "@/components/admin/notification-actions";
import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { StaffNotification } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { dateTime, humanise, relativeTime } from "@/lib/format";

export const metadata = { title: "Notifications" };

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

type Search = Promise<Record<string, string | undefined>>;

export default async function NotificationsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const unreadOnly = params.filter === "unread";

  const query = new URLSearchParams({ page_size: "50" });
  if (unreadOnly) query.set("unread", "true");
  if (params.page) query.set("page", params.page);

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

      <div className="mb-4 flex gap-2" role="group" aria-label="Filter notifications">
        <FilterTab href="/admin/notifications" active={!unreadOnly}>
          All
        </FilterTab>
        <FilterTab href="/admin/notifications?filter=unread" active={unreadOnly}>
          Unread{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </FilterTab>
      </div>

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
                      className="shrink-0 text-body-sm font-medium text-brand-600 hover:underline"
                    >
                      Open
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {feed && (feed.next || feed.previous) && (
        <nav className="mt-4 flex gap-2" aria-label="Notification pages">
          {feed.previous && (
            <PageLink
              href={pageHref(unreadOnly, Number(params.page ?? "1") - 1)}
              label="Previous"
            />
          )}
          {feed.next && (
            <PageLink href={pageHref(unreadOnly, Number(params.page ?? "1") + 1)} label="Next" />
          )}
        </nav>
      )}
    </>
  );
}

function pageHref(unreadOnly: boolean, page: number): string {
  const query = new URLSearchParams();
  if (unreadOnly) query.set("filter", "unread");
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return search ? `/admin/notifications?${search}` : "/admin/notifications";
}

function PageLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
    >
      {label}
    </Link>
  );
}

function FilterTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1.5 text-body-sm font-medium transition-colors duration-fast",
        active
          ? "bg-neutral-900 text-white"
          : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100",
      )}
    >
      {children}
    </Link>
  );
}
