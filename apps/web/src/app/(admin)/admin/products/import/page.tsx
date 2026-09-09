import { PageHeader } from "@/components/admin/shell";
import { ProductImport } from "@/components/admin/product-import";

export const metadata = { title: "Import products" };

export default function ProductImportPage() {
  return (
    <>
      <PageHeader
        title="Import products"
        description="Load a catalogue from a spreadsheet. Nothing is written until you have seen what it would do."
      />
      <ProductImport />
    </>
  );
}
