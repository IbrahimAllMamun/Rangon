import { notFound } from "next/navigation";

import { PrintDocument } from "@/components/documents/print-document";
import { apiServer } from "@/lib/api/server";
import type { Order } from "@/lib/api/types";

export const metadata = {
  title: "Print",
  robots: { index: false, follow: false },
};

type Params = Promise<{ id: string }>;
type Search = Promise<{ type?: string }>;

interface DocumentPayload {
  order: Order;
  document_type: string;
  organization: {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    vat_registration?: string;
    receipt_footer?: string;
  };
}

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const { type } = await searchParams;
  const packingSlip = type === "packing-slip";

  let payload: DocumentPayload;
  try {
    payload = await apiServer<DocumentPayload>(
      `/orders/${id}/${packingSlip ? "packing-slip" : "invoice"}/`,
    );
  } catch {
    notFound();
  }

  return (
    <PrintDocument
      order={payload.order}
      organization={payload.organization}
      documentType={packingSlip ? "PACKING_SLIP" : "INVOICE"}
    />
  );
}
