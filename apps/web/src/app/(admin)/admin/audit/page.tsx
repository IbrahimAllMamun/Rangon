import Link from "next/link";
import { redirect } from "next/navigation";

import { FilterField, FilterForm } from "@/components/admin/filter-form";
import { Pagination } from "@/components/admin/pagination";
import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, EmptyState, ErrorState, Label, Select } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { AuditEntry, SessionUser } from "@/lib/api/types";
import { AUDIT_ACTIONS, changedFields, entityHref, entityName } from "@/lib/audit-trail";
import { dateTime } from "@/lib/format";
import { applyPaging, readPaging } from "@/lib/paging";

export const metadata = { title: "Audit log" };

type Search = Promise<Record<string, string | undefined>>;

const PATH = "/admin/audit";
const KEYS = ["entity_id", "action", "search", "date_from", "date_to"] as const;

const TONE: Record<string, "success" | "warning" | "error" | "info" | "neutral"> = {
  LOGIN_FAILED: "error",
  DELETE: "error",
  ORDER_CANCELLED: "warning",
  REFUND_ISSUED: "warning",
  EXPENSE_VOIDED: "warning",
  DISCOUNT_OVERRIDE: "warning",
  PRICE_OVERRIDE: "warning",
  PERMISSION_ELEVATION: "warning",
  USER_CHANGED: "warning",
  SETTINGS_CHANGED: "warning",
  STOCK_ADJUSTMENT: "info",
  STOCK_TRANSFER: "info",
};

/**
 * The audit log, read back.
 *
 * Every service writes who did what, to which record, with the values before
 * and after and the reason given. Until this screen the trail could only be
 * read with database access. It is read-only by construction: `AuditLog` is
 * append-only and the API exposes list and retrieve, nothing else.
 */
