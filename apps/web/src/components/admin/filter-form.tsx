import Form from "next/form";
import Link from "next/link";

import { Button, Input, Label } from "@/components/ui/primitives";

/**
 * A GET form over a list screen's query string.
 *
 * `next/form` turns the submit into a client-side navigation to the same page
 * with the fields as search params — so the server component re-reads them,
 * the pending dim in the shell shows, and it still works before hydration as
 * a plain GET. Filters that live outside the form (a family chip, the record a
 * history is scoped to) ride along as hidden fields, so applying a date range
 * does not silently drop them. `page` never rides along: a new filter starts at
 * page 1, because DRF answers a page past the end with a 404.
 */
export function FilterForm({
  action,
  label,
  keep = {},
  clearHref,
  active,
  children,
}: {
  action: string;
  /** Names the search landmark, e.g. "Filter stock movements". */
  label: string;
  /** Params to carry across a submit that have no visible field here. */
  keep?: Record<string, string | undefined>;
  /** Where "Clear" goes; shown only while something is filtered. */
  clearHref: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Form
      action={action}
      role="search"
      aria-label={label}
      className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3"
    >
      {Object.entries(keep).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      {children}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="dark">
          Apply
        </Button>
        {active && (
          <Link
            href={clearHref}
            className="rounded-md px-2 py-2 text-body-sm font-medium text-neutral-700 hover:bg-neutral-100"
          >
            Clear
          </Link>
        )}
      </div>
    </Form>
  );
}

/** A labelled input sized for the filter bar. */
export function FilterField({
  id,
  label,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string }) {
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1 text-caption text-muted">
        {label}
      </Label>
      <Input id={id} {...props} />
    </div>
  );
}
