import { Check, Minus } from "lucide-react";

import { Card } from "@/components/ui/primitives";
import type { RoleMatrix as Matrix } from "@/lib/role-matrix";

/**
 * Who may do what, one row per permission and one column per staff role.
 *
 * A real table rather than a grid of divs, because the question it answers is
 * a lookup across two axes and a screen reader has to be able to make the same
 * lookup: every cell is announced with its row and column headers, and says
 * "Yes" or "No" in words. The mark is a tick or a dash — a shape, not a colour.
 *
 * The permission column stays put while the roles scroll sideways on a narrow
 * screen, so a row is never read without its name.
 */
export function RoleMatrix({ matrix }: { matrix: Matrix }) {
  const width = matrix.columns.length + 1;

  return (
    <Card className="overflow-hidden">
      {/* `relative` is load-bearing. The "Yes"/"No" words are `sr-only`, which
          is absolutely positioned; without a positioned ancestor *inside* the
          scroll box they resolve against one outside it, escape the clip, and
          stretch the whole page sideways from the far-right cells -- measured
          at 747px wide on a 390px phone before this was added. */}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[44rem] text-body-sm">
          <caption className="sr-only">
            What each staff role may do: {matrix.total} permissions against{" "}
            {matrix.columns.length} roles.
          </caption>
          <thead className="border-b border-border bg-neutral-50 text-left text-caption text-muted">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 bg-neutral-50 px-4 py-2.5 font-medium uppercase"
              >
                Permission
              </th>
              {matrix.columns.map((column) => (
                <th key={column.code} scope="col" className="px-3 py-2.5 text-center font-medium">
                  <span className="block text-body-sm font-semibold text-foreground">
                    {column.name}
                  </span>
                  <span className="tabular block">
                    {column.everything
                      ? "Everything, always"
                      : `${column.count} of ${matrix.total}`}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {matrix.groups.map((group) => (
            <tbody key={group.group} className="divide-y divide-border border-b border-border">
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={width}
                  className="bg-neutral-50 px-4 py-2 text-left text-caption font-semibold uppercase tracking-wide text-neutral-700"
                >
                  {/* Pinned inside its full-width cell: scrolled sideways on a
                      phone, the label otherwise leaves with the first column's
                      edge and every group reads as a blank band. */}
                  <span className="sticky left-4">{group.label}</span>
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.code} className="hover:bg-neutral-50">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-surface px-4 py-2 text-left font-normal"
                  >
                    <span className="block text-foreground">{row.name}</span>
                    <code className="block font-mono text-caption text-muted">{row.code}</code>
                  </th>
                  {row.held.map((held, index) => (
                    <td key={matrix.columns[index].code} className="px-3 py-2 text-center">
                      {held ? (
                        <Check
                          className="mx-auto size-4 text-foreground"
                          strokeWidth={2.5}
                          aria-hidden
                        />
                      ) : (
                        // `muted`, not a paler grey: the dash carries meaning, so it
                        // needs 3:1 against white (WCAG 1.4.11). neutral-300 is 1.5:1.
                        <Minus className="mx-auto size-4 text-muted" aria-hidden />
                      )}
                      <span className="sr-only">{held ? "Yes" : "No"}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </Card>
  );
}
