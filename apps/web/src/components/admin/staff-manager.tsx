"use client";

import { KeyRound, Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ROW_LINK_ABOVE, ROW_LINK_ROW, RowLink } from "@/components/admin/row-link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorSummary,
  Field,
  Input,
  PasswordInput,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { humanise } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

/** Personal and employment details. Every field is optional. */
export interface StaffProfile {
  designation: string;
  joined_on: string | null;
  date_of_birth: string | null;
  national_id: string;
  blood_group: string;
  present_address: string;
  permanent_address: string;
  emergency_contact_name: string;
  emergency_contact_relation: string;
  emergency_contact_phone: string;
  notes: string;
}

export const BLOOD_GROUPS = [
  { value: "A_POS", label: "A+" },
  { value: "A_NEG", label: "A−" },
  { value: "B_POS", label: "B+" },
  { value: "B_NEG", label: "B−" },
  { value: "AB_POS", label: "AB+" },
  { value: "AB_NEG", label: "AB−" },
  { value: "O_POS", label: "O+" },
  { value: "O_NEG", label: "O−" },
];

const BLANK_PROFILE: StaffProfile = {
  designation: "",
  joined_on: null,
  date_of_birth: null,
  national_id: "",
  blood_group: "",
  present_address: "",
  permanent_address: "",
  emergency_contact_name: "",
  emergency_contact_relation: "",
  emergency_contact_phone: "",
  notes: "",
};

export interface StaffRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string;
  /** The FK id. `role_code` is the one to compare against ("OWNER"). */
  role: string;
  role_code: string;
  role_name: string;
  branch: string | null;
  branch_name: string;
  status: string;
  date_joined: string;
  last_login: string | null;
  /** Present only for `users.manage`; the API leaves the key out for anyone else. */
  profile?: StaffProfile;
}

export interface RoleOption {
  id: string;
  code: string;
  name: string;
  is_staff_role: boolean;
}

export interface BranchOption {
  id: string;
  name: string;
  code: string;
}

type FieldError = { field: string; message: string };

/**
 * The input id for an API field: `profile.national_id` -> `staff-profile-national-id`.
 * Every input below is named this way, so a server error lands under the input
 * it is about and the error summary's link jumps to it.
 */
const fieldId = (apiField: string) => `staff-${apiField.replace(/[._]/g, "-")}`;

function toFieldErrors(caught: unknown, fallback: string): FieldError[] {
  if (caught instanceof ApiError) {
    const found = caught.fieldErrors();
    if (found.length) return found.map((error) => ({ ...error, field: fieldId(error.field) }));
    return [{ field: fallback, message: caught.message }];
  }
  return [{ field: fallback, message: "That did not work. Please try again." }];
}

/**
 * Staff accounts.
 *
 * The rules this screen has to make visible, because the API enforces them and
 * a form that hides them just produces a refusal nobody understands:
 *
 *  - You cannot deactivate or demote **your own** account.
 *  - You cannot deactivate or demote the **last active owner** — nothing else
 *    holds `users.manage` or `settings.manage`, so that would leave an
 *    organisation nobody can administer again.
 *  - Staff are deactivated, never deleted: the audit trail has to keep
 *    pointing at a real row.
 */
