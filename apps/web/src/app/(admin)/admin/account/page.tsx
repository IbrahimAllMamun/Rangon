import { redirect } from "next/navigation";

import { PasswordChangeForm } from "@/components/admin/password-change-form";
import { PageHeader } from "@/components/admin/shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Your account" };

/**
 * The signed-in person's own account — reachable by every staff role, which is
 * why it is gated on being signed in and nothing else. A cashier who suspects
 * their password is known to someone else changes it here, rather than having
 * to find an owner to reset it from /admin/staff.
 */
export default async function AccountPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/account");

  return (
    <>
      <PageHeader
        title="Your account"
        description="Who you are signed in as, and your password. Your name, role and branch are set by an owner from Staff."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Signed in as</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-body-sm">
              <div>
                <dt className="text-caption text-muted">Name</dt>
                <dd className="font-medium">{user.full_name || "—"}</dd>
              </div>
              <div>
                <dt className="text-caption text-muted">Email</dt>
                <dd className="font-medium">{user.email}</dd>
              </div>
              <div>
                <dt className="text-caption text-muted">Role</dt>
                <dd className="font-medium">{user.role_name}</dd>
              </div>
              <div>
                <dt className="text-caption text-muted">Branch</dt>
                <dd className="font-medium">
                  {user.branch ? `${user.branch.name} (${user.branch.code})` : "Every branch"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change your password</CardTitle>
            <p className="text-body-sm text-muted">
              Changing it signs you out everywhere else at once — use it if you think someone else
              knows your password.
            </p>
          </CardHeader>
          <CardContent>
            <PasswordChangeForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
