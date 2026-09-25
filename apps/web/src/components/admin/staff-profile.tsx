"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/admin/shell";
import {
  BLOOD_GROUPS,
  type BranchOption,
  type RoleOption,
  StaffForm,
  type StaffRow,
} from "@/components/admin/staff-manager";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { dateOnly, dateTime, humanise } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

/**
 * One member of staff: their account, and — for `users.manage` only — the
 * personal details the shop keeps about them. The API leaves `profile` out
 * for anyone else, so this screen cannot show what the caller may not read.
 */
export function StaffProfileView({
  staff,
  roles,
  branches,
  canManage,
  isSelf,
  isLastOwner,
  back,
}: {
  staff: StaffRow;
  roles: RoleOption[];
  branches: BranchOption[];
  canManage: boolean;
  isSelf: boolean;
  isLastOwner: boolean;
  back: { href: string; label: string };
}) {
  const [editing, setEditing] = useState(false);
  const name = staff.full_name || staff.email;
  const profile = staff.profile;

  if (editing) {
    return (
      <>
        <PageHeader title={name} back={back} />
        <StaffForm
          editing={staff}
          roles={roles}
          branches={branches}
          isSelf={isSelf}
          isLastOwner={isLastOwner}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={name}
        description={[
          profile?.designation || staff.role_name,
          staff.branch_name || "All branches",
        ].join(" · ")}
        back={back}
        actions={
          canManage ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden /> Edit details
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-body-sm sm:grid-cols-2">
              <Detail term="Email">{staff.email}</Detail>
              <Detail term="Phone">
                {staff.phone ? (
                  <a href={`tel:${staff.phone}`} className="text-brand-600 hover:underline">
                    {formatPhone(staff.phone)}
                  </a>
                ) : (
                  <NotRecorded />
                )}
              </Detail>
              <Detail term="Role">{staff.role_name}</Detail>
              <Detail term="Branch">{staff.branch_name || "All branches"}</Detail>
              <Detail term="Status">
                <Badge tone={staff.status === "ACTIVE" ? "success" : "neutral"}>
                  {humanise(staff.status)}
                </Badge>
              </Detail>
              <Detail term="Last signed in">
                {staff.last_login ? dateTime(staff.last_login) : "Never"}
              </Detail>
              <Detail term="Account created">{dateOnly(staff.date_joined)}</Detail>
            </dl>
          </CardContent>
        </Card>

        {profile ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Employment and personal</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 text-body-sm sm:grid-cols-2">
                  <Detail term="Designation">{profile.designation || <NotRecorded />}</Detail>
                  <Detail term="Joining date">
                    {profile.joined_on ? dateOnly(profile.joined_on) : <NotRecorded />}
                  </Detail>
                  <Detail term="Date of birth">
                    {profile.date_of_birth ? dateOnly(profile.date_of_birth) : <NotRecorded />}
                  </Detail>
                  <Detail term="National ID">
                    {profile.national_id ? (
                      <span className="font-mono">{profile.national_id}</span>
                    ) : (
                      <NotRecorded />
                    )}
                  </Detail>
                  <Detail term="Blood group">
                    {BLOOD_GROUPS.find((group) => group.value === profile.blood_group)?.label ?? (
                      <NotRecorded />
                    )}
                  </Detail>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Addresses</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 text-body-sm sm:grid-cols-2">
                  <Detail term="Present address">
                    <Multiline value={profile.present_address} />
                  </Detail>
                  <Detail term="Permanent address">
                    {profile.permanent_address &&
                    profile.permanent_address === profile.present_address ? (
                      "Same as present"
                    ) : (
                      <Multiline value={profile.permanent_address} />
                    )}
                  </Detail>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Emergency contact</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 text-body-sm sm:grid-cols-2">
                  <Detail term="Name">
                    {profile.emergency_contact_name ? (
                      <>
                        {profile.emergency_contact_name}
                        {profile.emergency_contact_relation && (
                          <span className="font-normal text-muted">
                            {" "}
                            ({profile.emergency_contact_relation})
                          </span>
                        )}
                      </>
                    ) : (
                      <NotRecorded />
                    )}
                  </Detail>
                  <Detail term="Phone">
                    {profile.emergency_contact_phone ? (
                      <a
                        href={`tel:${profile.emergency_contact_phone}`}
                        className="text-brand-600 hover:underline"
                      >
                        {formatPhone(profile.emergency_contact_phone)}
                      </a>
                    ) : (
                      <NotRecorded />
                    )}
                  </Detail>
                </dl>
              </CardContent>
            </Card>

            {profile.notes && (
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Notes</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-line text-body-sm">{profile.notes}</p>
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <Card>
            <CardContent>
              <p className="text-body-sm text-muted">
                Addresses, ID and emergency contact are visible to owners only.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-muted">{term}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

function NotRecorded() {
  return <span className="font-normal text-muted">Not recorded</span>;
}

function Multiline({ value }: { value: string }) {
  return value ? <span className="whitespace-pre-line">{value}</span> : <NotRecorded />;
}
