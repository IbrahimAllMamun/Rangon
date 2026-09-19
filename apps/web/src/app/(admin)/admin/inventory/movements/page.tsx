import Link from "next/link";
import { redirect } from "next/navigation";

import { FilterField, FilterForm } from "@/components/admin/filter-form";
import { Pagination } from "@/components/admin/pagination";
import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, EmptyState, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser, StockMovement, StockMovementType } from "@/lib/api/types";
import { dateTime, money } from "@/lib/format";
import { applyPaging, readPaging } from "@/lib/paging";
import {
  MOVEMENT_FAMILIES,
  documentHref,
  movesReserved,
  resolveFamily,
  signedQuantity,
} from "@/lib/stock-movements";

export const metadata = { title: "Stock movements" };

type Search = Promise<Record<string, string | undefined>>;

const PATH = "/admin/inventory/movements";

const TONE: Partial<Record<StockMovementType, "success" | "warning" | "error" | "info" | "neutral">> = {
  PURCHASE: "success",
  RETURN: "success",
  SALE: "info",
  DAMAGE: "error",
  LOSS: "error",
  ADJUSTMENT: "warning",
  PURCHASE_RETURN: "warning",
};

/**
 * The inventory ledger, read back.
 *
 * `/admin/inventory` shows the figure; this shows the rows that add up to it.
 * Nothing here can change a row — the ledger is append-only, and a correction
 * is a new movement made from the inventory screen or a stock count.
 */
