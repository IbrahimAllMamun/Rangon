import Link from "next/link";
import { redirect } from "next/navigation";

import { CustomerForm } from "@/components/admin/customer-form";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "New customer" };

export default async function NewCustomerPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/customers/new");

  const canCreate =
    user.permissions.includes("*") || user.permissions.includes("customers.create");

  return (
    <>
      <PageHeader
        title="New customer"
        description="Phone-first: a phone number or an email is required, so the counter can find this person again."
      />

      <p className="mb-4 text-body-sm text-muted">
        <Link href="/admin/customers" className="text-brand-600 hover:underline">
          ← Customers
        </Link>
      </p>

      {canCreate ? (
        <CustomerForm />
      ) : (
        <Card>
          <ErrorState
            title="You cannot create customers"
            description="Your role does not include customers.create. Ask an owner or a manager."
          />
        </Card>
      )}
    </>
  );
}
