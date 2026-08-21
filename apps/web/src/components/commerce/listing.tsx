import Link from "next/link";

/** Shared between `/shop` and `/category/[...slug]`, which render the same grid. */

export interface Facets {
  brands: { slug: string; name: string; count: number }[];
  attributes: {
    code: string;
    name: string;
    kind: string;
    values: { value: string; label: string; swatch: string; count: number }[];
  }[];
  price: { min: string; max: string };
}

export type ListingParams = Record<string, string | string[] | undefined>;

export function toQuery(params: ListingParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) search.append(key, entry);
  }
  return search.toString();
}

/** Page size must match `core.pagination.StandardPagination`. */
const PAGE_SIZE = 25;

export function ListingPagination({
  basePath,
  params,
  count,
  hasNext,
}: {
  basePath: string;
  params: ListingParams;
  count: number;
  hasNext: boolean;
}) {
  const page = Number(params.page ?? 1);
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  if (totalPages <= 1) return null;

  const build = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      // `category` never rides in the query string any more — it is the path.
      if (key === "page" || key === "category" || value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) search.append(key, entry);
    }
    search.set("page", String(target));
    return `${basePath}?${search.toString()}`;
  };

  return (
    <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-2">
      {page > 1 && (
        <Link
          href={build(page - 1)}
          rel="prev"
          className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-4 text-body-sm hover:bg-neutral-100"
        >
          Previous
        </Link>
      )}
      <span className="px-3 text-body-sm text-muted">
        Page {page} of {totalPages}
      </span>
      {hasNext && (
        <Link
          href={build(page + 1)}
          rel="next"
          className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-4 text-body-sm hover:bg-neutral-100"
        >
          Next
        </Link>
      )}
    </nav>
  );
}