export default async function AuditLogPage({ searchParams }: { searchParams: Search }) {
  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=${PATH}`);
  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  const params = await searchParams;
  const paging = readPaging(params);
  const query = new URLSearchParams();
  for (const key of KEYS) {
    if (params[key]) query.set(key, params[key]!);
  }
  applyPaging(query, paging);

  let page: Paginated<AuditEntry> | null = null;
  let error: string | null = null;
  if (can("audit.view")) {
    try {
      page = await apiServer<Paginated<AuditEntry>>(`/audit-logs/?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not load the audit log.";
    }
  } else {
    error = "Reading the audit log needs the audit.view permission.";
  }

  const rows = page?.results ?? [];
  const showBranch = new Set(rows.map((row) => row.branch_code ?? "")).size > 1;
  const scoped = params.entity_id ? rows[0] : undefined;
  const filtered = Boolean(params.action || params.search || params.date_from || params.date_to);

  const hrefWith = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const key of KEYS) {
      const value = key in changes ? changes[key] : params[key];
      if (value) next.set(key, value);
    }
    const search = next.toString();
    return search ? `${PATH}?${search}` : PATH;
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, to which record, and when — with the values before and after, and the reason they gave. Nothing here can be edited or removed."
      />

      {params.entity_id && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-neutral-50 px-4 py-3 text-body-sm">
          <p>
            {scoped ? (
              <>
                History of {entityName(scoped.entity_type).toLowerCase()}{" "}
                <span className="font-medium">{scoped.entity_label || scoped.entity_id}</span>
              </>
            ) : (
              "History of one record"
            )}
          </p>
          <Link
            href={hrefWith({ entity_id: undefined })}
            className="font-medium text-brand-600 hover:underline"
          >
            Show every record
          </Link>
        </div>
      )}

      <FilterForm
        action={PATH}
        label="Filter the audit log"
        keep={{ entity_id: params.entity_id }}
        clearHref={hrefWith({
          action: undefined,
          search: undefined,
          date_from: undefined,
          date_to: undefined,
        })}
        active={filtered}
      >
        <FilterField
          id="audit-search"
          name="search"
          type="search"
          label="Who, what or why"
          defaultValue={params.search ?? ""}
          placeholder="Order number, staff email, a reason…"
          className="min-w-[14rem] flex-1"
        />
        <div>
          <Label htmlFor="audit-action" className="mb-1 text-caption text-muted">
            Action
          </Label>
          <Select id="audit-action" name="action" defaultValue={params.action ?? ""}>
            <option value="">Any action</option>
            {AUDIT_ACTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <FilterField
          id="audit-from"
          name="date_from"
          type="date"
          label="From"
          defaultValue={params.date_from ?? ""}
        />
        <FilterField
          id="audit-to"
          name="date_to"
          type="date"
          label="To"
          defaultValue={params.date_to ?? ""}
        />
      </FilterForm>

      <Card className="overflow-hidden">
        {error ? (
          <ErrorState title="Could not load the audit log" description={error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing recorded"
            description={
              filtered || params.entity_id
                ? "No entries match these filters. Widen the dates or clear the search."
                : "Entries appear as people sign in, sell, refund, adjust stock and change settings."
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Audit log, newest entry first</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">When</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Who</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Action</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Record</th>
                    {showBranch && (
                      <th scope="col" className="px-4 py-2.5 font-medium">Branch</th>
                    )}
                    <th scope="col" className="px-4 py-2.5 font-medium">Reason and changes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => (
                    <AuditRow
                      key={row.id}
                      row={row}
                      href={entityHref(row, can)}
                      historyHref={
                        !params.entity_id && row.entity_id
                          ? hrefWith({ entity_id: row.entity_id, action: undefined, search: undefined })
                          : null
                      }
                      showBranch={showBranch}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              count={page?.count ?? 0}
              page={paging.page}
              pageSize={paging.pageSize}
              query={params}
              unit="entries"
            />
          </>
        )}
      </Card>
    </>
  );
}

function AuditRow({
  row,
  href,
  historyHref,
  showBranch,
}: {
  row: AuditEntry;
  href: string | null;
  historyHref: string | null;
  showBranch: boolean;
}) {
  const changes = changedFields(row.old_values, row.new_values);

  return (
    <tr className="align-top hover:bg-neutral-50">
      <td className="whitespace-nowrap px-4 py-2.5 text-muted">{dateTime(row.created_at)}</td>
      <td className="px-4 py-2.5">
        {/* No actor is the system itself (a scheduled job, a webhook) or a
            sign-in attempt nobody has been matched to yet. */}
        <span className="block">{row.actor_email || "System"}</span>
        {row.ip_address && (
          <span className="block font-mono text-caption text-muted">{row.ip_address}</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <Badge tone={TONE[row.action] ?? "neutral"}>{row.action_label}</Badge>
      </td>
      <td className="px-4 py-2.5">
        <span className="block text-caption text-muted">{entityName(row.entity_type)}</span>
        {href ? (
          <Link href={href} className="font-medium text-brand-600 hover:underline">
            {row.entity_label || row.entity_id}
          </Link>
        ) : (
          <span className="font-medium">{row.entity_label || row.entity_id || "—"}</span>
        )}
        {historyHref && (
          <Link
            href={historyHref}
            className="block text-caption text-muted underline-offset-2 hover:underline"
          >
            Its whole history
          </Link>
        )}
      </td>
      {showBranch && <td className="px-4 py-2.5">{row.branch_code ?? "All branches"}</td>}
      <td className="min-w-[18rem] px-4 py-2.5">
        {row.reason && <p>{row.reason}</p>}
        {changes.length > 0 && (
          <details className="group mt-1">
            <summary className="cursor-pointer text-caption font-medium text-neutral-700 hover:text-neutral-900">
              {changes.length === 1 ? "1 value" : `${changes.length} values`}
            </summary>
            <table className="mt-2 w-full text-caption">
              <caption className="sr-only">Values before and after</caption>
              <thead className="text-left text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Field</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Before</th>
                  <th scope="col" className="py-1 font-medium">After</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {changes.map((change) => (
                  <tr key={change.field}>
                    <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                      {change.field}
                    </th>
                    <td className="break-all py-1 pr-3 text-muted">{change.before ?? "—"}</td>
                    <td className="break-all py-1">{change.after ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
        {!row.reason && changes.length === 0 && <span className="text-muted">—</span>}
      </td>
    </tr>
  );
}
