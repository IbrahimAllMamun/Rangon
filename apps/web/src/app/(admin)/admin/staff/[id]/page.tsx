import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import type { BranchOption, RoleOption, StaffRow } from "@/components/admin/staff-manager";
import { StaffProfileView } from "@/components/admin/staff-profile";
import { Card, ErrorState } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { type Paginated, apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Staff member" };

type MaybePaged<T> = T[] | Paginated<T>;

function rows<T>(payload: MaybePaged<T> | null): T[] {
  if (!payload) return [];
  return Array.isArray(payload) ? payload : (payload.results ?? []);
}

const BACK = { href: "/admin/staff", label: "Back to staff" };

export default async function StaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=/admin/staff/${id}`);

  const canManage =
    user.permissions.includes("*") || user.permissions.includes("users.manage");

  let staff: StaffRow | null = null;
  let error: string | null = null;
  try {
    staff = await apiServer<StaffRow>(`/users/${id}/`);
  } catch (caught) {
    // A malformed id is refused as a validation error; to a visitor it is the
    // same thing as an id that does not exist.
    if (caught instanceof ApiError && (caught.status === 404 || caught.status === 400)) notFound();
    error = caught instanceof Error ? caught.message : "Could not load this staff member.";
  }

  if (error || !staff) {
    return (
      <>
        <PageHeader title="Staff member" back={BACK} />
        <Card>
          <ErrorState
            title="Could not load this staff member"
            description={error ?? "The record came back empty."}
          />
        </Card>
      </>
    );
  }

  // The form's role picker, branch picker and last-owner guard are only
  // needed by someone who can edit.
  let roles: RoleOption[] = [];
  let branches: BranchOption[] = [];
  let activeOwners = 0;
  if (canManage) {
    const [rolePayload, organization] = await Promise.all([
      apiServer<MaybePaged<RoleOption>>("/roles/").catch(() => null),
      apiServer<{ branches: BranchOption[] }>("/organization/").catch(() => null),
    ]);
    roles = rows(rolePayload);
    branches = organization?.branches ?? [];
    const ownerRole = roles.find((role) => role.code === "OWNER");
    if (ownerRole) {
      const owners = await apiServer<MaybePaged<StaffRow>>(
        `/users/?role=${ownerRole.id}&status=ACTIVE&page_size=1`,
      ).catch(() => null);
      activeOwners = owners ? (Array.isArray(owners) ? owners.length : owners.count) : 0;
    }
  }

  return (
    <StaffProfileView
      staff={staff}
      roles={roles}
      branches={branches}
      canManage={canManage}
      isSelf={staff.id === user.id}
      isLastOwner={staff.role_code === "OWNER" && staff.status === "ACTIVE" && activeOwners <= 1}
      back={BACK}
    />
  );
}
