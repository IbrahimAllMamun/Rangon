import { redirect } from "next/navigation";

import { LabelSheet } from "@/components/admin/label-sheet";
import { PageHeader } from "@/components/admin/shell";
import { currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Barcode labels" };

/**
 * Barcode label sheets.
 *
 * `products.view` to reach the screen, because choosing what to label is
 * reading the catalogue. Assigning a barcode to a variant that has none is a
 * write, so that is gated separately on `products.update` and the component is
 * told which it may do — the API refuses either way (CLAUDE.md section 3.4);
 * this only decides whether the screen offers it.
 */
export default async function LabelsPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/labels");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  if (!can("products.view")) redirect("/admin");

  return (
    <>
      <div className="no-print">
        <PageHeader
          title="Barcode labels"
          description="Print scannable labels for stock that arrives without them. Products keep the barcode they are given, so a label printed today still scans next year."
        />
      </div>
      <LabelSheet canAssign={can("products.update")} />
    </>
  );
}
