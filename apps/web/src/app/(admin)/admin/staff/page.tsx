import { redirect } from "next/navigation";

import { Pagination } from "@/components/admin/pagination";
import { RoleMatrix } from "@/components/admin/role-matrix";
import { PageHeader } from "@/components/admin/shell";
import {
  type BranchOption,
  type RoleOption,
  StaffManager,
  type StaffRow,
} from "@/components/admin/staff-manager";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated, apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { applyPaging, readPaging } from "@/lib/paging";
import { type MatrixPermission, type MatrixRole, buildRoleMatrix } from "@/lib/role-matrix";

export const metadata = { title: "Staff & roles" };

/** `RoleSerializer` uses SlugRelatedField(slug_field="code"), so `permissions`
 *  are *codes*, not objects. Typing them as objects once rendered a row of
 *  empty chips with duplicate React keys. */
type RoleDetail = RoleOption & MatrixRole & { description: string };

type MaybePaged<T> = T[] | Paginated<T>;

function rows<T>(payload: MaybePaged<T> | null): T[] {
  if (!payload) return [];
  return Array.isArray(payload) ? payload : (payload.results ?? []);
}

/** A bare array is the whole set; a paginated body knows its own total. */
function total<T>(payload: MaybePaged<T> | null): number {
  if (!payload) return 0;
  return Array.isArray(payload) ? payload.length : payload.count;
}

type Search = Promise<Record<string, string | undefined>>;

export default async function StaffPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const paging = readPaging(params);
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/staff");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);
  const canManage = can("users.manage");

  let staff: StaffRow[] = [];
  let staffTotal = 0;
  let roles: RoleDetail[] = [];
  let catalogue: MatrixPermission[] | null = null;
  let branches: BranchOption[] = [];
  let error: string | null = null;

  try {
    const staffQuery = applyPaging(new URLSearchParams(), paging);
    const [staffPayload, rolePayload, permissionPayload, organization] = await Promise.all([
      apiServer<MaybePaged<StaffRow>>(`/users/?${staffQuery.toString()}`),
      // Roles are a short fixed set and the whole list is needed for the
      // matrix below, so this one stays unpaginated.
      apiServer<MaybePaged<RoleDetail>>("/roles/"),
      // What each code means. Optional: without it the matrix falls back to
      // the codes themselves, which is plainer but hides nothing.
      apiServer<MaybePaged<MatrixPermission>>("/permissions/").catch(() => null),
      apiServer<{ branches: BranchOption[] }>("/organization/").catch(() => null),
    ]);
    staff = rows(staffPayload);
    staffTotal = total(staffPayload);
    roles = rows(rolePayload);
    catalogue = permissionPayload ? rows(permissionPayload) : null;
    branches = organization?.branches ?? [];
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load staff accounts.";
  }

  return (
    <>
      <PageHeader
        title="Staff & roles"
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
            <Card className="mt-4 overflow-hidden">
              <Pagination
                count={staffTotal}
                page={paging.page}
                pageSize={paging.pageSize}
                query={params}
                unit="accounts"
                className="border-t-0"
              />
            </Card>
          </section>

          <section aria-labelledby="roles">
            <h2 id="roles" className="text-h4 font-semibold">
              What each role can do
            </h2>
            <p className="mb-3 mt-1 max-w-prose text-body-sm text-muted">
              One row per permission, one column per role. Read across a row to see who may do
              something — refund a sale, adjust stock, pay a supplier.
            </p>
            <RoleMatrix matrix={buildRoleMatrix(roles, catalogue)} />
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
