/**
 * Paging helpers shared by the admin list screens.
 *
 * These live outside `components/admin/pagination.tsx` on purpose. That file is
 * a `"use client"` module, and a server component cannot call a function
 * exported from one — Next fails at request time with "Attempted to call
 * readPaging() from the server but readPaging is on the client", which both
 * `tsc --noEmit` and `next lint` pass straight over. The list pages are server
 * components, so the pure helpers have to sit in a module with no client
 * boundary.
 */

/**
 * Row counts the API will actually honour.
 *
 * `core.pagination.StandardPagination` caps `page_size` at 100, so offering more
 * would be silently clamped by the backend and the footer would then disagree
 * with the rows on screen.
 */
export const PAGE_SIZES: number[] = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Normalise `page` / `page_size` out of a route's search params.
 *
 * Server components call this, forward the result to the API, and hand the same
 * numbers to `<Pagination>` — so the footer can never describe a different page
 * than the one that was fetched.
 */
export function readPaging(params: Record<string, string | undefined>): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(Number(params.page)) || 1);
  const requested = Math.trunc(Number(params.page_size));
  return {
    page,
    pageSize: PAGE_SIZES.includes(requested) ? requested : DEFAULT_PAGE_SIZE,
  };
}

/** Append `page` / `page_size` to an outgoing API query, omitting the defaults. */
export function applyPaging(
  query: URLSearchParams,
  { page, pageSize }: { page: number; pageSize: number },
): URLSearchParams {
  if (page > 1) query.set("page", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) query.set("page_size", String(pageSize));
  return query;
}