export default async function StockMovementsPage({ searchParams }: { searchParams: Search }) {
  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=${PATH}`);
  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  const params = await searchParams;
  const paging = readPaging(params);
  const family = resolveFamily(params.family);

  const query = new URLSearchParams();
  for (const key of ["variant", "branch", "search", "date_from", "date_to"]) {
    if (params[key]) query.set(key, params[key]!);
  }
  if (family.types.length > 0) query.set("types", family.types.join(","));
  applyPaging(query, paging);

  let page: Paginated<StockMovement> | null = null;
  let error: string | null = null;
  if (can("inventory.view")) {
    try {
      page = await apiServer<Paginated<StockMovement>>(`/inventory-transactions/?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not load stock movements.";
    }
  } else {
    error = "Your role cannot see stock.";
  }

  const rows = page?.results ?? [];
  const showBranch = !params.branch && new Set(rows.map((row) => row.branch_code)).size > 1;
  // One variant's history names itself from its first row; with no rows there
  // is nothing to name it from, so the banner says so rather than guessing.
  const scoped = params.variant ? rows[0] : undefined;
  const filtered = Boolean(params.search || params.date_from || params.date_to);

  // Every link on the page is this page with one thing changed, and never a
  // `page`: a new filter starts at page 1.
  const current: Record<string, string | undefined> = { ...params, family: family.value };
  const hrefWith = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const key of ["variant", "branch", "family", "search", "date_from", "date_to"]) {
      const value = key in changes ? changes[key] : current[key];
      if (value) next.set(key, value);
    }
    const search = next.toString();
    return search ? `${PATH}?${search}` : PATH;
  };

  return (
    <>
      <PageHeader
        title="Stock movements"
        description="Every change to stock, newest first — what moved, why, and what the shelf held afterwards. Rows are written once and never edited: a correction is a new movement."
      />

      {params.variant && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-neutral-50 px-4 py-3 text-body-sm">
          <p>
            {scoped ? (
              <>
                History of <span className="font-medium">{scoped.product_name}</span>
                {scoped.variant_label && <> · {scoped.variant_label}</>}{" "}
                <span className="font-mono text-caption text-muted">{scoped.sku}</span>
                {params.branch && <> at {scoped.branch_code}</>}
              </>
            ) : (
              "History of one product variant"
            )}
          </p>
          <Link href={PATH} className="font-medium text-brand-600 hover:underline">
            Show every product
          </Link>
        </div>
      )}

      <nav aria-label="Kind of movement" className="mb-4 flex flex-wrap gap-2">
        {MOVEMENT_FAMILIES.map((option) => {
          const active = option.value === family.value;
          return (
            <Link
              key={option.value || "all"}
              href={hrefWith({ family: option.value })}
              aria-current={active ? "true" : undefined}
              className={`rounded-md px-3 py-1.5 text-body-sm font-medium ${
                active
                  ? "bg-neutral-900 text-white"
                  : "border border-border bg-surface hover:bg-neutral-100"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </nav>

      <FilterForm
        action={PATH}
        label="Filter stock movements"
        keep={{ variant: params.variant, branch: params.branch, family: family.value }}
        clearHref={hrefWith({ search: undefined, date_from: undefined, date_to: undefined })}
        active={filtered}
      >
        {!params.variant && (
          <FilterField
            id="movements-search"
            name="search"
            type="search"
            label="Product or SKU"
            defaultValue={params.search ?? ""}
            placeholder="e.g. RGN-TEE or Linen shirt"
            className="min-w-[14rem] flex-1"
          />
        )}
        <FilterField
          id="movements-from"
          name="date_from"
          type="date"
          label="From"
          defaultValue={params.date_from ?? ""}
        />
        <FilterField
          id="movements-to"
          name="date_to"
          type="date"
          label="To"
          defaultValue={params.date_to ?? ""}
        />
      </FilterForm>

      <Card className="overflow-hidden">
        {error ? (
          <ErrorState title="Could not load stock movements" description={error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No movements"
            description={
              family.value || filtered
                ? "Nothing matches these filters. Widen the dates or choose another kind of movement."
                : "Stock moves when goods are received, sold, returned, counted, transferred or written off."
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Stock movements, newest first</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">When</th>
                    {!params.variant && (
                      <th scope="col" className="px-4 py-2.5 font-medium">Product</th>
                    )}
                    {showBranch && (
                      <th scope="col" className="px-4 py-2.5 font-medium">Branch</th>
                    )}
                    <th scope="col" className="px-4 py-2.5 font-medium">Movement</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Quantity</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">On hand after</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Unit cost</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Document</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Reason</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => {
                    const href = documentHref(row.document, can);
                    const reserved = movesReserved(row.transaction_type);
                    const note = row.reason || row.notes;
                    return (
                      <tr key={row.id} className="hover:bg-neutral-50">
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                          {dateTime(row.created_at)}
                        </td>
                        {!params.variant && (
                          <td className="px-4 py-2.5">
                            <Link
                              href={`${PATH}?variant=${row.variant}&branch=${row.branch}`}
                              className="block font-medium hover:underline"
                            >
                              {row.product_name}
                            </Link>
                            <span className="block text-caption text-muted">
                              {row.variant_label && <>{row.variant_label} · </>}
                              <span className="font-mono">{row.sku}</span>
                            </span>
                          </td>
                        )}
                        {showBranch && <td className="px-4 py-2.5">{row.branch_code}</td>}
                        <td className="px-4 py-2.5">
                          <Badge tone={TONE[row.transaction_type] ?? "neutral"}>
                            {row.transaction_type_label}
                          </Badge>
                        </td>
                        <td
                          className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-medium ${
                            reserved
                              ? "text-muted"
                              : row.quantity >= 0
                                ? "text-[var(--success)]"
                                : "text-[var(--error)]"
                          }`}
                        >
                          {signedQuantity(row.quantity)}
                          {/* The reservation pair holds stock for an order; it
                              does not move the shelf, and says so in words. */}
                          {reserved && <span className="block text-caption font-normal">reserved</span>}
                        </td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-right">
                          {row.on_hand_after}
                          {row.reserved_after > 0 && (
                            <span className="block text-caption text-muted">
                              {row.reserved_after} reserved
                            </span>
                          )}
                        </td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-muted">
                          {row.unit_cost === null ? "—" : money(row.unit_cost)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          {row.document ? (
                            href ? (
                              <Link href={href} className="text-brand-600 hover:underline">
                                {row.document.label}
                              </Link>
                            ) : (
                              row.document.label
                            )
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="max-w-[28ch] px-4 py-2.5 text-muted">
                          <span className="line-clamp-2" title={note || undefined}>
                            {note || "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-caption text-muted">
                          {row.created_by_email || "system"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              count={page?.count ?? 0}
              page={paging.page}
              pageSize={paging.pageSize}
              query={params}
              unit="movements"
            />
          </>
        )}
      </Card>
    </>
  );
}