export function StaffManager({
  staff,
  roles,
  branches,
  currentUserId,
  canManage,
}: {
  staff: StaffRow[];
  roles: RoleOption[];
  branches: BranchOption[];
  currentUserId: string;
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);

  const activeOwners = staff.filter(
    (row) => row.role_code === "OWNER" && row.status === "ACTIVE",
  ).length;

  const close = () => setCreating(false);

  return (
    <div className="space-y-4">
      {canManage && creating && (
        <StaffForm
          roles={roles}
          branches={branches}
          isSelf={false}
          isLastOwner={false}
          onDone={close}
          onCancel={close}
        />
      )}

      {canManage && !creating && (
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden /> New staff account
        </Button>
      )}

      <Card className="overflow-hidden">
        {/* `relative` keeps the sr-only "Actions" header inside the scroll box;
            without it the page itself scrolled sideways on a phone (see
            role-matrix.tsx, which measured the same fault). */}
        <div className="relative overflow-x-auto">
          <table className="w-full text-body-sm">
            <caption className="sr-only">Staff accounts</caption>
            <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Phone</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Email</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Role</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Branch</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {staff.map((row) => (
                <tr key={row.id} className={ROW_LINK_ROW}>
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    {/* The whole row opens the profile; editing happens there. */}
                    <RowLink href={`/admin/staff/${row.id}`} className="block font-medium text-brand-600">
                      {row.full_name || row.email}
                    </RowLink>
                    {row.id === currentUserId && (
                      <span className="block text-caption text-muted">This is you</span>
                    )}
                  </th>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                    {row.phone ? formatPhone(row.phone) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{row.email}</td>
                  <td className="px-4 py-2.5">{row.role_name}</td>
                  <td className="px-4 py-2.5 text-muted">{row.branch_name || "All branches"}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={row.status === "ACTIVE" ? "success" : "neutral"}>
                      {humanise(row.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && (
                      <div className={`${ROW_LINK_ABOVE} flex justify-end gap-1`}>
                        <StatusButton
                          row={row}
                          isSelf={row.id === currentUserId}
                          isLastOwner={
                            row.role_code === "OWNER" && row.status === "ACTIVE" && activeOwners <= 1
                          }
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-caption text-muted">
        Staff are deactivated, never deleted — every order, adjustment and audit entry keeps pointing
        at a real account. Deactivating your own account, or the last active owner, is refused.
      </p>
    </div>
  );
}

function StatusButton({
  row,
  isSelf,
  isLastOwner,
}: {
  row: StaffRow;
  isSelf: boolean;
  isLastOwner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = row.status === "ACTIVE";
  const blocked = active && (isSelf || isLastOwner);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await apiClient(`/users/${row.id}/${active ? "deactivate" : "activate"}/`, {
        method: "POST",
        body: {},
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        disabled={blocked}
        onClick={toggle}
        title={
          blocked
            ? isSelf
              ? "You cannot deactivate your own account."
              : "This is the last active owner."
            : undefined
        }
        aria-label={`${active ? "Deactivate" : "Activate"} ${row.full_name || row.email}`}
      >
        {active ? "Deactivate" : "Activate"}
      </Button>
      {error && (
        <span role="alert" className="text-caption text-[var(--error)]">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Create or edit a staff account and its personal details, in one save.
 *
 * Used on the list (to create) and on the staff member's own page (to edit).
 * Only `users.manage` ever sees it, and only that permission gets `profile`
 * back from the API, so an edit whose row carries no profile sends none —
 * sending blanks would erase details the caller could not see.
 */
export function StaffForm({
  editing,
  roles,
  branches,
  isSelf,
  isLastOwner,
  onDone,
  onCancel,
}: {
  editing?: StaffRow;
  roles: RoleOption[];
  branches: BranchOption[];
  isSelf: boolean;
  isLastOwner: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(editing?.email ?? "");
  const [firstName, setFirstName] = useState(editing?.first_name ?? "");
  const [lastName, setLastName] = useState(editing?.last_name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [roleCode, setRoleCode] = useState(editing?.role_code ?? "CASHIER");
  const [branch, setBranch] = useState(editing?.branch ?? branches[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [profile, setProfile] = useState<StaffProfile>({
    ...BLANK_PROFILE,
    ...(editing?.profile ?? {}),
  });
  const [sameAddress, setSameAddress] = useState(
    Boolean(editing?.profile?.present_address) &&
      editing?.profile?.present_address === editing?.profile?.permanent_address,
  );
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const roleLocked = Boolean(editing) && (isSelf || isLastOwner);
  const sendsProfile = !editing || Boolean(editing.profile);

  function setDetail<K extends keyof StaffProfile>(key: K, value: StaffProfile[K]) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!email.trim()) found.push({ field: fieldId("email"), message: "An email is required." });
    if (!editing && password.length < 10) {
      found.push({
        field: fieldId("password"),
        message: "Set a password of at least 10 characters.",
      });
    }
    if (editing && password && password.length < 10) {
      found.push({
        field: fieldId("password"),
        message: "A new password must be at least 10 characters.",
      });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        email,
        first_name: firstName,
        last_name: lastName,
        phone,
        branch: branch || null,
      };
      if (!roleLocked) body.role_code = roleCode;
      if (password) body.password = password;
      if (sendsProfile) {
        body.profile = {
          ...profile,
          // An empty date input is "", which the API reads as a bad date.
          joined_on: profile.joined_on || null,
          date_of_birth: profile.date_of_birth || null,
          permanent_address: sameAddress ? profile.present_address : profile.permanent_address,
        };
      }

      await apiClient(editing ? `/users/${editing.id}/` : "/users/", {
        method: editing ? "PATCH" : "POST",
        body,
      });
      onDone();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, fieldId("email")));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (apiField: string) =>
    errors.find((error) => error.field === fieldId(apiField))?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.full_name || editing.email}` : "New staff account"}</CardTitle>
      </CardHeader>
      <CardContent>
        {roleLocked && (
          <p className="mb-4 flex gap-2 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-body-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning-text)]" aria-hidden />
            <span>
              {isSelf
                ? "This is your own account, so the role cannot be changed here — demoting yourself would remove the permission you need to undo it."
                : "This is the last active owner. Promote a second owner before changing this role, or nobody will be able to administer the shop."}
            </span>
          </p>
        )}

        <form onSubmit={submit} noValidate className="space-y-8">
          <ErrorSummary errors={errors} title="Could not save the account" />

          <FormSection title="Account" description="How this person signs in, and what they may do.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email" htmlFor={fieldId("email")} required error={errorFor("email")}>
                <Input
                  id={fieldId("email")}
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  invalid={Boolean(errorFor("email"))}
                />
              </Field>

              <Field label="Phone" htmlFor={fieldId("phone")} error={errorFor("phone")}>
                <Input
                  id={fieldId("phone")}
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  invalid={Boolean(errorFor("phone"))}
                />
              </Field>

              <Field label="First name" htmlFor={fieldId("first_name")} error={errorFor("first_name")}>
                <Input
                  id={fieldId("first_name")}
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              </Field>

              <Field label="Last name" htmlFor={fieldId("last_name")} error={errorFor("last_name")}>
                <Input
                  id={fieldId("last_name")}
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                />
              </Field>

              <Field
                label="Role"
                htmlFor={fieldId("role_code")}
                required
                hint="Decides what this person may do — refunds, discounts, stock adjustments."
                error={errorFor("role_code")}
              >
                <Select
                  id={fieldId("role_code")}
                  value={roleCode}
                  disabled={roleLocked}
                  onChange={(event) => setRoleCode(event.target.value)}
                >
                  {roles
                    .filter((role) => role.is_staff_role)
                    .map((role) => (
                      <option key={role.code} value={role.code}>
                        {role.name}
                      </option>
                    ))}
                </Select>
              </Field>

              <Field label="Branch" htmlFor={fieldId("branch")} error={errorFor("branch")}>
                <Select
                  id={fieldId("branch")}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                >
                  <option value="">All branches</option>
                  {branches.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} ({row.code})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label={editing ? "Set a new password" : "Password"}
              htmlFor={fieldId("password")}
              required={!editing}
              hint={
                editing
                  ? "Leave empty to keep the current one. A reset is written to the audit log; the password itself never is."
                  : "At least 10 characters."
              }
              error={errorFor("password")}
            >
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 shrink-0 text-neutral-400" aria-hidden />
                <PasswordInput
                  id={fieldId("password")}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  invalid={Boolean(errorFor("password"))}
                />
              </div>
            </Field>
          </FormSection>

          {sendsProfile && (
            <>
              <FormSection
                title="Employment"
                description="Optional. Only owners can see this and the sections below."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Designation"
                    htmlFor={fieldId("profile.designation")}
                    hint="Job title, e.g. Senior cashier"
                    error={errorFor("profile.designation")}
                  >
                    <Input
                      id={fieldId("profile.designation")}
                      value={profile.designation}
                      onChange={(event) => setDetail("designation", event.target.value)}
                      invalid={Boolean(errorFor("profile.designation"))}
                    />
                  </Field>
                  <Field
                    label="Joining date"
                    htmlFor={fieldId("profile.joined_on")}
                    error={errorFor("profile.joined_on")}
                  >
                    <Input
                      id={fieldId("profile.joined_on")}
                      type="date"
                      value={profile.joined_on ?? ""}
                      onChange={(event) => setDetail("joined_on", event.target.value || null)}
                      invalid={Boolean(errorFor("profile.joined_on"))}
                    />
                  </Field>
                </div>
              </FormSection>

              <FormSection title="Personal">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Date of birth"
                    htmlFor={fieldId("profile.date_of_birth")}
                    error={errorFor("profile.date_of_birth")}
                  >
                    <Input
                      id={fieldId("profile.date_of_birth")}
                      type="date"
                      value={profile.date_of_birth ?? ""}
                      onChange={(event) => setDetail("date_of_birth", event.target.value || null)}
                      invalid={Boolean(errorFor("profile.date_of_birth"))}
                    />
                  </Field>
                  <Field
                    label="National ID"
                    htmlFor={fieldId("profile.national_id")}
                    hint="NID, birth registration or passport number"
                    error={errorFor("profile.national_id")}
                  >
                    <Input
                      id={fieldId("profile.national_id")}
                      value={profile.national_id}
                      autoComplete="off"
                      onChange={(event) => setDetail("national_id", event.target.value)}
                      invalid={Boolean(errorFor("profile.national_id"))}
                    />
                  </Field>
                  <Field
                    label="Blood group"
                    htmlFor={fieldId("profile.blood_group")}
                    error={errorFor("profile.blood_group")}
                  >
                    <Select
                      id={fieldId("profile.blood_group")}
                      value={profile.blood_group}
                      onChange={(event) => setDetail("blood_group", event.target.value)}
                    >
                      <option value="">Not recorded</option>
                      {BLOOD_GROUPS.map((group) => (
                        <option key={group.value} value={group.value}>
                          {group.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </FormSection>

              <FormSection title="Addresses">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Present address"
                    htmlFor={fieldId("profile.present_address")}
                    error={errorFor("profile.present_address")}
                  >
                    <Textarea
                      id={fieldId("profile.present_address")}
                      rows={3}
                      value={profile.present_address}
                      onChange={(event) => setDetail("present_address", event.target.value)}
                      invalid={Boolean(errorFor("profile.present_address"))}
                    />
                  </Field>
                  <Field
                    label="Permanent address"
                    htmlFor={fieldId("profile.permanent_address")}
                    error={errorFor("profile.permanent_address")}
                  >
                    <Textarea
                      id={fieldId("profile.permanent_address")}
                      rows={3}
                      value={sameAddress ? profile.present_address : profile.permanent_address}
                      disabled={sameAddress}
                      onChange={(event) => setDetail("permanent_address", event.target.value)}
                      invalid={Boolean(errorFor("profile.permanent_address"))}
                    />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-body-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-brand-500"
                    checked={sameAddress}
                    onChange={(event) => setSameAddress(event.target.checked)}
                  />
                  Permanent address is the same as present
                </label>
              </FormSection>

              <FormSection title="Emergency contact" description="Who to call if something happens at work.">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Name"
                    htmlFor={fieldId("profile.emergency_contact_name")}
                    error={errorFor("profile.emergency_contact_name")}
                  >
                    <Input
                      id={fieldId("profile.emergency_contact_name")}
                      value={profile.emergency_contact_name}
                      onChange={(event) => setDetail("emergency_contact_name", event.target.value)}
                    />
                  </Field>
                  <Field
                    label="Relation"
                    htmlFor={fieldId("profile.emergency_contact_relation")}
                    hint="e.g. Mother, Spouse"
                    error={errorFor("profile.emergency_contact_relation")}
                  >
                    <Input
                      id={fieldId("profile.emergency_contact_relation")}
                      value={profile.emergency_contact_relation}
                      onChange={(event) =>
                        setDetail("emergency_contact_relation", event.target.value)
                      }
                    />
                  </Field>
                  <Field
                    label="Phone"
                    htmlFor={fieldId("profile.emergency_contact_phone")}
                    error={errorFor("profile.emergency_contact_phone")}
                  >
                    <Input
                      id={fieldId("profile.emergency_contact_phone")}
                      type="tel"
                      value={profile.emergency_contact_phone}
                      onChange={(event) => setDetail("emergency_contact_phone", event.target.value)}
                      invalid={Boolean(errorFor("profile.emergency_contact_phone"))}
                    />
                  </Field>
                </div>
              </FormSection>

              <FormSection title="Notes">
                <Field
                  label="Anything else worth keeping"
                  htmlFor={fieldId("profile.notes")}
                  hint="Previous employer, references, a guarantor — whatever the shop records."
                  error={errorFor("profile.notes")}
                >
                  <Textarea
                    id={fieldId("profile.notes")}
                    rows={3}
                    value={profile.notes}
                    onChange={(event) => setDetail("notes", event.target.value)}
                  />
                </Field>
              </FormSection>
            </>
          )}

          <div className="flex gap-3">
            <Button type="submit" loading={saving}>
              {editing ? "Save changes" : "Create account"}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-body font-semibold">{title}</legend>
      {description && <p className="mt-0.5 text-caption text-muted">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </fieldset>
  );
}
