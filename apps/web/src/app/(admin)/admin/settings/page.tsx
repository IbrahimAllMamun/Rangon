import { type Branch, BranchEditor } from "@/components/admin/branch-editor";
import { OrganizationForm } from "@/components/admin/organization-form";
import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { humanise } from "@/lib/format";

export const metadata = { title: "Settings" };

interface Organization {
  id: string;
  name: string;
  legal_name: string;
  email: string;
  phone: string;
  address: string;
  vat_registration: string;
  currency: string;
  receipt_footer: string;
  branches: Branch[];
}

interface StaffUser {
  id: string;
  email: string;
  full_name: string;
  role_name: string;
  branch_name: string;
  status: string;
}

export default async function SettingsPage() {
  const [orgResult, usersResult, user] = await Promise.all([
    apiServer<Organization>("/organization/").catch(() => null),
    apiServer<{ results: StaffUser[] }>("/users/").catch(() => null),
    currentUser<SessionUser>(),
  ]);

  const permissions = user?.permissions ?? [];
  const can = (code: string) => permissions.includes("*") || permissions.includes(code);
  const canManage = can("settings.manage");

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          canManage
            ? "Changes here are written straight through to the API and appear on receipts and invoices."
            : "You can view these settings. Changing them needs the settings.manage permission."
        }
      />

      {orgResult ? (
        <div className="space-y-6">
          <OrganizationForm
            canManage={canManage}
            initial={{
              name: orgResult.name ?? "",
              legal_name: orgResult.legal_name ?? "",
              email: orgResult.email ?? "",
              phone: orgResult.phone ?? "",
              address: orgResult.address ?? "",
              vat_registration: orgResult.vat_registration ?? "",
              currency: orgResult.currency ?? "BDT",
              receipt_footer: orgResult.receipt_footer ?? "",
            }}
          />

          <BranchEditor branches={orgResult.branches ?? []} canManage={canManage} />
        </div>
      ) : (
        <Card>
          <CardContent>
            <p role="alert" className="text-body-sm text-muted">
              You do not have permission to view organisation settings.
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Staff</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {usersResult?.results?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Staff accounts</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Email</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Role</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Branch</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {usersResult.results.map((staff) => (
                    <tr key={staff.id}>
                      <td className="px-4 py-2.5 font-medium">{staff.full_name}</td>
                      <td className="px-4 py-2.5">{staff.email}</td>
                      <td className="px-4 py-2.5">{staff.role_name}</td>
                      <td className="px-4 py-2.5 text-muted">{staff.branch_name || "—"}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={staff.status === "ACTIVE" ? "success" : "neutral"}>
                          {humanise(staff.status)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-6 text-body-sm text-muted">
              You do not have permission to view staff accounts.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Decisions still owed</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-body-sm text-neutral-700">
            These defaults are implemented so the system runs, but each is a business call. They are
            documented in <code>docs/business-rules.md</code> and marked{" "}
            <code>DECISION REQUIRED</code>.
          </p>
          <ul className="mt-3 space-y-2 text-body-sm">
            <li>
              <strong>VAT</strong> — currently <em>exclusive at 0%</em>. Settle this before the first
              real sale: it changes every historical total and report.
            </li>
            <li><strong>Return window</strong> — assumed 14 days.</li>
            <li><strong>Discount needing manager approval</strong> — assumed above 20%.</li>
            <li><strong>Reservation expiry</strong> for unpaid online orders — assumed 60 minutes.</li>
            <li><strong>Shipping refunded on a change-of-mind return</strong> — assumed no.</li>
          </ul>
          <p className="mt-3 text-caption text-muted">
            These five stay in environment variables on purpose. They change how money and stock are
            calculated, so a change should be a deliberate deployment with a record — not a stray
            click in a browser. See <code>.env</code> and <code>config/settings/base.py</code>.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
