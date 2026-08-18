import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";
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
  branches: {
    id: string;
    name: string;
    code: string;
    address: string;
    phone: string;
    is_default: boolean;
    register_count: number;
    status: string;
  }[];
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
  const [orgResult, usersResult] = await Promise.allSettled([
    apiServer<Organization>("/organization/"),
    apiServer<{ results: StaffUser[] }>("/users/"),
  ]);

  const organization = orgResult.status === "fulfilled" ? orgResult.value : null;
  const users = usersResult.status === "fulfilled" ? usersResult.value.results : [];

  return (
    <>
      <PageHeader
        title="Settings"
        description="Business behaviour lives in code and docs; this shows the values a manager can change."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Organisation</CardTitle>
          </CardHeader>
          <CardContent>
            {organization ? (
              <dl className="space-y-2 text-body-sm">
                <Row term="Name" value={organization.name} />
                <Row term="Legal name" value={organization.legal_name || "—"} />
                <Row term="Phone" value={organization.phone || "—"} />
                <Row term="Email" value={organization.email || "—"} />
                <Row term="Address" value={organization.address || "—"} />
                <Row term="VAT registration" value={organization.vat_registration || "Not set"} />
                <Row term="Currency" value={organization.currency} />
              </dl>
            ) : (
              <p className="text-body-sm text-muted">
                You do not have permission to view organisation settings.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Branches</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {organization?.branches?.length ? (
              organization.branches.map((branch) => (
                <div key={branch.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-body-sm font-medium">
                      {branch.name} <span className="text-muted">({branch.code})</span>
                    </p>
                    <div className="flex gap-1">
                      {branch.is_default && <Badge tone="brand">Default</Badge>}
                      <Badge tone={branch.status === "ACTIVE" ? "success" : "neutral"}>
                        {humanise(branch.status)}
                      </Badge>
                    </div>
                  </div>
                  <p className="mt-1 text-caption text-muted">{branch.address || "No address set"}</p>
                  <p className="text-caption text-muted">
                    {branch.register_count} register{branch.register_count === 1 ? "" : "s"}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-body-sm text-muted">No branches visible.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Staff</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {users.length ? (
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
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-2.5 font-medium">{user.full_name}</td>
                    <td className="px-4 py-2.5">{user.email}</td>
                    <td className="px-4 py-2.5">{user.role_name}</td>
                    <td className="px-4 py-2.5 text-muted">{user.branch_name || "—"}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={user.status === "ACTIVE" ? "success" : "neutral"}>
                        {humanise(user.status)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            Editing these is API/config only for now — they live in environment variables so a change
            is deliberate and auditable rather than a stray click.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-muted">{term}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
