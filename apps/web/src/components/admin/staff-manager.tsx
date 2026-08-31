"use client";

import { KeyRound, Pencil, Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { humanise } from "@/lib/format";

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
  last_login: string | null;
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

function toFieldErrors(caught: unknown, fallback: string): FieldError[] {
  if (caught instanceof ApiError) {
    const found = caught.fieldErrors();
    if (found.length) return found;
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
  const [editing, setEditing] = useState<StaffRow | null>(null);

  const activeOwners = staff.filter(
    (row) => row.role_code === "OWNER" && row.status === "ACTIVE",
  ).length;

  const close = () => {
    setCreating(false);
    setEditing(null);
  };

  return (
    <div className="space-y-4">
      {canManage && (creating || editing) && (
        <StaffForm
          editing={editing ?? undefined}
          roles={roles}
          branches={branches}
          isSelf={editing?.id === currentUserId}
          isLastOwner={Boolean(
            editing && editing.role_code === "OWNER" && editing.status === "ACTIVE" && activeOwners <= 1,
          )}
          onDone={close}
          onCancel={close}
        />
      )}

      {canManage && !creating && !editing && (
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden /> New staff account
        </Button>
      )}

      <Card className="overflow-hidden">
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
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {staff.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    <span className="block font-medium">{row.full_name || "—"}</span>
                    {row.id === currentUserId && (
                      <span className="block text-caption text-muted">This is you</span>
                    )}
                  </th>
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
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setCreating(false);
                            setEditing(row);
                          }}
                          aria-label={`Edit ${row.full_name || row.email}`}
                        >
                          <Pencil className="size-4" aria-hidden /> Edit
                        </Button>
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

function StaffForm({
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
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const roleLocked = Boolean(editing) && (isSelf || isLastOwner);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!email.trim()) found.push({ field: "staff-email", message: "An email is required." });
    if (!editing && password.length < 10) {
      found.push({
        field: "staff-password",
        message: "Set a password of at least 10 characters.",
      });
    }
    if (editing && password && password.length < 10) {
      found.push({
        field: "staff-password",
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

      await apiClient(editing ? `/users/${editing.id}/` : "/users/", {
        method: editing ? "PATCH" : "POST",
        body,
      });
      onDone();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "staff-email"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.full_name || editing.email}` : "New staff account"}</CardTitle>
      </CardHeader>
      <CardContent>
        {roleLocked && (
          <p className="mb-4 flex gap-2 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-body-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden />
            <span>
              {isSelf
                ? "This is your own account, so the role cannot be changed here — demoting yourself would remove the permission you need to undo it."
                : "This is the last active owner. Promote a second owner before changing this role, or nobody will be able to administer the shop."}
            </span>
          </p>
        )}

        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save the account" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" htmlFor="staff-email" required error={errorFor("staff-email") ?? errorFor("email")}>
              <Input
                id="staff-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                invalid={Boolean(errorFor("staff-email") ?? errorFor("email"))}
              />
            </Field>

            <Field label="Phone" htmlFor="staff-phone" error={errorFor("phone")}>
              <Input
                id="staff-phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>

            <Field label="First name" htmlFor="staff-first">
              <Input
                id="staff-first"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </Field>

            <Field label="Last name" htmlFor="staff-last">
              <Input
                id="staff-last"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
              />
            </Field>

            <Field
              label="Role"
              htmlFor="staff-role"
              required
              hint="Decides what this person may do — refunds, discounts, stock adjustments."
              error={errorFor("role_code")}
            >
              <Select
                id="staff-role"
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

            <Field label="Branch" htmlFor="staff-branch" error={errorFor("branch")}>
              <Select
                id="staff-branch"
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
            htmlFor="staff-password"
            required={!editing}
            hint={
              editing
                ? "Leave empty to keep the current one. A reset is written to the audit log; the password itself never is."
                : "At least 10 characters."
            }
            error={errorFor("staff-password") ?? errorFor("password")}
          >
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 shrink-0 text-neutral-400" aria-hidden />
              <Input
                id="staff-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                invalid={Boolean(errorFor("staff-password") ?? errorFor("password"))}
              />
            </div>
          </Field>

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
