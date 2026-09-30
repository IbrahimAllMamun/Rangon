import { NotFound } from './errors';
import { pyInt, removeQueryParam, replaceQueryParam } from './python';
import { QueryDict } from './query-dict';

/**
 * DRF's `PageNumberPagination` over Django's `Paginator`, as
 * `core.pagination.StandardPagination` configures it.
 *
 * The rules a client can observe, all kept:
 * - `page_size` is read with Python's `int()`; anything that is not a positive
 *   integer falls back to the default, and it is capped at the maximum.
 * - `page` is read the same way; `last` means the last page; a blank or absent
 *   page is 1; anything else that is not a page is `404 "Invalid page."`.
 * - An empty result set still has page 1.
 * - `next`/`previous` are the request's absolute URL with `page` replaced, the
 *   query re-encoded in sorted key order -- and `previous` to page 1 drops
 *   `page` altogether.
 */
export interface PaginationConfig {
  pageSize: number;
  maxPageSize: number;
}

export const STANDARD_PAGINATION: PaginationConfig = { pageSize: 25, maxPageSize: 100 };
export const LARGE_PAGINATION: PaginationConfig = { pageSize: 100, maxPageSize: 500 };

export interface Page {
  number: number;
  numPages: number;
  count: number;
  /** Rows to skip and rows to take: `object_list[bottom:top]`. */
  offset: number;
  limit: number;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** `get_page_size`: `_positive_int(value, strict=True, cutoff=max)`, else the default. */
export function pageSizeFrom(params: QueryDict, config: PaginationConfig): number {
  if (!params.has('page_size')) return config.pageSize;
  const value = pyInt(params.get('page_size', ''));
  if (value === null || value <= 0) return config.pageSize;
  return Math.min(value, config.maxPageSize);
}

/** `Paginator.page(number)` after `get_page_number`, or `NotFound("Invalid page.")`. */
export function resolvePage(params: QueryDict, count: number, pageSize: number): Page {
  // allow_empty_first_page=True, orphans=0.
  const numPages = Math.ceil(Math.max(1, count) / pageSize);
  const raw = params.get('page') || '1';
  const number = raw === 'last' ? numPages : pyInt(raw);
  if (number === null || number < 1 || number > numPages) throw new NotFound('Invalid page.');
  const bottom = (number - 1) * pageSize;
  const top = Math.min(bottom + pageSize, count);
  return { number, numPages, count, offset: bottom, limit: Math.max(0, top - bottom) };
}

/** `get_paginated_response`: count, next, previous, results. */
export function paginated<T>(page: Page, results: T[], absoluteUrl: string): Paginated<T> {
  let next: string | null = null;
  if (page.number < page.numPages) next = replaceQueryParam(absoluteUrl, 'page', page.number + 1);

  let previous: string | null = null;
  if (page.number > 1) {
    previous =
      page.number - 1 === 1
        ? removeQueryParam(absoluteUrl, 'page')
        : replaceQueryParam(absoluteUrl, 'page', page.number - 1);
  }
  return { count: page.count, next, previous, results };
}
