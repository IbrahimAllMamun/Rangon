import { Pagination } from "@/components/admin/pagination";
import { Card, EmptyState } from "@/components/ui/primitives";

/** What a list screen has to hand over for the footer to page itself. */
export interface TablePaging {
  /** Total matching rows, from the API's `count` — not `results.length`. */
  count: number;
  page: number;
  pageSize: number;
  /** The route's search params, so filters survive a page change. */
  query?: Record<string, string | undefined>;
  /** Plural noun for the summary line — "orders", "suppliers". */
  unit?: string;
}

export interface Column<T> {
  header: string;
  /** Right-align and use tabular numerals — for money and counts. */
  numeric?: boolean;
  cell: (row: T) => React.ReactNode;
}

/**
 * Dense read-only table shared by the admin list screens.
 *
 * Admin favours data density over decoration (CLAUDE.md §10): sticky-ish header,
 * 40px rows, right-aligned tabular figures, and a real <caption> for screen
 * readers.
 */
export function ResourceTable<T>({
  rows,
  columns,
  caption,
  error,
  emptyTitle,
  emptyDescription,
  footer,
  paging,
  rowKey,
}: {
  rows: T[];
  columns: Column<T>[];
  caption: string;
  error?: string | null;
  emptyTitle: string;
  emptyDescription?: string;
  footer?: React.ReactNode;
  /** Omit for a list the API returns whole; supply it for anything paginated. */
  paging?: TablePaging;
  rowKey: (row: T) => string;
}) {
  if (error) {
    return (
      <Card>
        <p role="alert" className="p-6 text-body-sm text-[var(--error)]">
          {error}
        </p>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-body-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.header}
                  scope="col"
                  className={`px-4 py-2.5 font-medium ${column.numeric ? "text-right" : ""}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={rowKey(row)} className="hover:bg-neutral-50">
                {columns.map((column) => (
                  <td
                    key={column.header}
                    className={`px-4 py-2.5 ${column.numeric ? "tabular text-right" : ""}`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className="border-t border-border px-4 py-2 text-caption text-muted">{footer}</div>}
      {paging && (
        <Pagination
          count={paging.count}
          page={paging.page}
          pageSize={paging.pageSize}
          query={paging.query}
          unit={paging.unit}
        />
      )}
    </Card>
  );
}
