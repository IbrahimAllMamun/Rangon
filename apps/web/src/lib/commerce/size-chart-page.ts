/**
 * What both size-chart pages load: the Size attribute a chart describes, and
 * its values as the rows the grid offers.
 *
 * SERVER ONLY — it calls `apiServer`. Shared so the create and edit pages
 * cannot disagree about which sizes a chart may hold or in what order.
 */
import type { AttributeRow } from "@/components/admin/attribute-manager";
import { apiServer } from "@/lib/api/server";
import type { SizeOption } from "@/lib/commerce/size-chart";

export async function loadSizeAttribute(
  attributeId: string,
): Promise<{ attribute: AttributeRow; sizes: SizeOption[] }> {
  const attribute = await apiServer<AttributeRow>(`/attributes/${attributeId}/`);
  const sizes = [...attribute.values]
    .sort((a, b) => a.position - b.position || a.value.localeCompare(b.value))
    .map((value) => ({ id: value.id, label: value.display || value.label || value.value }));
  return { attribute, sizes };
}
