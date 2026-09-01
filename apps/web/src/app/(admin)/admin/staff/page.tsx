import { redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import {
  type BranchOption,
  type RoleOption,
  StaffManager,
  type StaffRow,
} from "@/components/admin/staff-manager";
import { Card, CardContent, CardHeader, CardTitle, ErrorState } from "@/components/ui/primitives";
import { type Paginated, apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Staff & roles" };

interface RoleDetail extends RoleOption {
  description: string;
  /** `RoleSerializer` uses SlugRelatedField(slug_field="code"), so these are
   *  permission *codes*, not objects. Typing them as objects rendered a row of
   *  empty chips with duplicate React keys. */
  permissions: string[];
}

type MaybePaged<T> = T[] | Paginated<T>;

function rows<T>(payload: MaybePaged<T> | null): T[] {
  if (!payload) return [];
  return Array.isArray(payload) ? payload : (payload.results ?? []);
}

export default async function StaffPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/staff");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);
  const canManage = can("users.manage");

  let staff: StaffRow[] = [];
  let roles: RoleDetail[] = [];
  let branches: BranchOption[] = [];
  let error: string | null = null;

  try {
    const [staffPayload, rolePayload, organization] = await Promise.all([
      apiServer<MaybePaged<StaffRow>>("/users/?page_size=100"),
      apiServer<MaybePaged<RoleDetail>>("/roles/"),
      apiServer<{ branches: BranchOption[] }>("/organization/").catch(() => null),
    ]);
    staff = rows(staffPayload);
    roles = rows(rolePayload);
    branches = organization?.branches ?? [];
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load staff accounts.";
  }

  return (
    <>
      <PageHeader
        title="Staff &amp; roles"
        description="Who can sign in, and what each of them may do. A role change decides who may refund, discount and adjust stock, so every one is written to the audit log."
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load staff accounts" description={error} />
        </Card>
      ) : (
        <div className="space-y-10">
          <section aria-labelledby="accounts">
            <h2 id="accounts" className="sr-only">
              Staff accounts
            </h2>
            <StaffManager
              staff={staff}
              roles={roles}
              branches={branches}
              currentUserId={user.id}
              canManage={canManage}
            />
          </section>

          <section aria-labelledby="roles">
            <h2 id="roles" className="mb-3 text-h4 font-semibold">
              What each role can do
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {roles
                .filter((role) => role.is_staff_role)
                .map((role) => (
                  <Card key={role.id}>
                    <CardHeader>
                      <CardTitle>{role.name}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {role.description && (
                        <p className="mb-3 text-body-sm text-muted">{role.description}</p>
                      )}
                      {role.code === "OWNER" ? (
                        <p className="text-body-sm text-neutral-700">
                          Holds every permission, including the ones that are never granted
                          individually.
                        </p>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {role.permissions.map((permission) => (
                            <li
                              key={permission}
                              className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-caption text-neutral-700"
                            >
                              {permission}
                            </li>
                          ))}
                          {role.permissions.length === 0 && (
                            <li key="none" className="text-caption text-muted">
                              No permissions
                            </li>
                          )}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                ))}
            </div>
            <p className="mt-3 text-caption text-muted">
              Roles are seeded from <code>accounts/permissions.py</code> and are read-only here:
              changing what a role means would silently re-scope everyone already holding it. Move a
              person to a different role instead.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
