import { DamagedReturnsList } from "@/components/admin/damaged-returns";
import { PageHeader } from "@/components/admin/shell";
import { Card, CardContent } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { DamagedReturn } from "@/lib/api/types";

export const metadata = { title: "Damaged returns" };

/**
 * Damaged goods customers brought back, on their way to the supplier
 * (business rules 2.3). Each goes back on a purchase return against an order
 * that brought the same item in, and the supplier's credit lands on it.
 */
export default async function DamagedReturnsPage() {
  let rows: DamagedReturn[] = [];
  let error: string | null = null;
  try {
    rows = (await apiServer<Paginated<DamagedReturn>>("/damaged-returns/?page_size=100")).results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load damaged returns.";
  }

  return (
    <>
      <PageHeader
        title="Damaged returns"
        description="Damaged goods customers brought back. Send each back to its supplier for credit; none of them is in sellable stock."
      />
      {error ? (
        <Card>
          <CardContent>
            <p role="alert" className="text-body-sm text-[var(--error)]">
              {error}
            </p>
          </CardContent>
        </Card>
      ) : (
        <DamagedReturnsList rows={rows} />
      )}
    </>
  );
}
